'use strict'
require('dotenv').config()

const express    = require('express')
const crypto     = require('crypto')
const axios      = require('axios')
const OpenAI = require('openai')

const ig   = require('./instagram')
const db   = require('./db')
const imgP = require('./image-processor')

const app  = express()
const PORT = process.env.PORT ?? 3001

// ── Raw body para validar firma Meta ─────────────────────────────────────────
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf }
}))

// ── Inventario en memoria ─────────────────────────────────────────────────────
let inventario = []
async function cargarInventario() {
  try {
    inventario = await db.getInventario()
    console.log(`[inventario] ${inventario.length} productos cargados`)
  } catch (e) {
    console.error('[inventario] Error cargando:', e.message)
  }
}

// ── Rate limiting por PSID ────────────────────────────────────────────────────
const cooldowns = new Map()
function enCooldown(psid) {
  const last = cooldowns.get(psid) ?? 0
  if (Date.now() - last < 1500) return true
  cooldowns.set(psid, Date.now())
  return false
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

function buildSystemPrompt() {
  const inv = inventario.map(p =>
    `- ${p.nombre} | $${Number(p.precio ?? 0).toLocaleString('es-CO')} | ${p.medidas ?? ''} | ${p.material ?? ''} | ${p.subcategoria ?? ''}`
  ).join('\n')

  return `Eres Elena, asistente virtual de DeCasa (@muebles_decasa) en Instagram Direct.
DeCasa es una tienda colombiana de muebles de alta calidad. Tu objetivo es ayudar a los clientes a encontrar el mueble perfecto, agendar citas y resolver dudas.

REGLAS:
- Responde siempre en español, tono amable y profesional
- Máximo 150 palabras por respuesta (Instagram DM)
- Si el cliente manda una foto de su cuarto, detecta que quiere ver cómo quedaría un mueble
- Si no tienes información suficiente, di que un asesor les contactará pronto
- NO inventes precios ni productos que no estén en el inventario
- No menciones WhatsApp ni números de teléfono — estamos en Instagram

INVENTARIO ACTUAL:
${inv || 'Cargando inventario...'}

SEDES (para agendar citas):
1. Sede Norte — Calle 100 #15-30
2. Sede Sur — Carrera 30 #45-20
3. Sede Centro — Calle 72 #10-15
4. Sede Occidente — Av. Las Américas #68-50
5. Sede Online (videollamada)

Cuando el cliente quiera agendar, pide: nombre completo, sede, día (lunes a viernes), hora (8am-5pm) y motivo.`
}

const TOOLS = [
  {
    name: 'buscar_producto',
    description: 'Busca un producto en el inventario por nombre o descripción',
    parameters: { type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'] },
  },
  {
    name: 'enviar_foto_producto',
    description: 'Envía la foto de un producto al cliente',
    parameters: { type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'] },
  },
  {
    name: 'solicitar_asesor',
    description: 'Transfiere la conversación a un asesor humano',
    parameters: {
      type: 'object',
      properties: {
        motivo: { type: 'string' },
        tipo:   { type: 'string', enum: ['asesor', 'pedido', 'cita', 'personalizacion'] },
      },
      required: ['motivo', 'tipo'],
    },
  },
]

async function callGemini(psid, mensajeUsuario) {
  const historial = await db.getHistorial(psid, 12)

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...historial.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: mensajeUsuario },
  ]

  const tools = TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))

  const response = await openai.chat.completions.create({
    model:       process.env.OPENAI_MODEL ?? 'gpt-4o',
    messages,
    tools,
    tool_choice: 'auto',
    temperature: 0.8,
    max_tokens:  500,
  })

  const choice = response.choices[0]

  if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
    const call = choice.message.tool_calls[0]
    return {
      tipo:   'tool',
      nombre: call.function.name,
      args:   JSON.parse(call.function.arguments),
    }
  }

  return { tipo: 'texto', texto: choice.message.content ?? '' }
}

// ── Herramientas ──────────────────────────────────────────────────────────────

function buscarEnInventario(nombre) {
  const q = nombre.toLowerCase()
  return inventario
    .map(p => ({ ...p, score: scoring(p, q) }))
    .filter(p => p.score > 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
}

function scoring(p, q) {
  const nombre = (p.nombre ?? '').toLowerCase()
  const sub    = (p.subcategoria ?? '').toLowerCase()
  let score = 0
  if (nombre === q)                   score += 100
  if (nombre.includes(q))             score += 60
  if (sub.includes(q))                score += 30
  q.split(' ').forEach(w => {
    if (w.length > 2 && nombre.includes(w)) score += 20
  })
  return score
}

async function ejecutarTool(psid, nombre, args, userInfo) {
  switch (nombre) {

    case 'buscar_producto': {
      const resultados = buscarEnInventario(args.nombre)
      if (!resultados.length) return `No encontré "${args.nombre}" en el inventario. ¿Puedes describir mejor lo que buscas?`
      return resultados.map(p =>
        `*${p.nombre}*\nPrecio: $${Number(p.precio ?? 0).toLocaleString('es-CO')}\nMedidas: ${p.medidas ?? 'consultar'}\nMaterial: ${p.material ?? 'consultar'}`
      ).join('\n\n')
    }

    case 'enviar_foto_producto': {
      const resultado = buscarEnInventario(args.nombre)[0]
      if (!resultado) return `No encontré ese producto. ¿Puedes darme más detalles?`
      await db.setUltimoProducto(psid, { nombre: resultado.nombre, imagen: resultado.imagen ?? null, ts: Date.now() })
      if (resultado.imagen) {
        await ig.sendImageMessage(psid, resultado.imagen)
        return `Aquí tienes una foto de *${resultado.nombre}* — precio: $${Number(resultado.precio ?? 0).toLocaleString('es-CO')} 😊`
      }
      return `*${resultado.nombre}* — $${Number(resultado.precio ?? 0).toLocaleString('es-CO')}\nEn este momento no tengo foto disponible, pero puedes verlo en nuestro perfil @muebles_decasa`
    }

    case 'solicitar_asesor': {
      await enviarNotificacionSistema(psid, userInfo, args.motivo, args.tipo)
      return `Entendido, voy a conectarte con uno de nuestros asesores. Estarán contigo en breve 😊`
    }

    default:
      return null
  }
}

// ── Notificación al sistema de ventas ─────────────────────────────────────────

async function enviarNotificacionSistema(psid, userInfo, resumen, tipo = 'asesor') {
  const apiUrl   = process.env.DECASA_API_URL
  const apiToken = process.env.DECASA_AGENT_TOKEN
  if (!apiUrl) { console.warn('[redes] DECASA_API_URL no configurado'); return }

  try {
    const historial = await db.getHistorial(psid, 6)
    const username  = userInfo?.username ?? psid
    const contactoUrl = userInfo?.username
      ? `https://ig.me/m/${userInfo.username}`
      : null

    await axios.post(`${apiUrl}/api/redes/webhook`, {
      tipo,
      telefono:       psid,
      nombre_cliente: userInfo?.nombre ?? username,
      resumen,
      historial:      historial.map(m => ({ role: m.role, content: m.content })),
      whatsapp_url:   null,
      fuente:         'instagram',
      contacto_url:   contactoUrl,
    }, {
      headers:  { 'X-Agent-Token': apiToken ?? '' },
      timeout:  8000,
    })
    console.log(`[redes] Notificación enviada — tipo: ${tipo}, psid: ${psid}`)
  } catch (e) {
    console.error('[redes] Error enviando notificación:', e.response?.data ?? e.message)
  }
}

// ── Detección de foto de cuarto ───────────────────────────────────────────────

function esVisualizacion(texto) {
  if (!texto) return false
  return /\b(sala|cuarto|habitaci[oó]n|ambiente|visualiz|pon\s+(el|la)|c[oó]mo\s+(quedar[íi]a[n]?|se\s+ver[íi]a[n]?|luce[n]?|queda[n]?)|quedar[íi]a[n]?\s+(bien|aqu[íi]|ac[aá]|en)|queda[n]?\s+(bien|aqu[íi]|ac[aá]|en\s+este|en\s+mi)|ver\s+c[oó]mo\s+queda|quiero\s+ver\s+c[oó]mo)\b/i.test(texto)
}

// ── Manejador principal de mensajes ───────────────────────────────────────────

async function handleMessage(psid, texto, adjuntos, esStoryReply, storyUrl) {
  if (enCooldown(psid)) return

  const userInfo = await ig.getUserInfo(psid)
  await db.getOrCreateClienteByPsid(psid, userInfo.username, userInfo.nombre)
  await db.actualizarInteraccion(psid)
  await ig.sendTypingOn(psid)

  // Imagen recibida — posible visualización
  if (adjuntos?.length) {
    const imagenes = adjuntos.filter(a => a.type === 'image')
    if (imagenes.length) {
      const ultimoProd = await db.getUltimoProducto(psid)
      if (ultimoProd?.imagen || esVisualizacion(texto)) {
        const { buffer } = await ig.downloadMediaToBuffer(imagenes[0].payload.url)
        const result = await imgP.processRoomImage(buffer, ultimoProd)
        if (result.success) {
          await ig.sendImageMessage(psid, result.url)
          await ig.sendTextMessage(psid, `Así quedaría *${ultimoProd.nombre}* en tu espacio 😊`)
          await db.guardarMensaje(psid, 'user', '[imagen del cuarto]')
          await db.guardarMensaje(psid, 'assistant', 'Visualización generada')
          return
        } else {
          await ig.sendTextMessage(psid, result.message)
          return
        }
      }
    }
  }

  // Contexto de story reply
  let mensajeAI = texto ?? ''
  if (esStoryReply && storyUrl) {
    mensajeAI = `[El cliente respondió a una historia de @muebles_decasa] ${mensajeAI}`
  }

  if (!mensajeAI.trim()) return

  await db.guardarMensaje(psid, 'user', mensajeAI)

  try {
    const respuesta = await callGemini(psid, mensajeAI)

    if (respuesta.tipo === 'tool') {
      const toolResult = await ejecutarTool(psid, respuesta.nombre, respuesta.args, userInfo)
      if (toolResult) {
        await ig.sendTextMessage(psid, toolResult)
        await db.guardarMensaje(psid, 'assistant', toolResult)
      }
    } else {
      await ig.sendTextMessage(psid, respuesta.texto)
      await db.guardarMensaje(psid, 'assistant', respuesta.texto)
    }
  } catch (e) {
    console.error('[AI] Error:', e.message)
    await ig.sendTextMessage(psid, 'Tuve un problema procesando tu mensaje. Un asesor te contactará pronto 🙏')
  }
}

// ── Webhook Meta ──────────────────────────────────────────────────────────────

// GET — verificación de Meta
app.get('/webhook/instagram', (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    console.log('[webhook] Verificado por Meta')
    res.status(200).send(challenge)
  } else {
    res.sendStatus(403)
  }
})

// POST — mensajes entrantes
app.post('/webhook/instagram', (req, res) => {
  // Responder 200 inmediatamente para que Meta no reintente
  res.sendStatus(200)

  // Validar firma
  if (!verificarFirma(req)) {
    console.warn('[webhook] Firma inválida, ignorando')
    return
  }

  const body = req.body
  console.log(`[webhook] object=${body.object} entries=${body.entry?.length ?? 0}`)
  if (body.object !== 'instagram' && body.object !== 'page') return

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      // Ignorar ecos (mensajes propios del bot)
      if (event.message?.is_echo) continue

      const psid      = event.sender?.id
      const texto     = event.message?.text ?? null
      const adjuntos  = event.message?.attachments ?? null
      const storyReply = !!event.message?.reply_to?.story
      const storyUrl   = event.message?.reply_to?.story?.url ?? null

      if (!psid) continue

      handleMessage(psid, texto, adjuntos, storyReply, storyUrl)
        .catch(e => console.error('[handleMessage] Error no capturado:', e.message))
    }
  }
})

// ── Validación de firma ───────────────────────────────────────────────────────
function verificarFirma(req) {
  const appSecret = process.env.INSTAGRAM_APP_SECRET
  if (!appSecret) return true // sin secret configurado, aceptar en dev

  const sig = req.headers['x-hub-signature-256']?.replace('sha256=', '')
  if (!sig) return false

  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody ?? '')
    .digest('hex')

  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ ok: true, servicio: 'DeCasa Instagram Agent', inventario: inventario.length }))

// ── Páginas legales requeridas por Meta ───────────────────────────────────────
app.get('/privacy', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Política de Privacidad — DeCasa</title>
  <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6}h1{color:#333}</style></head>
  <body>
  <h1>Política de Privacidad — DeCasa Instagram Bot</h1>
  <p><strong>Última actualización:</strong> mayo 2026</p>
  <p>Este asistente de Instagram (<strong>Elena</strong>) es operado por <strong>DeCasa</strong>, tienda de muebles con sede en Colombia.</p>
  <h2>Datos que recopilamos</h2>
  <ul>
    <li>Tu nombre e ID de usuario de Instagram (PSID) para gestionar tu conversación.</li>
    <li>Los mensajes que envías, para responder tus consultas sobre productos.</li>
    <li>Fotos que compartas voluntariamente para la función de visualización de muebles.</li>
  </ul>
  <h2>Uso de los datos</h2>
  <p>Los datos se usan exclusivamente para responder consultas, agendar citas y mejorar la atención al cliente de DeCasa. No compartimos tu información con terceros.</p>
  <h2>Retención</h2>
  <p>El historial de conversación se conserva por 90 días y luego se elimina automáticamente.</p>
  <h2>Contacto</h2>
  <p>Para cualquier duda sobre privacidad escríbenos a <a href="mailto:juandavidrestrepobetancur756@gmail.com">juandavidrestrepobetancur756@gmail.com</a></p>
  </body></html>`)
})

app.get('/delete-data', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Eliminación de datos — DeCasa</title>
  <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6}h1{color:#333}</style></head>
  <body>
  <h1>Solicitud de eliminación de datos — DeCasa</h1>
  <p>Para solicitar la eliminación de tus datos de conversación con el asistente de DeCasa en Instagram, envía un correo a:</p>
  <p><strong><a href="mailto:juandavidrestrepobetancur756@gmail.com">juandavidrestrepobetancur756@gmail.com</a></strong></p>
  <p>Indica tu nombre de usuario de Instagram y procesaremos tu solicitud en un plazo de 72 horas.</p>
  </body></html>`)
})

// ── Inicio ────────────────────────────────────────────────────────────────────
async function startServer() {
  await cargarInventario()
  setInterval(cargarInventario, 30 * 60 * 1000) // refresca inventario cada 30 min

  app.listen(PORT, () => {
    console.log(`[server] Instagram Agent corriendo en puerto ${PORT}`)
  })
}

startServer().catch(e => { console.error(e); process.exit(1) })
