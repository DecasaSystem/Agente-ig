'use strict'
// La notificación al sistema de ventas lleva una clave de idempotencia que sobrevive a la
// cola de reintentos: el primer envío, el reintento de los 6 s y el de la cola (horas
// después) son el MISMO aviso, y el sistema de ventas no crea una segunda tarjeta.

const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

process.env.DECASA_API_URL = 'https://api.prueba'
const axios = require('axios')
const db = require('../db')
const agente = require('../index.js')

const enviados = []
let fallarEnvios = 0
let encolado = null

beforeEach(() => {
  enviados.length = 0
  fallarEnvios = 0
  encolado = null
  axios.post = async (_url, payload) => {
    enviados.push(payload)
    if (fallarEnvios-- > 0) throw Object.assign(new Error('Bad Request'), { response: { status: 400 } })
    return { status: 201 }
  }
  db.getHistorial = async () => []
  db.getPerfil = async () => null
  db.encolarNotificacion = async (psid, tipo, payload) => { encolado = { id: 1, psid, tipo, intentos: 1, payload } }
  db.eliminarNotificacion = async () => {}
  db.reprogramarNotificacion = async () => {}
})

const esperar = () => new Promise(r => setTimeout(r, 20))

test('el reintento desde la cola manda la misma clave que el primer envío', async () => {
  fallarEnvios = 1 // el primer envío falla (sin reintento inmediato: es un 4xx) y se encola
  agente.notificarRedes('123', { nombre: 'Ana' }, 'Quiere un asesor', 'asesor', {})
  await esperar()

  assert.ok(encolado, 'la notificación debió quedar en la cola')
  const clave = enviados[0].idempotencia
  assert.match(clave, /^[0-9a-f-]{36}$/)
  assert.equal(encolado.payload.extra.idempotencia, clave)

  db.getNotificacionesPendientes = async () => [encolado]
  await agente.procesarColaNotificaciones()
  assert.equal(enviados.length, 2)
  assert.equal(enviados[1].idempotencia, clave)
})

test('dos avisos distintos llevan claves distintas', async () => {
  agente.notificarRedes('123', { nombre: 'Ana' }, 'Quiere un asesor', 'asesor', {})
  agente.notificarRedes('123', { nombre: 'Ana' }, 'Quiere un asesor', 'asesor', {})
  await esperar()
  assert.equal(enviados.length, 2)
  assert.notEqual(enviados[0].idempotencia, enviados[1].idempotencia)
})
