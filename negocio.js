'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Configuración del negocio al que atiende el agente. Todo lo que cambia de un cliente a
// otro (nombre, sedes, horario, políticas, categorías, textos) vive en negocio.json; aquí
// solo se carga, se valida y se expone en la forma que necesita el código.
//
// Para desplegar el agente para otro negocio: se copia negocio.json, se edita y se apunta
// NEGOCIO_CONFIG a la copia. Los datos sensibles (teléfono de compras, email legal) se
// pueden dejar fuera del archivo y pasarlos por variables de entorno.

const fs   = require('fs');
const path = require('path');

const RUTA = process.env.NEGOCIO_CONFIG || path.join(__dirname, 'negocio.json');

function cargar() {
  try {
    const cfg = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
    validar(cfg);
    return cfg;
  } catch (e) {
    // Sin configuración válida el agente no puede atender a nadie: mejor no arrancar que
    // responder con los datos de otro negocio o con huecos.
    throw new Error(`No se pudo cargar la configuración del negocio (${RUTA}): ${e.message}`);
  }
}

function validar(cfg) {
  const faltan = [];
  if (!cfg.asesora?.nombre)     faltan.push('asesora.nombre');
  if (!cfg.empresa?.nombre)     faltan.push('empresa.nombre');
  if (!cfg.empresa?.zonaHoraria) faltan.push('empresa.zonaHoraria');
  if (!Array.isArray(cfg.sedes) || !cfg.sedes.length) faltan.push('sedes');
  if (!cfg.categorias || !Object.keys(cfg.categorias).length) faltan.push('categorias');
  if (!cfg.horario?.semana || !cfg.horario?.sabado) faltan.push('horario.semana/horario.sabado');
  if (faltan.length) throw new Error(`faltan campos obligatorios: ${faltan.join(', ')}`);

  for (const s of cfg.sedes) {
    if (!s.id || !s.direccion) throw new Error(`sede sin id o dirección: ${JSON.stringify(s)}`);
  }
}

const cfg = cargar();

// Los datos de contacto pueden venir por entorno para no guardarlos en el repositorio.
const comprasWhatsapp  = process.env.COMPRAS_WHATSAPP || cfg.contactos?.comprasWhatsapp || null;
const emailPrivacidad  = process.env.CONTACTO_PRIVACIDAD_EMAIL || cfg.contactos?.emailPrivacidad || null;
// App del sistema de ventas: de ahí salen los enlaces a sus catálogos públicos (catalogos.js).
const urlCatalogoPublico = (process.env.CATALOGO_PUBLICO_URL || cfg.catalogoPublico?.urlBase || '').replace(/\/+$/, '') || null;

// ── Sedes ─────────────────────────────────────────────────────────────────────

// { 1: 'Avenida Bolívar…' } — dirección completa por número de sede.
const UBICACIONES = Object.fromEntries(cfg.sedes.map(s => [s.id, s.direccion]));
// { 1: 'Decasa Bolívar — …' } — nombre comercial, el que ve el asesor en el panel.
const SEDE_NOMBRE = Object.fromEntries(cfg.sedes.map(s => [s.id, s.nombre || s.direccion]));
// { 1: 1 } — id de la tienda en la base de datos del sistema de ventas.
const SEDE_TIENDA_ID = Object.fromEntries(cfg.sedes.map(s => [s.id, s.tiendaId ?? s.id]));

// Una sede cerrada ("activa": false en negocio.json) se queda en la lista para poder
// nombrar las citas viejas que tenía, pero no se ofrece ni se acepta para citas nuevas.
// Circunvalar cerró el 2026-08-27 y el agente la seguía ofreciendo: el cliente podía
// llegar a una tienda cerrada.
//
// Además, al arrancar el agente compara las sedes con la tabla `tiendas` del sistema de
// ventas (contrato-bd.js → verificarSedes) y marca aquí las que allá estén cerradas, para
// que el próximo cierre no dependa de que alguien se acuerde de editar este archivo.
const sedesCerradasEnBD = new Set();
const sedeAbierta = s => s.activa !== false && !sedesCerradasEnBD.has(s.id);
const sedesAbiertas = () => cfg.sedes.filter(sedeAbierta);

const sedeMin = Math.min(...cfg.sedes.filter(s => s.activa !== false).map(s => s.id));
const sedeMax = Math.max(...cfg.sedes.filter(s => s.activa !== false).map(s => s.id));

function sedeValida(n) {
  return sedesAbiertas().some(s => s.id === Number(n));
}

// Lo llama el agente con las sedes cuya tienda está cerrada en la BD del sistema.
function marcarSedesCerradas(ids) {
  sedesCerradasEnBD.clear();
  for (const id of ids) sedesCerradasEnBD.add(Number(id));
}

// Lista numerada de sedes ABIERTAS para pedirle al cliente que elija. Usa solo lo que
// dice negocio.json (no la BD): va dentro del prompt y tiene que ser estable para la caché.
function listaSedes({ indent = '  ', emojiNumeros = false } = {}) {
  const numeros = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
  return cfg.sedes
    .filter(s => s.activa !== false)
    .map(s => `${indent}${emojiNumeros ? (numeros[s.id] ?? `${s.id}.`) : `${s.id}.`} ${s.corta || s.direccion}`)
    .join('\n');
}

// ── Categorías ────────────────────────────────────────────────────────────────

const CATEGORIAS = cfg.categorias;
const clavesCategorias = Object.keys(CATEGORIAS);

// Las claves en bloques de 5 por línea, como se listan en el prompt.
function categoriasParaPrompt(porLinea = 5) {
  const lineas = [];
  for (let i = 0; i < clavesCategorias.length; i += porLinea) {
    lineas.push(clavesCategorias.slice(i, i + porLinea).join(' | '));
  }
  return lineas.join('\n');
}

// ── Moneda ────────────────────────────────────────────────────────────────────

function formatearMoneda(valor) {
  return '$' + Number(valor || 0).toLocaleString(cfg.empresa.localeMoneda || 'es-CO');
}

// ── Descuento por pago en efectivo o transferencia ──────────────────────────
// El porcentaje que la asesora puede ofrecer sola (5 %, dueño 2026-10-08). Más que eso lo
// decide un asesor humano. La cifra la calcula SIEMPRE el código: si el modelo hiciera la
// cuenta, podría equivocarse y el cliente se quedaría con un precio prometido que no existe.
const porcentajeDescuentoEfectivo = Number(cfg.pagos?.descuentos?.porcentaje) > 0
  ? Number(cfg.pagos.descuentos.porcentaje) : 0;

function conDescuentoEfectivo(valor) {
  const n = Number(valor);
  if (!porcentajeDescuentoEfectivo || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * (100 - porcentajeDescuentoEfectivo) / 100);
}

// ── Operación ─────────────────────────────────────────────────────────────────

const op = cfg.operacion ?? {};

module.exports = {
  cfg,
  RUTA,
  // Identidad
  nombreAsesora: cfg.asesora.nombre,
  nombreEmpresa: cfg.empresa.nombre,
  zonaHoraria:   cfg.empresa.zonaHoraria,
  // Sedes
  UBICACIONES, SEDE_NOMBRE, SEDE_TIENDA_ID, sedeMin, sedeMax, sedeValida, listaSedes,
  sedes: cfg.sedes, marcarSedesCerradas, sedesAbiertas,
  // Categorías
  CATEGORIAS, clavesCategorias, categoriasParaPrompt,
  mapaCategoriasBD: cfg.mapaCategoriasBD ?? {},
  urlCatalogoPublico,
  // Textos
  saludo: canal => cfg.saludos?.[canal] ?? '',
  sedesPublico: cfg.sedesPublico ?? '',
  horarioTexto: cfg.horario.texto ?? '',
  horarioPublico: cfg.horario.textoPublico ?? cfg.horario.texto ?? '',
  // Contactos (pueden venir por entorno)
  comprasWhatsapp, emailPrivacidad,
  // Horario / operación
  horario: cfg.horario,
  cerradoEnFestivos: cfg.horario.cerradoEnFestivos !== false,
  margenCierreTransferenciaMin: cfg.horario.margenCierreTransferenciaMin ?? 20,
  ventanaConversacionMinutos: op.ventanaConversacionMinutos ?? 45,
  timeoutCarritoHoras:        op.timeoutCarritoHoras ?? 72,
  retencionHistorialDias:     op.retencionHistorialDias ?? 90,
  timeoutTransferidoMinutos:  op.timeoutTransferidoMinutos ?? 360,
  maxItemsCarrito:            op.maxItemsCarrito ?? 10,
  maxPedidosDiarios:          op.maxPedidosDiarios ?? 3,
  minutosSilencioAsesor:      op.minutosSilencioAsesor ?? 60,
  topeGastoDiarioUsd:         op.topeGastoDiarioUsd ?? 0,
  // Pagos
  porcentajeDescuentoEfectivo, conDescuentoEfectivo,
  // Utilidades
  formatearMoneda,
};
