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

// Set de message IDs ya procesados — evita duplicados que Meta reenvía
const midsProcesados = new Set()

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

// ── Catálogos PDF desde tabla configuracion ───────────────────────────────────
let catalogosDB = {}
async function cargarCatalogos() {
  try {
    const rows = await db.getCatalogos()
    catalogosDB = {}
    for (const { clave, valor } of rows) {
      catalogosDB[clave.replace('catalogo_', '')] = valor
    }
    console.log(`[catalogos] ${Object.keys(catalogosDB).length} catálogos cargados`)
  } catch (e) {
    console.error('[catalogos] Error cargando:', e.message)
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
1. Avenida Bolívar # 16 N 26, Armenia, Quindío
2. Km 2 vía El Edén, Armenia, Quindío
3. Km 1 vía Jardines, Armenia, Quindío
4. C.C. Unicentro, Pereira, Risaralda
5. Cra. 14 #11-93, Pereira, Risaralda

CATEGORÍAS:
camas | bases_comedores | sillas_comedor | sillas_auxiliares | sillas_barra
mesas_centro | mesas_auxiliares | mesas_noche | mesas_tv
sofas | sofas_modulares | sofas_camas | cajoneros_bifes | escritorios | colchones

INSTRUCCIONES OBLIGATORIAS:
1. SIEMPRE usa buscar_productos antes de mencionar cualquier producto o precio
2. NUNCA inventes precios ni productos — solo lo que devuelva buscar_productos
3. Cuando el cliente mencione presupuesto o "barato/económico" → usa buscar_por_presupuesto
3b. Cuando el cliente pregunte "¿tienes X?", "¿hay X?", "¿tienen X?", "¿en qué tienda está?", "¿dónde lo puedo ver?", si hay disponibilidad, si pueden conseguir algo, o antes de confirmar un pedido → llama consultar_disponibilidad con el nombre exacto del producto (el mismo nombre que devolvió buscar_productos). NUNCA respondas con la lista genérica de las 5 sedes — solo menciona la(s) tienda(s) que el resultado de consultar_disponibilidad indique. Si hay stock en tienda: díselo con entusiasmo y di el nombre de la tienda específica. Si solo hay en fábrica: es una ventaja, fabricación propia. Si no hay stock: ofrece fabricarlo al mismo precio (nunca digas que no se puede conseguir).
4. Para fotos → usa enviar_foto (escribe "Te envío la foto 👇" antes de llamarla)
4b. Para catálogos → usa enviar_catalogo cuando el cliente pida ver el catálogo de una categoría o quiera explorar todas las opciones
5. Para agendar → recopila EN ORDEN: nombre completo, sede preferida, fecha (día y mes), hora (Lun-Vie 8am-5pm / Sáb 8am-12pm); el motivo es OPCIONAL — pregúntalo solo si el cliente no lo mencionó, pero si no quiere darlo llama agendar_cita sin motivo (NUNCA inventes ni inferras el motivo del contexto). Al pedir la sede SIEMPRE lista las opciones así:
"¿Cuál sede prefieres?
1️⃣ Avenida Bolívar # 16 N 26, Armenia
2️⃣ Km 2 vía El Edén, Armenia
3️⃣ Km 1 vía Jardines, Armenia
4️⃣ C.C. Unicentro, Pereira
5️⃣ Cra. 14 #11-93, Pereira"
6. Máximo 160 palabras por respuesta

VISIÓN DE IMÁGENES:
- Puedes ver imágenes cuando el cliente las comparte
- Si el cliente comparte una publicación con imagen: descríbela brevemente y responde con la info del producto que aparece en el contexto
- Si el cliente envía una foto de un mueble o producto: identifica qué es, busca en el inventario y ofrece ese producto o similares
- NUNCA digas que no puedes ver imágenes — siempre tienes capacidad de visión cuando se te envía una imagen

TÉRMINOS AMBIGUOS — pregunta ANTES de buscar:
- "sillas" → "¿Buscas sillas de comedor, sillas auxiliares (sala/decoración) o sillas de barra?"
- "mesas" → "¿Buscas mesa de centro, mesa auxiliar, mesa de noche o mesa para TV?"
- "sofá/sofas" sin más contexto → "¿Buscas sofá tradicional, modular o sofá cama?"
- "comedor" / "juego de comedor" / "conjunto comedor" → "¡Ojo importante! 😊 En DeCasa la base (mesa) de comedor y las sillas se venden por separado. ¿Buscas la base, las sillas, o te muestro ambas para que armes tu juego completo?"
No preguntes si el cliente YA especificó el tipo (ej: "sillas de comedor", "base de comedor").

CARRITO Y COMPRAS:
8. Cuando el cliente confirme querer comprar un producto → llama agregar_al_carrito (con nombre exacto y precio)
9. Para ver carrito → llama ver_carrito
10. Si el cliente dice "quita X", "ya no quiero X", "elimina X", "borra X del carrito" → llama quitar_del_carrito con el nombre del producto
11. Si quiere vaciar todo el carrito → llama quitar_del_carrito sin el campo producto
12. Para finalizar la compra → llama confirmar_pedido (solo cuando el cliente confirme explícitamente)
NUNCA llames solicitar_asesor cuando el cliente quiera comprar — usa siempre el flujo de carrito

DISPONIBILIDAD EN TIENDAS — REGLA ABSOLUTA:
- NUNCA respondas en qué tienda está disponible un producto sin llamar PRIMERO a consultar_disponibilidad
- buscar_productos NO tiene información de stock — solo da precio, material y medidas
- Si el cliente pregunta "¿tienes X?", "¿está disponible?", "¿en qué tienda está?", "¿hay unidades?", "¿lo tienen?" → llama consultar_disponibilidad antes de responder
- Menciona SOLO las tiendas que devuelva consultar_disponibilidad — NUNCA inventes o asumas en cuál tienda hay stock

ENTREGA Y VISITAS:
- DeCasa hace entregas a domicilio — el cliente NO necesita ir a la tienda para comprar
- Menciónalo proactivamente cuando el cliente muestre interés real: "te lo llevamos a tu casa 🚚, no tienes que desplazarte"
- Si el cliente dice que quiere ir a verlo ("quiero verlo", "voy a la tienda", "prefiero ir", "paso por allá") → invítalo a agendar una cita: "¡Perfecto! Para que te atendamos bien y tengamos el producto listo, agendemos tu visita 😊 ¿Cómo te llamas?" y sigue el flujo de agendar_cita
- Para preguntas sobre costo de envío, tiempo o cobertura → transfiere al asesor (no inventes valores)

CUÁNDO TRANSFERIR (llama solicitar_asesor inmediatamente):
- Pide financiación, crédito, cuotas o formas de pago
- Quiere producto a medida, color especial o personalización
- Pregunta por costo de envío, cobertura de entrega, instalación o garantía
- Lleva 2+ mensajes con la misma duda sin resolución
- Expresa frustración
El campo 'motivo' de solicitar_asesor debe ser un resumen claro en 1-2 líneas para el vendedor. Incluye siempre:
• Qué quiere el cliente: comprar en tienda / que lo fabriquen / personalizar / consultar envío / otro
• Nombre exacto del producto de interés (si lo mencionó)
• Si llamaste consultar_disponibilidad: indica el resultado (ej: "hay 2 und en Decasa Edén" o "sin stock, fabricar")
Ejemplos correctos:
- "Quiere comprar Sofá Medellín 3P. Hay 2 und en Decasa Edén. Pregunta por envío a Calarcá."
- "Quiere que le fabriquen Cama Lisboa 2P (sin stock en tiendas)."
- "Quiere personalizar Sofá Roma con tela verde y patas negras."
- "Pregunta por costo de envío para Silla Cali a Manizales."

TONO Y ESTILO DE VENTA:
Eres una vendedora cálida, entusiasta y persuasiva — como una amiga experta en decoración que quiere ayudarte a tomar la mejor decisión. No eres un catálogo de datos.

REGLAS DE ORO:
- Nunca respondas solo con datos. Siempre añade emoción, beneficio o pregunta de cierre
- Destaca beneficios concretos según el contexto: "perfecta si tienes niños o mascotas", "la madera Flor Morado no se astilla ni decolora", "puedes usarla de sofá de día y cama de noche para visitas"
- SIEMPRE cierra con una pregunta que lleve al siguiente paso: "¿Para qué espacio la tienes pensada?", "¿Quieres que te muestre más opciones en ese rango?", "¿Te agendo una visita para que la veas en persona?"
- Si el cliente vio un producto, ofrece complemento natural: sofá → mesa de centro; cama → colchón o mesa de noche; base de comedor → sillas de comedor (aclarando que se venden por separado); sillas de comedor → base de comedor
- Crea urgencia suave y honesta: "es de los más pedidos", "en la sede de Armenia la tienen en exhibición"
- Si el precio asusta, llama buscar_por_presupuesto antes de rendirte

EJEMPLO de respuesta CORRECTA (cuando el cliente pide info de un sofá):
"¡El Sofacama Roma es uno de nuestros favoritos! 😍 $3.000.000 — tela antifluido que resiste derrames y manchas (ideal si tienes mascotas o niños), y abre fácil como cama de 1.80 para cuando llegan visitas. Las patas en Flor Morado le dan ese toque elegante que encaja con casi cualquier sala.
¿La tienes pensada para sala principal o cuarto de huéspedes? Así te cuento cuál acabado te queda mejor 🙌"

EJEMPLO de respuesta INCORRECTA (demasiado seca):
"El Sofacama Roma cuesta $3.000.000, mide 1.80x0.90, tela antifluido, patas Flor Morado. ¿Deseas agendar visita?"

Emojis moderados (1-2 por respuesta). Máximo 160 palabras.

INVENTARIO ACTUAL:
${inv || 'Cargando inventario...'}`
}

const TOOLS = [
  {
    name: 'buscar_productos',
    description: 'Busca productos en el catálogo por nombre, descripción o categoría. Solo devuelve precio, material y medidas. NO incluye stock ni disponibilidad en tiendas — para eso usa consultar_disponibilidad.',
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
        dia:       { type: 'string', description: 'Fecha de la visita (ej: "martes 3 de junio")' },
        hora:      { type: 'string', description: 'Hora en formato HH:MM (dentro de horario comercial)' },
        motivo:    { type: 'string', description: 'Motivo de la visita (opcional, solo si el cliente lo menciona)' },
      },
      required: ['nombre', 'ubicacion', 'dia', 'hora'],
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
  {
    name: 'ver_carrito',
    description: 'Muestra los productos en el carrito del cliente con precios y total.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'agregar_al_carrito',
    description: 'Agrega un producto al carrito. SOLO cuando el cliente confirme explícitamente que quiere comprar ese producto.',
    parameters: {
      type: 'object',
      properties: {
        producto: { type: 'string', description: 'Nombre exacto del producto' },
        precio:   { type: 'string', description: 'Precio como texto (ej: "$3.000.000")' },
        cantidad: { type: 'number', description: 'Cantidad (default 1)' },
      },
      required: ['producto', 'precio'],
    },
  },
  {
    name: 'quitar_del_carrito',
    description: 'Quita un producto del carrito o vacía todo el carrito.',
    parameters: {
      type: 'object',
      properties: {
        producto: { type: 'string', description: 'Nombre (parcial) del producto a quitar. Omitir para vaciar todo.' },
      },
    },
  },
  {
    name: 'confirmar_pedido',
    description: 'Confirma la compra de todos los productos en el carrito. Solo cuando el cliente diga explícitamente que quiere finalizar la compra.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'enviar_catalogo',
    description: 'Envía el catálogo PDF de una categoría cuando el cliente pida ver el catálogo o quiera explorar todas las opciones de una categoría.',
    parameters: {
      type: 'object',
      properties: {
        categoria: {
          type: 'string',
          description: 'Categoría del catálogo. Valores posibles: sofas, camas, bases_comedores, mesas_auxiliares, mesas_centro, mesas_noche, mesas_tv, sillas_auxiliares, sillas_barra, sofas_camas, sofas_modulares, cajoneros_bifes',
        },
      },
      required: ['categoria'],
    },
  },
  {
    name: 'consultar_disponibilidad',
    description: 'Consulta en tiempo real si hay unidades disponibles en tiendas o fábrica para un producto. Llamar cuando el cliente pregunte si hay stock, si pueden conseguir algo, si está disponible, o antes de confirmar un pedido.',
    parameters: {
      type: 'object',
      properties: {
        nombre_producto: {
          type: 'string',
          description: 'Nombre exacto del producto tal como aparece en el inventario (ej: "Sofá Medellín 3 puestos")',
        },
      },
      required: ['nombre_producto'],
    },
  },
]

const RE_DISPONIBILIDAD = /\b(disponible|disponibles|tienes|tienen|hay|puedes\s+conseguir|conseguir|stock|en\s+qu[eé]\s+tienda|d[oó]nde\s+(lo|la)\s+puedo|d[oó]nde\s+(est[aá]|tienen|lo\s+tienen)|est[aá]\s+disponible|puedo\s+(verlo|verla|ir\s+a\s+ver)|tienen\s+en)\b/i

async function runAgentLoop(psid, mensajeUsuario, imageBase64 = null, userInfo = {}) {
  const historial = await db.getHistorial(psid, 12)

  // Pre-fetch stock cuando la pregunta es sobre disponibilidad
  let stockInyectado = ''
  if (RE_DISPONIBILIDAD.test(mensajeUsuario)) {
    try {
      const ultimoProd = await db.getUltimoProducto(psid)
      if (ultimoProd?.nombre) {
        const filas = await db.consultarStock(ultimoProd.nombre)
        if (filas.length > 0) {
          const lista = filas.map(f => `${f.tienda} (${f.cantidad_disponible} und)`).join(', ')
          stockInyectado = `\n\n⚠️ STOCK CONFIRMADO AHORA MISMO para "${ultimoProd.nombre}": HAY UNIDADES EN → ${lista}. USA ESTE DATO en tu respuesta. No llames consultar_disponibilidad de nuevo para este producto.`
        } else {
          stockInyectado = `\n\n⚠️ STOCK CONFIRMADO AHORA MISMO para "${ultimoProd.nombre}": SIN UNIDADES en tiendas físicas. Ofrece fabricarlo al mismo precio.`
        }
      }
    } catch (e) {
      console.error('[stock-prefetch]', e.message)
    }
  }

  const userContent = imageBase64
    ? [
        { type: 'text', text: mensajeUsuario },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'low' } },
      ]
    : mensajeUsuario

  const messages = [
    { role: 'system', content: buildSystemPrompt() + stockInyectado },
    ...historial.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: userContent },
  ]

  const tools = TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))

  for (let round = 0; round < 5; round++) {
    if (round > 0) await ig.sendTypingOn(psid)
    const response = await openai.chat.completions.create({
      model:       process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.8,
      max_tokens:  600,
    })

    const choice = response.choices[0]

    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
      return choice.message.content ?? ''
    }

    messages.push(choice.message)

    for (const toolCall of choice.message.tool_calls) {
      const nombre = toolCall.function.name
      let args
      try { args = JSON.parse(toolCall.function.arguments) } catch { args = {} }
      const result = await ejecutarTool(psid, nombre, args, userInfo)
      messages.push({
        role:         'tool',
        tool_call_id: toolCall.id,
        content:      String(result ?? 'OK'),
      })
    }
  }

  return 'Tuve un problema procesando tu solicitud. Un asesor te contactará pronto 🙏'
}

// ── Herramientas ──────────────────────────────────────────────────────────────

function normalize(str) {
  return (str ?? '').toLowerCase()
    .replace(/[aáàäâ]/g, 'a').replace(/[eéèëê]/g, 'e')
    .replace(/[iíìïî]/g, 'i').replace(/[oóòöô]/g, 'o')
    .replace(/[uúùüû]/g, 'u').replace(/[ñ]/g, 'n')
    .trim()
}

function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) => [i])
  for (let j = 1; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

function fuzzyWord(word, targetWords) {
  const maxDist = word.length <= 5 ? 1 : 2
  return targetWords.some(w => w.length > 2 && levenshtein(word, w) <= maxDist)
}

function buscarEnInventario(consulta, categoria = null, limite = 5) {
  const q = normalize(consulta)
  let base = inventario
  if (categoria) {
    const cat = normalize(categoria).replace(/\s+/g, '_')
    base = inventario.filter(p => normalize(p.subcategoria).replace(/\s+/g, '_') === cat)
  }
  return base
    .map(p => ({ ...p, score: scoring(p, q) }))
    .filter(p => p.score >= 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limite, 10))
}

function scoring(p, q) {
  const nombre      = normalize(p.nombre)
  const sub         = normalize(p.subcategoria)
  const nombreWords = nombre.split(/\s+/)
  const subWords    = sub.split(/\s+/)
  let score = 0
  if (nombre === q)       score += 100
  if (nombre.includes(q)) score += 60
  if (sub.includes(q))    score += 40
  q.split(/\s+/).forEach(w => {
    if (w.length <= 2) return
    if (nombreWords.includes(w))        score += 20
    else if (fuzzyWord(w, nombreWords)) score += 12
    if (subWords.includes(w))           score += 10
    else if (fuzzyWord(w, subWords))    score += 6
  })
  return score
}

function formatProducto(p) {
  return `*${p.nombre}*\nPrecio: $${Number(p.precio ?? 0).toLocaleString('es-CO')}\nMedidas: ${p.medidas ?? 'consultar'}\nMaterial: ${p.material ?? 'Madera Flor Morado'}`
}

function parsearPrecio(p) {
  if (typeof p === 'number') return p
  return parseInt(String(p).replace(/[^0-9]/g, '')) || 0
}

async function getCarrito(psid) {
  const estado = await db.getEstado(psid)
  if (!estado?.carrito) return []
  try { return JSON.parse(estado.carrito) } catch { return [] }
}

async function setCarrito(psid, carrito) {
  await db.setEstado(psid, { carrito: JSON.stringify(carrito) })
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
        const cat = normalize(args.categoria).replace(/\s+/g, '_')
        base = base.filter(p => normalize(p.subcategoria).replace(/\s+/g, '_') === cat)
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
        return `[Foto de ${resultado.nombre} enviada — $${Number(resultado.precio ?? 0).toLocaleString('es-CO')}. Haz seguimiento de venta]`
      }
      return `[${resultado.nombre} — $${Number(resultado.precio ?? 0).toLocaleString('es-CO')} — sin foto disponible. Sugiere al cliente visitar el perfil @muebles_decasa]`
    }

    case 'agendar_cita': {
      const sedeNombre = SEDE_NOMBRE[args.ubicacion] ?? `Sede ${args.ubicacion}`
      const tiendaId   = SEDE_TIENDA_ID[args.ubicacion] ?? null
      const motivo     = args.motivo || null
      const datosCita  = { nombre: args.nombre, ubicacion: args.ubicacion, sede_nombre: sedeNombre, dia: args.dia, hora: args.hora, motivo }
      await enviarNotificacionSistema(
        psid, userInfo,
        `Cita: ${args.nombre} — ${sedeNombre} — ${args.dia} ${args.hora}${motivo ? ` — ${motivo}` : ''}`,
        'cita',
        { datos_cita: datosCita, tienda_id: tiendaId }
      )
      const lineaMotivo = motivo ? `\nMotivo: ${motivo}` : ''
      return `¡Listo! Tu cita quedó agendada ✅\n\n👤 *${args.nombre}*\n📍 ${sedeNombre}\n📅 ${args.dia} a las ${args.hora}${lineaMotivo}\n\nNuestro equipo te confirmará la visita pronto 😊\n\n¿Hay algo más en lo que pueda ayudarte?`
    }

    case 'enviar_catalogo': {
      const cat = normalize(args.categoria ?? '').replace(/\s+/g, '_')
      let url = catalogosDB[cat]
      if (!url) {
        // Buscar primero coincidencia exacta de prefijo, luego substring
        const entrada = Object.entries(catalogosDB).find(([k]) => k === cat)
          ?? Object.entries(catalogosDB).find(([k]) => k.startsWith(cat) || cat.startsWith(k))
        url = entrada?.[1]
      }
      if (!url) return `No tengo catálogo disponible para esa categoría en este momento. Puedo mostrarte productos específicos si me dices qué buscas 😊`
      await ig.sendTextMessage(psid, `Aquí tienes el catálogo completo 📖 — toca el enlace para verlo:\n${url}`)
      return `[Catálogo de ${cat} enviado exitosamente. El cliente ya recibió el enlace — haz seguimiento con una pregunta de cierre]`
    }

    case 'solicitar_asesor': {
      // Adjuntar contexto del estado aunque Elena no lo haya incluido en motivo
      const ultimoProdIG = await db.getUltimoProducto(psid)
      const carritoIG    = await getCarrito(psid)
      let motivoFinal = args.motivo || 'Solicitud de asesor'
      if (ultimoProdIG?.nombre && !motivoFinal.includes(ultimoProdIG.nombre)) {
        motivoFinal += `\nÚltimo producto visto: ${ultimoProdIG.nombre}`
      }
      if (carritoIG.length > 0 && !motivoFinal.toLowerCase().includes('carrito')) {
        const resumenCarritoIG = carritoIG.map(i => `${i.producto} ×${i.cantidad || 1}`).join(', ')
        motivoFinal += `\nCarrito: ${resumenCarritoIG}`
      }
      await enviarNotificacionSistema(psid, userInfo, motivoFinal, args.tipo, { carrito: carritoIG.length ? carritoIG : undefined })
      const aviso = avisoHorarioTarde()
      return `Entendido, voy a conectarte con uno de nuestros asesores 😊${aviso ? `\n\n${aviso}` : ''}`
    }

    case 'ver_carrito': {
      const items = await getCarrito(psid)
      if (!items.length) return 'Tu carrito está vacío 🛒 ¿Te gustaría ver algún producto? 😊'
      const total = items.reduce((s, i) => s + parsearPrecio(i.precio) * (i.cantidad || 1), 0)
      const lista = items.map((i, idx) =>
        `${idx + 1}. *${i.producto}* — $${parsearPrecio(i.precio).toLocaleString('es-CO')} × ${i.cantidad || 1}`
      ).join('\n')
      // Notificar al sistema de ventas cuando hay carrito activo (cliente listo para decidir)
      enviarNotificacionSistema(
        psid, userInfo,
        `Carrito activo:\n${lista}\nTotal: $${total.toLocaleString('es-CO')}`,
        'asesor',
        { carrito: items }
      ).catch(() => {})
      return `🛍️ *Tu carrito:*\n${lista}\n\n*Total: $${total.toLocaleString('es-CO')}*\n\n¿Confirmamos la compra o quieres seguir viendo productos?`
    }

    case 'agregar_al_carrito': {
      const carrito = await getCarrito(psid)
      if (carrito.length >= 10) return 'Tu carrito está lleno (máximo 10 productos). Confirma la compra o elimina algo primero.'
      const ya = carrito.find(i => i.producto.toLowerCase() === (args.producto ?? '').toLowerCase())
      if (ya) {
        // Actualizar cantidad si se especificó una diferente
        const nuevaCantidad = args.cantidad ?? ya.cantidad ?? 1
        ya.cantidad = nuevaCantidad
        await setCarrito(psid, carrito)
        const total = carrito.reduce((s, i) => s + parsearPrecio(i.precio) * (i.cantidad || 1), 0)
        return `Actualicé *${args.producto}* a ${nuevaCantidad} unidad${nuevaCantidad > 1 ? 'es' : ''} en tu carrito 🛍️\nTotal: *$${total.toLocaleString('es-CO')}*\n\n¿Agregamos algo más o confirmamos el pedido?`
      }
      carrito.push({ producto: args.producto, precio: args.precio, cantidad: args.cantidad ?? 1 })
      await setCarrito(psid, carrito)
      const total = carrito.reduce((s, i) => s + parsearPrecio(i.precio) * (i.cantidad || 1), 0)
      return `¡Listo! 🛍️ *${args.producto}* agregado al carrito.\nTotal: *$${total.toLocaleString('es-CO')}* (${carrito.length} producto${carrito.length > 1 ? 's' : ''})\n\n¿Agregamos algo más o confirmamos el pedido?`
    }

    case 'quitar_del_carrito': {
      const carrito = await getCarrito(psid)
      if (!args.producto) {
        await setCarrito(psid, [])
        return 'Carrito vaciado 🗑️ ¿Te puedo ayudar a buscar algo? 😊'
      }
      const busqueda = args.producto.toLowerCase().substring(0, 15)
      const filtrado = carrito.filter(i => !i.producto.toLowerCase().includes(busqueda))
      if (filtrado.length === carrito.length) return `No encontré *${args.producto}* en tu carrito. Escribe "ver carrito" para ver lo que tienes 😊`
      await setCarrito(psid, filtrado)
      return `Listo, eliminé *${args.producto}* del carrito. ${filtrado.length ? `Te quedan ${filtrado.length} producto(s).` : 'Tu carrito está vacío ahora.'} ¿Puedo ayudarte con algo más?`
    }

    case 'confirmar_pedido': {
      const carrito = await getCarrito(psid)
      if (!carrito.length) return 'Tu carrito está vacío 🛒 Agrega productos primero 😊'
      const total = carrito.reduce((s, i) => s + parsearPrecio(i.precio) * (i.cantidad || 1), 0)
      const resumen = carrito.map((i, idx) =>
        `${idx + 1}. ${i.producto} × ${i.cantidad || 1} — $${parsearPrecio(i.precio).toLocaleString('es-CO')}`
      ).join('\n')
      // Fire-and-forget: no bloquear el flujo esperando la notificación (puede tardar 56s en retry)
      enviarNotificacionSistema(
        psid, userInfo,
        `PEDIDO CONFIRMADO:\n${resumen}\nTotal: $${total.toLocaleString('es-CO')}`,
        'pedido',
        { carrito }
      ).catch(e => console.error('[redes] Error notificación pedido IG:', e.message))
      await setCarrito(psid, [])
      await ig.sendTextMessage(psid,
        `¡Pedido confirmado! 🎉\n\n${resumen}\n\n*Total: $${total.toLocaleString('es-CO')}*\n\nUn asesor de DeCasa te contactará pronto para coordinar el pago y la entrega. ¡Gracias por elegir DeCasa! 😊`
      )
      return `[Confirmación de pedido enviada al cliente con el resumen completo. Solo despídete con una frase corta, sin repetir el resumen.]`
    }

    case 'consultar_disponibilidad': {
      const { nombre_producto } = args
      const filas = await db.consultarStock(nombre_producto)
      if (filas.length === 0) {
        return { disponible: false, tiendas: [], mensaje: 'No hay unidades en exhibición ahora, pero DeCasa puede fabricarlo al mismo precio.' }
      }
      // Tratar todas las tiendas igual: Bolívar es fábrica internamente pero también es tienda física
      const tiendas = filas.map(f => `${f.tienda} (${f.cantidad_disponible} und)`)
      return {
        disponible: true,
        tiendas,
        mensaje: `Hay unidades disponibles en: ${tiendas.join(', ')}.`
      }
    }

    default:
      return null
  }
}

// ── Notificación al sistema de ventas ─────────────────────────────────────────

// Mapeo sede (1-5) → tienda_id en la BD (mismo orden que el seeder)
const SEDE_TIENDA_ID = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }
const SEDE_NOMBRE    = {
  1: 'Decasa Bolívar — Av. Bolívar # 16 N 26, Armenia',
  2: 'Decasa Vía El Edén — Km 2 vía El Edén, Armenia',
  3: 'Decasa Vía Jardines — Km 1 vía Jardines, Armenia',
  4: 'Decasa Unicentro — C.C. Unicentro, Pereira',
  5: 'Decasa Circunvalar — Cra. 14 #11-93, Pereira',
}

async function enviarNotificacionSistema(psid, userInfo, resumen, tipo = 'asesor', extra = {}) {
  const apiUrl   = process.env.DECASA_API_URL
  const apiToken = process.env.DECASA_AGENT_TOKEN
  if (!apiUrl) { console.warn('[redes] DECASA_API_URL no configurado'); return }

  const titulos = {
    asesor:          'Solicitud de asesor (Instagram)',
    pedido:          'Nuevo pedido confirmado (Instagram)',
    cita:            'Nueva cita agendada (Instagram)',
    personalizacion: 'Solicitud de personalización (Instagram)',
  }

  const username    = userInfo?.username ?? psid
  // La API usa whatsapp_url para el botón de contacto en Telegram — usamos el link de Instagram DM
  const contactoUrl = userInfo?.username ? `https://ig.me/m/${userInfo.username}` : `https://ig.me/direct/t/${psid}`
  const resumenFinal = `${titulos[tipo] ?? 'Notificación Instagram'}\n${resumen ?? ''}`

  try {
    const historial = await db.getHistorial(psid, 6)

    const payload = {
      tipo,
      telefono:       `ig_${psid}`,
      nombre_cliente: userInfo?.nombre ?? username,
      resumen:        resumenFinal,
      historial:      historial.slice(-8).map(m => ({ role: m.role, content: String(m.content).substring(0, 150) })),
      whatsapp_url:   contactoUrl,
      fuente:         'instagram',
      contacto_url:   contactoUrl,
      ...(extra.carrito    && { carrito:    extra.carrito }),
      ...(extra.datos_cita && { datos_cita: extra.datos_cita }),
      ...(extra.tienda_id  && { tienda_id:  extra.tienda_id }),
    }
    const config = {
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': apiToken ?? '' },
      timeout: 25000,
    }

    const intentar = () => axios.post(`${apiUrl}/api/redes/webhook`, payload, config)
    try {
      await intentar()
    } catch (e) {
      const reintentable = e.response?.status === 429 || e.response?.status === 503
        || e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' || !e.response
      if (reintentable) {
        await new Promise(r => setTimeout(r, 6000))
        await intentar()
      } else {
        throw e
      }
    }
    console.log(`[redes] Notificación enviada — tipo: ${tipo}, psid: ${psid}`)
  } catch (e) {
    console.error('[redes] Error enviando notificación:', e.response?.status ?? e.message)
  }
}

function avisoHorarioTarde() {
  const h = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }))
  return (h >= 21 || h < 8)
    ? '⚠️ Ten en cuenta que ya es tarde — puede que el asesor te responda mañana, pero haremos nuestro mejor esfuerzo por atenderte. ¡Gracias por tu paciencia! 🙏'
    : null
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

  // Post compartido en DM (type: ig_post) — buscar producto + descargar imagen
  if (adjuntos?.length) {
    const postCompartido = adjuntos.find(a => a.type === 'ig_post' || a.type === 'share')
    if (postCompartido) {
      const caption  = postCompartido.payload?.title ?? ''
      const urlImagen = postCompartido.payload?.url ?? null  // CDN URL directa

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

    // Video/reel compartido — leer caption para identificar el producto
    const mediaAdj = adjuntos.find(a => ['video', 'reel', 'ig_reel'].includes(a.type))
    if (mediaAdj) {
      const captionReel = mediaAdj.payload?.title ?? mediaAdj.payload?.caption ?? ''
      if (captionReel) {
        const resultados = buscarEnInventario(captionReel, null, 3)
        if (resultados.length) {
          const info = resultados.map(formatProducto).join('\n\n')
          mensajeAI = `[El cliente compartió un reel de @muebles_decasa: "${captionReel}". Producto en inventario:\n${info}]\n${mensajeAI || '¿Cuánto vale?'}`
        } else {
          mensajeAI = `[El cliente compartió un reel de @muebles_decasa: "${captionReel}"]\n${mensajeAI || '¿Cuánto vale o cómo consigo este mueble?'}`
        }
      } else if (!mensajeAI.trim()) {
        mensajeAI = '[El cliente compartió un video/reel de @muebles_decasa] Quiero más información'
      }
    }

    // Audio recibido — transcribir con Whisper
    const audioAdj = adjuntos.find(a => a.type === 'audio')
    if (audioAdj?.payload?.url) {
      try {
        const { toFile } = require('openai')
        const { buffer, contentType } = await ig.downloadMediaToBuffer(audioAdj.payload.url)
        const mimeClean = (contentType || 'audio/mp4').split(';')[0]
        const ext = mimeClean.split('/')[1] || 'mp4'
        const audioFile = await toFile(buffer, `audio.${ext}`, { type: mimeClean })
        const transcripcion = await openai.audio.transcriptions.create({
          model: 'whisper-1',
          file: audioFile,
          language: 'es',
        })
        const textoTranscrito = transcripcion.text?.trim()
        if (textoTranscrito) {
          mensajeAI = textoTranscrito
          console.log(`[AUDIO→TEXTO] ${psid}: ${textoTranscrito}`)
        } else if (!mensajeAI.trim()) {
          await ig.sendTextMessage(psid, 'No pude entender el audio. ¿Podrías escribir tu consulta? 😊')
          return
        }
      } catch (e) {
        console.warn('[AUDIO] Error transcribiendo:', e.message)
        if (!mensajeAI.trim()) {
          await ig.sendTextMessage(psid, 'No pude procesar el audio. ¿Puedes escribir tu consulta? 😊')
          return
        }
      }
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

  // Detectar primer mensaje ANTES de guardar para que el historial esté vacío
  const histPrev       = await db.getHistorial(psid, 1)
  const esPrimerMensaje = histPrev.length === 0

  try {
    const SALUDO_IG = '¡Hola! 😊 Soy Elena, tu asesora de DeCasa. ¿Estás buscando algún mueble o necesitas asesoría? 🛋️'
    const esSoloSaludo = /^[¡!¿?\s]*(hola|holis|holi|holaa|buenas?|buenos\s*(dias?|tardes?|noches?)|que\s*tal|hi|hello|hey|saludos)[¡!¿?\s.]*$/i.test(mensajeAI.trim())

    if (esPrimerMensaje && esSoloSaludo) {
      // Solo saludo inicial: responder con el hardcodeado y no llamar a OpenAI
      await ig.sendTextMessage(psid, SALUDO_IG)
      await db.guardarMensaje(psid, 'user', mensajeAI)
      await db.guardarMensaje(psid, 'assistant', SALUDO_IG)
      return
    }

    // runAgentLoop lee el historial y le anexa el mensaje actual; guardamos el
    // mensaje del usuario DESPUÉS para no inyectarlo dos veces en el contexto.
    const respuestaFinal = await runAgentLoop(psid, mensajeAI, imageBase64, userInfo)
    await db.guardarMensaje(psid, 'user', imageBase64 ? `${mensajeAI} [+imagen]` : mensajeAI)
    if (respuestaFinal) {
      await ig.sendTextMessage(psid, respuestaFinal)
      await db.guardarMensaje(psid, 'assistant', respuestaFinal)
    }
  } catch (e) {
    console.error('[AI] Error:', e.message)
    await db.guardarMensaje(psid, 'user', imageBase64 ? `${mensajeAI} [+imagen]` : mensajeAI)
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

      if (!psid) continue

      // Deduplicar: Meta a veces reenvía el mismo evento varias veces
      const mid = event.message?.mid
      if (mid) {
        if (midsProcesados.has(mid)) { console.log(`[webhook] mid duplicado ignorado: ${mid}`); continue }
        midsProcesados.add(mid)
        setTimeout(() => midsProcesados.delete(mid), 5 * 60 * 1000)
      }

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

// ── Debug stock (temporal) ────────────────────────────────────────────────────
app.get('/debug-stock', async (req, res) => {
  const nombre = req.query.nombre ?? 'BASE 2K'
  try {
    const filas = await db.consultarStock(nombre)
    res.json({ nombre, filas, inventario_cargado: inventario.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

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
  await cargarCatalogos()
  setInterval(cargarInventario, 30 * 60 * 1000)
  setInterval(cargarCatalogos, 30 * 60 * 1000)

  // Limpiar historial antiguo al arrancar y luego cada 24 horas
  db.limpiarHistorialAntiguo(90).catch(e => console.error('[db] limpieza error:', e.message))
  setInterval(() => {
    db.limpiarHistorialAntiguo(90).catch(e => console.error('[db] limpieza error:', e.message))
  }, 24 * 60 * 60 * 1000)

  app.listen(PORT, () => {
    console.log(`[server] Instagram Agent corriendo en puerto ${PORT}`)
  })
}

startServer().catch(e => { console.error(e); process.exit(1) })
