'use strict'
// Nombre y celular antes de pasar al cliente con una persona (dueño, 2026-10-08). En
// Instagram es todavía más importante que en WhatsApp: no hay teléfono del chat y sin
// él el asesor solo puede escribirle por el DM. También: el 5 % por efectivo/transferencia
// lo calcula el código, y solo para lo que está en existencia: lo que se fabrica no lleva
// descuento (dueño, 2026-10-20).

const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

process.env.DECASA_API_URL = 'https://api.prueba'
const axios = require('axios')
const db = require('../db')
const agente = require('../index.js')

const originales = { ...db }
const RealDate = Date
const enviados = []
let perfil = null
let transferido = null
let pedidoGuardado = false
const CARRITO_MIAMI = [{ producto: 'CAMA MIAMI (1.60)', precio: '$2.980.000', cantidad: 1 }]
let carrito = CARRITO_MIAMI
// CAMA MIAMI hay en existencia; SOFA NUBE se fabrica sobre pedido.
const INVENTARIO = [
  { id: 1, nombre: 'CAMA MIAMI', precio: 2980000, variantes: [], existencias: 2 },
  { id: 2, nombre: 'SOFA NUBE', precio: 3580000, variantes: [], existencias: 0 },
  // Promoción de Inventario → Promociones: 15 % en la 1.40, en dos tiendas.
  {
    id: 3, nombre: 'CAMA BALI', precio: 1500000, existencias: 3,
    variantes: [
      { etiqueta: '1.40', precio: 1500000, tipo: 'Medidas', precioPropio: true, afectaPrecio: true, configId: 10, varianteId: null },
      { etiqueta: '1.60', precio: 1800000, tipo: 'Medidas', precioPropio: true, afectaPrecio: true, configId: 11, varianteId: null },
    ],
    promociones: [{ id: 7, nombre: 'Feria de octubre', config_id: 10, variante_id: null, tipo: 'porcentaje', valor: 15,
      fecha_inicio: '2026-01-01', fecha_fin: '2099-12-31', tiendas: ['Unicentro', 'Vía El Edén'] }],
  },
]
let carritoGuardado = null

beforeEach(async () => {
  enviados.length = 0
  perfil = null
  transferido = null
  pedidoGuardado = false
  carrito = CARRITO_MIAMI
  axios.post = async (_url, payload) => { enviados.push(payload); return { status: 201 } }
  db.getInventario = async () => INVENTARIO
  await agente.cargarInventario()
  Object.assign(db, {
    getHistorial: async () => [],
    getPerfil: async () => perfil,
    setPerfil: async (_psid, p) => { perfil = p },
    getUltimoProducto: async () => null,
    getEstado: async () => ({ carrito: JSON.stringify(carrito) }),
    setEstado: async (_psid, e) => { if (e?.carrito !== undefined) carritoGuardado = typeof e.carrito === 'string' ? JSON.parse(e.carrito) : e.carrito },
    marcarTransferido: async (_psid, v) => { transferido = v },
    solicitudAsesorPendiente: async () => false,
    registrarEvento: async () => {},
    contarPedidosRecientes: async () => 0,
    guardarPedido: async () => { pedidoGuardado = true },
    cancelarSeguimientos: async () => 0,
    encolarNotificacion: async () => {},
  })
  // Martes 10:00 a. m. en Bogotá: dentro del horario, la transferencia es inmediata.
  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate('2026-09-15T15:00:00Z') }
    static now() { return new RealDate('2026-09-15T15:00:00Z').getTime() }
  }
})

afterEach(() => {
  global.Date = RealDate
  Object.assign(db, originales)
})

const esperar = () => new Promise(r => setTimeout(r, 20))

test('solicitar_asesor sin datos NO transfiere: le pide a Elena nombre y celular', async () => {
  const salida = await agente.ejecutarTool('psid-1', 'solicitar_asesor', { motivo: 'quiere asesor', tipo: 'asesor' }, { username: 'laura.g' })
  await esperar()
  assert.match(salida, /FALTAN DATOS \(nombre, telefono\)/)
  assert.match(salida, /UN solo mensaje/)
  assert.doesNotMatch(salida, /este_mismo/, 'en Instagram no hay número del chat')
  assert.equal(enviados.length, 0)
  assert.equal(transferido, null)
})

test('con nombre y celular transfiere y el contacto viaja al sistema con el @usuario', async () => {
  const salida = await agente.ejecutarTool('psid-1', 'solicitar_asesor',
    { motivo: 'quiere asesor', tipo: 'asesor', nombre: 'laura gómez', telefono_contacto: '310 555 1234' },
    { username: 'laura.g', nombre: 'Lau' })
  await esperar()
  assert.match(salida, /Laura Gómez/)
  assert.equal(transferido, true)
  const [aviso] = enviados
  assert.equal(aviso.nombre_cliente, 'Laura Gómez')
  assert.deepEqual(
    { nombre: aviso.contacto.nombre, telefono: aviso.contacto.telefono, usuario_red: aviso.contacto.usuario_red },
    { nombre: 'Laura Gómez', telefono: '+573105551234', usuario_red: '@laura.g' },
  )
  assert.match(aviso.resumen, /Contacto: Laura Gómez · \+573105551234/)
  // Queda guardado: la próxima vez no se le pregunta.
  assert.equal(perfil.telefono_contacto, '+573105551234')
})

test('si no quiere darlos, se transfiere igual', async () => {
  await agente.ejecutarTool('psid-1', 'solicitar_asesor', { motivo: 'x', tipo: 'asesor', cliente_no_quiso_dar_datos: true }, {})
  await esperar()
  assert.equal(enviados.length, 1)
  assert.equal(transferido, true)
})

test('confirmar_pedido sin datos no guarda el pedido', async () => {
  const salida = await agente.ejecutarTool('psid-1', 'confirmar_pedido', { ciudad: 'Armenia' }, {})
  assert.match(salida, /FALTAN DATOS/)
  assert.equal(pedidoGuardado, false)
})

test('confirmar_pedido pagando por transferencia lleva el total con el 5 % a la tarjeta', async () => {
  const mensajesCliente = []
  const ig = require('../instagram')
  const originalEnviar = ig.enviarTexto
  ig.enviarTexto = async (_psid, texto) => { mensajesCliente.push(texto) }
  try {
    await agente.ejecutarTool('psid-1', 'confirmar_pedido', { nombre: 'Laura', telefono_contacto: '3001112233', forma_pago: 'transferencia' }, {})
    await esperar()
    assert.equal(pedidoGuardado, true)
    const aviso = enviados.find(e => e.tipo === 'pedido')
    assert.match(aviso.resumen, /5% de descuento por pago en efectivo\/transferencia: \$2\.831\.000/)
    assert.equal(aviso.contacto.forma_pago, 'transferencia')
  } finally {
    ig.enviarTexto = originalEnviar
  }
})

test('ver_carrito muestra cuánto paga en efectivo o transferencia', async () => {
  const salida = await agente.ejecutarTool('psid-1', 'ver_carrito', {}, {})
  assert.match(salida, /Total: \$2\.980\.000/)
  assert.match(salida, /5% de descuento\): \$2\.831\.000/)
})

test('lo que se fabrica no lleva descuento: solo se rebaja lo que está en existencia', async () => {
  carrito = [...CARRITO_MIAMI, { producto: 'SOFA NUBE', precio: '$3.580.000', cantidad: 1 }]
  const salida = await agente.ejecutarTool('psid-1', 'ver_carrito', {}, {})
  // 2.980.000 × 95 % + 3.580.000 = 6.411.000
  assert.match(salida, /5% de descuento\): \$6\.411\.000/)
  assert.match(salida, /Sin descuento \(se fabrica sobre pedido\): SOFA NUBE/)
  await agente.ejecutarTool('psid-1', 'confirmar_pedido', { nombre: 'Laura', telefono_contacto: '3001112233', forma_pago: 'efectivo' }, {})
  await esperar()
  const aviso = enviados.find(e => e.tipo === 'pedido')
  assert.match(aviso.resumen, /\$6\.411\.000 \(sin descuento por ser para fabricar: SOFA NUBE\)/)
})

test('si todo el carrito se fabrica, no se ofrece total con descuento', async () => {
  carrito = [{ producto: 'SOFA NUBE', precio: '$3.580.000', cantidad: 1 }]
  const salida = await agente.ejecutarTool('psid-1', 'ver_carrito', {}, {})
  assert.doesNotMatch(salida, /descuento/)
})

test('la ficha del producto trae el precio pagando en efectivo si está en existencia', () => {
  const ficha = agente.formatProducto({ nombre: 'SOFÁ ROMA', precio: 3000000, medidas: '2.00', material: 'Tela', existencias: 1 })
  assert.match(ficha, /Precio: \$3\.000\.000 \(pagando en efectivo o transferencia: \$2\.850\.000\)/)
})

test('la ficha de algo que se fabrica no trae precio con descuento y lo explica', () => {
  const ficha = agente.formatProducto({ nombre: 'SOFA NUBE', precio: 3580000, existencias: 0 })
  assert.doesNotMatch(ficha, /pagando en efectivo/)
  assert.match(ficha, /se fabrica sobre pedido y lo que se fabrica NO tiene el 5%/)
})

test('si no se sabe la existencia, no se promete la cifra con descuento', () => {
  const ficha = agente.formatProducto({ nombre: 'SOFA NUBE', precio: 3580000 })
  assert.doesNotMatch(ficha, /pagando en efectivo/)
  assert.match(ficha, /un asesor lo confirma/)
})

test('guardar_contacto: apenas da sus datos queda en el sistema, con el @usuario y SIN tarjeta', async () => {
  const salida = await agente.ejecutarTool('psid-1', 'guardar_contacto', { nombre: 'laura', telefono_contacto: '3104445566' }, { username: 'laura.g' })
  await esperar()
  assert.match(salida, /Guardado/)
  assert.equal(enviados.filter(e => e.tipo).length, 0, 'no se crea tarjeta de Redes')
  const s = enviados.find(e => e.fuente === 'instagram' && e.contacto && !e.tipo)
  assert.equal(s.telefono, 'ig_psid-1')
  assert.equal(s.contacto.nombre, 'Laura')
  assert.equal(s.contacto.telefono, '+573104445566')
  assert.equal(s.contacto.usuario_red, '@laura.g')
})

test('si no quiso dar sus datos, al transferir no se le vuelven a pedir', async () => {
  await agente.ejecutarTool('psid-1', 'guardar_contacto', { cliente_no_quiso_dar_datos: true }, {})
  const salida = await agente.ejecutarTool('psid-1', 'solicitar_asesor', { motivo: 'x', tipo: 'asesor' }, {})
  await esperar()
  assert.doesNotMatch(salida, /FALTAN DATOS/)
  assert.equal(transferido, true)
})

test('la ficha muestra la promoción de la 1.40 con el 5 % sobre el precio de promoción', () => {
  const ficha = agente.formatProducto(INVENTARIO[2])
  assert.ok(ficha.includes('1.40 → $1.500.000 → EN PROMOCIÓN $1.275.000 (pagando en efectivo o transferencia: $1.211.250)'), ficha)
  assert.ok(ficha.includes('1.60 → $1.800.000 (pagando'), ficha)
  assert.ok(ficha.includes('PROMOCIÓN "Feria de octubre" (1.40) −15 %: queda en $1.275.000 (precio de lista $1.500.000) en Unicentro y Vía El Edén, hasta el 31 de dic.'), ficha)
})

test('si se fabrica, la promoción aparece marcada como que NO aplica y no se rebaja el precio', () => {
  const ficha = agente.formatProducto({ ...INVENTARIO[2], existencias: 0 })
  assert.doesNotMatch(ficha, /EN PROMOCIÓN/)
  assert.match(ficha, /NO aplica/)
})

test('al agregar la 1.40 al carrito entra con el precio de promoción', async () => {
  carrito = []
  const salida = await agente.ejecutarTool('psid-1', 'agregar_al_carrito', { producto: 'CAMA BALI', variante: '1.40' }, {})
  assert.ok(salida.includes('agregado al carrito por $1.275.000 (en promoción: Feria de octubre −15 % (lista $1.500.000))'), salida)
  assert.deepEqual(carritoGuardado?.[0], { producto: 'CAMA BALI (1.40)', precio: '$1.275.000', cantidad: 1, promocion: 'Feria de octubre −15 % (lista $1.500.000)' })
})
