'use strict'
// Renovación automática del token de Instagram (caduca a los 60 días y el agente se queda
// mudo). mantenerToken renueva cada semana, guarda el nuevo en ig_token y lo usa; si en
// Render ponen un token distinto, manda ese.

const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const db = require('../db')
const ig = require('../instagram')
const agente = require('../index.js')

const originalesDb = { ...db }
const originalesIg = { ...ig }
const DIA = 24 * 60 * 60 * 1000
const AHORA = Date.parse('2026-10-29T12:00:00Z')
const hash = t => crypto.createHash('sha256').update(t).digest('hex')
let guardado, renovaciones, enUso

beforeEach(() => {
  process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = 'token-de-render'
  guardado = null
  renovaciones = 0
  enUso = undefined
  Object.assign(db, {
    getTokenGuardado: async () => guardado,
    guardarToken: async t => { guardado = { ...t, renovado: new Date(AHORA) } },
  })
  ig.usarToken = t => { enUso = t }
  ig.renovarToken = async () => { renovaciones++; return { token: `renovado-${renovaciones}`, expira: AHORA + 60 * DIA } }
})

afterEach(() => {
  Object.assign(db, originalesDb)
  Object.assign(ig, originalesIg)
})

test('sin token guardado: renueva, lo guarda y lo usa', async () => {
  await agente.mantenerToken({ ahora: AHORA })
  assert.equal(renovaciones, 1)
  assert.equal(guardado.token, 'renovado-1')
  assert.equal(guardado.origen, hash('token-de-render'))
  assert.equal(enUso, 'renovado-1')
})

test('renovado hace poco: lo usa sin volver a renovar', async () => {
  guardado = { token: 'renovado-viejo', origen: hash('token-de-render'), expira: new Date(AHORA + 50 * DIA), renovado: new Date(AHORA - 2 * DIA) }
  await agente.mantenerToken({ ahora: AHORA })
  assert.equal(renovaciones, 0)
  assert.equal(enUso, 'renovado-viejo')
})

test('a la semana lo vuelve a renovar', async () => {
  guardado = { token: 'renovado-viejo', origen: hash('token-de-render'), expira: new Date(AHORA + 50 * DIA), renovado: new Date(AHORA - 8 * DIA) }
  await agente.mantenerToken({ ahora: AHORA })
  assert.equal(renovaciones, 1)
  assert.equal(enUso, 'renovado-1')
})

test('si en Render pusieron otro token, manda ese y no el guardado', async () => {
  guardado = { token: 'renovado-del-anterior', origen: hash('token-anterior'), expira: new Date(AHORA + 50 * DIA), renovado: new Date(AHORA - DIA) }
  ig.renovarToken = async () => { throw new Error('(#190) aún no se puede renovar') }
  await agente.mantenerToken({ ahora: AHORA })
  assert.equal(enUso, null, 'se usa la variable de Render')
})
