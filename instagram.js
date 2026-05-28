'use strict'
require('dotenv').config()
const axios = require('axios')

const BASE  = 'https://graph.facebook.com/v19.0'
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
  try {
    await axios.post(`${BASE}/me/messages`, {
      recipient: { id: psid },
      message,
    }, {
      params: { access_token: TOKEN() },
      timeout: 10000,
    })
  } catch (e) {
    const err = e.response?.data?.error
    console.error('[IG] sendMessage error:', err ?? e.message)
    // 190 = token expirado, 10 = sin permisos, 613 = rate limit
    if (err?.code === 613) {
      await new Promise(r => setTimeout(r, 3000))
      await axios.post(`${BASE}/me/messages`, { recipient: { id: psid }, message },
        { params: { access_token: TOKEN() } })
    }
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

module.exports = { sendTextMessage, sendImageMessage, sendTypingOn, getUserInfo, downloadMediaToBuffer }
