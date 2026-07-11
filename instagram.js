'use strict'
require('dotenv').config()
const axios = require('axios')
const { alertar, conReintentos } = require('./alertas')

const BASE  = 'https://graph.instagram.com/v22.0'
const TOKEN = () => process.env.INSTAGRAM_PAGE_ACCESS_TOKEN

// Enviar texto al usuario (dividir si supera 1000 chars)
async function sendTextMessage(psid, texto) {
  const chunks = splitMessage(texto, 980)
  for (const chunk of chunks) {
    await _send(psid, { text: chunk })
  }
}

// Enviar imagen via URL pública (Cloudinary)
async function sendImageMessage(psid, imageUrl) {
  await _send(psid, {
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
  } catch (e) {
    const err = e.response?.data?.error
    console.error('[IG] sendMessage error:', err ?? e.message)
    // 190 = token expirado / inválido: el bot queda mudo indefinidamente hasta que se
    // renueve el token de larga duración (~60 días). Hay que enterarse ya, no descubrirlo
    // por clientes sin respuesta.
    if (err?.code === 190) {
      alertar('Token de Instagram inválido/expirado (code 190)', err.message ?? 'sin detalle')
    }
    // No relanzar: un fallo de envío no debe tumbar el manejo del mensaje. El caller
    // decide si el texto era crítico.
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

module.exports = { sendTextMessage, sendImageMessage, sendTypingOn, getUserInfo, downloadMediaToBuffer, getMediaDetails }
