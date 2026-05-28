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

  return `Eres Elena, asesora de ventas de DeCasa en Instagram Direct (@muebles_decasa).
DeCasa es una tienda colombiana de muebles de madera Flor Morado de alta calidad, con sedes en Armenia y Pereira.

IDENTIDAD:
- Horario: Lunes-Viernes 8am-5pm | Sábado 8am-12pm
- No menciones WhatsApp ni teléfonos — estamos en Instagram

SEDES:
1. Av. Bolívar # 16 N 26, Armenia, Quindío
2. Km 2 vía El Edén, Armenia, Quindío
3. Km 1 vía Jardines, Armenia, Quindío
4. CC Unicentro Pereira, Risaralda
5. Cra. 14 #11-93, Pereira, Risaralda

CATEGORÍAS:
camas | bases_comedores | sillas_comedor | sillas_auxiliares | sillas_barra
mesas_centro | mesas_auxiliares | mesas_noche | mesas_tv
sofas | sofas_modulares | sofas_camas | cajoneros_bifes | escritorios | colchones

INSTRUCCIONES OBLIGATORIAS:
1. SIEMPRE usa buscar_productos antes de mencionar cualquier producto o precio
2. NUNCA inventes precios ni productos — solo lo que devuelva buscar_productos
3. Cuando el cliente mencione presupuesto o "barato/económico" → usa buscar_por_presupuesto
4. Para fotos → usa enviar_foto (escribe "Te envío la foto 👇" antes de llamarla)
5. Para agendar → pide nombre, sede (1-5), día, hora, motivo; luego llama agendar_cita
6. Máximo 150 palabras por respuesta

VISIÓN DE IMÁGENES:
- Puedes ver imágenes cuando el cliente las comparte
- Si el cliente comparte una publicación con imagen: descríbela brevemente y responde con la info del producto que aparece en el contexto
- Si el cliente envía una foto de un mueble o producto: identifica qué es, busca en el inventario y ofrece ese producto o similares
- NUNCA digas que no puedes ver imágenes — siempre tienes capacidad de visión cuando se te envía una imagen

TÉRMINOS AMBIGUOS — pregunta ANTES de buscar:
- "sillas" → "¿Buscas sillas de comedor, sillas auxiliares (sala/decoración) o sillas de barra?"
- "mesas" → "¿Buscas mesa de centro, mesa auxiliar, mesa de noche o mesa para TV?"
- "sofá/sofas" sin más contexto → "¿Buscas sofá tradicional, modular o sofá cama?"
No preguntes si el cliente YA especificó el tipo (ej: "sillas de comedor").

CUÁNDO TRANSFERIR (llama solicitar_asesor inmediatamente):
- Pide financiación, crédito, cuotas o formas de pago
- Quiere producto a medida, color especial o personalización
- Pregunta por domicilio, entrega, instalación o garantía
- Lleva 2+ mensajes con la misma duda sin resolución
- Expresa frustración

TONO: Amable, profesional, persuasiva. Emojis moderados. Cierra siempre con una pregunta.

INVENTARIO ACTUAL:
${inv || 'Cargando inventario...'}`
}

const TOOLS = [
  {
    name: 'buscar_productos',
    description: 'Busca productos en el inventario por nombre, descripción o categoría. Úsalo para cualquier pregunta sobre productos, precios o disponibilidad.',
    parameters: {
      type: 'object',
      properties: {
        consulta:  { type: 'string', description: 'Texto de búsqueda (ej: "silla comedor", "cama doble")' },
        categoria: { type: 'string', description: 'Categoría opcional: sillas_comedor, sillas_auxiliares, sillas_barra, mesas_centro, mesas_auxiliares, mesas_noche, mesas_tv, sofas, sofas_modulares, sofas_camas, camas, bases_comedores, cajoneros_bifes, escritorios, colchones' },
        limite:    { type: 'number', description: 'Máximo resultados (default 5)' },
      },
      required: ['consulta'],
    },
  },
  {
    name: 'buscar_por_presupuesto',
    description: 'Busca productos dentro del presupuesto del cliente.',
    parameters: {
      type: 'object',
      properties: {
        presupuesto_max: { type: 'number', description: 'Presupuesto máximo en pesos (sin puntos ni $, ej: 2000000)' },
        categoria:       { type: 'string', description: 'Categoría específica (opcional)' },
      },
      required: ['presupuesto_max'],
    },
  },
  {
    name: 'enviar_foto',
    description: 'Envía la foto de un producto al cliente.',
    parameters: {
      type: 'object',
      properties: { nombre_producto: { type: 'string' } },
      required: ['nombre_producto'],
    },
  },
  {
    name: 'agendar_cita',
    description: 'Guarda una cita de visita. Recopila TODA la info primero.',
    parameters: {
      type: 'object',
      properties: {
        nombre:    { type: 'string', description: 'Nombre completo del cliente' },
        ubicacion: { type: 'number', description: 'Número de sede 1-5' },
        dia:       { type: 'string', description: 'Día de la semana' },
        hora:      { type: 'string', description: 'Hora en formato HH:MM' },
        motivo:    { type: 'string', description: 'Motivo de la visita' },
      },
      required: ['nombre', 'ubicacion', 'dia', 'hora', 'motivo'],
    },
  },
  {
    name: 'solicitar_asesor',
    description: 'Transfiere la conversación a un asesor humano.',
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

async function callGemini(psid, mensajeUsuario, imageBase64 = null) {
  const historial = await db.getHistorial(psid, 12)

  // Si hay imagen, el último mensaje del usuario incluye la imagen para visión
  const userContent = imageBase64
    ? [
        { type: 'text', text: mensajeUsuario },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'low' } },
      ]
    : mensajeUsuario

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...historial.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: userContent },
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

function buscarEnInventario(consulta, categoria = null, limite = 5) {
  const q = consulta.toLowerCase()
  let base = inventario
  if (categoria) {
    const cat = categoria.toLowerCase().replace(/\s+/g, '_')
    base = inventario.filter(p => (p.subcategoria ?? '').toLowerCase().replace(/\s+/g, '_') === cat)
  }
  return base
    .map(p => ({ ...p, score: scoring(p, q) }))
    .filter(p => p.score > 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limite, 10))
}

function scoring(p, q) {
  const nombre = (p.nombre ?? '').toLowerCase()
  const sub    = (p.subcategoria ?? '').toLowerCase()
  let score = 0
  if (nombre === q)         score += 100
  if (nombre.includes(q))   score += 60
  if (sub.includes(q))      score += 40
  q.split(' ').forEach(w => {
    if (w.length > 2 && nombre.includes(w)) score += 20
    if (w.length > 2 && sub.includes(w))    score += 10
  })
  return score
}

function formatProducto(p) {
  return `*${p.nombre}*\nPrecio: $${Number(p.precio ?? 0).toLocaleString('es-CO')}\nMedidas: ${p.medidas ?? 'consultar'}\nMaterial: ${p.material ?? 'Madera Flor Morado'}`
}

async function ejecutarTool(psid, nombre, args, userInfo) {
  switch (nombre) {

    case 'buscar_productos': {
      const resultados = buscarEnInventario(args.consulta, args.categoria ?? null, args.limite ?? 5)
      if (!resultados.length) return `No encontré "${args.consulta}" en el inventario. ¿Puedes describir mejor lo que buscas?`
      return resultados.map(formatProducto).join('\n\n')
    }

    case 'buscar_por_presupuesto': {
      let base = inventario.filter(p => Number(p.precio ?? 0) <= args.presupuesto_max)
      if (args.categoria) {
        const cat = args.categoria.toLowerCase().replace(/\s+/g, '_')
        base = base.filter(p => (p.subcategoria ?? '').toLowerCase().replace(/\s+/g, '_') === cat)
      }
      const resultados = base.sort((a, b) => Number(b.precio) - Number(a.precio)).slice(0, 5)
      if (!resultados.length) return `No encontré productos en ese presupuesto. ¿Quieres ver opciones cercanas a tu rango?`
      return resultados.map(formatProducto).join('\n\n')
    }

    case 'enviar_foto': {
      const resultado = buscarEnInventario(args.nombre_producto)[0]
      if (!resultado) return `No encontré ese producto. ¿Puedes darme más detalles?`
      await db.setUltimoProducto(psid, { nombre: resultado.nombre, imagen: resultado.imagen ?? null, ts: Date.now() })
      if (resultado.imagen) {
        await ig.sendImageMessage(psid, resultado.imagen)
        return `Aquí tienes la foto de *${resultado.nombre}* — $${Number(resultado.precio ?? 0).toLocaleString('es-CO')} 😊`
      }
      return `*${resultado.nombre}* — $${Number(resultado.precio ?? 0).toLocaleString('es-CO')}\nNo tengo foto disponible por ahora. Puedes verlo en nuestro perfil @muebles_decasa`
    }

    case 'agendar_cita': {
      await enviarNotificacionSistema(psid, userInfo, `Cita: ${args.nombre} — Sede ${args.ubicacion} — ${args.dia} ${args.hora} — ${args.motivo}`, 'cita')
      return `¡Listo! Cita agendada para *${args.nombre}*:\n📍 Sede ${args.ubicacion} | 📅 ${args.dia} a las ${args.hora}\nMotivo: ${args.motivo}\n\nNuestro equipo confirmará tu visita pronto 😊`
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

    const payload = {
      tipo,
      telefono:       psid,
      nombre_cliente: userInfo?.nombre ?? username,
      resumen,
      historial:      historial.map(m => ({ role: m.role, content: m.content })),
      whatsapp_url:   null,
      fuente:         'instagram',
      contacto_url:   contactoUrl,
    }
    const config = { headers: { 'X-Agent-Token': apiToken ?? '' }, timeout: 15000 }

    // Retry una vez si hay 429 (Render free tier sleeping)
    try {
      await axios.post(`${apiUrl}/api/redes/webhook`, payload, config)
    } catch (e) {
      if (e.response?.status === 429 || e.response?.status === 503) {
        await new Promise(r => setTimeout(r, 5000))
        await axios.post(`${apiUrl}/api/redes/webhook`, payload, config)
      } else {
        throw e
      }
    }
    console.log(`[redes] Notificación enviada — tipo: ${tipo}, psid: ${psid}`)
  } catch (e) {
    console.error('[redes] Error enviando notificación:', e.response?.status ?? e.message)
  }
}

// ── Detección de foto de cuarto ───────────────────────────────────────────────

function esVisualizacion(texto) {
  if (!texto) return false
  return /\b(sala|cuarto|habitaci[oó]n|ambiente|visualiz|pon\s+(el|la)|c[oó]mo\s+(quedar[íi]a[n]?|se\s+ver[íi]a[n]?|luce[n]?|queda[n]?)|quedar[íi]a[n]?\s+(bien|aqu[íi]|ac[aá]|en)|queda[n]?\s+(bien|aqu[íi]|ac[aá]|en\s+este|en\s+mi)|ver\s+c[oó]mo\s+queda|quiero\s+ver\s+c[oó]mo)\b/i.test(texto)
}

// ── Manejador principal de mensajes ───────────────────────────────────────────

async function handleMessage(psid, texto, adjuntos, esStoryReply, storyUrl, storyId) {
  if (enCooldown(psid)) return

  const userInfo = await ig.getUserInfo(psid)
  await db.getOrCreateClienteByPsid(psid, userInfo.username, userInfo.nombre)
  await db.actualizarInteraccion(psid)
  await ig.sendTypingOn(psid)

  // Imagen recibida — posible visualización de mueble en cuarto
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

  let mensajeAI = texto ?? ''
  let imageBase64 = null  // imagen para visión de la IA

  // Post compartido en DM — buscar producto + intentar obtener imagen del post
  if (adjuntos?.length) {
    const postCompartido = adjuntos.find(a => a.type === 'share')
    if (postCompartido) {
      console.log('[post] payload:', JSON.stringify(postCompartido.payload ?? {}))

      const caption  = postCompartido.payload?.title ?? ''
      const mediaId  = postCompartido.payload?.id
        ?? postCompartido.payload?.media_id
        ?? postCompartido.payload?.media?.id
        ?? null
      const mediaUrl = postCompartido.payload?.media?.image?.src
        ?? postCompartido.payload?.image_data?.url
        ?? postCompartido.payload?.media_url
        ?? null

      // Intentar descargar imagen del post para visión
      const urlImagen = mediaUrl ?? (mediaId ? (await ig.getMediaDetails(mediaId))?.media_url : null)
      console.log(`[post] mediaId=${mediaId} urlImagen=${urlImagen ?? 'none'}`)
      if (urlImagen) {
        try {
          const { buffer } = await ig.downloadMediaToBuffer(urlImagen)
          imageBase64 = buffer.toString('base64')
          console.log('[post] imagen descargada para visión')
        } catch (e) { console.warn('[post] no se pudo descargar imagen:', e.message) }
      }

      if (caption) {
        const resultados = buscarEnInventario(caption, null, 3)
        if (resultados.length) {
          const info = resultados.map(formatProducto).join('\n\n')
          mensajeAI = `[El cliente compartió la publicación: "${caption}". Producto en inventario:\n${info}]\n${mensajeAI || '¿Qué quieres saber sobre este producto?'}`
        } else {
          mensajeAI = `[El cliente compartió la publicación: "${caption}"]\n${mensajeAI || 'Quiero más información sobre este producto'}`
        }
      } else {
        mensajeAI = `[El cliente compartió una publicación de @muebles_decasa] ${mensajeAI || 'Quiero más información sobre esto'}`
      }
    }

    // Imagen directa que no es visualización de cuarto — pasar a visión de la IA
    const imagenes = adjuntos.filter(a => a.type === 'image')
    if (imagenes.length && !imageBase64 && !esVisualizacion(texto)) {
      try {
        const { buffer } = await ig.downloadMediaToBuffer(imagenes[0].payload.url)
        imageBase64 = buffer.toString('base64')
        if (!mensajeAI.trim()) mensajeAI = 'El cliente envió una imagen'
      } catch { /* continuar sin imagen */ }
    }

    // Video/reel compartido
    const mediaAdj = adjuntos.find(a => ['video', 'reel', 'ig_reel'].includes(a.type))
    if (mediaAdj && !mensajeAI.trim()) {
      mensajeAI = '[El cliente compartió un video/reel de @muebles_decasa] Quiero más información'
    }
  }

  // Respuesta a historia — intentar obtener caption e imagen
  if (esStoryReply) {
    let storyCtx = ''
    if (storyId) {
      const details = await ig.getMediaDetails(storyId)
      if (details?.caption) storyCtx = ` La historia decía: "${details.caption}".`
      if (details?.media_url && !imageBase64) {
        try {
          const { buffer } = await ig.downloadMediaToBuffer(details.media_url)
          imageBase64 = buffer.toString('base64')
        } catch { /* continuar sin imagen */ }
      }
    }
    const prefijo = `[El cliente respondió a una historia de @muebles_decasa.${storyCtx}]`
    mensajeAI = `${prefijo} ${mensajeAI || 'Quiero más información'}`
  }

  if (!mensajeAI.trim()) return

  await db.guardarMensaje(psid, 'user', imageBase64 ? `${mensajeAI} [+imagen]` : mensajeAI)

  try {
    const respuesta = await callGemini(psid, mensajeAI, imageBase64)

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

      const psid       = event.sender?.id
      const texto      = event.message?.text ?? null
      const adjuntos   = event.message?.attachments ?? null
      const storyReply = !!event.message?.reply_to?.story
      const storyUrl   = event.message?.reply_to?.story?.url ?? null
      const storyId    = event.message?.reply_to?.story?.id ?? null

      // Log para debug de estructura de mensaje
      console.log(`[msg] psid=${psid} texto=${texto ?? 'null'} adjuntos=${adjuntos ? JSON.stringify(adjuntos) : 'null'}`)

      if (!psid) continue

      handleMessage(psid, texto, adjuntos, storyReply, storyUrl, storyId)
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
  await db.runMigrations()
  await cargarInventario()
  setInterval(cargarInventario, 30 * 60 * 1000)

  app.listen(PORT, () => {
    console.log(`[server] Instagram Agent corriendo en puerto ${PORT}`)
  })
}

startServer().catch(e => { console.error(e); process.exit(1) })
