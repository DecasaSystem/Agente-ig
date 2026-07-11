'use strict'
require('dotenv').config()
const axios = require('axios')
const { alertar, conReintentos } = require('./alertas')

const BASE  = 'https://graph.instagram.com/v22.0'
const TOKEN = () => process.env.INSTAGRAM_PAGE_ACCESS_TOKEN

// Enviar texto al usuario (dividir si supera 1000 chars)
async function sendTextMessage(psid, texto) {
  const chunks = splitMessage(texto, 980)
  let ok = true
  for (const chunk of chunks) {
    if (!(await _send(psid, { text: chunk }))) ok = false
  }
  return ok
}

// Enviar imagen via URL pública (Cloudinary)
async function sendImageMessage(psid, imageUrl) {
  return _send(psid, {
    attachment: {
      type: 'image',
      payload: { url: imageUrl, is_reusable: true },
    },
  })
}

// Mostrar indicador "escribiendo..."
async function sendTypingOn(psid) {
  try {
    await axios.post(`${BASE}/me/messages`, {
      recipient:     { id: psid },
      sender_action: 'typing_on',
    }, { params: { access_token: TOKEN() } })
  } catch {}
}

// Obtener nombre y username del usuario
async function getUserInfo(psid) {
  try {
    const { data } = await axios.get(`${BASE}/${psid}`, {
      params: {
        fields:       'name,username',
        access_token: TOKEN(),
      },
    })
    return { nombre: data.name ?? null, username: data.username ?? null }
  } catch (e) {
    console.error('[IG] getUserInfo error:', e.response?.data ?? e.message)
    return { nombre: null, username: null }
  }
}

// Descargar media de Meta INMEDIATAMENTE (las URLs expiran en ~1h)
async function downloadMediaToBuffer(mediaUrl) {
  const response = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${TOKEN()}` },
    timeout: 15000,
  })
  return {
    buffer:      Buffer.from(response.data),
    contentType: response.headers['content-type'] ?? 'image/jpeg',
  }
}

// ── Interno ───────────────────────────────────────────────────────────────────

async function _send(psid, message) {
  const enviar = () => axios.post(`${BASE}/me/messages`,
    { recipient: { id: psid }, message },
    { params: { access_token: TOKEN() }, timeout: 10000 }
  )

  try {
    await conReintentos(enviar, {
      intentos: 3,
      baseMs:   1500,
      contexto: `IG _send psid=${psid}`,
      // Reintentar solo lo transitorio: rate limit (613), 5xx, o red caída. No tiene
      // sentido reintentar un token expirado o falta de permisos.
      esReintentable: e => {
        const code   = e.response?.data?.error?.code
        const status = e.response?.status
        return code === 613 || (status >= 500 && status < 600) || !e.response
      },
    })
    return true
  } catch (e) {
    const err = e.response?.data?.error
    console.error('[IG] sendMessage error:', err ?? e.message)
    // 190 = token expirado / inválido: el bot queda mudo indefinidamente hasta que se
    // renueve el token de larga duración (~60 días). Hay que enterarse ya, no descubrirlo
    // por clientes sin respuesta.
    if (err?.code === 190) {
      alertar('Token de Instagram inválido/expirado (code 190)', err.message ?? 'sin detalle')
    }
    // No relanzar: un fallo de envío no debe tumbar el manejo del mensaje. Se devuelve
    // false para que el caller pueda caer a texto plano.
    return false
  }
}

// Texto con botones de respuesta rápida. opciones = [{ title, payload }] (máx 13,
// title máx 20 chars). Devuelve true/false para permitir degradación a texto plano.
async function sendQuickReplies(psid, texto, opciones) {
  const quick_replies = (opciones ?? []).slice(0, 13).map(o => ({
    content_type: 'text',
    title:        String(o.title).substring(0, 20),
    payload:      String(o.payload).substring(0, 1000),
  }))
  if (!quick_replies.length) return sendTextMessage(psid, texto)
  return _send(psid, { text: String(texto).substring(0, 980), quick_replies })
}

// Carrusel de tarjetas (generic template). elementos = [{ title, subtitle, image_url,
// buttons: [{type:'postback',title,payload} | {type:'web_url',title,url}] }] (máx 10).
async function sendCarousel(psid, elementos) {
  const elements = (elementos ?? []).slice(0, 10).map(el => {
    const card = { title: String(el.title).substring(0, 80) }
    if (el.subtitle)  card.subtitle  = String(el.subtitle).substring(0, 80)
    if (el.image_url) card.image_url = el.image_url
    if (el.buttons?.length) {
      card.buttons = el.buttons.slice(0, 3).map(b =>
        b.type === 'web_url'
          ? { type: 'web_url',  url: b.url, title: String(b.title).substring(0, 20) }
          : { type: 'postback', title: String(b.title).substring(0, 20), payload: String(b.payload).substring(0, 1000) }
      )
    }
    return card
  })
  if (!elements.length) return false
  return _send(psid, {
    attachment: { type: 'template', payload: { template_type: 'generic', elements } },
  })
}

// Respuesta PRIVADA a un comentario: abre un DM en respuesta al comentario. Requiere
// el permiso instagram_manage_comments y la suscripción al campo 'comments' del webhook.
// Nota de Meta: solo una respuesta privada por comentario, y dentro de los 7 días.
async function sendPrivateReplyToComment(commentId, texto) {
  const enviar = () => axios.post(`${BASE}/me/messages`,
    { recipient: { comment_id: commentId }, message: { text: String(texto).substring(0, 980) } },
    { params: { access_token: TOKEN() }, timeout: 10000 }
  )
  try {
    await enviar()
    return true
  } catch (e) {
    console.error('[IG] private reply error:', e.response?.data?.error ?? e.message)
    return false
  }
}

function splitMessage(texto, maxLen) {
  if (texto.length <= maxLen) return [texto]
  const chunks = []
  let i = 0
  while (i < texto.length) {
    let end = i + maxLen
    if (end < texto.length) {
      const corte = texto.lastIndexOf('\n', end)
      if (corte > i) end = corte + 1
    }
    chunks.push(texto.slice(i, end).trim())
    i = end
  }
  return chunks.filter(Boolean)
}

// Obtener caption/detalles de un post o historia por su media ID
async function getMediaDetails(mediaId) {
  try {
    const { data } = await axios.get(`${BASE}/${mediaId}`, {
      params: {
        fields:       'caption,media_type,media_url,thumbnail_url',
        access_token: TOKEN(),
      },
    })
    return data
  } catch (e) {
    console.error('[IG] getMediaDetails error:', e.response?.data?.error?.message ?? e.message)
    return null
  }
}

module.exports = {
  sendTextMessage, sendImageMessage, sendTypingOn, getUserInfo,
  downloadMediaToBuffer, getMediaDetails,
  sendQuickReplies, sendCarousel, sendPrivateReplyToComment,
}
