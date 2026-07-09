'use strict'
const sharp = require('sharp')
const axios = require('axios')

const HASH_SIZE = 8 // grilla 8x8 -> hash de 64 bits

// dHash: en escala de grises, compara cada pixel con su vecino de la derecha.
// Es robusto a recompresión/reescalado (screenshots, reposts) sin depender de un modelo.
async function dHashDeBuffer(buffer) {
  const { data } = await sharp(buffer)
    .resize(HASH_SIZE + 1, HASH_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  let hash = 0n
  let bit = 0n
  for (let fila = 0; fila < HASH_SIZE; fila++) {
    for (let col = 0; col < HASH_SIZE; col++) {
      const izq = data[fila * (HASH_SIZE + 1) + col]
      const der = data[fila * (HASH_SIZE + 1) + col + 1]
      if (izq > der) hash |= (1n << bit)
      bit++
    }
  }
  return hash.toString(16).padStart(16, '0')
}

function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB) return 64
  let x = BigInt('0x' + hexA) ^ BigInt('0x' + hexB)
  let dist = 0
  while (x > 0n) { dist += Number(x & 1n); x >>= 1n }
  return dist
}

// Un screenshot de Instagram trae de más: barra de estado, header, iconos, caption.
// Un solo hash de la imagen completa casi nunca calza con la foto limpia del catálogo,
// así que probamos también un par de recortes centrales plausibles (proporción cuadrada
// y 4:5, que son las que usa Instagram para posts) además de la imagen completa.
async function hashesCandidatos(buffer) {
  const hashes = [await dHashDeBuffer(buffer)]
  try {
    const { width: w, height: h } = await sharp(buffer).metadata()
    if (w && h) {
      const recortes = [
        { left: 0, top: Math.round(h * 0.15), width: w, height: w },               // banda cuadrada centrada
        { left: 0, top: Math.round(h * 0.20), width: w, height: Math.round(w * 1.25) }, // banda 4:5
      ]
      for (const r of recortes) {
        if (r.top < 0 || r.top + r.height > h) continue
        const recorte = await sharp(buffer).extract(r).toBuffer()
        hashes.push(await dHashDeBuffer(recorte))
      }
    }
  } catch { /* si el recorte falla, seguimos solo con el hash de la imagen completa */ }
  return hashes
}

async function hashDesdeUrl(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 })
  return dHashDeBuffer(Buffer.from(resp.data))
}

// Umbral sobre 64 bits: <=10 bits distintos es una coincidencia muy probable para
// fotos reusadas (mismo archivo recomprimido, recortado o reposteado).
const UMBRAL_MATCH = 10

// catalogo: iterable de [nombre, hashHex]
function mejorCoincidencia(hashesEntrada, catalogo) {
  let mejor = null
  for (const [nombre, hashCatalogo] of catalogo) {
    for (const h of hashesEntrada) {
      const dist = hammingDistance(h, hashCatalogo)
      if (dist <= UMBRAL_MATCH && (!mejor || dist < mejor.dist)) {
        mejor = { nombre, dist }
      }
    }
  }
  return mejor
}

module.exports = { dHashDeBuffer, hashesCandidatos, hashDesdeUrl, hammingDistance, mejorCoincidencia, UMBRAL_MATCH }
