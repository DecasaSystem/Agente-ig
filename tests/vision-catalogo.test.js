'use strict'
// Identificación visual por categoría: clasificar el mueble y comparar SOLO con las
// fotos de esa categoría. El cliente de OpenAI se simula.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vc = require('../vision-catalogo')

const IMAGEN = { base64: 'AAAA', mime: 'image/jpeg' }
const CATEGORIAS = [
  { clave: 'bases_comedores', nombre: 'Comedores' },
  { clave: 'sillas_comedor',  nombre: 'Sillas de Comedor' },
  { clave: 'sofas',           nombre: 'Sofás' },
]
const INVENTARIO = [
  { nombre: 'BASE ABANICA', imagen: 'https://res.cloudinary.com/x/image/upload/v1/a.png', medidas: 'Diametro 120', material: 'Chapilla', precio: 2180000, categoria: 'bases_comedores' },
  { nombre: 'BASE 2K',      imagen: 'https://res.cloudinary.com/x/image/upload/v1/b.png', medidas: '1.20 x 0.90',  material: 'Madera',   precio: 1480000, categoria: 'bases_comedores' },
  { nombre: 'SILLA SELENE', imagen: 'https://res.cloudinary.com/x/image/upload/v1/c.png', medidas: '45x50', material: 'Madera', precio: 780000, categoria: 'sillas_comedor' },
  { nombre: 'SOFA ROMA',    imagen: 'https://res.cloudinary.com/x/image/upload/v1/d.png', medidas: '2.00', material: 'Tela', precio: 3000000, categoria: 'sofas' },
]

function openaiFalso({ clasificacion, comparaciones = [] }) {
  const llamadas = []
  let n = 0
  return {
    llamadas,
    chat: { completions: { create: async (req) => {
      llamadas.push(req)
      const esquema = req.response_format?.json_schema?.name
      const datos = esquema === 'clasificacion_imagen' ? clasificacion : (comparaciones[n++] ?? { coincidencias: [] })
      return { usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ message: { content: JSON.stringify(datos) } }] }
    } } },
  }
}
const clasifComedor = { es_mueble: true, categorias: ['bases_comedores'], es_captura: true, texto_visible: '', descripcion: 'mesa redonda' }

test('vision: compara solo con la categoría clasificada y devuelve coincidencia alta', async () => {
  const openai = openaiFalso({ clasificacion: clasifComedor, comparaciones: [{ coincidencias: [{ indice: 1, similitud: 92, razon: 'misma base' }] }] })
  const r = await vc.identificarPorVision(openai, IMAGEN, { inventarioPlano: INVENTARIO, categorias: CATEGORIAS, resolverPorNombre: () => null })
  assert.equal(r.tipo, 'alta')
  assert.equal(r.producto.nombre, 'BASE ABANICA')
  const textos = openai.llamadas[1].messages[1].content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  assert.ok(textos.includes('#1 BASE ABANICA') && textos.includes('#2 BASE 2K'))
  assert.ok(!textos.includes('SOFA ROMA') && !textos.includes('SILLA SELENE'))
  assert.equal(openai.llamadas[0].messages[1].content[1].image_url.detail, 'low')
  assert.ok(vc.construirContextoVision(r, p => p.nombre).includes('COINCIDENCIA VISUAL ALTA'))
})

test('vision: el texto leído en la captura identifica el producto sin comparar', async () => {
  const openai = openaiFalso({ clasificacion: { ...clasifComedor, texto_visible: 'Base 2K' } })
  const r = await vc.identificarPorVision(openai, IMAGEN, {
    inventarioPlano: INVENTARIO, categorias: CATEGORIAS,
    resolverPorNombre: t => INVENTARIO.find(p => p.nombre.toLowerCase() === t.toLowerCase()) ?? null,
  })
  assert.equal(r.tipo, 'nombre')
  assert.equal(openai.llamadas.length, 1)
})

test('vision: similitud media y baja no afirman que sea el producto', async () => {
  const media = await vc.identificarPorVision(openaiFalso({ clasificacion: clasifComedor, comparaciones: [{ coincidencias: [{ indice: 2, similitud: 70, razon: 'parecida' }] }] }), IMAGEN, { inventarioPlano: INVENTARIO, categorias: CATEGORIAS })
  assert.equal(media.tipo, 'media')
  assert.equal(media.producto, null)
  assert.ok(vc.construirContextoVision(media, p => p.nombre).includes('se parece mucho a'))

  const baja = await vc.identificarPorVision(openaiFalso({ clasificacion: clasifComedor, comparaciones: [{ coincidencias: [{ indice: 1, similitud: 20, razon: 'no' }] }] }), IMAGEN, { inventarioPlano: INVENTARIO, categorias: CATEGORIAS })
  assert.equal(baja.tipo, 'baja')
  assert.ok(vc.construirContextoVision(baja, p => p.nombre).includes('reportar_imagen_no_identificada'))
})

test('vision: comedor completo compara en bases y sillas', async () => {
  const openai = openaiFalso({
    clasificacion: { ...clasifComedor, categorias: ['bases_comedores', 'sillas_comedor'] },
    comparaciones: [{ coincidencias: [{ indice: 1, similitud: 88, razon: 'base' }] }, { coincidencias: [{ indice: 1, similitud: 95, razon: 'silla' }] }],
  })
  const r = await vc.identificarPorVision(openai, IMAGEN, { inventarioPlano: INVENTARIO, categorias: CATEGORIAS })
  assert.equal(openai.llamadas.length, 3)
  assert.deepEqual(r.coincidencias.map(c => c.nombre), ['SILLA SELENE', 'BASE ABANICA'])
})

test('vision: más de 20 fotos se comparan por tandas', async () => {
  const muchos = Array.from({ length: 25 }, (_, i) => ({ nombre: `BASE ${i + 1}`, imagen: `https://res.cloudinary.com/x/image/upload/v1/${i}.png` }))
  const openai = openaiFalso({ comparaciones: [{ coincidencias: [{ indice: 3, similitud: 50, razon: 'a' }] }, { coincidencias: [{ indice: 2, similitud: 90, razon: 'b' }] }] })
  const { coincidencias } = await vc.compararConCategoria(openai, IMAGEN, muchos)
  assert.equal(openai.llamadas.length, 2)
  assert.deepEqual(coincidencias.map(c => c.nombre), ['BASE 22', 'BASE 3'])
})
