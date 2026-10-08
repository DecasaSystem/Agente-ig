'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Las cerraduras de los agentes, en un solo sitio (revisión de seguridad del 2026-10-08).

const crypto = require('crypto');

// ¿Se puede aceptar un webhook SIN verificar su firma? Solo en pruebas o si alguien lo
// pide a propósito para desarrollo local (PERMITIR_WEBHOOK_SIN_FIRMA=1).
//
// Antes, si faltaba el secreto (INSTAGRAM_APP_SECRET / TWILIO_AUTH_TOKEN), el webhook
// aceptaba cualquier cosa "para desarrollo": borrar o escribir mal una variable en Render
// dejaba que cualquiera en internet se hiciera pasar por un cliente, creara pedidos y
// llenara de avisos el celular de los vendedores. Es el mismo error que se corrigió en el
// sistema de ventas (TokenDelAgente): sin secreto se rechaza.
function puedeAceptarSinFirma() {
  return process.env.NODE_ENV === 'test' || process.env.PERMITIR_WEBHOOK_SIN_FIRMA === '1';
}

// Compara un token sin filtrar su contenido por el tiempo de respuesta (la comparación
// normal se corta en el primer carácter distinto). Sin token esperado, nada es válido.
function tokenValido(dado, esperado) {
  if (!esperado || typeof dado !== 'string') return false;
  const a = crypto.createHash('sha256').update(dado).digest();
  const b = crypto.createHash('sha256').update(String(esperado)).digest();
  return crypto.timingSafeEqual(a, b);
}

// ¿Es una dirección de Twilio a la que se le pueden mandar las credenciales de la cuenta?
// La foto o el audio del cliente llegan como `MediaUrl0` y se descargan con las
// credenciales de Twilio en la cabecera. Sin esta comprobación, una URL ajena en ese campo
// se llevaba el SID y el token de la cuenta.
function esUrlDeTwilio(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && (u.hostname === 'api.twilio.com' || u.hostname.endsWith('.twilio.com'));
  } catch {
    return false;
  }
}

module.exports = { puedeAceptarSinFirma, tokenValido, esUrlDeTwilio };
