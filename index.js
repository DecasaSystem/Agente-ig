'use strict'
require('dotenv').config()

const express    = require('express')
const crypto     = require('crypto')
const axios      = require('axios')
const OpenAI = require('openai')

const { alertar } = require('./alertas')

// Sin esto, una promesa rechazada sin manejar tumba el proceso en silencio y el bot
// queda mudo hasta que alguien lo note.
process.on('uncaughtException',  err => alertar('ERROR CRÍTICO NO CAPTURADO', err?.stack ?? err))
process.on('unhandledRejection', err => alertar('PROMESA RECHAZADA', err?.stack ?? err))

const ig      = require('./instagram')
const db      = require('./db')
const imgP    = require('./image-processor')
const imgHash = require('./image-hash')
const fechas  = require('./fechas')
const reintentos = require('./reintentos')
const negocio = require('./negocio')
const { construirSystemPrompt } = require('./prompt')
const vigilancia = require('./vigilancia')
const seguimientos = require('./seguimientos')
const memoria = require('./memoria')
const { conReintentos } = reintentos
const visionCatalogo = require('./vision-catalogo')

const app  = express()
const PORT = process.env.PORT ?? 3001

// Registro de eventos para métricas, fire-and-forget: nunca debe romper el flujo ni
// hacer esperar al cliente.
function evento(psid, tipo, detalle) {
  db.registrarEvento(psid, tipo, detalle).catch(e => console.error('[metricas] evento falló:', e.message))
}

// ── Raw body para validar firma Meta ─────────────────────────────────────────
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf }
}))

// ── Inventario en memoria ─────────────────────────────────────────────────────
let inventario = []
let preciosInventario = new Set() // todos los precios reales, para validar la salida
async function cargarInventario() {
  try {
    inventario = await db.getInventario()
    // Los precios de las variantes también son válidos: sin esto, en cuanto Elena diera
    // el precio correcto de una medida concreta saltaría la alerta de precio inventado,
    // porque ese importe no existe como precio_base de ningún producto.
    preciosInventario = new Set(
      inventario.flatMap(p => [Number(p.precio ?? 0), ...(p.variantes ?? []).map(v => Number(v.precio ?? 0))])
                .filter(Boolean)
    )
    console.log(`[inventario] ${inventario.length} productos cargados`)
  } catch (e) {
    console.error('[inventario] Error cargando:', e.message)
  }
}

// Extrae montos en pesos de un texto: "$3.380.000", "3.380.000", "$780000"...
// Solo considera valores >= 10.000 para no confundir medidas ("1.80") ni cantidades.
function extraerPrecios(texto) {
  const nums = []
  const re = /\$?\s*(\d{1,3}(?:[.,]\d{3})+|\d{5,})/g
  let m
  while ((m = re.exec(texto ?? '')) !== null) {
    const n = parseInt(m[1].replace(/[.,]/g, ''))
    if (n >= 10000) nums.push(n)
  }
  return nums
}

// Monitorea precios inventados: cualquier precio en la respuesta que no exista en el
// inventario ni haya salido de una herramienta en este turno (p.ej. total de carrito)
// es sospechoso. No se bloquea el mensaje (evita romper la conversación por un falso
// positivo), pero se alerta para poder corregir el prompt si Elena empieza a inventar.
function validarPrecios(psid, texto, preciosVistos) {
  const sospechosos = extraerPrecios(texto).filter(
    n => !preciosInventario.has(n) && !preciosVistos.has(n)
  )
  if (sospechosos.length) {
    alertar('Posible precio inventado por Elena', `psid=${psid} precios=${sospechosos.join(', ')} | msg="${String(texto).substring(0, 160)}"`)
  }
  return sospechosos // devuelto para poder testearlo; el caller no necesita usarlo
}

// Precios válidos conocidos, inyectable para tests (en producción lo llena cargarInventario).
function setPreciosInventarioParaPruebas(nums) {
  preciosInventario = new Set(nums)
}

// ── Hash de imágenes de catálogo (para identificar fotos reenviadas/capturadas) ─
let hashesCatalogo = new Map() // nombre -> { hash, imagen }
async function sincronizarHashesCatalogo() {
  try {
    const existentes = await db.getHashesProductos()
    hashesCatalogo = new Map(existentes.map(r => [r.producto_nombre, { hash: r.hash, imagen: r.imagen_url }]))

    // Solo se procesan productos nuevos o cuya foto cambió — evita redescargar
    // todo el catálogo en cada refresco de inventario (cada 30 min). Además se
    // limita cuántos se procesan por ciclo: en un servidor con poca RAM (Render
    // 512Mi), la primera sincronización con un catálogo grande (cientos de fotos)
    // no debe intentar bajarlas todas de un tirón — el resto se completa en los
    // siguientes ciclos de 30 min.
    const LOTE_MAX = 60
    const todosPendientes = inventario.filter(p => p.imagen && hashesCatalogo.get(p.nombre)?.imagen !== p.imagen)
    const pendientes = todosPendientes.slice(0, LOTE_MAX)
    for (const p of pendientes) {
      try {
        const hash = await imgHash.hashDesdeUrl(p.imagen)
        await db.upsertHashProducto(p.nombre, p.imagen, hash)
        hashesCatalogo.set(p.nombre, { hash, imagen: p.imagen })
      } catch (e) {
        console.warn(`[hash-imagen] no se pudo procesar "${p.nombre}":`, e.message)
      }
      await new Promise(r => setTimeout(r, 150))
    }
    if (pendientes.length) {
      console.log(`[hash-imagen] ${pendientes.length} fotos de catálogo indexadas${todosPendientes.length > LOTE_MAX ? ` (${todosPendientes.length - LOTE_MAX} quedan para el próximo ciclo)` : ''}`)
    }
  } catch (e) {
    console.error('[hash-imagen] Error sincronizando:', e.message)
  }
}

// Nombres legibles de las categorías del catálogo, para el clasificador de imágenes.
// Nombres legibles de las categorías, desde negocio.json (categorias).
const NOMBRES_CATEGORIA = negocio.CATEGORIAS

// Identificación visual por categoría (vision-catalogo.js): clasifica el mueble de la
// foto y lo compara con las fotos de los productos de ESA categoría. Devuelve el bloque
// de contexto para el modelo, o null si no aportó nada (sin inventario, error de red…).
// Nunca rompe el flujo: si falla, la foto sigue su camino al modelo como antes.
async function identificarImagenPorCategoria(psid, imagen) {
  if (!inventario.length) return null
  const claves = [...new Set(inventario.map(p => p.subcategoria).filter(Boolean))]
  const categorias = claves.map(clave => ({ clave, nombre: NOMBRES_CATEGORIA[clave] ?? clave }))
  const inventarioPlano = inventario.map(p => ({
    nombre: p.nombre, imagen: p.imagen || null, medidas: p.medidas || '', material: p.material || '',
    precio: p.precio, categoria: p.subcategoria, variantes: p.variantes,
  }))

  try {
    const resultado = await visionCatalogo.identificarPorVision(openai, imagen, {
      inventarioPlano,
      categorias,
      resolverPorNombre: texto => buscarProductoExacto(texto),
    })
    if (!resultado) return null
    console.log(`[vision-catalogo] ${psid}: ${resultado.tipo} · cat=${resultado.clasificacion.categorias.join(',') || '-'} · top=${resultado.coincidencias.map(c => `${c.nombre}(${c.similitud})`).join(', ') || '-'} · tokens ${resultado.tokens.entrada}/${resultado.tokens.salida}`)
    evento(psid, 'vision_catalogo', `${resultado.tipo}: ${resultado.producto?.nombre ?? resultado.coincidencias[0]?.nombre ?? resultado.clasificacion.categorias.join(',') ?? '-'}`)
    // formatProducto espera el producto con el formato del inventario de IG (precio
    // numérico y variantes): se busca por nombre para no perder esos campos.
    const formatear = p => formatProducto(inventario.find(x => x.nombre === p.nombre) ?? p)
    return visionCatalogo.construirContextoVision(resultado, formatear)
  } catch (e) {
    console.warn('[vision-catalogo] no se pudo identificar la imagen:', e.message)
    return null
  }
}

// Compara una imagen entrante contra el catálogo indexado y devuelve el nombre
// del producto si hay coincidencia confiable (misma foto, reescalada/recomprimida/
// recortada en un screenshot), o null si no hay match.
async function identificarProductoPorImagen(buffer) {
  if (!hashesCatalogo.size) return null
  try {
    const hashesEntrada = await imgHash.hashesCandidatos(buffer)
    const catalogoArr   = [...hashesCatalogo.entries()].map(([nombre, v]) => [nombre, v.hash])
    const match = imgHash.mejorCoincidencia(hashesEntrada, catalogoArr)
    return match?.nombre ?? null
  } catch (e) {
    console.warn('[hash-imagen] no se pudo comparar imagen entrante:', e.message)
    return null
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

// ── Buffer de ráfagas + cola serializada por PSID ─────────────────────────────
// En Instagram la gente manda varias cosas seguidas ("Hola" / "quiero una cama" / "de
// 2 metros", o comparte una publicación y luego escribe "Precio?"). Se agrupa TODA la
// ráfaga (texto + adjunto + respuesta a historia) en un solo turno con un debounce, y
// se procesa una sola vez → una sola respuesta. Además el procesamiento de un mismo
// PSID se serializa, para que no corran dos runAgentLoop en paralelo con escrituras de
// historial intercaladas.
const DEBOUNCE_MS = 2800
const buffers = new Map() // psid -> { textos, adjuntos, esStory, storyUrl, storyId, timer }
const colas   = new Map() // psid -> Promise (cadena de ejecución serializada)

// Encadena la tarea después de la última del mismo PSID (mutex por cliente).
// La cadena que se guarda va siempre "silenciada": si una tarea falla, la siguiente
// debe correr igual y el rechazo no puede quedar sin manejar — la promesa derivada del
// .finally() no tenía manejador de error, así que una tarea que rechazara provocaba un
// unhandledRejection y tumbaba el proceso entero, con él las conversaciones de todos
// los clientes. Hoy no se dispara porque quien llama envuelve la tarea en un .catch,
// pero eso deja el fallo a un descuido de distancia.
function encolar(psid, tarea) {
  const anterior = colas.get(psid) ?? Promise.resolve()
  const cadena   = anterior.then(tarea, tarea).catch(e => {
    console.error(`[cola] tarea de ${psid} falló:`, e?.message ?? e)
  })
  colas.set(psid, cadena)
  cadena.finally(() => { if (colas.get(psid) === cadena) colas.delete(psid) })
  return cadena
}

const correr = (psid, ...args) =>
  handleMessage(psid, ...args).catch(e => alertar('handleMessage falló', `psid=${psid} ${e.message}`))

// Punto de entrada desde el webhook. Acumula todo lo que llegue en la ventana de
// debounce y lo procesa como un solo turno.
function recibirMensaje(psid, texto, adjuntos, esStoryReply, storyUrl, storyId, noSoportado = false) {
  let buf = buffers.get(psid)
  if (!buf) {
    buf = { textos: [], adjuntos: null, esStory: false, storyUrl: null, storyId: null, noSoportado: false, timer: null }
    buffers.set(psid, buf)
  }

  if (texto) buf.textos.push(texto)
  // Si en la ráfaga llega más de un adjunto, se queda con el último (caso raro; lo
  // normal es una sola imagen o publicación por turno).
  if (adjuntos?.length) buf.adjuntos = adjuntos
  if (esStoryReply) { buf.esStory = true; buf.storyUrl = storyUrl; buf.storyId = storyId }
  if (noSoportado) buf.noSoportado = true

  if (buf.timer) clearTimeout(buf.timer)
  buf.timer = setTimeout(() => {
    buffers.delete(psid)
    encolar(psid, () => correr(
      psid,
      buf.textos.join('\n') || null,
      buf.adjuntos,
      buf.esStory,
      buf.storyUrl,
      buf.storyId,
      buf.noSoportado,
    ))
  }, DEBOUNCE_MS)
}

// Menú de respuestas rápidas que acompaña al saludo inicial.
const QUICK_MENU = [
  { title: 'Ver catálogo 📖',    payload: 'MENU::CATALOGO' },
  { title: 'Agendar visita 📅',  payload: 'MENU::AGENDAR' },
  { title: 'Hablar con asesor 💬', payload: 'MENU::ASESOR' },
]

// Traduce el payload de un quick reply / botón de carrusel a un mensaje de cliente,
// para que el flujo siga igual que si lo hubiera escrito a mano.
function payloadAIntent(payload) {
  if (!payload) return null
  if (payload.startsWith('INTERESA::')) {
    return `Me interesa el ${payload.slice('INTERESA::'.length)}, cuéntame más 😊`
  }
  switch (payload) {
    case 'MENU::CATALOGO': return 'Quiero ver el catálogo'
    case 'MENU::AGENDAR':  return 'Quiero agendar una visita'
    case 'MENU::ASESOR':   return 'Quiero hablar con un asesor'
    default:               return null
  }
}

// Caché de getUserInfo por PSID: nombre y username no cambian entre mensajes, y antes
// se pedía a Graph API en CADA mensaje (una llamada extra incluso con el bot callado).
const userInfoCache = new Map()
const USER_INFO_TTL = 6 * 60 * 60 * 1000 // 6 h
async function getUserInfoCache(psid) {
  const cached = userInfoCache.get(psid)
  if (cached && Date.now() - cached.ts < USER_INFO_TTL) return cached.data
  const data = await ig.getUserInfo(psid)
  userInfoCache.set(psid, { data, ts: Date.now() })
  return data
}

// Aviso automático que envía la IA mientras el cliente está con un asesor. Se usa como
// constante para poder distinguirlo del texto que escribe el asesor (y no guardarlo
// como contexto ni contarlo como mensaje del asesor).
const AVISO_ESPERA = 'Tu mensaje fue recibido, un asesor te responderá pronto 😊'

// Red de seguridad extra contra el bucle del aviso "tu mensaje fue recibido": aunque
// ya se filtran los ecos arriba, si algo se cuela igual (otro caso no previsto de
// Meta) esto evita que se repita en ráfaga — como mucho una vez cada 2 minutos por
// cliente mientras sigue transferido.
const avisosEsperaEnviados = new Map()
function debeEnviarAvisoEspera(psid) {
  const last = avisosEsperaEnviados.get(psid) ?? 0
  if (Date.now() - last < 2 * 60 * 1000) return false
  avisosEsperaEnviados.set(psid, Date.now())
  return true
}

// Cuenta imágenes/capturas seguidas que la IA no logró identificar, por cliente (se resetea al reiniciar el servidor)
const capturasNoIdentificadas = new Map()

// ── Detección de un asesor humano en la conversación ──────────────────────────
//
// Instagram devuelve como "eco" TODO lo que sale de la cuenta del negocio: tanto lo que
// envía la IA como lo que escribe una persona desde el Instagram de la empresa. Para
// callar a la IA en cuanto entra un humano hay que distinguir unos de otros, y lo único
// que los diferencia es el contenido: si el texto no es uno de los que la IA acaba de
// enviar, lo escribió alguien.
//
// Antes esto no se hacía: el silencio dependía de que un asesor pulsara "Tomar" en el
// panel. Si entraba a escribir sin tocar el panel, la IA seguía contestando y el cliente
// recibía dos respuestas a la vez.
const _enviadoPorIA = new Map() // psid -> [{ texto, ts }]
const VENTANA_ECO_MS = 10 * 60 * 1000
const MAX_ENVIADOS_RECORDADOS = 30

function normalizarEco(texto) {
  return String(texto ?? '').replace(/\s+/g, ' ').trim()
}

function registrarEnviadoPorIA(psid, texto) {
  const t = normalizarEco(texto)
  if (!t) return
  const ahora = Date.now()
  const lista = (_enviadoPorIA.get(psid) ?? []).filter(e => ahora - e.ts < VENTANA_ECO_MS)
  lista.push({ texto: t, ts: ahora })
  _enviadoPorIA.set(psid, lista.slice(-MAX_ENVIADOS_RECORDADOS))
}

// ¿Este texto lo envió la propia IA? Se compara por inclusión porque los mensajes largos
// salen troceados (sendTextMessage parte en 980 caracteres) y cada trozo vuelve como un
// eco distinto. En textos cortos se exige igualdad exacta, para no confundir un "¡Listo!"
// del asesor con uno de la IA. No se consume la entrada: del mismo mensaje pueden llegar
// varios ecos.
function textoCoincideCon(candidato, referencia) {
  const a = normalizarEco(candidato), b = normalizarEco(referencia);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 15 && b.length >= 15 && (a.includes(b) || b.includes(a));
}

function ecoEsDeLaIA(psid, texto) {
  return (_enviadoPorIA.get(psid) ?? []).some(e => textoCoincideCon(texto, e.texto));
}

// Segunda comprobación, contra el historial guardado: el registro de arriba vive en
// memoria y se pierde en cada redeploy de Render. Sin esto, tras un reinicio los ecos de
// lo que la IA envió antes de reiniciar parecerían de un humano y la callarían sin motivo.
async function ecoEstaEnHistorial(psid, texto) {
  try {
    const ultimos = await db.getHistorial(psid, 8)
    return ultimos.some(m => m.role === 'assistant' && textoCoincideCon(texto, m.content))
  } catch { return false }
}

// Envía texto al cliente dejando constancia de que salió de la IA. Todos los envíos de
// texto del agente pasan por aquí: si alguno se saltara el registro, su eco se leería como
// un humano escribiendo y la IA se callaría sola.
async function enviarTextoIA(psid, texto) {
  registrarEnviadoPorIA(psid, texto)
  return ig.sendTextMessage(psid, texto)
}

// Un mensaje salió de la cuenta del negocio y no lo escribió la IA: hay una persona
// atendiendo. Se la silencia en el acto y se guarda lo que dijo, para que al retomar
// tenga el contexto de lo que ya se habló.
async function detectarAsesorHumano(psid, texto) {
  if (texto === AVISO_ESPERA) return
  if (ecoEsDeLaIA(psid, texto)) return
  if (await ecoEstaEnHistorial(psid, texto)) return

  const esPrimerMensaje = await db.marcarAsesorHumano(psid)
  await db.guardarMensaje(psid, 'assistant', `[Asesor] ${texto}`)

  if (esPrimerMensaje) {
    evento(psid, 'asesor_humano_detectado')
    console.log(`[asesor-humano] ${psid}: una persona entró en la conversación — la IA se calla`)
  }
}

// Guarda en el perfil del cliente lo que se va sabiendo de él. La mayor parte se captura
// sola de lo que ya pasa por las herramientas; solo lo cualitativo necesita que el modelo lo
// cuente con recordar_preferencia. Nunca debe romper el turno.
async function actualizarPerfil(psid, cambios) {
  try {
    const actual = await db.getPerfil(psid)
    await db.setPerfil(psid, memoria.fusionarPerfil(actual, cambios))
  } catch (e) {
    console.warn('[memoria] no se pudo actualizar el perfil:', e.message)
  }
}

// Lo que core/seguimientos.js necesita del agente: cómo enviar, cómo saber si se puede
// escribir y cómo consultar la base de datos. Se inyecta para poder probar el módulo sin
// red ni BD.
function depsSeguimientos() {
  return {
    db,
    enviar: (psid, texto) => enviarTextoIA(psid, texto),
    minutosDesdeUltimoMensaje: psid => db.minutosDesdeUltimaInteraccion(psid),
    // Ojo: aquí cuenta también el asesor detectado por los ecos, no solo el panel.
    hayAsesorAtendiendo: async psid => {
      const estado = await db.getEstado(psid)
      return !!estado?.transferido
    },
    guardarEnHistorial: (psid, texto) => db.guardarMensaje(psid, 'assistant', texto).catch(() => {}),
    evento: (psid, tipo, detalle) => evento(psid, tipo, detalle),
  }
}

// Fallos técnicos recientes por cliente: sirve para escalar a un asesor solo si el
// problema se repite, en vez de crear una tarjeta en el primer tropiezo de red.
const fallosTecnicos = new Map()
const VENTANA_FALLO_MS = 10 * 60 * 1000
function registrarFalloTecnico(psid) {
  const previo = fallosTecnicos.get(psid)
  const ahora = Date.now()
  fallosTecnicos.set(psid, ahora)
  if (fallosTecnicos.size > 500) {
    for (const [k, t] of fallosTecnicos) if (ahora - t > VENTANA_FALLO_MS) fallosTecnicos.delete(k)
  }
  return !!previo && ahora - previo < VENTANA_FALLO_MS
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
// Sin clave el constructor lanza en el require y, con el handler de uncaughtException,
// la suite de tests pasaba en verde con 0 tests ejecutados. Se construye igual y la
// ausencia se avisa al arrancar (revisarSeguridad); las llamadas fallarían con 401.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'sin-configurar' })

// El system prompt se genera desde la configuración del negocio (ver prompt.js y
// negocio.json), compartido con el agente de WhatsApp: antes eran dos prompts escritos a
// mano que ya habían divergido entre sí.
function buildSystemPrompt() {
  return construirSystemPrompt('instagram')
}

const TOOLS = [
  {
    name: 'buscar_productos',
    description: 'Busca productos en el catálogo por nombre, descripción o categoría. Entiende también número de puestos de una mesa ("4 puestos", "6 personas") y forma ("redonda", "en forma de copa", "ovalada") — inclúyelos en la consulta tal como los dijo el cliente. Solo devuelve precio, material y medidas. NO incluye stock ni disponibilidad en tiendas.',
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
    description: 'Envía la foto de UN producto al cliente. Úsalo cuando muestras un solo producto.',
    parameters: {
      type: 'object',
      properties: { nombre_producto: { type: 'string' } },
      required: ['nombre_producto'],
    },
  },
  {
    name: 'enviar_carrusel',
    description: 'Envía VARIOS productos (2 a 10) como tarjetas deslizables con foto, precio y botón. Úsalo SIEMPRE que vayas a mostrar varias opciones al cliente, en lugar de listarlas en texto y mandar fotos sueltas. Escribe una frase corta ("Mira estas opciones 👇") antes de llamarlo.',
    parameters: {
      type: 'object',
      properties: {
        productos: {
          type: 'array',
          items: { type: 'string' },
          description: 'Nombres exactos de los productos a mostrar (2-10), tal como los devolvió buscar_productos.',
        },
      },
      required: ['productos'],
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
        dia:       { type: 'string', description: 'Fecha de la visita con día de la semana, número de día, mes y año (ej: "miércoles 3 de junio de 2026"). SIEMPRE incluye el año. NUNCA inventes ni asumas el año — confírmalo con el cliente si es ambiguo.' },
        hora:      { type: 'string', description: 'Hora en formato HH:MM (dentro de horario comercial)' },
        motivo:    { type: 'string', description: 'Motivo de la visita (opcional, solo si el cliente lo menciona)' },
      },
      required: ['nombre', 'ubicacion', 'dia', 'hora'],
    },
  },
  {
    name: 'cancelar_cita',
    description: 'Cancela una cita ya agendada del cliente. Úsalo cuando diga que no puede ir, que quiere cancelar o que quiere cambiar la fecha/hora de su visita (para cambiarla: primero cancela y luego agenda la nueva con agendar_cita). Si el cliente tiene varias citas y no está claro cuál, llámalo sin cita_id: la herramienta te devuelve la lista para que le preguntes.',
    parameters: {
      type: 'object',
      properties: {
        cita_id: { type: 'number', description: 'Id de la cita a cancelar, tal como lo devuelve esta misma herramienta o consultar_estado. Omítelo si el cliente solo tiene una cita o si aún no sabes cuál es.' },
        motivo:  { type: 'string', description: 'Motivo de la cancelación si el cliente lo menciona (opcional)' },
      },
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
    name: 'consultar_estado',
    description: 'Devuelve el estado del cliente: qué tiene en el carrito, el último producto que vio y sus citas agendadas. Úsalo cuando pregunte por algo que ya pasó ("¿qué había pedido?", "¿a qué hora quedó mi visita?", "¿en qué sede era?") y no lo tengas claro en la conversación.',
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
        variante: { type: 'string', description: 'Opción elegida por el cliente cuando el producto tiene variantes con precios distintos (ej: "1.60", "6 pts", "piedra sinterizada"). Obligatorio en esos productos: sin ella no se puede saber el precio.' },
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
    name: 'reportar_imagen_no_identificada',
    description: 'Llama esta función SIEMPRE que analices una imagen (foto o captura de pantalla) y NO puedas identificar con confianza qué producto es, incluso después de intentar leer el texto visible y clasificar el tipo de mueble. Es solo para seguimiento interno, no se le muestra al cliente tal cual.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'recordar_preferencia',
    description: 'Guarda lo que el cliente cuenta de sí mismo para no hacérselo repetir en otra conversación: para qué espacio busca el mueble ("apartamento pequeño", "cuarto de mi hija") y qué le gusta o necesita ("madera clara", "que resista mascotas"). Llámalo en cuanto lo diga, sin anunciárselo. NO guardes datos sensibles ni nada que no sirva para venderle mejor.',
    parameters: {
      type: 'object',
      properties: {
        espacio:      { type: 'string', description: 'Para qué espacio o persona busca el mueble' },
        preferencias: { type: 'array', items: { type: 'string' }, description: 'Gustos o necesidades concretas (material, color, resistencia)' },
      },
    },
  },
  {
    name: 'reportar_objecion',
    description: 'Úsalo cuando el cliente muestra interés pero pone un freno que tú no puedes resolver: dice que está caro, que lo va a pensar, que lo consulta con su pareja, que lo ve más adelante, o compara con otra tienda. NO le digas al cliente que estás reportando nada y NO te despidas: sigue atendiéndolo e intenta resolver la objeción. Esto solo avisa al equipo de ventas.',
    parameters: {
      type: 'object',
      properties: {
        objecion: { type: 'string', description: 'Qué dijo el cliente, en sus palabras o resumido' },
        producto: { type: 'string', description: 'Producto sobre el que puso el freno, si lo hay' },
      },
      required: ['objecion'],
    },
  },
  {
    name: 'reportar_proveedor',
    description: 'Úsalo cuando la persona NO es un cliente sino un PROVEEDOR o alguien que quiere VENDERLE a la empresa o proponer una colaboración/alianza comercial (ej: "somos importadores/fabricantes de X", "quiero enviarles mi portafolio", "les ofrezco materia prima/tapas/piedra", "propuesta comercial", "trabajar juntos"). NO lo trates como cliente, NO agendes visita, NO le des ningún número. Solo se notifica internamente al equipo de compras.',
    parameters: {
      type: 'object',
      properties: {
        resumen: { type: 'string', description: 'Qué ofrece y el nombre/empresa de la persona si lo mencionó' },
      },
      required: ['resumen'],
    },
  },
]

// Log del consumo de tokens de un turno, con costo estimado (tarifas gpt-4o:
// $2.50/1M tokens de entrada, $10/1M de salida). Permite auditar el gasto desde los
// logs sin depender solo del dashboard de OpenAI.
// Los tokens "cacheados" son los de entrada que OpenAI sirvió desde su caché de prefijo,
// a mitad de precio. Se logean para comprobar que el caché funciona: si sale 0 a partir
// del segundo mensaje, algo cambiante se está colando delante del prompt estable.
function logUsoTokens(psid, promptTok, completionTok, rondas, cacheados = 0) {
  const costo = ((promptTok - cacheados) / 1e6) * 2.5 + (cacheados / 1e6) * 1.25 + (completionTok / 1e6) * 10
  const pctCache = promptTok ? Math.round((cacheados / promptTok) * 100) : 0
  console.log(`[tokens] ${psid} · ${rondas} ronda(s) · entrada ${promptTok} (${pctCache}% en caché) · salida ${completionTok} · ~$${costo.toFixed(4)}`)
}

async function runAgentLoop(psid, mensajeUsuario, imageBase64 = null, userInfo = {}, imageMimeType = 'image/jpeg', contextoExtra = null) {
  // En conversaciones largas se pasan los últimos mensajes literales más un resumen de los
  // anteriores: antes se truncaba en 12 sin resumen y el agente olvidaba el principio,
  // incluido lo que el cliente ya había descartado.
  const { mensajes: historial } = await memoria.prepararHistorial(
    { db }, psid, { openai, modeloRapido: process.env.OPENAI_MODEL_RAPIDO || 'gpt-4o-mini' }
  )

  // Lo que ya se sabe del cliente y el resumen de lo hablado. Si algo falla, el turno sigue.
  let contextoPerfil = null, contextoResumen = null
  try {
    contextoPerfil = memoria.construirContextoPerfil(await db.getPerfil(psid), { formatearMoneda: n => `$${Number(n).toLocaleString('es-CO')}` })
    contextoResumen = memoria.construirContextoResumen(await db.getResumenConversacion(psid))
  } catch (e) {
    console.warn('[memoria] no se pudo cargar el contexto del cliente:', e.message)
  }

  const userContent = imageBase64
    ? [
        { type: 'text', text: mensajeUsuario },
        { type: 'image_url', image_url: { url: `data:${imageMimeType};base64,${imageBase64}`, detail: 'high' } },
      ]
    : mensajeUsuario

  // Guardamos una referencia al mensaje del usuario para poder quitarle la imagen en
  // las rondas siguientes (ver más abajo) sin re-facturar los tokens de visión.
  const userMsg = { role: 'user', content: userContent }
  const messages = [
    // El primer mensaje es el prompt grande y SIEMPRE idéntico: es el prefijo que OpenAI
    // cachea (y cobra más barato). Todo lo que cambia va detrás, en mensajes aparte. Antes
    // la fecha iba dentro del prompt, así que el prefijo cambiaba cada día y el caché no
    // llegaba a usarse.
    { role: 'system', content: buildSystemPrompt() },
    { role: 'system', content: fechas.bloqueFechaParaPrompt() },
    // Contexto efímero (p.ej. los productos recién mostrados) — no se guarda en el
    // historial, solo ayuda a resolver referencias en este turno.
    ...(contextoPerfil ? [{ role: 'system', content: contextoPerfil }] : []),
    ...(contextoResumen ? [{ role: 'system', content: contextoResumen }] : []),
    ...(contextoExtra ? [{ role: 'system', content: contextoExtra }] : []),
    ...historial.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    userMsg,
  ]

  const tools = TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))

  // Precios que las herramientas devolvieron en ESTE turno (resultados de búsqueda,
  // totales de carrito, etc.). Se usan para validar la respuesta final sin marcar como
  // "inventado" un total del carrito, que es una suma que no existe como precio suelto.
  const preciosVistos = new Set()

  // Contadores de tokens para auditar el gasto real por conversación (OpenAI los
  // devuelve en response.usage). Se logean al terminar el turno.
  let tokPrompt = 0, tokCompletion = 0, tokCacheados = 0

  // Un asesor puede pulsar "Tomar" en el panel mientras este turno está en curso (entre
  // el debounce, las descargas de medios y las rondas de OpenAI pasan varios segundos).
  // Se re-chequea antes de cada ronda y antes de devolver el texto final: si ya tiene el
  // chat, se corta sin enviar nada — ni fotos, ni carruseles, ni texto encima de su
  // conversación. La excepción es cuando fue la propia IA quien llamó a solicitar_asesor
  // en este turno: ahí debe poder decirle al cliente que lo está conectando.
  let transfiriendo = false
  const asesorTomoElChat = async (round) => {
    if (transfiriendo || !(await db.asesorAtendiendo(psid))) return false
    console.log(`[transferido] ${psid}: un asesor tomó el chat a mitad del turno — se descarta la respuesta`)
    logUsoTokens(psid, tokPrompt, tokCompletion, round, tokCacheados)
    return true
  }

  // 6 rondas, igual que el agente de WhatsApp: con 5 se quedaba corto en turnos que
  // encadenan búsqueda, foto y carrito.
  for (let round = 0; round < 6; round++) {
    if (await asesorTomoElChat(round)) return null
    if (round > 0) await ig.sendTypingOn(psid)
    // Con reintentos: un 429 o un 5xx pasajero de OpenAI ya no tumba el turno ni dispara
    // una tarjeta de asesor. Temperatura 0.3, igual que el agente de WhatsApp: la regla
    // número uno es no inventar precios ni nombres, y la calidez la da el prompt.
    const response = await conReintentos(
      () => openai.chat.completions.create({
        model:       process.env.OPENAI_MODEL ?? 'gpt-4o',
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens:  600,
      }),
      { contexto: `openai psid=${psid} ronda ${round + 1}` }
    )

    if (response.usage) {
      tokPrompt     += response.usage.prompt_tokens     ?? 0
      tokCompletion += response.usage.completion_tokens ?? 0
      tokCacheados  += response.usage.prompt_tokens_details?.cached_tokens ?? 0
    }

    const choice = response.choices[0]

    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
      // La última llamada a OpenAI (la que redacta el texto) es la más larga: es el
      // momento más probable para que el asesor haya tomado el chat entre medias.
      if (await asesorTomoElChat(round + 1)) return null
      const texto = choice.message.content ?? ''
      validarPrecios(psid, texto, preciosVistos)
      logUsoTokens(psid, tokPrompt, tokCompletion, round + 1, tokCacheados)
      return texto
    }

    messages.push(choice.message)

    for (const toolCall of choice.message.tool_calls) {
      const nombre = toolCall.function.name
      let args
      try { args = JSON.parse(toolCall.function.arguments) } catch { args = {} }
      if (nombre === 'solicitar_asesor') transfiriendo = true
      const result = await ejecutarTool(psid, nombre, args, userInfo)
      const resultStr = String(result ?? 'OK')
      for (const n of extraerPrecios(resultStr)) preciosVistos.add(n)
      messages.push({
        role:         'tool',
        tool_call_id: toolCall.id,
        content:      resultStr,
      })
    }

    // La imagen ya se analizó en la primera ronda a MÁXIMA calidad (detail:'high').
    // En las rondas siguientes el modelo solo procesa resultados de herramientas y NO
    // necesita "ver" de nuevo la foto, así que la quitamos del mensaje para no
    // re-facturar los tokens de visión (que en 'high' son caros) en cada ronda. La
    // calidad del análisis NO baja porque la ronda 0 sí usó la imagen completa.
    if (imageBase64 && Array.isArray(userMsg.content)) {
      userMsg.content = mensajeUsuario
    }
  }

  evento(psid, 'sin_resolver', 'limite de rondas')
  await enviarNotificacionSistema(psid, userInfo, 'La IA no pudo resolver la solicitud tras varios intentos (límite de rondas de herramientas alcanzado). Revisar conversación.', 'asesor').catch(err => console.error('[redes] no se pudo notificar límite de rondas:', err.message))
  logUsoTokens(psid, tokPrompt, tokCompletion, 6, tokCacheados)
  const avisoRondas = avisoFueraHorario()
  return `Tuve un problema procesando tu solicitud. Un asesor te contactará pronto 🙏${avisoRondas ? `\n\n${avisoRondas}` : ''}`
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
  return targetWords.some(w => {
    if (w.length <= 2) return false
    const d = levenshtein(word, w)
    if (d <= maxDist) return true
    // Nombres propios cortos con misma raíz pero errata/variante fonética
    // ("fiji" ↔ "figy"): se aceptan hasta 2 ediciones si comparten el prefijo de 2
    // letras. La guarda de prefijo evita falsos positivos entre palabras cortas.
    return word.length >= 4 && w.length >= 4 && word.slice(0, 2) === w.slice(0, 2) && d <= 2
  })
}

// Tokeniza quitando puntuación pero conservando dígitos: "1.20 x 0.90 (4 Puestos)"
// → ["1","20","x","0","90","4","puestos"]. Así el nº de puestos es buscable.
function tokens(str) {
  return normalize(str ?? '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
}

// El cliente pide "4 puestos/personas" y en el catálogo eso vive en medidas como
// "(4 Puestos)". Da un empujón fuerte al producto cuyo nº de puestos coincide, para
// que las bases del tamaño pedido queden de primeras.
function boostPuestos(q, medidas) {
  const pedido = q.match(/(\d+)\s*(puesto|persona|sitio)/)
  if (!pedido) return 0
  return new RegExp('\\b' + pedido[1] + '\\s*puesto').test(normalize(medidas ?? '')) ? 45 : 0
}

// "redonda/circular/forma de copa/pedestal": en el catálogo las bases redondas de
// pedestal dicen "Diametro" en medidas (o "REDONDA" en el nombre). Sin esto, "mesa
// redonda" o "en forma de copa" no encontraban ninguna.
function boostForma(q, medidas, nombre) {
  if (!/\b(redond[oa]|circular|copa|pedestal|columna)\b/.test(q)) return 0
  return (normalize(medidas ?? '').includes('diametro') || /redond/.test(normalize(nombre ?? ''))) ? 35 : 0
}

function buscarEnInventario(consulta, categoria = null, limite = 5) {
  const q = normalize(consulta)
  const qWords = tokens(q)
  let base = inventario
  if (categoria) {
    const cat = normalize(categoria).replace(/\s+/g, '_')
    base = inventario.filter(p => normalize(p.subcategoria).replace(/\s+/g, '_') === cat)
  }
  return base
    .map(p => ({ ...p, score: scoring(p, q, qWords) }))
    .filter(p => p.score >= 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limite, 10))
}

function scoring(p, q, qWords) {
  const nombre      = normalize(p.nombre)
  // "bases_comedores" → "bases comedores", para que la palabra "comedor" del cliente
  // haga match (antes era un solo token con guion bajo y no matcheaba).
  const sub         = normalize(p.subcategoria).replace(/_/g, ' ')
  const nombreWords = tokens(nombre)
  const subWords    = tokens(sub)
  const medidaWords = tokens(p.medidas)
  const material    = normalize(p.material ?? '')
  // Versiones "pegadas" para cuando el cliente escribe todo junto ("sofacama" ↔
  // "sofa cama"): se compara sin espacios contra el nombre y la subcategoría.
  const nombreCompacto = nombreWords.join('')
  const subCompacto    = subWords.join('')
  let score = 0
  if (nombre === q)            score += 100
  if (q && nombre.includes(q)) score += 60
  if (q && sub.includes(q))    score += 40
  for (const w of qWords) {
    // Se saltan palabras de ≤2 letras salvo que sean números (p.ej. "4" puestos).
    if (w.length <= 2 && !/^\d+$/.test(w)) continue
    if (nombreWords.includes(w))                           score += 20
    else if (fuzzyWord(w, nombreWords))                    score += 12
    else if (w.length >= 5 && nombreCompacto.includes(w))  score += 16
    if (subWords.includes(w))                              score += 12
    else if (fuzzyWord(w, subWords))                       score += 8
    else if (w.length >= 5 && subCompacto.includes(w))     score += 10
    if (medidaWords.includes(w))        score += 8
    if (w.length > 3 && material.includes(w)) score += 6
  }
  score += boostPuestos(q, p.medidas)
  score += boostForma(q, p.medidas, p.nombre)
  return score
}

// Traduce las variantes de un producto a los campos que ve el modelo. La regla clave:
// si las opciones tienen precios distintos, NO se le entrega un `precio` suelto — se le
// da el rango y la lista, para que no pueda comprometer un importe que solo vale para
// una de las medidas. Si todas cuestan igual (color, acabado), el precio es único y las
// opciones son solo información que enriquece la respuesta.
function infoPrecioVariantes(p) {
  const variantes = (p.variantes || []).filter(v => v.etiqueta && v.precio > 0)
  if (variantes.length === 0) return { precio: Number(p.precio ?? 0) }

  const precios = [...new Set(variantes.map(v => v.precio))]
  if (precios.length === 1) {
    return {
      precio: Number(p.precio ?? 0),
      opciones: variantes.map(v => v.etiqueta),
      tipo_opcion: variantes[0].tipo,
    }
  }

  return {
    precio: null,
    precio_desde: Math.min(...precios),
    precio_hasta: Math.max(...precios),
    tipo_variante: variantes[0].tipo,
    variantes: variantes.map(v => ({ opcion: v.etiqueta, precio: v.precio })),
    nota_variantes: 'Este producto tiene varias opciones con PRECIOS DISTINTOS. No des un precio único ni menciones solo el más bajo como si fuera el precio: dile el rango (desde X hasta Y), enumera las opciones disponibles y pregúntale cuál necesita. Cuando la elija, dale el precio exacto de ESA opción.',
  }
}

// Precio con el que comparar contra el presupuesto del cliente: el más bajo al que
// puede llevarse el producto.
function precioMinimo(p) {
  const variantes = (p.variantes || []).filter(v => v.precio > 0)
  if (!variantes.length) return parsearPrecio(p.precio)
  return Math.min(...variantes.map(v => v.precio))
}

// Busca una variante por lo que escribió el cliente ("1.60", "6 pts", "flor morado").
// Tolerante con la puntuación porque en la BD conviven "1,40", "1.40" y "160".
function encontrarVariante(producto, textoVariante) {
  const variantes = (producto?.variantes || []).filter(v => v.etiqueta && v.precio > 0)
  if (!variantes.length || !textoVariante) return null
  const norm = s => normalize(String(s)).replace(/[.,\s]/g, '')
  const buscado = norm(textoVariante)
  if (!buscado) return null

  const exacta = variantes.find(v => norm(v.etiqueta) === buscado)
  if (exacta) return exacta

  // Coincidencia parcial solo si es INEQUÍVOCA. Antes "2" (de "la de 2 metros") hacía
  // match con la primera etiqueta que contuviera un 2 ("1.20", la más barata) y el
  // pedido salía con la medida y el precio equivocados. Con varias candidatas se
  // devuelve null para que la herramienta le pida al cliente que elija.
  const parciales = variantes.filter(v => {
    const e = norm(v.etiqueta)
    return e.includes(buscado) || buscado.includes(e)
  })
  return parciales.length === 1 ? parciales[0] : null
}

// Precio corto para tarjetas de carrusel y confirmaciones: "desde $X" cuando el
// producto tiene opciones que valen distinto.
function etiquetaPrecio(p) {
  const info = infoPrecioVariantes(p)
  return info.precio === null
    ? `desde $${info.precio_desde.toLocaleString('es-CO')}`
    : `$${Number(p.precio ?? 0).toLocaleString('es-CO')}`
}

// Identifica el producto de una publicación por su texto, pero solo si de verdad lo
// nombra. buscarEnInventario está pensado para lo que ESCRIBE el cliente ("cama miami")
// y devuelve resultados con una sola palabra en común, lo cual en un caption es basura:
// "Buenas noches, descansa como mereces" daba MESA DE NOCHE, y el agente le afirmaba al
// cliente que estaba interesado en una mesa de noche cuando el reel mostraba un reloj.
//
// Aquí se mide al revés: cuánto del NOMBRE del producto aparece en el caption. "Reloj
// Decorativo Chronos GLD" aparece entero (100%); "MESA DE NOCHE AMIGABLE" en ese caption
// solo aporta "noche" (25%) y se descarta.
// Gana el producto MEJOR cubierto, no el primero que pase el listón: con el caption
// "Cama Miami en flor morado", CAMA FLOR MORADO LISA llegaba antes por score (comparte
// tres palabras) y se llevaba la identificación por delante de CAMA MIAMI, que está
// nombrada entera.
function identificarProductoPorCaption(caption) {
  const q = normalize(caption ?? '')
  if (!q) return null

  let mejor = null
  let mejorCobertura = 0
  for (const p of buscarEnInventario(caption, null, 5)) {
    const palabras = tokens(normalize(p.nombre)).filter(w => w.length >= 3)
    if (!palabras.length) continue
    const cobertura = palabras.filter(w => q.includes(w)).length / palabras.length
    if (cobertura > mejorCobertura) {
      mejorCobertura = cobertura
      mejor = p
    }
  }
  return mejorCobertura >= 0.6 ? mejor : null
}

// Para ACCIONES sobre un producto concreto (mandar su foto, meterlo al carrito) no vale
// el "primer resultado" de la búsqueda: esa lista es aproximada a propósito, para poder
// sugerir. Aquí hace falta certeza, porque el cliente ve el resultado.
//
// Sin esto, enviar_foto("nevera") le mandaba al cliente la foto de una LAMPARA DE MESA
// NEGRA (score 12, coincidencia difusa) y "tapete persa" le mandaba una SILLA AUX PERLA.
// Se exige que lo pedido esté realmente en el nombre del producto.
function buscarProductoExacto(consulta) {
  const palabras = tokens(normalize(consulta ?? '')).filter(w => w.length >= 3)
  if (!palabras.length) return null
  const candidatos = buscarEnInventario(consulta, null, 5)
  if (!candidatos.length) return null

  let mejor = null
  let mejorCobertura = 0
  for (const p of candidatos) {
    const nombre         = normalize(p.nombre)
    const nombreWords    = tokens(nombre)
    const nombreCompacto = nombreWords.join('')
    // Se mantiene la tolerancia a nombres pegados ("sofacama" encuentra "SOFA CAMA"),
    // pero NO la difusa: "nevera" está a dos letras de "negra" y colaba una LAMPARA DE
    // MESA NEGRA. Para una acción que el cliente ve, es mejor rechazar y preguntar. Las
    // erratas de quien escribe las sigue absorbiendo buscar_productos, que es donde el
    // resultado aproximado sí tiene sentido.
    const coincide = w => nombre.includes(w) || nombreCompacto.includes(w)
    const cobertura = palabras.filter(coincide).length / palabras.length
    if (cobertura > mejorCobertura) {
      mejorCobertura = cobertura
      mejor = p
    }
  }
  return mejorCobertura >= 0.6 ? mejor : null
}

function formatProducto(p) {
  const info = infoPrecioVariantes(p)
  const linea = info.precio === null
    ? `Precio: desde $${info.precio_desde.toLocaleString('es-CO')} hasta $${info.precio_hasta.toLocaleString('es-CO')} (según la opción)\nOpciones: ${info.variantes.map(v => `${v.opcion} → $${v.precio.toLocaleString('es-CO')}`).join(' | ')}\n[No des un precio único: pregúntale cuál opción quiere y dale el precio de esa]`
    : `Precio: $${Number(p.precio ?? 0).toLocaleString('es-CO')}${info.opciones ? `\nDisponible en: ${info.opciones.join(', ')}` : ''}`
  return `*${p.nombre}*\n${linea}\nMedidas: ${p.medidas ?? 'consultar'}\nMaterial: ${p.material ?? 'consultar'}`
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

// Guarda (compacto) los productos que se le acaban de mostrar al cliente, para poder
// resolver "esa / la segunda / la de $X" en el mensaje siguiente. No debe romper el
// flujo si falla.
async function recordarMostrados(psid, productos) {
  try {
    // Con variantes se guarda el precio de entrada: "la de $X" del cliente se resuelve
    // por el precio más bajo, que es el que se le mostró como "desde".
    await db.setUltimosMostrados(psid, productos.slice(0, 6).map(p => ({
      nombre: p.nombre, precio: precioMinimo(p),
    })))
    // Lo mostrado queda en su perfil: si vuelve en unos días, el agente sabe por dónde iba.
    actualizarPerfil(psid, { productos_interes: productos.slice(0, 3).map(p => p.nombre) }).catch(() => {})
  } catch (e) { console.warn('[mostrados] no se pudo guardar:', e.message) }
}

async function ejecutarTool(psid, nombre, args, userInfo) {
  switch (nombre) {

    case 'buscar_productos': {
      const resultados = buscarEnInventario(args.consulta, args.categoria ?? null, args.limite ?? 5)
      evento(psid, 'busqueda', args.consulta)
      if (!resultados.length) return `No encontré "${args.consulta}" en el inventario. ¿Puedes describir mejor lo que buscas?`
      await recordarMostrados(psid, resultados)
      return resultados.map(formatProducto).join('\n\n')
    }

    case 'buscar_por_presupuesto': {
      // El presupuesto llega aquí gratis: se guarda para no preguntárselo otra vez.
      if (Number(args.presupuesto_max) > 0) actualizarPerfil(psid, { presupuesto: Number(args.presupuesto_max) }).catch(() => {})
      // Con variantes cuenta el precio de entrada: si el cliente tiene $3.000.000 y la
      // cama en 1.40 vale $2.980.000, el producto entra aunque la de 2 metros se pase.
      let base = inventario.filter(p => precioMinimo(p) > 0 && precioMinimo(p) <= args.presupuesto_max)
      if (args.categoria) {
        const cat = normalize(args.categoria).replace(/\s+/g, '_')
        base = base.filter(p => normalize(p.subcategoria).replace(/\s+/g, '_') === cat)
      }
      const resultados = base.sort((a, b) => precioMinimo(b) - precioMinimo(a)).slice(0, 5)
      if (!resultados.length) return `No encontré productos en ese presupuesto. ¿Quieres ver opciones cercanas a tu rango?`
      await recordarMostrados(psid, resultados)
      return resultados.map(formatProducto).join('\n\n')
    }

    case 'enviar_foto': {
      const resultado = buscarProductoExacto(args.nombre_producto)
      if (!resultado) {
        // Antes se mandaba el primer resultado por parecido, así que pedir "nevera"
        // le enviaba al cliente la foto de una lámpara. Mejor admitir que no está y
        // ofrecer lo más cercano para que el modelo pregunte.
        const cercanos = buscarEnInventario(args.nombre_producto, null, 3).map(p => p.nombre)
        return cercanos.length
          ? `No tenemos "${args.nombre_producto}" en el catálogo. NO le mandes otra foto como si fuera ese producto. Lo más parecido que hay es: ${cercanos.join(', ')}. Pregúntale al cliente si alguno le sirve.`
          : `No tenemos "${args.nombre_producto}" en el catálogo. Díselo con amabilidad y pregúntale qué tipo de mueble busca.`
      }
      await db.setUltimoProducto(psid, { nombre: resultado.nombre, imagen: resultado.imagen ?? null, ts: Date.now() })
      await recordarMostrados(psid, [resultado])
      evento(psid, 'producto_visto', resultado.nombre)
      if (resultado.imagen) {
        await ig.sendImageMessage(psid, resultado.imagen)
        // Segunda foto del producto si existe (otro ángulo/detalle): antes se ignoraba.
        if (resultado.imagen2 && resultado.imagen2 !== resultado.imagen) {
          await ig.sendImageMessage(psid, resultado.imagen2)
        }
        return `[Foto de ${resultado.nombre} enviada — ${etiquetaPrecio(resultado)}. Haz seguimiento de venta]`
      }
      return `[${resultado.nombre} — ${etiquetaPrecio(resultado)} — sin foto disponible. Sugiere al cliente visitar el perfil ${negocio.cfg.empresa.instagram}]`
    }

    case 'enviar_carrusel': {
      // Muestra 2-10 productos como tarjetas con foto, precio y botón. Es el reemplazo
      // "nativo" de listar productos en texto + varias fotos sueltas.
      const nombres = Array.isArray(args.productos) ? args.productos.slice(0, 10) : []
      // Solo productos identificados con certeza: una tarjeta con la foto de otro
      // producto es peor que una tarjeta de menos.
      const encontrados = nombres
        .map(n => buscarProductoExacto(n))
        .filter(p => p && p.imagen)
      if (encontrados.length < 2) {
        // Con menos de 2 tarjetas no vale la pena un carrusel: que el modelo use enviar_foto.
        return 'No hay suficientes productos con foto para un carrusel. Usa enviar_foto para mostrar uno solo.'
      }
      const elementos = encontrados.map(p => ({
        title:     p.nombre,
        subtitle:  `${etiquetaPrecio(p)}${p.medidas ? ` · ${p.medidas}` : ''}`,
        image_url: p.imagen,
        buttons:   [{ type: 'postback', title: 'Me interesa 💬', payload: `INTERESA::${p.nombre}` }],
      }))
      const ok = await ig.sendCarousel(psid, elementos)
      await db.setUltimoProducto(psid, { nombre: encontrados[0].nombre, imagen: encontrados[0].imagen ?? null, ts: Date.now() })
      await recordarMostrados(psid, encontrados)
      for (const p of encontrados) evento(psid, 'producto_visto', p.nombre)
      if (!ok) {
        // Degradación elegante: si el carrusel falla, el modelo lo presenta en texto.
        return `No pude enviar el carrusel visual. Preséntale estos productos en texto:\n${encontrados.map(formatProducto).join('\n\n')}`
      }
      return `[Carrusel enviado con ${encontrados.length} productos: ${encontrados.map(p => p.nombre).join(', ')}. Añade una frase corta de cierre invitando a elegir o pedir más info.]`
    }

    case 'agendar_cita': {
      // Validar antes de escribir nada: sin esto se podía agendar un domingo a las
      // 3am. Se le devuelve el error al modelo para que se lo aclare al cliente.
      if (!negocio.sedeValida(args.ubicacion)) {
        return `Sede inválida (debe ser ${negocio.sedeMin}-${negocio.sedeMax}). Pregúntale al cliente cuál sede prefiere y vuelve a intentar.`
      }
      // La fecha se valida de verdad (ver fechas.js): que exista, que no haya pasado, que
      // no sea domingo y que el día de la semana que dijo el modelo coincida con la fecha.
      // Antes bastaba con que apareciera la palabra "martes" en el texto, y el asesor
      // recibía citas como "martes 3 de junio de 2026" (que es miércoles).
      const val = fechas.validarFechaHoraCita(args.dia, args.hora)
      if (!val.ok) return val.error

      const diaTexto   = val.fecha.texto.charAt(0).toUpperCase() + val.fecha.texto.slice(1)
      const horaTexto  = val.hora
      const sedeNombre = SEDE_NOMBRE[args.ubicacion] ?? `Sede ${args.ubicacion}`
      const tiendaId   = SEDE_TIENDA_ID[args.ubicacion] ?? null
      const motivo     = args.motivo || null
      const datosCita  = { nombre: args.nombre, ubicacion: args.ubicacion, sede_nombre: sedeNombre, dia: diaTexto, fecha: val.fecha.iso, hora: horaTexto, motivo }

      // Una cita ya registrada para el mismo día no se duplica: el modelo a veces vuelve a
      // llamar la herramienta cuando el cliente confirma por segunda vez.
      if (await db.existeCitaPendiente(psid, val.fecha.iso)) {
        return `El cliente YA tiene una cita registrada para el ${val.fecha.texto}. No la registres de nuevo: confírmale que sigue en pie (${sedeNombre} a las ${horaTexto}) y pregúntale si quiere cambiarla o si necesita algo más.`
      }

      // Persistir ANTES de confirmarle al cliente. Si esto falla, no le decimos que la
      // cita quedó agendada.
      try {
        await db.guardarCita(psid, datosCita)
      } catch (e) {
        alertar('No se pudo guardar la cita', `psid=${psid} ${e.message}`)
        return 'No pude registrar la cita en este momento. Dile al cliente que un asesor lo contactará para confirmarla, y llama a solicitar_asesor.'
      }
      evento(psid, 'cita', `${sedeNombre} — ${diaTexto} ${horaTexto}`)

      // Recordatorios: el día antes y un par de horas antes. Es el seguimiento con menos
      // riesgo y más valor — el cliente PIDIÓ la cita — y reduce que no se presente.
      seguimientos.programarRecordatoriosCita(depsSeguimientos(), {
        destinatario: psid,
        referencia:   val.fecha.iso,
        fechaIso:     val.fecha.iso,
        hora:         horaTexto,
        nombre:       args.nombre,
        sede:         sedeNombre,
      }).catch(e => console.warn('[seguimientos] no se programaron los recordatorios:', e.message))

      notificarRedes(
        psid, userInfo,
        `Cita: ${args.nombre} — ${sedeNombre} — ${diaTexto} ${horaTexto}${motivo ? ` — ${motivo}` : ''}`,
        'cita',
        { datos_cita: datosCita, tienda_id: tiendaId }
      )

      const lineaMotivo = motivo ? `\nMotivo: ${motivo}` : ''
      return `¡Listo! Tu cita quedó agendada ✅\n\n👤 *${args.nombre}*\n📍 ${sedeNombre}\n📅 ${diaTexto} a las ${horaTexto}${lineaMotivo}\n\nNuestro equipo te confirmará la visita pronto 😊\n\n¿Hay algo más en lo que pueda ayudarte?`
    }

    case 'cancelar_cita': {
      const vigentes = await db.getCitasVigentes(psid)
      if (!vigentes.length) {
        return 'El cliente no tiene ninguna cita vigente registrada. Dile que no encuentras una visita agendada a su nombre y pregúntale si quiere agendar una.'
      }

      const describir = c => `#${c.id} — ${c.dia}${c.hora ? ` a las ${c.hora}` : ''} en ${SEDE_NOMBRE[c.ubicacion] ?? `sede ${c.ubicacion}`}`

      let cita = null
      if (args.cita_id) {
        cita = vigentes.find(c => Number(c.id) === Number(args.cita_id)) ?? null
        if (!cita) return `No encontré la cita ${args.cita_id} entre las vigentes del cliente. Las que tiene son: ${vigentes.map(describir).join(' | ')}.`
      } else if (vigentes.length === 1) {
        cita = vigentes[0]
      } else {
        return `[NO se canceló nada] El cliente tiene varias citas vigentes: ${vigentes.map(describir).join(' | ')}. Enumérale las opciones, pregúntale cuál quiere cancelar y vuelve a llamar cancelar_cita con el cita_id correspondiente.`
      }

      if (!(await db.cancelarCita(psid, cita.id))) {
        return 'No pude cancelar la cita en este momento. Dile al cliente que un asesor lo va a confirmar y llama a solicitar_asesor.'
      }

      const sedeNombreCita = SEDE_NOMBRE[cita.ubicacion] ?? `Sede ${cita.ubicacion}`
      evento(psid, 'cita_cancelada', `${sedeNombreCita} — ${cita.dia} ${cita.hora}`)
      // Sin esto, el cliente que canceló recibiría el recordatorio de una visita que ya no existe.
      if (cita.fecha) {
        const fechaRef = cita.fecha instanceof Date ? cita.fecha.toISOString().slice(0, 10) : String(cita.fecha).slice(0, 10)
        seguimientos.cancelar(depsSeguimientos(), { destinatario: psid, referencia: fechaRef }).catch(() => {})
      }
      // El panel de ventas tiene que enterarse: si no, el asesor prepara el producto y
      // espera a un cliente que ya avisó que no va.
      notificarRedes(
        psid, userInfo,
        `CITA CANCELADA por el cliente\n${cita.nombre ?? ''} — ${sedeNombreCita} — ${cita.dia} ${cita.hora}${args.motivo ? `\nMotivo: ${args.motivo}` : ''}`,
        'cita',
        { datos_cita: { cancelada: true, cita_id: cita.id, dia: cita.dia, hora: cita.hora, sede_nombre: sedeNombreCita, motivo: args.motivo ?? null }, tienda_id: SEDE_TIENDA_ID[cita.ubicacion] ?? null }
      )

      return `Cita cancelada ✅ (${cita.dia}${cita.hora ? ` a las ${cita.hora}` : ''}, ${sedeNombreCita}). Confírmaselo al cliente con amabilidad y pregúntale si quiere agendar otra fecha; si te dice cuándo, llama agendar_cita con la fecha nueva.`
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
      await enviarTextoIA(psid, `Aquí tienes el catálogo completo 📖 — toca el enlace para verlo:\n${url}`)
      return `[Catálogo de ${cat} enviado exitosamente. El cliente ya recibió el enlace — haz seguimiento con una pregunta de cierre]`
    }

    case 'reportar_imagen_no_identificada': {
      const intentos = (capturasNoIdentificadas.get(psid) ?? 0) + 1
      capturasNoIdentificadas.set(psid, intentos)
      evento(psid, 'imagen_no_identificada')
      if (intentos >= 2) {
        capturasNoIdentificadas.set(psid, 0)
        enviarNotificacionSistema(
          psid, userInfo,
          `El cliente ha enviado ${intentos} imágenes/capturas seguidas que la IA no pudo identificar en el inventario. Revisar la conversación y ayudarle manualmente a encontrar el producto.`,
          'asesor'
        ).catch(e => console.error('[redes] no se pudo notificar imagen no identificada:', e.message))
        return `Se avisó a un asesor porque ya van varios intentos sin identificar la imagen. Coméntale al cliente que un asesor también le va a ayudar con esto, sin dejar de mostrarle opciones parecidas.${avisoFueraHorario() ? ` IMPORTANTE: estamos fuera de horario (${negocio.horarioTexto}), avísale que el asesor le responderá en el próximo horario hábil para que no espere.` : ''}`
      }
      return 'Registrado. Sigue el flujo normal: pregunta si el cliente puede leer el nombre y muéstrale opciones parecidas según el tipo de mueble que identifiques.'
    }

    case 'recordar_preferencia': {
      await actualizarPerfil(psid, { espacio: args.espacio, preferencias: args.preferencias })
      return 'Anotado. NO se lo menciones al cliente: sigue la conversación con normalidad.'
    }

    case 'reportar_objecion': {
      // Una objeción es el momento de más valor de la conversación: el cliente quiere el
      // producto pero algo lo frena. El agente sigue intentándolo y el equipo se entera
      // para trabajarlo a mano si vale la pena. Al cliente NO se le dice nada de esto.
      const objecion = String(args.objecion ?? '').substring(0, 200)
      evento(psid, 'objecion', objecion)
      const carritoObj = await getCarrito(psid)
      const detalleProducto = args.producto ? `\nProducto: ${args.producto}` : ''
      const detalleCarrito = carritoObj.length ? `\nCarrito: ${carritoObj.map(i => i.producto).join(', ')}` : ''
      notificarRedes(
        psid, userInfo,
        `OBJECIÓN SIN RESOLVER 🤔\n${objecion}${detalleProducto}${detalleCarrito}\nEl cliente sigue hablando con la IA; esto es solo para que ventas decida si hace seguimiento.`,
        'asesor',
        { carrito: carritoObj.length ? carritoObj : undefined }
      )
      return 'Registrado para el equipo de ventas. NO le menciones esto al cliente ni te despidas: sigue atendiéndolo e intenta resolver la objeción tú misma (opciones más económicas con buscar_por_presupuesto, beneficios del producto, formas de pago).'
    }

    case 'reportar_proveedor': {
      // El número del encargado va SOLO en la notificación interna (el equipo lo ve en
      // el sistema de ventas), nunca en la respuesta al proveedor.
      const resumenProv = `PROVEEDOR / PROPUESTA COMERCIAL 🏭\n${args.resumen || 'Sin detalle'}\nReenviar al encargado de compras${process.env.COMPRAS_WHATSAPP ? ` (WhatsApp ${process.env.COMPRAS_WHATSAPP})` : ''}.`
      // Tipo 'asesor' y no 'otro': los tipos que acepta el sistema de ventas son
      // asesor|pedido|cita|personalizacion, así que 'otro' podía ser rechazado con un 4xx y
      // el lead del proveedor terminaba descartado tras los reintentos. La naturaleza de la
      // solicitud ya va clarísima en el resumen ('PROVEEDOR / PROPUESTA COMERCIAL').
      notificarRedes(psid, userInfo, resumenProv, 'asesor')
      evento(psid, 'proveedor', (args.resumen ?? '').substring(0, 120))
      return 'Registrado como propuesta de proveedor/colaboración. Agradécele con amabilidad, dile que su propuesta ya fue enviada a nuestro equipo de compras y que lo contactarán por este mismo medio si hay interés. NO agendes visita, NO le des ningún número, NO le pidas datos como si fuera un cliente.'
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

      // Fuera de horario (o a menos de 20 min del cierre): nadie va a tomar la tarjeta
      // hasta el próximo día hábil, así que NO se silencia a la IA — antes el cliente
      // quedaba toda la noche hablando con nadie. La tarjeta se crea igual (el asesor la
      // ve al abrir y al pulsar "Tomar" la IA se calla), y Elena le dice al cliente cuándo
      // le responderán y sigue atendiéndolo mientras tanto. Si ya hay una tarjeta
      // pendiente de este cliente, no se crea otra: el asesor ya va a contactarlo.
      const horario = estadoHorario(MARGEN_CIERRE_TRANSFERENCIA_MIN)
      if (!horario.abierto) {
        const yaPendiente = await db.solicitudAsesorPendiente(psid)
        if (!yaPendiente) {
          evento(psid, 'transferencia', `${args.tipo} (fuera de horario)`)
          notificarRedes(psid, userInfo, motivoFinal, args.tipo, { carrito: carritoIG.length ? carritoIG : undefined })
        }
        return `FUERA DE HORARIO: ${yaPendiente ? 'la solicitud de asesor de este cliente ya estaba registrada' : 'la solicitud quedó registrada'} y un asesor le escribirá ${horario.proximaApertura} (horario: ${negocio.horarioTexto}). Díselo al cliente con calidez y deja claro que MIENTRAS TANTO tú sigues aquí para ayudarle con lo que necesite (productos, precios, fotos, medidas, carrito). NO te despidas ni dejes de atenderlo, y NO vuelvas a llamar solicitar_asesor por este mismo motivo.`
      }

      // Silenciar la IA YA, no cuando el asesor pulse "Tomar" en el panel: entre una
      // cosa y la otra pueden pasar horas, y la IA le seguía conversando al cliente
      // después de haberle dicho que lo transfería.
      await db.marcarTransferido(psid, true)
      evento(psid, 'transferencia', args.tipo)

      notificarRedes(
        psid, userInfo, motivoFinal, args.tipo,
        { carrito: carritoIG.length ? carritoIG : undefined },
        // Si ni siquiera se pudo encolar, no dejemos al cliente hablando solo con nadie:
        // se reactiva la IA para que al menos siga atendiéndolo.
        { alFallar: () => db.marcarTransferido(psid, false) }
      )

      return 'Confírmale al cliente que lo estás conectando con un asesor que lo atenderá pronto 😊.'
    }

    case 'consultar_estado': {
      // Resume lo que ya pasó con este cliente. El historial de conversación se limpia
      // por inactividad, así que sin esto una pregunta como "¿a qué hora quedó mi
      // visita?" o "¿qué había pedido?" se quedaba sin respuesta.
      const items = await getCarrito(psid)
      const ultimo = await db.getUltimoProducto(psid)
      const citasRecientes = (await db.getCitasRecientes(psid)).map(c => ({
        id: c.id, nombre: c.nombre, dia: c.dia, hora: c.hora,
        sede: SEDE_NOMBRE[c.ubicacion] ?? `Sede ${c.ubicacion}`,
        motivo: c.razon, estado: c.estado,
      }))

      const total = items.reduce((s, i) => s + parsearPrecio(i.precio) * (i.cantidad || 1), 0)
      return JSON.stringify({
        carrito: items.length
          ? { items: items.map(i => ({ producto: i.producto, precio: i.precio, cantidad: i.cantidad || 1 })), total: `$${total.toLocaleString('es-CO')}` }
          : null,
        ultimo_producto_visto: ultimo ? { nombre: ultimo.nombre } : null,
        citas_agendadas: citasRecientes.length ? citasRecientes : null,
      })
    }

    case 'ver_carrito': {
      const items = await getCarrito(psid)
      if (!items.length) return 'Tu carrito está vacío 🛒 ¿Te gustaría ver algún producto? 😊'
      const total = items.reduce((s, i) => s + parsearPrecio(i.precio) * (i.cantidad || 1), 0)
      const lista = items.map((i, idx) =>
        `${idx + 1}. *${i.producto}* — $${parsearPrecio(i.precio).toLocaleString('es-CO')} × ${i.cantidad || 1}`
      ).join('\n')
      // Antes esto notificaba a Redes: mirar el carrito no es pedir ayuda humana, y
      // cada vistazo creaba una tarjeta "pendiente" nueva para el equipo de ventas.
      // El pedido de verdad se notifica en confirmar_pedido; la ayuda, en solicitar_asesor.
      return `🛍️ *Tu carrito:*\n${lista}\n\n*Total: $${total.toLocaleString('es-CO')}*\n\n¿Confirmamos la compra o quieres seguir viendo productos?`
    }

    case 'agregar_al_carrito': {
      // Un producto con variantes de precio no puede entrar al carrito "a secas": el
      // pedido llegaría al sistema de ventas con un importe que no corresponde a lo que
      // el cliente quiere. Se exige la opción y el precio sale de la BD, no del modelo.
      // El precio NUNCA sale del argumento del modelo: se resuelve el producto de forma
      // estricta y el importe se toma de la BD. Antes, para los productos sin variantes,
      // el `precio` que generaba GPT-4o iba directo al carrito y al pedido.
      const prodInv = buscarProductoExacto(args.producto ?? '')
      if (!prodInv) {
        const cercanos = buscarEnInventario(args.producto ?? '', null, 3).map(p => p.nombre)
        return `[NO agregado al carrito] No existe "${args.producto}" con ese nombre exacto en el inventario.${cercanos.length ? ` Los más parecidos son: ${cercanos.join(', ')}. Confirma con el cliente cuál quiere y vuelve a llamar agregar_al_carrito con el nombre EXACTO.` : ' Busca primero con buscar_productos.'}`
      }
      const nombreReal = prodInv.nombre
      const variantesPrecio = (prodInv.variantes || []).filter(v => v.etiqueta && v.precio > 0)
      const preciosDistintos = new Set(variantesPrecio.map(v => v.precio)).size > 1

      let etiquetaVariante = null
      let precioFinal = `$${Number(prodInv.precio ?? 0).toLocaleString('es-CO')}`
      if (preciosDistintos) {
        const elegida = encontrarVariante(prodInv, args.variante)
        if (!elegida) {
          const lista = variantesPrecio.map(v => `${v.etiqueta} → $${v.precio.toLocaleString('es-CO')}`).join(' | ')
          return `[NO agregado al carrito] "${nombreReal}" se vende en varias opciones con precios distintos${args.variante ? ` y "${args.variante}" no identifica una sola de ellas` : ''}: ${lista}. Pregúntale al cliente cuál quiere (enumerándole las opciones con su precio) y vuelve a llamar agregar_al_carrito con el campo variante EXACTO. NO le des un precio hasta que elija.`
        }
        etiquetaVariante = elegida.etiqueta
        precioFinal = `$${elegida.precio.toLocaleString('es-CO')}` // el precio manda desde la BD
      }
      // Si el modelo pasó un precio distinto al real, se registra: es señal de que está
      // inventando importes y conviene revisar el prompt.
      if (args.precio && parsearPrecio(args.precio) !== parsearPrecio(precioFinal)) {
        alertar('Modelo pasó un precio distinto al de la BD en agregar_al_carrito', `psid=${psid} producto="${nombreReal}" modelo=${args.precio} bd=${precioFinal}`)
      }
      const nombreCarrito = etiquetaVariante ? `${nombreReal} (${etiquetaVariante})` : nombreReal

      const carrito = await getCarrito(psid)
      if (carrito.length >= negocio.maxItemsCarrito) return `Tu carrito está lleno (máximo ${negocio.maxItemsCarrito} productos). Confirma la compra o elimina algo primero.`
      const ya = carrito.find(i => i.producto.toLowerCase() === (nombreCarrito ?? '').toLowerCase())
      if (ya) {
        // Actualizar cantidad si se especificó una diferente
        const nuevaCantidad = args.cantidad ?? ya.cantidad ?? 1
        ya.cantidad = nuevaCantidad
        await setCarrito(psid, carrito)
        const total = carrito.reduce((s, i) => s + parsearPrecio(i.precio) * (i.cantidad || 1), 0)
        return `Actualicé *${nombreCarrito}* a ${nuevaCantidad} unidad${nuevaCantidad > 1 ? 'es' : ''} en tu carrito 🛍️\nTotal: *$${total.toLocaleString('es-CO')}*\n\n¿Agregamos algo más o confirmamos el pedido?`
      }
      carrito.push({ producto: nombreCarrito, precio: precioFinal, cantidad: args.cantidad ?? 1 })
      await setCarrito(psid, carrito)

      // Si no vuelve, se le escribe UNA vez a las 24 h (y solo si sigue dentro de la
      // ventana de mensajería de Instagram).
      seguimientos.programarCarritoAbandonado(depsSeguimientos(), {
        destinatario: psid,
        producto:     nombreCarrito,
        nombre:       userInfo?.nombre ?? null,
      }).catch(e => console.warn('[seguimientos] carrito abandonado no programado:', e.message))
      const total = carrito.reduce((s, i) => s + parsearPrecio(i.precio) * (i.cantidad || 1), 0)
      return `¡Listo! 🛍️ *${nombreCarrito}* agregado al carrito por ${precioFinal}.\nTotal: *$${total.toLocaleString('es-CO')}* (${carrito.length} producto${carrito.length > 1 ? 's' : ''})\n\n¿Agregamos algo más o confirmamos el pedido?`
    }

    case 'quitar_del_carrito': {
      const carrito = await getCarrito(psid)
      if (!args.producto) {
        await setCarrito(psid, [])
        // Sin carrito no hay carrito que recordar.
        seguimientos.cancelar(depsSeguimientos(), { destinatario: psid, tipo: seguimientos.TIPOS.CARRITO_ABANDONADO }).catch(() => {})
        return 'Carrito vaciado 🗑️ ¿Te puedo ayudar a buscar algo? 😊'
      }
      // Antes se comparaba por los primeros 15 caracteres: "quita el sofá" con dos sofás
      // en el carrito borraba LOS DOS. Ahora se busca la coincidencia más específica y, si
      // hay varias candidatas, se le pide al cliente que aclare.
      const q = normalize(args.producto)
      const coincide = i => {
        const n = normalize(i.producto)
        return n === q || n.includes(q) || q.includes(n)
      }
      let candidatos = carrito.filter(coincide)
      if (candidatos.length > 1) {
        const exactos = candidatos.filter(i => normalize(i.producto) === q)
        if (exactos.length === 1) candidatos = exactos
      }
      if (!candidatos.length) return `No encontré *${args.producto}* en tu carrito. Escribe "ver carrito" para ver lo que tienes 😊`
      if (candidatos.length > 1) {
        return `[NO se quitó nada] "${args.producto}" coincide con varios productos del carrito: ${candidatos.map(i => i.producto).join(', ')}. Pregúntale al cliente cuál quiere quitar y vuelve a llamar quitar_del_carrito con el nombre completo.`
      }
      const aQuitar = candidatos[0]
      const filtrado = carrito.filter(i => i !== aQuitar)
      await setCarrito(psid, filtrado)
      return `Listo, eliminé *${aQuitar.producto}* del carrito. ${filtrado.length ? `Te quedan ${filtrado.length} producto(s).` : 'Tu carrito está vacío ahora.'} ¿Puedo ayudarte con algo más?`
    }

    case 'confirmar_pedido': {
      const carrito = await getCarrito(psid)
      if (!carrito.length) return 'Tu carrito está vacío 🛒 Agrega productos primero 😊'
      const total = carrito.reduce((s, i) => s + parsearPrecio(i.precio) * (i.cantidad || 1), 0)
      const resumen = carrito.map((i, idx) =>
        `${idx + 1}. ${i.producto} × ${i.cantidad || 1} — $${parsearPrecio(i.precio).toLocaleString('es-CO')}`
      ).join('\n')

      // Persistir ANTES de confirmarle al cliente: la notificación a Redes puede
      // fallar, y antes era la única constancia del pedido en todo el sistema.
      try {
        await db.guardarPedido(psid, carrito)
      } catch (e) {
        alertar('No se pudo guardar el pedido', `psid=${psid} ${e.message}`)
        return 'No pude registrar el pedido en este momento. Dile al cliente que un asesor lo contactará para completarlo, y llama a solicitar_asesor.'
      }
      evento(psid, 'pedido', `${total.toLocaleString('es-CO')}`)
      // El carrito ya es un pedido: recordárselo sería absurdo.
      seguimientos.cancelar(depsSeguimientos(), { destinatario: psid, tipo: seguimientos.TIPOS.CARRITO_ABANDONADO }).catch(() => {})

      notificarRedes(
        psid, userInfo,
        `PEDIDO CONFIRMADO:\n${resumen}\nTotal: $${total.toLocaleString('es-CO')}`,
        'pedido',
        { carrito }
      )
      await setCarrito(psid, [])
      const avisoPedido = avisoFueraHorario()
      await enviarTextoIA(psid,
        `¡Pedido confirmado! 🎉\n\n${resumen}\n\n*Total: $${total.toLocaleString('es-CO')}*\n\nUn asesor de ${negocio.nombreEmpresa} te contactará pronto para coordinar el pago y la entrega. ¡Gracias por elegir ${negocio.nombreEmpresa}! 😊${avisoPedido ? `\n\n${avisoPedido}` : ''}`
      )
      return `[Confirmación de pedido enviada al cliente con el resumen completo. Solo despídete con una frase corta, sin repetir el resumen.]`
    }

    default:
      return null
  }
}

// ── Notificación al sistema de ventas ─────────────────────────────────────────

// Mapeo sede (1-5) → tienda_id en la BD (mismo orden que el seeder)
// Sedes desde negocio.json (ver negocio.js): para otro cliente se edita ese archivo.
const { SEDE_TIENDA_ID, SEDE_NOMBRE } = negocio

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
    // Se relanza a propósito: antes se tragaba aquí y quien llamaba nunca se enteraba,
    // así que un pedido o una cita podían "confirmarse" al cliente sin que llegara
    // nada al sistema de ventas. Ahora cada caller decide qué hacer con el fallo.
    throw new Error(`[redes] notificación ${tipo} falló: ${e.response?.status ?? e.message}`)
  }
}

// Notifica a Redes sin bloquear la respuesta al cliente. La notificación puede tardar
// hasta ~56 s (timeout de 25 s + reintento), y no tiene sentido que el cliente espere
// eso para leer "voy a conectarte con un asesor". Si el envío directo falla, se ENCOLA
// en BD para que el worker lo reintente con backoff, en vez de perderse.
function notificarRedes(psid, userInfo, resumen, tipo, extra = {}, { alFallar } = {}) {
  enviarNotificacionSistema(psid, userInfo, resumen, tipo, extra)
    .catch(async e => {
      console.warn(`[redes] envío directo falló (${tipo} psid=${psid}), encolando para reintento:`, e.message)
      try {
        await db.encolarNotificacion(psid, tipo, {
          resumen, extra,
          userInfo: { nombre: userInfo?.nombre ?? null, username: userInfo?.username ?? null },
        })
      } catch (enqErr) {
        alertar(`No se pudo encolar notificación ${tipo}`, `psid=${psid} ${enqErr.message}`)
        if (alFallar) Promise.resolve().then(alFallar).catch(() => {})
      }
    })
}

// ¿El sistema de ventas rechazó la notificación de forma definitiva? Un 4xx (payload
// inválido, tipo desconocido, token equivocado) no se arregla reintentando; un 408/429 sí.
// El mensaje de error lo arma enviarNotificacionSistema con el status al final.
function esRechazoPermanente(e) {
  const m = /(\d{3})\s*$/.exec(String(e?.message ?? '').trim())
  if (!m) return false
  const status = Number(m[1])
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

// Worker: reintenta las notificaciones encoladas. Corre en intervalo desde startServer.
let procesandoCola = false
async function procesarColaNotificaciones() {
  if (procesandoCola) return // evita solapamiento si un ciclo tarda más que el intervalo
  procesandoCola = true
  try {
    const pendientes = await db.getNotificacionesPendientes(10)
    for (const n of pendientes) {
      const { resumen, extra, userInfo } = n.payload
      try {
        await enviarNotificacionSistema(n.psid, userInfo ?? {}, resumen, n.tipo, extra ?? {})
        await db.eliminarNotificacion(n.id)
        console.log(`[redes] notificación encolada #${n.id} (${n.tipo}) enviada tras reintento`)
      } catch (e) {
        const intentos = (n.intentos ?? 0) + 1
        // Un rechazo permanente (payload inválido, tipo desconocido, token equivocado) no
        // se arregla repitiéndolo: antes se reintentaba durante más de un día y la alerta
        // llegaba cuando ya nadie se acordaba del cliente. Se avisa al primer intento.
        if (esRechazoPermanente(e)) {
          await db.eliminarNotificacion(n.id)
          alertar(`Notificación ${n.tipo} RECHAZADA por el sistema de ventas`, `psid=${n.psid}: ${e.message} — revisar payload/tipo; hay que crear la tarjeta a mano`)
        } else if (intentos >= 8) {
          // ~cola llega hasta 120 min entre intentos; 8 intentos es más de un día.
          await db.eliminarNotificacion(n.id)
          alertar(`Notificación ${n.tipo} descartada tras ${intentos} intentos`, `psid=${n.psid}: ${e.message}`)
        } else {
          await db.reprogramarNotificacion(n.id, intentos, e.message)
        }
      }
    }
  } catch (e) {
    console.error('[redes] error procesando cola:', e.message)
  } finally {
    procesandoCola = false
  }
}

// Horario real de atención, leído de negocio.json (horario.semana / horario.sabado).
// (La versión anterior solo miraba la hora 21-8 e ignoraba el día de la semana,
// así que un mensaje sábado en la tarde o cualquier hora del domingo no avisaba
// nada aunque el asesor solo fuera a responder hasta el siguiente día hábil.)
//
// `margenCierreMin`: minutos antes del cierre a partir de los cuales ya se considera
// fuera de horario. Se usa para las transferencias: una solicitud que entra a las 4:50
// pm ya no la va a atender nadie ese día, así que para el cliente es "mañana".
// `proximaApertura` es el texto para decirle al cliente cuándo le responderá el asesor.
function estadoHorario(margenCierreMin = 0, ahora = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: negocio.zonaHoraria, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(ahora)
  const dia    = partes.find(p => p.type === 'weekday')?.value
  let hora     = parseInt(partes.find(p => p.type === 'hour')?.value)
  if (hora === 24) hora = 0
  const minuto = parseInt(partes.find(p => p.type === 'minute')?.value) || 0
  const min    = hora * 60 + minuto

  const h        = negocio.horario
  const rango    = dia === 'Sat' ? h.sabado : h.semana
  const apertura = rango.abre * 60
  const cierre   = rango.cierra * 60 - margenCierreMin
  const abierto  = !(dia === 'Sun' && h.domingoCerrado) && min >= apertura && min < cierre

  let proximaApertura
  if (abierto)                             proximaApertura = null
  else if (dia === 'Sun')                  proximaApertura = 'mañana lunes a partir de las 8am'
  else if (min < apertura)                 proximaApertura = 'hoy a partir de las 8am'
  else if (dia === 'Fri' || dia === 'Sat') proximaApertura = 'el lunes a partir de las 8am'
  else                                     proximaApertura = 'mañana a partir de las 8am'

  return { abierto, proximaApertura }
}

function avisoFueraHorario() {
  return estadoHorario().abierto
    ? null
    : `⚠️ Ten en cuenta que estamos fuera de nuestro horario de atención (${negocio.horarioTexto}) — puede que el asesor te responda hasta el próximo horario hábil, pero haremos nuestro mejor esfuerzo por atenderte pronto. ¡Gracias por tu paciencia! 🙏`
}

// Minutos antes del cierre a partir de los cuales una transferencia ya se trata como
// fuera de horario (Lun-Vie desde las 4:40 pm, Sáb desde las 11:40 am).
const MARGEN_CIERRE_TRANSFERENCIA_MIN = negocio.margenCierreTransferenciaMin

// ── Detección de foto de cuarto ───────────────────────────────────────────────

function esVisualizacion(texto) {
  if (!texto) return false
  return /\b(sala|cuarto|habitaci[oó]n|ambiente|visualiz|pon\s+(el|la)|c[oó]mo\s+(quedar[íi]a[n]?|se\s+ver[íi]a[n]?|luce[n]?|queda[n]?)|quedar[íi]a[n]?\s+(bien|aqu[íi]|ac[aá]|en)|queda[n]?\s+(bien|aqu[íi]|ac[aá]|en\s+este|en\s+mi)|ver\s+c[oó]mo\s+queda|quiero\s+ver\s+c[oó]mo)\b/i.test(texto)
}

// ── Manejador principal de mensajes ───────────────────────────────────────────

async function handleMessage(psid, texto, adjuntos, esStoryReply, storyUrl, storyId, noSoportado = false) {
  const userInfo = await getUserInfoCache(psid)
  await db.getOrCreateClienteByPsid(psid, userInfo.username, userInfo.nombre)

  // Cuánto llevaba el cliente sin escribir, medido ANTES de actualizarInteraccion: si se
  // consultara después siempre daría 0. Se usa más abajo para que Elena retome la
  // conversación en vez de seguir como si no se hubiera interrumpido.
  const minutosAusente = await db.minutosDesdeUltimaInteraccion(psid)

  // Mientras el cliente siga transferido a un asesor, la IA NO interviene bajo
  // ninguna circunstancia. Se libera cuando el asesor da "Terminar" en el panel de
  // Redes. Si nadie ha tomado la tarjeta todavía, hay además una red de seguridad por
  // inactividad del cliente (ver db.debeEsperarAsesor).
  //
  // Importante: NO se vuelve a notificar al sistema de ventas en cada mensaje del
  // cliente mientras espera — eso creaba una tarjeta "pendiente" nueva por cada
  // mensaje, como si fuera otra solicitud sin reclamar, aunque el cliente ya estuviera
  // siendo atendido. La solicitud original ya tiene el historial completo y el asesor
  // puede abrir el chat directamente.
  if (await db.debeEsperarAsesor(psid)) {
    await db.actualizarInteraccion(psid)
    // Guardar lo que el cliente escribe MIENTRAS lo atiende un asesor, para que la IA
    // tenga contexto si retoma el chat (Terminar en el panel de Redes o timeout).
    const contenidoCliente = texto?.trim() || (adjuntos?.length ? '[el cliente envió una imagen/adjunto]' : null)
    if (contenidoCliente) await db.guardarMensaje(psid, 'user', contenidoCliente)
    // El aviso "un asesor te responderá pronto" solo tiene sentido mientras NADIE ha
    // tomado la tarjeta. Con el chat ya tomado, el asesor está hablando con el cliente
    // por Instagram y este aviso automático se metía cada dos minutos en medio de esa
    // conversación, como si fuera otra persona interrumpiendo.
    if (!(await db.tomadaPorAsesor(psid)) && debeEnviarAvisoEspera(psid)) {
      await enviarTextoIA(psid, AVISO_ESPERA)
    }
    return
  }

  await db.actualizarInteraccion(psid)
  await ig.sendTypingOn(psid)

  // Imagen recibida — posible visualización de mueble en cuarto
  if (adjuntos?.length) {
    const imagenes = adjuntos.filter(a => a.type === 'image')
    // Solo se compone el mueble sobre la foto cuando el cliente lo PIDE ("cómo quedaría
    // en mi sala"). Antes bastaba con que ya se le hubiera mostrado un producto: toda
    // imagen posterior (una captura del mueble que quería, por ejemplo) se le devolvía con
    // el último producto pegado encima, sin pasar por visión ni por el hash de catálogo.
    if (imagenes.length && esVisualizacion(texto)) {
      const ultimoProd = await db.getUltimoProducto(psid)
      {
        const { buffer } = await ig.downloadMediaToBuffer(imagenes[0].payload.url)
        const result = await imgP.processRoomImage(buffer, ultimoProd)
        // Generar la visualización tarda bastante: si en ese rato un asesor tomó el
        // chat, no se le manda nada encima (el mismo criterio que en runAgentLoop).
        if (await db.asesorAtendiendo(psid)) {
          console.log(`[transferido] ${psid}: un asesor tomó el chat durante la visualización — se descarta`)
          await db.guardarMensaje(psid, 'user', '[imagen del cuarto]')
          return
        }
        if (result.success) {
          await ig.sendImageMessage(psid, result.url)
          await enviarTextoIA(psid, `Así quedaría *${ultimoProd.nombre}* en tu espacio 😊`)
          await db.guardarMensaje(psid, 'user', '[imagen del cuarto]')
          await db.guardarMensaje(psid, 'assistant', 'Visualización generada')
          return
        } else {
          await enviarTextoIA(psid, result.message)
          return
        }
      }
    }
  }

  let mensajeAI = texto ?? ''
  let imageBase64 = null  // imagen para visión de la IA
  let imageMimeType = 'image/jpeg'

  // Post compartido en DM (type: ig_post) — buscar producto + descargar imagen
  if (adjuntos?.length) {
    const postCompartido = adjuntos.find(a => a.type === 'ig_post' || a.type === 'share')
    if (postCompartido) {
      const caption  = postCompartido.payload?.title ?? ''
      const urlImagen = postCompartido.payload?.url ?? null  // CDN URL directa

      if (urlImagen) {
        try {
          const { buffer, contentType } = await ig.downloadMediaToBuffer(urlImagen)
          if (contentType?.startsWith('image/')) {
            imageBase64 = buffer.toString('base64')
            imageMimeType = contentType
            console.log('[post] imagen descargada para visión')
          }
        } catch (e) { console.warn('[post] no se pudo descargar imagen:', e.message) }
      }

      // Mismo criterio que en los reels: el caption solo cuenta si NOMBRA el producto.
      // Con una palabra suelta en común se le colaba al modelo un producto equivocado
      // como si fuera el que el cliente está mirando.
      const prodCaption = identificarProductoPorCaption(caption)
      if (prodCaption) {
        mensajeAI = `[El cliente compartió la publicación: "${caption}". Producto en inventario:\n${formatProducto(prodCaption)}]\n${mensajeAI || '¿Qué quieres saber sobre este producto?'}`
      } else if (imageBase64) {
        mensajeAI = `[El cliente compartió una publicación de ${negocio.cfg.empresa.instagram}${caption ? `: "${caption}"` : ''}. El texto no dice qué producto es, pero tienes la imagen adjunta: identifica el artículo que se ve ahí (puede ser un reloj, un espejo, una lámpara o cualquier objeto decorativo, no solo muebles grandes) y búscalo con buscar_productos. Si no lo reconoces con seguridad, pregúntale al cliente cuál le interesó. NO des por hecho ningún producto.]\n${mensajeAI || '¿Qué quieres saber sobre este producto?'}`
      } else {
        mensajeAI = `[El cliente compartió una publicación de ${negocio.cfg.empresa.instagram}${caption ? `: "${caption}"` : ''}, pero no pudimos ver la imagen ni identificar el producto. NO adivines: pregúntale qué artículo le llamó la atención o pídele una foto.]\n${mensajeAI || 'Quiero más información sobre esto'}`
      }
    }

    // Imagen directa que no es visualización de cuarto — pasar a visión de la IA
    const imagenes = adjuntos.filter(a => a.type === 'image')
    if (imagenes.length && !imageBase64 && !esVisualizacion(texto)) {
      try {
        const { buffer, contentType } = await ig.downloadMediaToBuffer(imagenes[0].payload.url)
        if (contentType?.startsWith('image/')) {
          imageBase64 = buffer.toString('base64')
          imageMimeType = contentType
        }
        if (!mensajeAI.trim()) mensajeAI = 'El cliente envió una imagen'
      } catch { /* continuar sin imagen */ }
    }

    // Video/reel compartido. El caption casi nunca nombra el producto, así que lo que
    // de verdad identifica el mueble es la imagen: se intenta bajar el fotograma de
    // portada del reel para que el modelo lo VEA, igual que se hace con las historias.
    const mediaAdj = adjuntos.find(a => ['video', 'reel', 'ig_reel'].includes(a.type))
    if (mediaAdj) {
      const captionReel = mediaAdj.payload?.title ?? mediaAdj.payload?.caption ?? ''

      if (!imageBase64) {
        const idReel = mediaAdj.payload?.reel_video_id ?? mediaAdj.payload?.media_id ?? mediaAdj.payload?.id
        if (idReel) {
          try {
            const det = await ig.getMediaDetails(idReel)
            const urlPortada = det?.thumbnail_url ?? det?.media_url
            if (urlPortada) {
              const { buffer, contentType } = await ig.downloadMediaToBuffer(urlPortada)
              if (contentType?.startsWith('image/')) {
                imageBase64 = buffer.toString('base64')
                imageMimeType = contentType
                console.log('[reel] portada descargada para visión')
              }
            }
          } catch (e) { console.warn('[reel] no se pudo obtener la portada:', e.message) }
        }
      }

      // El caption solo vale si NOMBRA el producto. Antes bastaba una palabra suelta en
      // común, y un reel de un reloj con caption "buenas noches..." hacía que el agente
      // le afirmara al cliente que quería una MESA DE NOCHE.
      const prodCaption = identificarProductoPorCaption(captionReel)
      if (prodCaption) {
        mensajeAI = `[El cliente compartió un reel de ${negocio.cfg.empresa.instagram}: "${captionReel}". Producto en inventario:\n${formatProducto(prodCaption)}]\n${mensajeAI || '¿Cuánto vale?'}`
      } else if (imageBase64) {
        mensajeAI = `[El cliente compartió un reel de ${negocio.cfg.empresa.instagram}${captionReel ? ` con el texto: "${captionReel}"` : ''}. NO sabemos qué producto es: el texto no lo nombra. Se te adjunta el fotograma de portada del reel — identifica el mueble que se ve AHÍ (mira bien: puede ser un reloj, un espejo, una lámpara o cualquier objeto decorativo, no solo muebles grandes) y búscalo con buscar_productos. Si no logras identificarlo con seguridad, pregúntale al cliente qué producto del video le interesó. NO des por hecho ningún producto.]\n${mensajeAI || '¿Cuánto vale?'}`
      } else {
        mensajeAI = `[El cliente compartió un reel de ${negocio.cfg.empresa.instagram}${captionReel ? ` con el texto: "${captionReel}"` : ''}, pero NO pudimos ver el video ni identificar el producto. NO adivines ni asumas de qué mueble se trata: pregúntale amablemente qué producto del video le llamó la atención, o pídele que te mande una foto o captura.]\n${mensajeAI}`
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
          await enviarTextoIA(psid, 'No pude entender el audio. ¿Podrías escribir tu consulta? 😊')
          return
        }
      } catch (e) {
        console.warn('[AUDIO] Error transcribiendo:', e.message)
        if (!mensajeAI.trim()) {
          await enviarTextoIA(psid, 'No pude procesar el audio. ¿Puedes escribir tu consulta? 😊')
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
      // Las historias en video no se pueden pasar como imagen a la IA — usar el thumbnail en su lugar
      const imagenHistoria = details?.media_type === 'VIDEO' ? details?.thumbnail_url : details?.media_url
      if (imagenHistoria && !imageBase64) {
        try {
          const { buffer, contentType } = await ig.downloadMediaToBuffer(imagenHistoria)
          if (contentType?.startsWith('image/')) {
            imageBase64 = buffer.toString('base64')
            imageMimeType = contentType
          }
        } catch { /* continuar sin imagen */ }
      }
    }
    const prefijo = `[El cliente respondió a una historia de ${negocio.cfg.empresa.instagram}.${storyCtx}]`
    mensajeAI = `${prefijo} ${mensajeAI || 'Quiero más información'}`
  }

  // Identificación por imagen: cubre el caso de un cliente que reenvía o captura
  // una foto que YA está en nuestro propio catálogo (p.ej. un screenshot de un post
  // donde el nombre del producto quedó cortado y no se puede leer). Si ya se
  // encontró el producto por caption (post/reel compartido), no hace falta repetirlo.
  if (imageBase64 && !mensajeAI.includes('Producto en inventario')) {
    const nombreDetectado = await identificarProductoPorImagen(Buffer.from(imageBase64, 'base64'))
    if (nombreDetectado) {
      // Usar el producto EXACTO que matcheó el hash (no re-buscar con fuzzy, que puede
      // derivar a otro producto distinto).
      const prod = inventario.find(p => p.nombre === nombreDetectado) ?? buscarEnInventario(nombreDetectado, null, 1)[0]
      if (prod) {
        const info = formatProducto(prod)
        // Instrucción estricta: sin esto el modelo tiende a renombrar el producto y a
        // inventar medidas/material (llenando los campos "consultar" con valores
        // plausibles), sobre todo cuando además está "viendo" la imagen.
        mensajeAI = `[COINCIDENCIA POR FOTO. La imagen coincide con este producto del catálogo. Usa EXACTAMENTE estos datos, textualmente:\n${info}\nREGLAS: no cambies ni acortes el nombre; no inventes medidas ni material; si un campo dice "consultar", dile al cliente que ese dato lo confirma un asesor. La imagen es secundaria: manda el dato del catálogo, no lo que creas ver.]\n${mensajeAI || '¿Qué quieres saber sobre este producto?'}`
      }
    } else {
      // El hash no la reconoce (no es la misma foto del catálogo): visión por categoría
      // (vision-catalogo.js) — clasifica qué mueble es y lo compara SOLO con las fotos
      // de esa categoría. Antes el modelo recibía la foto sin ninguna referencia visual
      // del catálogo y "parecido" lo decidía por los nombres en texto.
      const contextoVision = await identificarImagenPorCategoria(psid, { base64: imageBase64, mime: imageMimeType })
      if (contextoVision) mensajeAI = `${contextoVision}\n${mensajeAI || '¿Qué quieres saber sobre este producto?'}`
    }
  }

  // El cliente mandó algo (casi siempre una foto) que Instagram no nos dejó ver, y no
  // se identificó ningún producto por imagen. Se lo decimos al modelo para que lo
  // reconozca — típicamente el cliente muestra un modelo que quiere, muchas veces para
  // que se lo fabriquemos a la medida.
  if (noSoportado && !imageBase64 && !mensajeAI.includes('COINCIDENCIA POR FOTO') && !mensajeAI.includes('Producto en inventario')) {
    mensajeAI = `[El cliente envió una FOTO que no pudimos recibir por Instagram (no la vemos). Probablemente muestra un mueble/modelo que le interesa. NO asumas que es uno de nuestros productos ni le muestres opciones como si fuera "lo que busca": primero pídele con amabilidad que te la reenvíe o que te describa el mueble (tipo, medidas, color). Y recuerda que en ${negocio.nombreEmpresa} fabricamos a la medida: si quiere un mueble como el de su foto, podemos hacérselo — para eso ofrécele pasarlo con un asesor (personalización).]\n${mensajeAI}`
  }

  if (!mensajeAI.trim()) return

  // Detectar primer mensaje ANTES de guardar para que el historial esté vacío
  const histPrev       = await db.getHistorial(psid, 1)
  const esPrimerMensaje = histPrev.length === 0
  if (esPrimerMensaje) evento(psid, 'conversacion')

  try {
    const SALUDO_IG = negocio.saludo('instagram')
    const esSoloSaludo = /^[¡!¿?\s]*(hola|holis|holi|holaa|buenas?|buenos\s*(dias?|tardes?|noches?)|que\s*tal|hi|hello|hey|saludos)[¡!¿?\s.]*$/i.test(mensajeAI.trim())

    if (esPrimerMensaje && esSoloSaludo) {
      // Solo saludo inicial: responder con el hardcodeado (con botones rápidos) y no
      // llamar a OpenAI. sendQuickReplies cae solo a texto si el envío falla.
      // El saludo va con botones, así que no pasa por enviarTextoIA: se registra a mano
      // para reconocer su eco y no confundirlo con un asesor escribiendo.
      registrarEnviadoPorIA(psid, SALUDO_IG)
      const saludado = await ig.sendQuickReplies(psid, SALUDO_IG, QUICK_MENU)
      await db.guardarMensaje(psid, 'user', mensajeAI)
      // Si el saludo no salió, no queda en el historial: así el siguiente mensaje del
      // cliente vuelve a contar como primer contacto y sí recibe la bienvenida.
      if (saludado) await db.guardarMensaje(psid, 'assistant', SALUDO_IG)
      return
    }

    // Contexto de los productos recién mostrados (carrusel/foto/búsqueda), para que
    // "esa / la segunda / la de $X" se resuelva. Es efímero: no se guarda en historial.
    let contextoMostrados = null
    const mostrados = await db.getUltimosMostrados(psid)
    if (mostrados?.length) {
      const lista = mostrados.map((p, i) => `${i + 1}) ${p.nombre} — $${Number(p.precio ?? 0).toLocaleString('es-CO')}`).join('; ')
      contextoMostrados = `Productos que le mostraste al cliente hace un momento: ${lista}. Si el cliente dice "esa", "la segunda", "la primera", "la de $X", "la última", etc., se refiere a uno de estos — resuélvelo con esta lista y usa el nombre EXACTO.`
    }

    // Si el cliente vuelve tras un rato, el modelo debe saberlo para retomar en vez de
    // seguir como si la conversación no se hubiera interrumpido (mismo criterio que el
    // agente de WhatsApp).
    if (Number.isFinite(minutosAusente) && minutosAusente >= 45) {
      const cuanto = minutosAusente >= 120 ? `${Math.round(minutosAusente / 60)} horas` : `${minutosAusente} minutos`
      contextoMostrados = `${contextoMostrados ? `${contextoMostrados}\n` : ''}El cliente vuelve tras ${cuanto} sin escribir. Su carrito y lo que ya habló siguen guardados (mira el historial). Salúdalo brevemente reconociendo que había pasado un rato, retoma donde quedó (sin repetir el saludo de bienvenida ni volver a preguntarle todo) y confirma si sigue interesado en lo mismo.`
    }

    // runAgentLoop lee el historial y le anexa el mensaje actual; guardamos el
    // mensaje del usuario DESPUÉS para no inyectarlo dos veces en el contexto.
    // Devuelve null si un asesor tomó el chat a mitad del turno: el mensaje del cliente
    // se guarda igual (contexto para cuando la IA retome) pero no se le envía nada.
    const respuestaFinal = await runAgentLoop(psid, mensajeAI, imageBase64, userInfo, imageMimeType, contextoMostrados)
    await db.guardarMensaje(psid, 'user', imageBase64 ? `${mensajeAI} [+imagen]` : mensajeAI)
    if (respuestaFinal) {
      // Solo se guarda como dicho lo que de verdad se entregó: si el envío falla, en el
      // turno siguiente Elena no puede dar la respuesta por dicha. sendTextMessage
      // devuelve false cuando Graph API rechaza el envío.
      const entregado = await enviarTextoIA(psid, respuestaFinal)
      if (entregado) {
        await db.guardarMensaje(psid, 'assistant', respuestaFinal)
      } else {
        alertar('No se pudo entregar la respuesta al cliente', `psid=${psid} — Graph API rechazó el envío`)
      }
    }
  } catch (e) {
    console.error('[AI] Error:', e.message)
    await db.guardarMensaje(psid, 'user', imageBase64 ? `${mensajeAI} [+imagen]` : mensajeAI)
    // Si un asesor ya está con el cliente, no tiene sentido ni el aviso de error ni
    // otra tarjeta pidiendo asesor: él ya lo está atendiendo.
    if (await db.asesorAtendiendo(psid).catch(() => false)) return

    // Si OpenAI está caído (ya se reintentó con backoff), no se molesta a un asesor por
    // cada cliente: durante una caída con varios clientes activos eso son tantas tarjetas
    // falsas como clientes. Se le pide paciencia y solo se escala si vuelve a fallar en su
    // siguiente mensaje, o si el error es nuestro.
    if (reintentos.esFalloDelProveedor(e) && !registrarFalloTecnico(psid)) {
      alertar('OpenAI no responde', `psid=${psid} — ${e.message}`)
      await enviarTextoIA(psid, 'Se me complicó la conexión un momento 🙏 ¿Me repites tu último mensaje? Ya te atiendo 😊')
      return
    }
    await enviarNotificacionSistema(psid, userInfo, `Error técnico procesando el mensaje del cliente: ${e.message}. Revisar y contactar manualmente.`, 'asesor').catch(err => console.error('[redes] no se pudo notificar error:', err.message))
    const avisoError = avisoFueraHorario()
    await enviarTextoIA(psid, `Tuve un problema procesando tu mensaje. Un asesor te contactará pronto 🙏${avisoError ? `\n\n${avisoError}` : ''}`)
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

  procesarEventos(body).catch(e => alertar('procesarEventos falló', e.message))
})

async function procesarEventos(body) {
  for (const entry of body.entry ?? []) {
    // Comentarios en publicaciones (requiere suscripción al campo 'comments' del webhook).
    for (const change of entry.changes ?? []) {
      if (change.field === 'comments') {
        await manejarComentario(change.value).catch(e => console.error('[comentario] error:', e.message))
      }
    }

    for (const event of entry.messaging ?? []) {
      // Mensajes "de nuestro lado": ecos del propio bot, o lo que un asesor escribe
      // desde el Instagram de la empresa (llega como is_echo o con sender = nuestra cuenta).
      // Antes se descartaban del todo (arreglo del bucle en que el asesor le escribía al
      // cliente y el bot lo reprocesaba). Ahora, si el chat está tomado por un asesor,
      // guardamos lo que el asesor escribió para que la IA tenga contexto al retomar. Los
      // envíos de la propia IA no se guardan aquí (ya los guarda ella cuando responde).
      const esNuestro = !!event.message?.is_echo ||
        (event.sender?.id && event.sender.id === process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID)
      if (esNuestro) {
        const psidCliente = event.recipient?.id // en un eco, el destinatario es el cliente
        const textoAsesor = event.message?.text
        if (psidCliente && textoAsesor) {
          // Si el texto no es uno de los que envió la IA, lo escribió una persona: se la
          // silencia en el acto, sin esperar a que nadie pulse "Tomar" en el panel.
          detectarAsesorHumano(psidCliente, textoAsesor)
            .catch(e => console.warn('[asesor-humano] no se pudo procesar el eco:', e.message))
        }
        continue
      }

      const psid       = event.sender?.id
      // quick_reply (botón bajo un texto) y postback (botón de carrusel) llegan como
      // payload; se traduce a un mensaje de cliente para que el flujo siga igual. Al
      // tocar un quick reply, Meta manda también el título como texto: se prioriza el
      // payload mapeado (más fiable) y se cae al texto solo si el payload es desconocido.
      const payload    = event.message?.quick_reply?.payload ?? event.postback?.payload ?? null
      const texto      = payload
        ? (payloadAIntent(payload) ?? event.message?.text ?? null)
        : (event.message?.text ?? null)
      const adjuntos   = event.message?.attachments ?? null
      const storyReply = !!event.message?.reply_to?.story
      const storyUrl   = event.message?.reply_to?.story?.url ?? null
      const storyId    = event.message?.reply_to?.story?.id ?? null
      // Instagram marca así los mensajes cuyo contenido la API no puede recibir (a
      // veces fotos/adjuntos): llega sin imagen usable. Nos sirve para saber que el
      // cliente SÍ mandó algo (probablemente una foto) aunque no la podamos ver.
      const noSoportado = !!event.message?.is_unsupported

      if (!psid) continue

      // Deduplicar: Meta reenvía el mismo evento varias veces. Ahora es durable en BD
      // (antes un Set en memoria: tras un redeploy de Render se re-procesaban mensajes
      // ya contestados, y con más de una instancia no servía).
      const mid = event.message?.mid ?? event.postback?.mid
      if (mid && !(await db.registrarMid(mid))) {
        console.log(`[webhook] mid duplicado ignorado: ${mid}`)
        continue
      }

      // Un mensaje no soportado sin texto ni adjunto igual se procesa (para avisarle al
      // cliente que no vimos su foto), así que no se descarta por venir "vacío".
      if (texto === null && !adjuntos?.length && !storyReply && !noSoportado) continue

      recibirMensaje(psid, texto, adjuntos, storyReply, storyUrl, storyId, noSoportado)
    }
  }
}

// (Lo que escribe un asesor humano ahora lo maneja detectarAsesorHumano, más arriba: no
// solo guarda el mensaje, también silencia a la IA en el acto. La versión anterior solo
// guardaba, y únicamente si alguien ya había marcado el chat como transferido en el panel.)

// ── Comentarios en publicaciones → invitar al DM ──────────────────────────────
// Regla de negocio: en el comentario público NUNCA se dan precios ni detalles. Solo
// se responde (con una respuesta privada que abre el DM) cuando el comentario pregunta
// por precio, medidas, disponibilidad o cómo comprar. Los comentarios que no preguntan
// nada (elogios, emojis, etiquetas a amigos) no se responden.
function comentarioEsConsulta(texto) {
  if (!texto) return false
  const t = normalize(texto)
  return /(precio|vale|cuanto|cuesta|valor|costo|medida|tama|dimension|disponible|disponibilidad|hay|tienen|queda|consigo|comprar|domicilio|envio|cuota|credito|addi|informacion|info|interesa|me\s+gusta\s+cuanto)/.test(t)
}

// ── Respuesta pública a comentarios ───────────────────────────────────────────
// Lo que se escribe en un comentario lo lee todo el mundo y queda ahí, así que la
// clasificación es por reglas y no por IA: el modelo podría inventarse un precio o
// picar el anzuelo de un comentario provocador, y eso en público no se puede deshacer.
// La lista es blanca — si un comentario no encaja en ninguna categoría, no se responde.

// Comentarios agresivos o de queja pública: no se contesta NADA (ni público ni privado).
// Discutir en comentarios solo alimenta el hilo, y una respuesta automática a una queja
// real se lee como si la marca no estuviera escuchando. Lo atiende una persona.
function comentarioEsHostil(texto) {
  const t = normalize(texto)
  return /(estafa|estafador|ladron|roban|robaron|rateros|pesim[ao]|horrible|basura|porqueria|no\s+sirve|no\s+val(e|en)\s+(nada|la\s+pena)|nunca\s+(mas|responden|contestan)|denuncia|demanda|tutela|fraude|incumpl|mentira|mentiroso|verguenza|maldit|idiota|imbecil|estupid|tarad|hp\b|hijuep|gonorrea|malparid|put[ao]\b|mierda|cagada|jodid)/.test(t)
}

// Temas que SÍ se pueden responder en el comentario: son datos públicos, fijos y que no
// dependen del producto. Nada de precios, medidas ni disponibilidad.
//
// Las reglas piden intención explícita de preguntar, no solo que aparezca la palabra: un
// "saludos desde Armenia" o un "feliz sábado" no deben provocar que la cuenta suelte sus
// direcciones o su horario debajo de la foto.
function clasificarComentario(texto) {
  const t = normalize(texto)
  if (comentarioEsHostil(t)) return 'hostil'

  const preguntaUbicacion =
    /(donde\s+(estan|queda|es|los\s+ubico|puedo\s+ver|los\s+encuentro)|ubicacion|ubicados|direccion|sedes?\b|almacen|tienda\s+(fisica|queda|estan|hay)|en\s+que\s+ciudad|como\s+llego)/.test(t) ||
    /(tienen|hay|abrieron|queda|estan).*(armenia|pereira|quindio|risaralda)/.test(t) ||
    /(armenia|pereira|quindio|risaralda).*(tienen|hay|sede|tienda|queda|estan)/.test(t)
  if (preguntaUbicacion) return 'ubicacion'

  const preguntaHorario =
    /(horario|a\s+que\s+hora|que\s+hora|hora\s+(abren|cierran|atienden)|abren|cierran|atienden|estan\s+abiertos)/.test(t) ||
    /(domingo|festivo|sabado)s?\s+(abren|atienden|trabajan|estan)/.test(t)
  if (preguntaHorario) return 'horario'

  if (/(catalogo|catalogos|portafolio|brochure|folleto)/.test(t)) return 'catalogo'
  if (comentarioEsConsulta(t)) return 'consulta'
  return null
}

// Textos públicos (van en comentarios de publicaciones, los lee cualquiera): desde config.
const SEDES_PUBLICO = negocio.sedesPublico

const HORARIO_PUBLICO = negocio.horarioPublico

// Texto que se publica como respuesta al comentario, según el tema detectado.
function respuestaPublicaComentario(tipo) {
  switch (tipo) {
    case 'ubicacion':
      return `¡Hola! 😊 Estas son nuestras sedes:\n${SEDES_PUBLICO}\n\n¡Te esperamos! 🛋️`
    case 'horario':
      return `¡Hola! 😊 Nuestro horario es:\n${HORARIO_PUBLICO}\n\n¡Te esperamos! 🛋️`
    case 'catalogo':
      return '¡Claro que sí! 😊 Te acabamos de escribir por privado para enviarte el catálogo 📩'
    case 'consulta':
      return '¡Hola! 😊 Ya te escribimos al privado para resolver tu duda 📩'
    default:
      return null
  }
}

async function manejarComentario(value) {
  const commentId = value?.id
  const texto     = value?.text ?? ''
  const fromId    = value?.from?.id

  if (!commentId) return
  // No responder los comentarios propios de la cuenta.
  if (fromId && fromId === process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID) return

  const tipo = clasificarComentario(texto)
  // Sin tema reconocible ("qué lindo 😍", etiquetas a amigos) no hay nada que responder.
  // Los hostiles se dejan para una persona: contestarles en automático empeora el hilo.
  if (!tipo || tipo === 'hostil') {
    if (tipo === 'hostil') console.log(`[comentario] ${commentId} clasificado como hostil, se deja a un humano`)
    return
  }

  // Una sola respuesta por comentario (Meta lo exige y evita spam).
  if (!(await db.registrarComentario(commentId))) return

  // 1) Respuesta pública, con datos fijos que no dependen del producto: nunca precios.
  const publica = respuestaPublicaComentario(tipo)
  if (publica) {
    const okPublica = await ig.replyToComment(commentId, publica)
    console.log(`[comentario] respuesta pública (${tipo}) ${okPublica ? 'enviada' : 'falló'} para ${commentId}`)
  }

  // 2) Mensaje privado: es donde de verdad se resuelve la consulta. Para el catálogo se
  //    manda el de la categoría que pidió, si se puede deducir del propio comentario.
  const privada = tipo === 'catalogo'
    ? mensajePrivadoCatalogo(texto)
    : '¡Hola! 😊 Con gusto te damos toda la info por aquí en privado. ¿Qué mueble te interesa? 🛋️'
  const ok = await ig.sendPrivateReplyToComment(commentId, privada)
  if (ok) console.log(`[comentario] respuesta privada enviada para comment ${commentId}`)
}

// Arma el DM del catálogo. Si en el comentario se adivina la categoría ("catálogo de
// sofás") se manda ese enlace; si no, se le pregunta cuál quiere en vez de soltarle los
// quince.
function mensajePrivadoCatalogo(texto) {
  const t = normalize(texto)
  const porCategoria = [
    ['sofas_camas',      /sofa\s*cama|sofacama/],
    ['sofas_modulares',  /modular/],
    ['sofas',            /sofa|sala/],
    ['camas',            /cama|alcoba|dormitorio/],
    ['colchones',        /colchon/],
    ['bases_comedores',  /comedor|base|mesa\s+de\s+comedor/],
    ['sillas_comedor',   /silla.*comedor|comedor.*silla/],
    ['sillas_barra',     /barra|bar\b/],
    ['sillas_auxiliares',/silla/],
    ['mesas_centro',     /mesa\s*de\s*centro|centro/],
    ['mesas_noche',      /mesa\s*de\s*noche|nochero/],
    ['mesas_tv',         /tv|televisor|rack/],
    ['mesas_auxiliares', /mesa/],
    ['escritorios',      /escritorio|estudio|oficina/],
    ['cajoneros_bifes',  /cajonera|cajonero|bife|comoda/],
  ]
  for (const [clave, re] of porCategoria) {
    if (re.test(t) && catalogosDB[clave]) {
      return `¡Hola! 😊 Aquí tienes nuestro catálogo:\n${catalogosDB[clave]}\n\n¿Hay algún mueble que te haya gustado? Con gusto te ayudo 🛋️`
    }
  }
  return '¡Hola! 😊 Con gusto te comparto nuestro catálogo. ¿De qué te interesa: sofás, camas, comedores, colchones, mesas o sillas? 🛋️'
}

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
app.get('/', (req, res) => res.json({ ok: true, servicio: `${negocio.nombreEmpresa} Instagram Agent`, inventario: inventario.length }))

// Protege endpoints internos con el mismo DECASA_AGENT_TOKEN (header X-Agent-Token o
// ?token=). Sin token configurado se rechaza todo: mejor un 401 que exponer datos.
function requireAgentToken(req, res, next) {
  const token = process.env.DECASA_AGENT_TOKEN
  const dado  = req.headers['x-agent-token'] ?? req.query.token
  if (!token || dado !== token) return res.status(401).json({ error: 'no autorizado' })
  next()
}

// ── Debug stock (temporal) ────────────────────────────────────────────────────
app.get('/debug-stock', requireAgentToken, async (req, res) => {
  const nombre = req.query.nombre ?? 'BASE 2K'
  try {
    const filas = await db.consultarStock(nombre)
    res.json({ nombre, filas, inventario_cargado: inventario.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Métricas de negocio ───────────────────────────────────────────────────────
// Protegido con el mismo DECASA_AGENT_TOKEN (header X-Agent-Token o ?token=). Sin
// token configurado, se rechaza para no exponer datos.
app.get('/stats', requireAgentToken, async (req, res) => {
  try {
    const dias = Math.min(Math.max(parseInt(req.query.dias ?? '30') || 30, 1), 365)
    res.json(await db.getMetricas(dias))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Páginas legales requeridas por Meta ───────────────────────────────────────
app.get('/privacy', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Política de Privacidad — ${negocio.nombreEmpresa}</title>
  <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6}h1{color:#333}</style></head>
  <body>
  <h1>Política de Privacidad — ${negocio.nombreEmpresa} Instagram Bot</h1>
  <p><strong>Última actualización:</strong> mayo 2026</p>
  <p>Este asistente de Instagram (<strong>${negocio.nombreAsesora}</strong>) es operado por <strong>${negocio.nombreEmpresa}</strong>, ${negocio.cfg.empresa.descripcion} con sede en ${negocio.cfg.empresa.pais}.</p>
  <h2>Datos que recopilamos</h2>
  <ul>
    <li>Tu nombre e ID de usuario de Instagram (PSID) para gestionar tu conversación.</li>
    <li>Los mensajes que envías, para responder tus consultas sobre productos.</li>
    <li>Fotos que compartas voluntariamente para la función de visualización de muebles.</li>
  </ul>
  <h2>Uso de los datos</h2>
  <p>Los datos se usan exclusivamente para responder consultas, agendar citas y mejorar la atención al cliente de ${negocio.nombreEmpresa}. No compartimos tu información con terceros.</p>
  <h2>Retención</h2>
  <p>El historial de conversación se conserva por ${negocio.retencionHistorialDias} días y luego se elimina automáticamente.</p>
  <h2>Contacto</h2>
  <p>Para cualquier duda sobre privacidad escríbenos a <a href="mailto:${negocio.emailPrivacidad ?? ""}">${negocio.emailPrivacidad ?? ""}</a></p>
  </body></html>`)
})

app.get('/delete-data', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Eliminación de datos — ${negocio.nombreEmpresa}</title>
  <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6}h1{color:#333}</style></head>
  <body>
  <h1>Solicitud de eliminación de datos — ${negocio.nombreEmpresa}</h1>
  <p>Para solicitar la eliminación de tus datos de conversación con el asistente de ${negocio.nombreEmpresa} en Instagram, envía un correo a:</p>
  <p><strong><a href="mailto:${negocio.emailPrivacidad ?? ""}">${negocio.emailPrivacidad ?? ""}</a></strong></p>
  <p>Indica tu nombre de usuario de Instagram y procesaremos tu solicitud en un plazo de 72 horas.</p>
  </body></html>`)
})

// Avisa si el token que protege /stats y el webhook de Redes es débil o ausente.
function revisarSeguridad() {
  if (!process.env.OPENAI_API_KEY) console.error('[seguridad] ❌ OPENAI_API_KEY ausente: el agente no podrá responder.')
  const t = process.env.DECASA_AGENT_TOKEN
  const debiles = ['', 'decasa_agent_2026', 'changeme', 'token', 'secret']
  if (!t || debiles.includes(t)) {
    console.warn('[seguridad] ⚠️ DECASA_AGENT_TOKEN ausente o débil. Rótalo por un valor largo y aleatorio (ver AGENT.md).')
  }
}

// ── Inicio ────────────────────────────────────────────────────────────────────
async function startServer() {
  revisarSeguridad()
  await db.runMigrations()
  await db.eliminarCatalogosDescuento()
  const refrescarInventarioYHashes = async () => {
    await cargarInventario()
    await sincronizarHashesCatalogo()
  }
  await refrescarInventarioYHashes()
  await cargarCatalogos()
  setInterval(() => {
    refrescarInventarioYHashes().catch(e => console.error('[inventario] error refrescando:', e.message))
  }, 30 * 60 * 1000)
  setInterval(cargarCatalogos, 30 * 60 * 1000)

  // Limpiar historial antiguo al arrancar y luego cada 24 horas
  db.limpiarHistorialAntiguo(90).catch(e => console.error('[db] limpieza error:', e.message))
  setInterval(() => {
    db.limpiarHistorialAntiguo(90).catch(e => console.error('[db] limpieza error:', e.message))
    db.limpiarMidsAntiguos(2).catch(e => console.error('[db] limpieza mids error:', e.message))
  }, 24 * 60 * 60 * 1000)

  // Worker de la cola durable de notificaciones a Redes (reintentos con backoff).
  setInterval(() => { procesarColaNotificaciones() }, 60 * 1000)

  // Vigilancia del negocio: avisa si el agente deja de vender EN SILENCIO (inventario
  // vacío, ninguna conversación en horario, notificaciones que no llegan al panel, token
  // de Meta a punto de caducar). Las otras alertas solo cubren que el proceso se caiga.
  vigilancia.iniciarVigilancia({
    contarConversaciones:          horas => db.contarConversacionesRecientes(horas),
    contarInventario:              () => inventario.length,
    contarNotificacionesAtascadas: () => db.contarNotificacionesAtascadas(),
    estadoHorario:                 () => estadoHorario(),
    expiracionToken:               () => ig.expiracionToken(),
    alertar,
  }, 30)

  // Seguimientos: recordatorios de cita y carrito abandonado. Solo dentro de la ventana de
  // 24 h de Instagram y nunca por encima de un asesor humano (ver core/seguimientos.js).
  seguimientos.iniciarWorker(depsSeguimientos(), 10)

  app.listen(PORT, () => {
    console.log(`[server] Instagram Agent corriendo en puerto ${PORT}`)
  })
}

// Solo arranca el servidor cuando se ejecuta directamente (node index.js). Al
// requerirlo desde los tests, NO arranca — así se pueden probar las funciones puras
// sin abrir el puerto ni conectar a la BD.
if (require.main === module) {
  startServer().catch(e => { console.error(e); process.exit(1) })
}

// Superficie exportada para tests unitarios (funciones puras / con inyección).
module.exports = {
  TOOLS,
  extraerPrecios, validarPrecios, setPreciosInventarioParaPruebas,
  comentarioEsConsulta, payloadAIntent, normalize,
  buscarEnInventario,
  ejecutarTool,
  clasificarComentario, respuestaPublicaComentario, comentarioEsHostil, mensajePrivadoCatalogo,
  manejarComentario,
  identificarProductoPorCaption, buscarProductoExacto,
  // Variantes de precio (un producto con varias medidas que valen distinto)
  infoPrecioVariantes, precioMinimo, encontrarVariante, formatProducto, etiquetaPrecio,
  encolar,
  estadoHorario, MARGEN_CIERRE_TRANSFERENCIA_MIN,
  // Detección de asesor humano por los ecos de Instagram
  registrarEnviadoPorIA, ecoEsDeLaIA, textoCoincideCon, detectarAsesorHumano, normalizarEco,
  setInventarioParaPruebas: (arr) => { inventario = arr },
}
