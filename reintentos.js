'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Reintentos con backoff exponencial y jitter para llamadas de red que fallan de forma
// transitoria (429 de rate limit, 5xx, conexión caída). Antes, un 429 de OpenAI caía
// directo al catch del manejador de mensajes: el cliente recibía "un asesor te
// contactará" y se creaba una tarjeta en el panel. Con 30 clientes activos durante una
// caída de dos minutos, eso son 30 tarjetas falsas que el equipo tiene que descartar a
// mano.
async function conReintentos(fn, { intentos = 3, baseMs = 800, esReintentable = esTransitorio, contexto = '' } = {}) {
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimoError = e;
      if (i === intentos - 1 || !esReintentable(e)) throw e;
      const espera = baseMs * (2 ** i) + Math.floor(Math.random() * 300);
      console.warn(`[retry] ${contexto} intento ${i + 1}/${intentos} falló (${e.message}); reintentando en ${espera}ms`);
      await new Promise(r => setTimeout(r, espera));
    }
  }
  throw ultimoError;
}

// Qué vale la pena reintentar: límite de tasa, error del servidor, timeout o red caída.
// Una clave inválida (401) o una petición mal formada (400) no se arreglan repitiéndola.
function esTransitorio(e) {
  const status = e?.status ?? e?.response?.status ?? e?.code;
  if (status === 429 || status === 408 || status === 409) return true;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNABORTED'].includes(e?.code)) return true;
  if (e?.name === 'APIConnectionError' || e?.name === 'APIConnectionTimeoutError') return true;
  return false;
}

// Distingue "OpenAI está caído" de "hay un bug en nuestro código". Solo en el primer caso
// tiene sentido pedirle paciencia al cliente sin molestar a un asesor.
function esFalloDelProveedor(e) {
  if (esTransitorio(e)) return true;
  const status = e?.status ?? e?.response?.status;
  return status === 401 || status === 403 || status === 402;
}

module.exports = { conReintentos, esTransitorio, esFalloDelProveedor };
