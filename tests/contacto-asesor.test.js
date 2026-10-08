'use strict'
// Nombre y celular antes de pasar al cliente con una persona (dueño, 2026-10-08). En
// Instagram es todavía más importante que en WhatsApp: no hay teléfono del chat y sin
// él el asesor solo puede escribirle por el DM. También: el 5 % por efectivo/transferencia
// lo calcula el código.

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

beforeEach(() => {
  enviados.length = 0
  perfil = null
  transferido = null
  pedidoGuardado = false
  axios.post = async (_url, payload) => { enviados.push(payload); return { status: 201 } }
  Object.assign(db, {
    getHistorial: async () => [],
    getPerfil: async () => perfil,
    setPerfil: async (_psid, p) => { perfil = p },
    getUltimoProducto: async () => null,
    getEstado: async () => ({ carrito: JSON.stringify([{ producto: 'CAMA MIAMI (1.60)', precio: '$2.980.000', cantidad: 1 }]) }),
    setEstado: async () => {},
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

test('la ficha del producto trae el precio pagando en efectivo', () => {
  const ficha = agente.formatProducto({ nombre: 'SOFÁ ROMA', precio: 3000000, medidas: '2.00', material: 'Tela' })
  assert.match(ficha, /Precio: \$3\.000\.000 \(pagando en efectivo o transferencia: \$2\.850\.000\)/)
})
