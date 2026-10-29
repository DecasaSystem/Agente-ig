'use strict'
// Copia de nuestras historias (caso real del 2026-10-29): Instagram solo deja verlas 24 h y
// una clienta respondió a una ya vencida. archivarHistorias guarda imagen y texto mientras
// están publicadas; la respuesta a la historia usa esa copia después.

const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const db = require('../db')
const ig = require('../instagram')
const agente = require('../index.js')

const originalesDb = { ...db }
const originalesIg = { ...ig }
let guardadas

beforeEach(() => {
  guardadas = []
  Object.assign(db, {
    historiasGuardadas: async () => new Set(['ya-guardada']),
    guardarHistoria: async h => { guardadas.push(h) },
    purgarHistorias: async () => 0,
  })
})

afterEach(() => {
  Object.assign(db, originalesDb)
  Object.assign(ig, originalesIg)
})

test('guarda las historias nuevas con su imagen reducida y su texto', async () => {
  const grande = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#a0522d' } }).png().toBuffer()
  ig.getHistoriasActivas = async () => [
    { id: 'ya-guardada', media_type: 'IMAGE', media_url: 'https://cdn/x.jpg' },
    { id: 'nueva', media_type: 'IMAGE', media_url: 'https://cdn/figy.jpg', caption: 'Cama Figy con alerones', timestamp: '2026-10-28T13:00:00+0000' },
    { id: 'video', media_type: 'VIDEO', media_url: 'https://cdn/v.mp4', thumbnail_url: 'https://cdn/v.jpg' },
  ]
  const pedidas = []
  ig.downloadMediaToBuffer = async url => { pedidas.push(url); return { buffer: grande, contentType: 'image/png' } }

  await agente.archivarHistorias()

  assert.deepEqual(pedidas, ['https://cdn/figy.jpg', 'https://cdn/v.jpg'], 'la ya guardada no se baja; del video, la portada')
  assert.equal(guardadas.length, 2)
  const figy = guardadas.find(h => h.storyId === 'nueva')
  assert.equal(figy.caption, 'Cama Figy con alerones')
  assert.equal(figy.mime, 'image/jpeg')
  const { width, height } = await sharp(figy.imagen).metadata()
  assert.ok(width <= 768 && height <= 768, `reducida: ${width}x${height}`)
})

test('si la API de historias falla, no rompe nada', async () => {
  ig.getHistoriasActivas = async () => { throw new Error('(#10) sin permiso') }
  await agente.archivarHistorias()
  assert.equal(guardadas.length, 0)
})
