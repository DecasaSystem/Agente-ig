'use strict'
// Tests unitarios de las funciones puras del agente. Se usa el runner integrado de
// Node (node:test) para no depender de Jest ni de un npm install.
//   Ejecutar con:  npm test   (o: node --test)
// Requiere index.js SIN arrancar el servidor (guard require.main === module).

const { test } = require('node:test')
const assert = require('node:assert/strict')

const agente = require('../index.js')

test('extraerPrecios: capta precios reales, ignora medidas y cantidades', () => {
  assert.deepEqual(agente.extraerPrecios('El Sofacama Roma es $3.000.000, mide 1.80x0.90'), [3000000])
  assert.deepEqual(agente.extraerPrecios('Cama Bethel $3.380.000 y mesa $780.000'), [3380000, 780000])
  assert.deepEqual(agente.extraerPrecios('Mide 2.00 x 1.60, patas de 0.15'), [])
  assert.deepEqual(agente.extraerPrecios('son 3 sillas a 12 cuotas'), [])
  assert.deepEqual(agente.extraerPrecios('precio 780000 sin puntos'), [780000])
})

test('validarPrecios: pasa precios reales y totales de carrito, marca inventados', () => {
  agente.setPreciosInventarioParaPruebas([3000000, 3380000, 780000])
  const vistos = new Set([4160000]) // total de carrito visto en el turno

  assert.deepEqual(agente.validarPrecios('p', 'La Cama Bethel cuesta $3.380.000', vistos), [])
  assert.deepEqual(agente.validarPrecios('p', 'Total: $4.160.000', vistos), [])
  assert.deepEqual(agente.validarPrecios('p', 'Te lo dejo en $2.500.000', vistos), [2500000])
})

test('comentarioEsConsulta: verdadero solo para preguntas de precio/disponibilidad', () => {
  for (const t of ['¿Cuánto vale?', 'Precio?', 'que medidas tiene', 'lo hacen a domicilio?', 'me interesa', 'tienen disponible?']) {
    assert.equal(agente.comentarioEsConsulta(t), true, `debería ser consulta: "${t}"`)
  }
  for (const t of ['Que hermoso 😍', '🔥🔥🔥', '@maria mira esto', 'felicitaciones', '']) {
    assert.equal(agente.comentarioEsConsulta(t), false, `NO debería ser consulta: "${t}"`)
  }
})

test('payloadAIntent: mapea botones a intención, null si desconocido', () => {
  assert.equal(agente.payloadAIntent('MENU::CATALOGO'), 'Quiero ver el catálogo')
  assert.equal(agente.payloadAIntent('MENU::AGENDAR'), 'Quiero agendar una visita')
  assert.equal(agente.payloadAIntent('MENU::ASESOR'), 'Quiero hablar con un asesor')
  assert.equal(agente.payloadAIntent('INTERESA::Cama Bethel'), 'Me interesa el Cama Bethel, cuéntame más 😊')
  assert.equal(agente.payloadAIntent('XYZ'), null)
  assert.equal(agente.payloadAIntent(null), null)
})

test('normalize: minúsculas y sin acentos', () => {
  assert.equal(agente.normalize('MIÉRCOLES Ñoño'), 'miercoles nono')
  assert.equal(agente.normalize('  Sofá  '), 'sofa')
})

test('buscarEnInventario: filtra bases por nº de puestos y por forma', () => {
  const inv = [
    { nombre: 'BASE 2K',          precio: 1480000, medidas: '1.20 x 0.90 (4 Puestos)',            material: 'madera',  subcategoria: 'bases_comedores' },
    { nombre: 'BASE ABANICA',     precio: 2180000, medidas: 'Cubierta 120 Diametro (4 Puestos)',  material: 'chapilla',subcategoria: 'bases_comedores' },
    { nombre: 'BASE FIGY RECTA',  precio: 2680000, medidas: '1.60 x 1.00 (6 Puestos)',            material: 'chapilla',subcategoria: 'bases_comedores' },
    { nombre: 'BASE FIGY CURVA',  precio: 7880000, medidas: '2.20 x 0.90 (8 Puestos)',            material: 'chapilla',subcategoria: 'bases_comedores' },
    { nombre: 'SILLA COMEDOR ALEXA', precio: 780000, medidas: 'Standard',                          material: 'madera',  subcategoria: 'sillas_comedor' },
  ]
  agente.setInventarioParaPruebas(inv)

  // "comedor 4 puestos" debe traer las bases de 4 puestos ANTES que las sillas.
  const cuatro = agente.buscarEnInventario('comedor 4 puestos', null, 5).map(p => p.nombre)
  assert.ok(cuatro[0] === 'BASE 2K' || cuatro[0] === 'BASE ABANICA', `esperaba una base de 4 puestos primero, dio ${cuatro[0]}`)
  assert.ok(!cuatro.slice(0, 2).includes('BASE FIGY RECTA'), 'una base de 6 puestos no debería salir primero')

  // "en forma de copa" (pedestal) → base redonda con "Diametro".
  const copa = agente.buscarEnInventario('mesa comedor en forma de copa', 'bases_comedores', 5).map(p => p.nombre)
  assert.equal(copa[0], 'BASE ABANICA', `esperaba la base redonda (Diametro) primero, dio ${copa[0]}`)
})

// ── Variantes de precio ───────────────────────────────────────────────────────
// Un producto puede venderse en varias medidas con precios distintos. Antes el agente
// cotizaba siempre precio_base: para el COLCHON SOPHIA decía $760.000 cuando la medida
// de 1.40 vale $960.000, comprometiendo un precio por debajo del real.

const CAMA_MIAMI = {
  nombre: 'CAMA MIAMI', precio: 2880000, medidas: '1.60 / 1.90', material: 'Flor Morado',
  subcategoria: 'camas', imagen: 'x.jpg',
  variantes: [
    { etiqueta: '1.90', precio: 2480000, tipo: 'Cama Miami medidas', afectaPrecio: true },
    { etiqueta: '1.60', precio: 2980000, tipo: 'Cama Miami medidas', afectaPrecio: true },
  ],
}
const CAMA_SIMPLE = {
  nombre: 'CAMA SENCILLA', precio: 1200000, medidas: '1.00 x 1.90', material: 'Pino',
  subcategoria: 'camas', imagen: 'y.jpg', variantes: [],
}
const SILLA_COLORES = {
  nombre: 'Silla comedor Selene', precio: 780000, medidas: '45x50', material: 'Madera',
  subcategoria: 'sillas_comedor', imagen: 'z.jpg',
  variantes: [
    { etiqueta: 'Natural', precio: 780000, tipo: 'Colores selene', afectaPrecio: true },
    { etiqueta: 'cafe', precio: 780000, tipo: 'Colores selene', afectaPrecio: true },
  ],
}

test('infoPrecioVariantes: con precios distintos no entrega precio único sino rango', () => {
  const info = agente.infoPrecioVariantes(CAMA_MIAMI)
  assert.equal(info.precio, null)
  assert.equal(info.precio_desde, 2480000)
  assert.equal(info.precio_hasta, 2980000)
  assert.deepEqual(info.variantes, [
    { opcion: '1.90', precio: 2480000 },
    { opcion: '1.60', precio: 2980000 },
  ])
  assert.match(info.nota_variantes, /PRECIOS DISTINTOS/)
})

test('infoPrecioVariantes: sin variantes devuelve el precio tal cual', () => {
  assert.deepEqual(agente.infoPrecioVariantes(CAMA_SIMPLE), { precio: 1200000 })
})

test('infoPrecioVariantes: variantes del mismo precio (colores) mantienen precio único', () => {
  const info = agente.infoPrecioVariantes(SILLA_COLORES)
  assert.equal(info.precio, 780000)
  assert.equal(info.precio_desde, undefined)
  assert.deepEqual(info.opciones, ['Natural', 'cafe'])
})

test('precioMinimo: usa el precio de entrada para comparar con el presupuesto', () => {
  assert.equal(agente.precioMinimo(CAMA_MIAMI), 2480000)
  assert.equal(agente.precioMinimo(CAMA_SIMPLE), 1200000)
})

test('encontrarVariante: tolera cómo escriba el cliente la medida', () => {
  assert.equal(agente.encontrarVariante(CAMA_MIAMI, '1.60').precio, 2980000)
  assert.equal(agente.encontrarVariante(CAMA_MIAMI, '1,60').precio, 2980000)
  assert.equal(agente.encontrarVariante(CAMA_MIAMI, '160').precio, 2980000)
  assert.equal(agente.encontrarVariante(CAMA_MIAMI, '2.00'), null)
  assert.equal(agente.encontrarVariante(CAMA_SIMPLE, '1.90'), null)
})

test('formatProducto: muestra el rango y prohíbe el precio único', () => {
  const texto = agente.formatProducto(CAMA_MIAMI)
  assert.match(texto, /desde \$2\.480\.000 hasta \$2\.980\.000/)
  assert.match(texto, /1\.90 → \$2\.480\.000/)
  assert.match(texto, /No des un precio único/)
})

test('formatProducto: sin variantes mantiene el formato de siempre', () => {
  const texto = agente.formatProducto(CAMA_SIMPLE)
  assert.match(texto, /Precio: \$1\.200\.000/)
  assert.doesNotMatch(texto, /desde/)
})

test('etiquetaPrecio: "desde" solo cuando las opciones valen distinto', () => {
  assert.equal(agente.etiquetaPrecio(CAMA_MIAMI), 'desde $2.480.000')
  assert.equal(agente.etiquetaPrecio(CAMA_SIMPLE), '$1.200.000')
  assert.equal(agente.etiquetaPrecio(SILLA_COLORES), '$780.000')
})

test('validarPrecios: el precio de una variante NO se marca como inventado', () => {
  // 2.980.000 solo existe como precio de la medida 1.60, no como precio_base
  agente.setPreciosInventarioParaPruebas([2880000, 2480000, 2980000, 1200000])
  assert.deepEqual(agente.validarPrecios('p', 'La CAMA MIAMI en 1.60 vale $2.980.000', new Set()), [])
  assert.deepEqual(agente.validarPrecios('p', 'Te la dejo en $2.700.000', new Set()), [2700000])
})

test('encolar: una tarea que falla no bloquea la siguiente ni tumba el proceso', async () => {
  const ejecutadas = []
  // encolar absorbe el fallo: la promesa devuelta nunca rechaza, así que un error en un
  // cliente no puede provocar un unhandledRejection que mate el servidor.
  const p1 = agente.encolar('cliente-A', async () => { ejecutadas.push(1); throw new Error('boom') })
  const p2 = agente.encolar('cliente-A', async () => { ejecutadas.push(2) })
  assert.equal(await p1, undefined)
  await p2
  assert.deepEqual(ejecutadas, [1, 2])
})

test('encolar: serializa las tareas del mismo cliente', async () => {
  const orden = []
  const tarea = (id, ms) => () => new Promise(res => {
    orden.push(`inicio-${id}`)
    setTimeout(() => { orden.push(`fin-${id}`); res() }, ms)
  })
  const p1 = agente.encolar('cliente-B', tarea(1, 30))
  const p2 = agente.encolar('cliente-B', tarea(2, 1))
  await Promise.all([p1, p2])
  assert.deepEqual(orden, ['inicio-1', 'fin-1', 'inicio-2', 'fin-2'])
})

test('consultar_estado: resume carrito, ultimo producto y citas sin tocar db.pool', async () => {
  // Este test existe porque la primera version usaba db.pool.query directamente, y en
  // este agente `pool` NO se exporta: habria reventado en produccion al primer uso.
  const db = require('../db.js')
  const originales = {
    getEstado: db.getEstado, getUltimoProducto: db.getUltimoProducto, getCitasRecientes: db.getCitasRecientes,
  }
  // El carrito se guarda como texto JSON en estado_usuario, no como array
  db.getEstado = async () => ({ carrito: JSON.stringify([{ producto: 'CAMA MIAMI (1.60)', precio: '$2.980.000', cantidad: 1 }]) })
  db.getUltimoProducto = async () => ({ nombre: 'CAMA MIAMI' })
  db.getCitasRecientes = async () => ([
    { nombre: 'Ana', dia: 'martes 3', hora: '10:00', ubicacion: 1, razon: null, estado: 'pendiente' },
  ])

  try {
    const salida = JSON.parse(await agente.ejecutarTool('psid-test', 'consultar_estado', {}, {}))
    assert.equal(salida.carrito.items.length, 1)
    assert.equal(salida.carrito.total, '$2.980.000')
    assert.equal(salida.ultimo_producto_visto.nombre, 'CAMA MIAMI')
    assert.equal(salida.citas_agendadas.length, 1)
    assert.match(salida.citas_agendadas[0].sede, /Bol[ií]var|Sede 1/)
  } finally {
    Object.assign(db, originales)
  }
})

// ── Respuesta pública a comentarios ───────────────────────────────────────────
// Lo que se escribe en un comentario lo lee todo el mundo, así que lo importante de
// estos tests es lo que NO se responde.

test('clasificarComentario: temas que sí se responden en público', () => {
  assert.equal(clasif('donde quedan?'), 'ubicacion')
  assert.equal(clasif('en que ciudad estan ubicados'), 'ubicacion')
  assert.equal(clasif('tienen sede en Pereira?'), 'ubicacion')
  assert.equal(clasif('cual es el horario?'), 'horario')
  assert.equal(clasif('a que hora abren los sabados'), 'horario')
  assert.equal(clasif('tienen catalogo?'), 'catalogo')
  assert.equal(clasif('me pasan el portafolio'), 'catalogo')
})

test('clasificarComentario: el precio se trata como consulta, nunca se responde en público', () => {
  for (const t of ['cuanto vale?', 'precio?', 'que valor tiene', 'cuanto cuesta el sofa']) {
    assert.equal(clasif(t), 'consulta', `"${t}" debería ser consulta`)
  }
  // Y la respuesta pública de una consulta jamás lleva cifras
  const publica = agente.respuestaPublicaComentario('consulta')
  assert.match(publica, /privado/)
  assert.doesNotMatch(publica, /\d{4,}|\$/)
})

test('clasificarComentario: los comentarios hostiles no reciben respuesta', () => {
  for (const t of ['son unos estafadores', 'pesimo servicio nunca responden', 'esto es una porqueria',
                   'me robaron el dinero', 'voy a poner una demanda', 'que basura de muebles']) {
    assert.equal(clasif(t), 'hostil', `"${t}" debería ser hostil`)
  }
  assert.equal(agente.respuestaPublicaComentario('hostil'), null)
})

test('clasificarComentario: ignora los comentarios que no preguntan nada', () => {
  for (const t of ['que hermoso 😍', '🔥🔥🔥', '@maria mira esto', 'felicitaciones', '']) {
    assert.equal(clasif(t), null, `"${t}" no debería clasificarse`)
  }
})

test('respuestaPublicaComentario: ubicación y horario dan el dato, sin precios', () => {
  const ubi = agente.respuestaPublicaComentario('ubicacion')
  assert.match(ubi, /Armenia/)
  assert.match(ubi, /Pereira/)
  assert.doesNotMatch(ubi, /\$/)

  const hor = agente.respuestaPublicaComentario('horario')
  assert.match(hor, /8am-5pm/)
  assert.match(hor, /domingo/i)

  // El catálogo se anuncia en público pero el enlace va por privado
  const cat = agente.respuestaPublicaComentario('catalogo')
  assert.match(cat, /privado/)
  assert.doesNotMatch(cat, /http/)
})

test('mensajePrivadoCatalogo: manda el de la categoría pedida y si no, pregunta', () => {
  // Sin catálogos cargados no puede adivinar, así que pregunta
  const generico = agente.mensajePrivadoCatalogo('tienen catalogo?')
  assert.match(generico, /sof[aá]s, camas, comedores/)
  assert.doesNotMatch(generico, /http/)
})

function clasif(t) { return agente.clasificarComentario(t) }

test('clasificarComentario: no responde a menciones casuales de ciudad o día', () => {
  // Antes "saludos desde Armenia" hacía que la cuenta soltara sus 5 direcciones debajo
  // de la foto, y "feliz sábado" el horario de atención.
  for (const t of ['saludos desde Armenia 😍', 'feliz sabado!', 'que lindo, un abrazo desde Pereira',
                   'me encanta el domingo con estos muebles']) {
    assert.equal(clasif(t), null, `"${t}" no debería disparar respuesta pública`)
  }
})

test('clasificarComentario: lo hostil gana aunque venga con una pregunta', () => {
  assert.equal(clasif('cuanto vale? son unos estafadores'), 'hostil')
  assert.equal(clasif('donde quedan? nunca responden'), 'hostil')
  assert.equal(clasif('esto no vale nada'), 'hostil')
})

test('manejarComentario: responde en público Y por privado', async () => {
  const ig = require('../instagram.js')
  const db = require('../db.js')
  const orig = { reply: ig.replyToComment, priv: ig.sendPrivateReplyToComment, reg: db.registrarComentario }
  const llamadas = { publicas: [], privadas: [] }
  ig.replyToComment = async (id, texto) => { llamadas.publicas.push({ id, texto }); return true }
  ig.sendPrivateReplyToComment = async (id, texto) => { llamadas.privadas.push({ id, texto }); return true }
  db.registrarComentario = async () => true

  try {
    await agente.manejarComentario({ id: 'c1', text: 'donde quedan?', from: { id: 'otro' } })
    assert.equal(llamadas.publicas.length, 1)
    assert.match(llamadas.publicas[0].texto, /Armenia/)
    assert.equal(llamadas.privadas.length, 1, 'el privado se sigue enviando')

    // Una consulta de precio: acuse en público, sin cifras
    await agente.manejarComentario({ id: 'c2', text: 'cuanto vale?', from: { id: 'otro' } })
    assert.match(llamadas.publicas[1].texto, /privado/)
    assert.doesNotMatch(llamadas.publicas[1].texto, /\$|\d{4,}/)

    // Hostil: ni pública ni privada
    await agente.manejarComentario({ id: 'c3', text: 'son unos estafadores', from: { id: 'otro' } })
    assert.equal(llamadas.publicas.length, 2, 'no debe responder en público a un hostil')
    assert.equal(llamadas.privadas.length, 2, 'tampoco por privado')

    // Comentario sin pregunta: no se responde
    await agente.manejarComentario({ id: 'c4', text: 'que hermoso 😍', from: { id: 'otro' } })
    assert.equal(llamadas.publicas.length, 2)
  } finally {
    ig.replyToComment = orig.reply
    ig.sendPrivateReplyToComment = orig.priv
    db.registrarComentario = orig.reg
  }
})

// ── Identificación por caption de publicación/reel ────────────────────────────
// Caso real: un cliente compartió un reel donde se ve un reloj y el agente le dijo que
// veía que estaba interesada en una mesa de noche. El caption compartía UNA palabra con
// "MESA DE NOCHE" y eso bastaba para dárselo al modelo como el producto.

test('identificarProductoPorCaption: reconoce el producto cuando el caption lo nombra', () => {
  const inv = [
    { nombre: 'Reloj Decorativo Chronos GLD', precio: 1180000, medidas: '60cm', material: 'Metal', subcategoria: 'decoracion' },
    { nombre: 'MESA DE NOCHE AMIGABLE',       precio: 880000,  medidas: '50x40', material: 'Madera', subcategoria: 'mesas_noche' },
    { nombre: 'MESA DE NOCHE BARCELONETA',    precio: 920000,  medidas: '50x40', material: 'Madera', subcategoria: 'mesas_noche' },
  ]
  agente.setInventarioParaPruebas(inv)

  assert.equal(agente.identificarProductoPorCaption('Reloj Decorativo Chronos GLD').nombre, 'Reloj Decorativo Chronos GLD')
  assert.equal(agente.identificarProductoPorCaption('Nuevo reloj decorativo chronos gld ✨').nombre, 'Reloj Decorativo Chronos GLD')
  assert.equal(agente.identificarProductoPorCaption('Mesa de noche Amigable').nombre, 'MESA DE NOCHE AMIGABLE')
})

test('identificarProductoPorCaption: no inventa producto por una palabra suelta', () => {
  const inv = [
    { nombre: 'Reloj Decorativo Chronos GLD', precio: 1180000, medidas: '60cm', material: 'Metal', subcategoria: 'decoracion' },
    { nombre: 'MESA DE NOCHE AMIGABLE',       precio: 880000,  medidas: '50x40', material: 'Madera', subcategoria: 'mesas_noche' },
    { nombre: 'BASE AHORRA ESPACIO',          precio: 1480000, medidas: '1.20',  material: 'Madera', subcategoria: 'bases_comedores' },
  ]
  agente.setInventarioParaPruebas(inv)

  // El caso que se vio en producción
  assert.equal(agente.identificarProductoPorCaption('Buenas noches, descansa como mereces'), null)
  // Otros captions de marketing que antes colaban un producto cualquiera
  assert.equal(agente.identificarProductoPorCaption('Dale un toque especial a tu espacio'), null)
  assert.equal(agente.identificarProductoPorCaption('Detalles que hacen la diferencia'), null)
  assert.equal(agente.identificarProductoPorCaption(''), null)
  assert.equal(agente.identificarProductoPorCaption(null), null)
})

test('identificarProductoPorCaption: gana el producto mejor nombrado, no el primero por score', () => {
  const inv = [
    { nombre: 'CAMA MIAMI',             precio: 2880000, medidas: '1.60', material: 'Flor Morado', subcategoria: 'camas' },
    { nombre: 'CAMA FLOR MORADO LISA',  precio: 2980000, medidas: '1.40', material: 'Flor Morado', subcategoria: 'camas' },
  ]
  agente.setInventarioParaPruebas(inv)
  // "CAMA FLOR MORADO LISA" comparte 3 palabras con el caption y llegaba antes por
  // score, pero la que está nombrada entera es CAMA MIAMI.
  assert.equal(agente.identificarProductoPorCaption('Cama Miami en flor morado').nombre, 'CAMA MIAMI')
})

// ── Producto exacto para acciones (foto, carrusel, carrito) ───────────────────
// buscarEnInventario devuelve resultados aproximados a propósito, para sugerir. Pero en
// una acción que el cliente VE, un match flojo es una foto equivocada: pedir "nevera"
// le enviaba la foto de una LAMPARA DE MESA NEGRA.

test('buscarProductoExacto: rechaza lo que no está en el catálogo', () => {
  agente.setInventarioParaPruebas([
    { nombre: 'LAMPARA DE MESA NEGRA', precio: 380000, medidas: '40cm', material: 'Metal',  subcategoria: 'decoracion' },
    { nombre: 'SILLA AUX PERLA LEATHER', precio: 980000, medidas: '80x60', material: 'Cuero', subcategoria: 'sillas_auxiliares' },
    { nombre: 'SOFA CAMA ROMA', precio: 3000000, medidas: '1.80', material: 'Tela', subcategoria: 'sofas_camas' },
  ])
  for (const t of ['nevera', 'tapete persa', 'televisor', 'cortinas']) {
    assert.equal(agente.buscarProductoExacto(t), null, `"${t}" no debería resolverse a ningún producto`)
  }
})

test('buscarProductoExacto: acepta el nombre real y tolera nombres pegados', () => {
  agente.setInventarioParaPruebas([
    { nombre: 'SOFA CAMA ROMA', precio: 3000000, medidas: '1.80', material: 'Tela', subcategoria: 'sofas_camas' },
    { nombre: 'LAMPARA DE PIE', precio: 450000, medidas: '1.50', material: 'Metal', subcategoria: 'decoracion' },
  ])
  assert.equal(agente.buscarProductoExacto('SOFA CAMA ROMA').nombre, 'SOFA CAMA ROMA')
  assert.equal(agente.buscarProductoExacto('sofacama roma').nombre, 'SOFA CAMA ROMA')
  assert.equal(agente.buscarProductoExacto('LAMPARA DE PIE').nombre, 'LAMPARA DE PIE')
})
