'use strict'
require('dotenv').config()
const cloudinary = require('cloudinary').v2
const sharp      = require('sharp')
const axios      = require('axios')

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

// Subir buffer a Cloudinary y devolver URL permanente
async function uploadBuffer(buffer, folder = 'ig-rooms') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (err, result) => {
        if (err) reject(err)
        else resolve(result.secure_url)
      }
    )
    stream.end(buffer)
  })
}

// URL de producto sin fondo via Cloudinary transform
function urlProductoSinFondo(cloudinaryUrl) {
  if (!cloudinaryUrl || !cloudinaryUrl.includes('cloudinary.com')) return cloudinaryUrl
  return cloudinaryUrl.replace('/upload/', '/upload/e_make_transparent:30,f_png/')
}

// Componer foto del cuarto con mueble encima
async function processRoomImage(roomBuffer, sofaInfo) {
  if (!sofaInfo?.imagen) {
    return { success: false, error: 'SIN_PRODUCTO', message: 'Primero pregúntame por un mueble específico para que pueda mostrarte cómo se vería.' }
  }

  try {
    // URL del producto sin fondo
    const productoUrl = urlProductoSinFondo(sofaInfo.imagen)

    // Descargar producto sin fondo
    const prodResp = await axios.get(productoUrl, { responseType: 'arraybuffer', timeout: 15000 })
    const prodBuffer = Buffer.from(prodResp.data)

    // Metadata del cuarto
    const roomMeta = await sharp(roomBuffer).metadata()
    const roomW = roomMeta.width
    const roomH = roomMeta.height

    // Escalar mueble al 38% del ancho del cuarto
    const targetW = Math.round(roomW * 0.38)
    const prodResized = await sharp(prodBuffer)
      .resize({ width: targetW, withoutEnlargement: false })
      .png()
      .toBuffer()

    const prodMeta  = await sharp(prodResized).metadata()
    const left      = Math.round((roomW - prodMeta.width) / 2)
    const top       = Math.round(roomH - prodMeta.height - roomH * 0.05)

    // Componer
    const resultBuffer = await sharp(roomBuffer)
      .composite([{ input: prodResized, left, top }])
      .jpeg({ quality: 88 })
      .toBuffer()

    // Subir resultado a Cloudinary
    const resultUrl = await uploadBuffer(resultBuffer, 'ig-visualizations')
    return { success: true, url: resultUrl }

  } catch (e) {
    console.error('[image-processor] Error:', e.message)
    return { success: false, error: 'ERROR', message: 'No pude generar la visualización, intenta de nuevo.' }
  }
}

module.exports = { uploadBuffer, urlProductoSinFondo, processRoomImage }
