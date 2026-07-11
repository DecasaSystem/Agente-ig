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
