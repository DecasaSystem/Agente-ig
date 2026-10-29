'use strict'
// Respuesta a una foto nuestra (caso real del 2026-10-29): el asesor le mandó a la
// clienta varias fotos de comedores y ella contestó "Nos gustó este comedor y..." sobre
// una. El webhook solo trae reply_to.mid; contextoDeRespuesta lo traduce para el modelo.

const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const db = require('../db')
const ig = require('../instagram')
const agente = require('../index.js')

const originalesDb = { ...db }
const originalesIg = { ...ig }
let enviados

beforeEach(() => {
  enviados = new Map()
  Object.assign(db, {
    getMensajeEnviado: async (mid, psid) => enviados.get(`${mid}|${psid}`) ?? null,
  })
  agente.setInventarioParaPruebas([
    { nombre: 'BASE SODEGE 6 PUESTOS', categoria: 'bases_comedores', precio: 2540000, imagen: 'https://cdn/sodege.jpg' },
  ])
})

afterEach(() => {
  Object.assign(db, originalesDb)
  Object.assign(ig, originalesIg)
})

test('foto que mandó Elena: dice el producto con sus datos del catálogo', async () => {
  enviados.set('m1|cliente', { producto: 'BASE SODEGE 6 PUESTOS', imagen_url: 'https://cdn/sodege.jpg' })
  const { ctx, imagen } = await agente.contextoDeRespuesta('cliente', 'm1')
  assert.match(ctx, /RESPONDIENDO a la foto de BASE SODEGE 6 PUESTOS/)
  assert.ok(ctx.includes('Producto en inventario'), 'así no se repite la identificación por visión')
  assert.equal(imagen, null)
})

test('foto que mandó el asesor: se baja para identificarla', async () => {
  enviados.set('m2|cliente', { producto: null, imagen_url: 'https://lookaside/foto.jpg' })
  ig.downloadMediaToBuffer = async () => ({ buffer: Buffer.from('jpg'), contentType: 'image/jpeg' })
  const { ctx, imagen } = await agente.contextoDeRespuesta('cliente', 'm2')
  assert.match(ctx, /foto que le enviamos nosotros/)
  assert.equal(imagen.mime, 'image/jpeg')
})

test('si la foto ya no se puede bajar, no adivina', async () => {
  enviados.set('m3|cliente', { producto: null, imagen_url: 'https://lookaside/vencida.jpg' })
  ig.downloadMediaToBuffer = async () => { throw new Error('403') }
  const { ctx, imagen } = await agente.contextoDeRespuesta('cliente', 'm3')
  assert.match(ctx, /NO adivines/)
  assert.equal(imagen, null)
})

test('carrusel: da la lista para que pregunte cuál', async () => {
  enviados.set('m4|cliente', { producto: 'BASE SODEGE 6 PUESTOS | BASE FIGY RECTA' })
  const { ctx } = await agente.contextoDeRespuesta('cliente', 'm4')
  assert.match(ctx, /carrusel .* BASE SODEGE 6 PUESTOS, BASE FIGY RECTA/)
})

test('texto nuestro: lo cita', async () => {
  enviados.set('m5|cliente', { texto: 'Esta con el descuento te queda a 3.380.000' })
  const { ctx } = await agente.contextoDeRespuesta('cliente', 'm5')
  assert.ok(ctx.includes('"Esta con el descuento te queda a 3.380.000"'))
})

test('un mid de otro cliente no revela lo que se le mandó', async () => {
  enviados.set('m6|otro', { producto: 'BASE SODEGE 6 PUESTOS' })
  const { ctx } = await agente.contextoDeRespuesta('cliente', 'm6')
  assert.ok(!ctx.includes('SODEGE'))
  assert.match(ctx, /NO adivines/)
})
