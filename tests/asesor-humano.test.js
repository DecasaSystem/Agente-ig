'use strict'
// Detección automática de un asesor humano en la conversación.
//
// Instagram devuelve como "eco" todo lo que sale de la cuenta del negocio: lo que envía la
// IA y lo que escribe una persona. Distinguirlos es lo que permite callar a la IA en
// cuanto entra un humano, sin esperar a que nadie pulse "Tomar" en el panel. Si la
// distinción falla hacia un lado, hablan dos a la vez; si falla hacia el otro, la IA se
// calla sola sin motivo. Por eso ambos sentidos están cubiertos aquí.

const { test } = require('node:test')
const assert = require('node:assert/strict')

const agente = require('../index.js')

test('normalizarEco: ignora diferencias de espacios y saltos de línea', () => {
  assert.equal(agente.normalizarEco('  Hola   \n  mundo '), 'Hola mundo')
  assert.equal(agente.normalizarEco(null), '')
})

test('textoCoincideCon: exacto siempre; por fragmento solo en textos largos', () => {
  // Igualdad exacta
  assert.equal(agente.textoCoincideCon('¡Listo! 🛍️', '¡Listo! 🛍️'), true)

  // Un mensaje largo sale troceado: cada trozo debe reconocerse como propio
  const largo = 'La CAMA BALI es preciosa y viene tapizada en tela antifluido, ideal si tienes niños o mascotas en casa'
  const trozo = 'La CAMA BALI es preciosa y viene tapizada'
  assert.equal(agente.textoCoincideCon(trozo, largo), true)
  assert.equal(agente.textoCoincideCon(largo, trozo), true)

  // Textos cortos distintos NO deben colarse por inclusión: un "Listo" del asesor no es
  // el "Listo, la agrego" de la IA
  assert.equal(agente.textoCoincideCon('Listo', 'Listo, la agrego'), false)
  assert.equal(agente.textoCoincideCon('Hola', 'Hola, ¿en qué te ayudo?'), false)

  // Nada vacío coincide
  assert.equal(agente.textoCoincideCon('', 'algo'), false)
  assert.equal(agente.textoCoincideCon('algo', ''), false)
})

test('ecoEsDeLaIA: reconoce lo que la IA acaba de enviar y no lo demás', () => {
  const psid = 'psid-eco-1'
  agente.registrarEnviadoPorIA(psid, 'El SOFA ROMA cuesta $3.000.000 y viene en tela antifluido 😊')

  assert.equal(agente.ecoEsDeLaIA(psid, 'El SOFA ROMA cuesta $3.000.000 y viene en tela antifluido 😊'), true)
  // Mismo texto con otro espaciado (Meta puede normalizarlo)
  assert.equal(agente.ecoEsDeLaIA(psid, 'El SOFA ROMA cuesta $3.000.000  y viene en tela antifluido 😊'), true)
  // Un trozo del mensaje largo
  assert.equal(agente.ecoEsDeLaIA(psid, 'El SOFA ROMA cuesta $3.000.000'), true)

  // Lo que escribe un asesor no está registrado
  assert.equal(agente.ecoEsDeLaIA(psid, 'Hola, soy Carlos del equipo, ¿te ayudo con el sofá?'), false)
  // Ni afecta a otro cliente
  assert.equal(agente.ecoEsDeLaIA('psid-otro', 'El SOFA ROMA cuesta $3.000.000'), false)
})

test('detectarAsesorHumano: silencia a la IA solo cuando escribe una persona', async () => {
  const psid = 'psid-deteccion'
  const llamadas = { marcado: 0, guardado: [] }

  // db se sustituye por uno de mentira: aquí solo importa a quién se llama, no la BD.
  const db = require('../db.js')
  const originalMarcar = db.marcarAsesorHumano
  const originalGuardar = db.guardarMensaje
  const originalHistorial = db.getHistorial
  db.marcarAsesorHumano = async () => { llamadas.marcado++; return llamadas.marcado === 1 }
  db.guardarMensaje = async (p, role, content) => { llamadas.guardado.push(content) }
  db.getHistorial = async () => []

  try {
    // 1. Lo que envía la IA no la silencia
    agente.registrarEnviadoPorIA(psid, 'Con gusto te muestro nuestras camas tapizadas 😊')
    await agente.detectarAsesorHumano(psid, 'Con gusto te muestro nuestras camas tapizadas 😊')
    assert.equal(llamadas.marcado, 0, 'un eco propio no debe silenciar a la IA')

    // 2. Un mensaje que la IA no envió sí la silencia y queda en el historial
    await agente.detectarAsesorHumano(psid, 'Hola, soy Carlos. Te confirmo que sí tenemos esa cama en Armenia.')
    assert.equal(llamadas.marcado, 1)
    assert.equal(llamadas.guardado[0], '[Asesor] Hola, soy Carlos. Te confirmo que sí tenemos esa cama en Armenia.')

    // 3. Mensajes siguientes del asesor se siguen guardando (refrescan su actividad)
    await agente.detectarAsesorHumano(psid, '¿Te la llevamos el viernes por la mañana?')
    assert.equal(llamadas.marcado, 2)
    assert.equal(llamadas.guardado.length, 2)
  } finally {
    db.marcarAsesorHumano = originalMarcar
    db.guardarMensaje = originalGuardar
    db.getHistorial = originalHistorial
  }
})

test('detectarAsesorHumano: tras un redeploy, el historial evita el falso positivo', async () => {
  const psid = 'psid-redeploy'
  const db = require('../db.js')
  const originalMarcar = db.marcarAsesorHumano
  const originalGuardar = db.guardarMensaje
  const originalHistorial = db.getHistorial

  let marcado = 0
  db.marcarAsesorHumano = async () => { marcado++; return true }
  db.guardarMensaje = async () => {}
  // El registro en memoria se perdió, pero el mensaje sí está en el historial guardado
  db.getHistorial = async () => ([
    { role: 'user', content: '¿cuánto vale?' },
    { role: 'assistant', content: 'La CAMA MIAMI va desde $2.480.000 según la medida que elijas 😊' },
  ])

  try {
    await agente.detectarAsesorHumano(psid, 'La CAMA MIAMI va desde $2.480.000 según la medida que elijas 😊')
    assert.equal(marcado, 0, 'un mensaje de la IA recuperado del historial no debe silenciarla')
  } finally {
    db.marcarAsesorHumano = originalMarcar
    db.guardarMensaje = originalGuardar
    db.getHistorial = originalHistorial
  }
})

test('detectarAsesorHumano: el aviso automático de espera no cuenta como asesor', async () => {
  const db = require('../db.js')
  const original = db.marcarAsesorHumano
  let marcado = 0
  db.marcarAsesorHumano = async () => { marcado++; return true }
  try {
    await agente.detectarAsesorHumano('psid-aviso', 'Tu mensaje fue recibido, un asesor te responderá pronto 😊')
    assert.equal(marcado, 0)
  } finally {
    db.marcarAsesorHumano = original
  }
})
