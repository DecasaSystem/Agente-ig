'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Logs con contexto de conversación.
//
// Hasta ahora eran `console.log` sueltos: para reconstruir qué pasó con un cliente concreto
// había que ir cazando líneas por el teléfono, y los mensajes de dos clientes atendidos a la
// vez quedaban entrelazados sin forma de separarlos.
//
// Aquí cada línea lleva quién, por qué canal y en qué turno. El contexto se propaga con
// AsyncLocalStorage, así que NO hay que pasar un parámetro extra por todas las funciones:
// se abre una vez al empezar a procesar el mensaje y todo lo que ocurra dentro lo hereda,
// incluidas las llamadas asíncronas.
//
// Formato: por defecto texto legible (para desarrollo); con LOG_FORMATO=json, una línea JSON
// por evento, que es lo que quieren los agregadores de logs.

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

const almacen = new AsyncLocalStorage();
const formatoJSON = () => process.env.LOG_FORMATO === 'json';

// Id corto y legible: suficiente para agrupar un turno sin llenar la línea.
function nuevoId() {
  return crypto.randomBytes(3).toString('hex');
}

// Abre un contexto para todo lo que ocurra dentro de `fn`.
function conContexto(datos, fn) {
  const contexto = { turno: nuevoId(), ...datos };
  return almacen.run(contexto, fn);
}

function contextoActual() {
  return almacen.getStore() ?? {};
}

// Añade datos al contexto en curso (por ejemplo, el nombre del cliente cuando se descubre).
function anotar(datos) {
  const actual = almacen.getStore();
  if (actual) Object.assign(actual, datos);
}

function emitir(nivel, evento, datos = {}) {
  const ctx = contextoActual();
  if (formatoJSON()) {
    const linea = JSON.stringify({ ts: new Date().toISOString(), nivel, evento, ...ctx, ...datos });
    (nivel === 'error' ? console.error : console.log)(linea);
    return;
  }

  // Texto legible: [turno canal cliente] evento clave=valor
  const cabecera = [ctx.turno, ctx.canal, ctx.cliente].filter(Boolean).join(' ');
  const extra = Object.entries(datos)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
  const linea = `${cabecera ? `[${cabecera}] ` : ''}${evento}${extra ? ` ${extra}` : ''}`;
  (nivel === 'error' ? console.error : console.log)(linea);
}

const info = (evento, datos) => emitir('info', evento, datos);
const aviso = (evento, datos) => emitir('warn', evento, datos);
const error = (evento, datos) => emitir('error', evento, datos);

// Mide cuánto tarda algo y lo registra. Útil para ver dónde se va el tiempo de un turno
// (modelo, base de datos, descarga de imágenes) sin instrumentar a mano cada llamada.
async function medir(evento, fn, datos = {}) {
  const desde = Date.now();
  try {
    const resultado = await fn();
    info(evento, { ...datos, ms: Date.now() - desde });
    return resultado;
  } catch (e) {
    error(`${evento}_fallo`, { ...datos, ms: Date.now() - desde, error: e.message });
    throw e;
  }
}

module.exports = { conContexto, contextoActual, anotar, info, aviso, error, medir, nuevoId };
