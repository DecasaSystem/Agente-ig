'use strict'
require('dotenv').config()

// Módulo aparte (y no dentro de index.js) para que instagram.js pueda alertar sin
// crear una dependencia circular: index.js ya requiere instagram.js.

// Evita inundar Telegram cuando algo falla en bucle: la misma alerta, como mucho una
// vez cada 10 minutos.
const ultimaAlerta = new Map()
const SILENCIO_MS = 10 * 60 * 1000

function alertar(titulo, detalle) {
  console.error(`[ALERTA] ${titulo}:`, detalle)

  const ahora = Date.now()
  if (ahora - (ultimaAlerta.get(titulo) ?? 0) < SILENCIO_MS) return
  ultimaAlerta.set(titulo, ahora)

  const token  = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return // sin credenciales, queda solo en los logs

  const texto = `🚨 <b>${titulo} — Elena Instagram</b>\n<code>${String(detalle).substring(0, 400)}</code>`
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML' }),
  }).catch(() => {})
}

// Espera con backoff exponencial y jitter. Reintenta solo si `esReintentable` lo dice.
async function conReintentos(fn, { intentos = 3, baseMs = 1000, esReintentable = () => true, contexto = '' } = {}) {
  let ultimoError
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn()
    } catch (e) {
      ultimoError = e
      if (i === intentos - 1 || !esReintentable(e)) throw e
      const espera = baseMs * (2 ** i) + Math.floor(Math.random() * 300)
      console.warn(`[retry] ${contexto} intento ${i + 1}/${intentos} falló (${e.message}); reintentando en ${espera}ms`)
      await new Promise(r => setTimeout(r, espera))
    }
  }
  throw ultimoError
}

module.exports = { alertar, conReintentos }
