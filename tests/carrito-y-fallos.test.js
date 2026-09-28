'use strict'
// Carrito (precio desde la BD, quitar sin borrar de más) y clasificación de fallos
// transitorios del proveedor frente a errores propios.

const { test } = require('node:test')
const assert = require('node:assert/strict')

const agente = require('../index.js')
const reintentos = require('../reintentos')

const INVENTARIO = [
  { nombre: 'CAMA MIAMI', precio: 2880000, medidas: '1.60 / 1.90', material: 'Flor Morado', subcategoria: 'camas', imagen: 'a.png',
    variantes: [
      { etiqueta: '1.90', precio: 2480000, tipo: 'Medidas', afectaPrecio: true },
      { etiqueta: '1.60', precio: 2980000, tipo: 'Medidas', afectaPrecio: true },
    ] },
  { nombre: 'CAMA SENCILLA', precio: 1200000, medidas: '1.00 x 1.90', material: 'Pino', subcategoria: 'camas', imagen: 'b.png', variantes: [] },
  { nombre: 'SOFA ROMA', precio: 3000000, medidas: '2.00', material: 'Tela', subcategoria: 'sofas', imagen: 'c.png', variantes: [] },
  { nombre: 'SOFA CAMA TORELLO', precio: 2500000, medidas: '1.80', material: 'Tela', subcategoria: 'sofas_camas', imagen: 'd.png', variantes: [] },
]

// Estado de carrito en memoria para no tocar la BD: se inyecta reemplazando el módulo db
// no es posible aquí, así que se prueban las funciones puras y la herramienta con el
// carrito que devuelva getEstado. ejecutarTool usa db real, así que estas pruebas se
// limitan a lo que no escribe: validación de variantes y resolución de nombres.
test('encontrarVariante: no resuelve una medida ambigua a la más barata', () => {
  const cama = INVENTARIO[0]
  assert.equal(agente.encontrarVariante(cama, '1.60').precio, 2980000)
  assert.equal(agente.encontrarVariante(cama, '160').precio, 2980000)
  // "1" aparece en 1.90 y en 1.60: ambiguo, no debe elegir ninguna
  assert.equal(agente.encontrarVariante(cama, '1'), null)
  assert.equal(agente.encontrarVariante(cama, '2.00'), null)
})

test('buscarProductoExacto: distingue productos con nombres solapados', () => {
  agente.setInventarioParaPruebas(INVENTARIO)
  assert.equal(agente.buscarProductoExacto('SOFA ROMA').nombre, 'SOFA ROMA')
  assert.equal(agente.buscarProductoExacto('sofa cama torello').nombre, 'SOFA CAMA TORELLO')
  assert.equal(agente.buscarProductoExacto('nevera samsung'), null)
})

test('esFalloDelProveedor: distingue caída de OpenAI de un bug nuestro', () => {
  assert.equal(reintentos.esFalloDelProveedor(Object.assign(new Error('rate'), { status: 429 })), true)
  assert.equal(reintentos.esFalloDelProveedor(Object.assign(new Error('boom'), { status: 503 })), true)
  assert.equal(reintentos.esFalloDelProveedor(Object.assign(new Error('sin clave'), { status: 401 })), true)
  assert.equal(reintentos.esFalloDelProveedor(Object.assign(new Error('red'), { code: 'ECONNRESET' })), true)
  assert.equal(reintentos.esFalloDelProveedor(new TypeError('x is not a function')), false)
  assert.equal(reintentos.esFalloDelProveedor(Object.assign(new Error('mal'), { status: 400 })), false)
})

test('conReintentos: repite lo transitorio y se rinde con lo demás', async () => {
  let intentos = 0
  const ok = await reintentos.conReintentos(async () => {
    intentos++
    if (intentos < 3) throw Object.assign(new Error('429'), { status: 429 })
    return 'listo'
  }, { baseMs: 1 })
  assert.equal(ok, 'listo')
  assert.equal(intentos, 3)

  let intentosFatal = 0
  await assert.rejects(() => reintentos.conReintentos(async () => {
    intentosFatal++
    throw new TypeError('bug')
  }, { baseMs: 1 }))
  assert.equal(intentosFatal, 1) // no se reintenta un error propio
})
