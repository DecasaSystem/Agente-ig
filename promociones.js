'use strict';
// Promociones por tienda del sistema de ventas (Inventario → Promociones, tablas
// `promociones` + `promocion_tienda`, migración 2026_10_23 allá). Las programa un
// supervisor: qué se rebaja (el producto entero, una opción `config_id` o una
// tela/medida `variante_id`), en qué tiendas, cuánto y de qué fecha a qué fecha.
//
// La cuenta es la misma de Promocion::precioCon y utils/promociones.js de la app:
//   porcentaje → valor = 15 (15 % menos) · monto → le quita $valor · precio → queda en $valor
// y si a un producto le aplican dos, gana la más concreta (la de la opción o la tela);
// entre dos del mismo nivel, la que más rebaja.
//
// Decisiones del dueño (2026-10-20):
//   - Elena vende por redes, que no es ninguna tienda: ofrece TODAS las vigentes y dice
//     en qué tiendas corren.
//   - Solo para lo que está en EXISTENCIA, igual que el 5 % (Nueva orden también se la
//     pone a lo que se manda a fabricar; el agente no).
//   - El 5 % por efectivo/transferencia se SUMA, calculado sobre el precio de promoción
//     (como el descuento condicionado de Nueva orden).
//
// `producto.promociones` lo llena db.js con las encendidas que no han terminado; aquí se
// filtran por la fecha de hoy en Bogotá, así no hay que recargar a medianoche.

const fechas = require('./fechas');

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function hoyIso() {
  return fechas.iso(fechas.hoy());
}

function vigentes(producto, hoy = hoyIso()) {
  return (producto?.promociones ?? []).filter(p =>
    p.fecha_inicio <= hoy && p.fecha_fin >= hoy);
}

function esConcreta(promo) {
  return Boolean(promo.config_id || promo.variante_id);
}

// Cuánto queda una unidad que valía `lista`. Nunca menos de 0 ni más de `lista`.
function precioCon(promo, lista) {
  const l = Number(lista) || 0;
  const v = Number(promo?.valor) || 0;
  let queda = l;
  if (promo?.tipo === 'porcentaje') queda = l - Math.round(l * v / 100);
  else if (promo?.tipo === 'monto') queda = l - v;
  else if (promo?.tipo === 'precio') queda = Math.min(l, v);
  return Math.max(0, Math.min(l, Math.round(queda)));
}

// La variante del producto a la que apunta la promoción (null = el producto entero).
function varianteDe(producto, promo) {
  const vs = producto?.variantes ?? [];
  if (promo.config_id) return vs.find(v => Number(v.configId) === Number(promo.config_id)) ?? null;
  if (promo.variante_id) return vs.find(v => Number(v.varianteId) === Number(promo.variante_id)) ?? null;
  return null;
}

// Precio de lista de lo que se rebaja, como Promocion::precioDeLista: el de la opción o
// la tela si tiene uno propio, si no el del producto.
function precioDeLista(producto, promo) {
  const base = Number(String(producto?.precio ?? 0).replace(/[^0-9]/g, '')) || 0;
  const v = varianteDe(producto, promo);
  return v && v.precioPropio !== false && Number(v.precio) > 0 ? Number(v.precio) : base;
}

function enExistencia(producto) {
  return Number(producto?.existencias) > 0;
}

// La promoción que le toca a una versión del producto (la variante elegida, o null para
// el producto sin opción) y su precio. `aplica` = false si no está en existencia.
function promoPara(producto, variante = null, { hoy } = {}) {
  const lista = vigentes(producto, hoy);
  if (!lista.length) return null;
  const concretas = variante
    ? lista.filter(p =>
        (p.config_id && Number(p.config_id) === Number(variante.configId)) ||
        (p.variante_id && Number(p.variante_id) === Number(variante.varianteId)))
    : [];
  const candidatas = concretas.length ? concretas : lista.filter(p => !esConcreta(p));
  if (!candidatas.length) return null;
  const precioLista = variante && variante.precioPropio !== false && Number(variante.precio) > 0
    ? Number(variante.precio)
    : precioDeLista(producto, { });
  const mejor = candidatas.reduce((a, b) => precioCon(b, precioLista) < precioCon(a, precioLista) ? b : a);
  return { promo: mejor, precioLista, precioPromo: precioCon(mejor, precioLista), aplica: enExistencia(producto) };
}

function textoRebaja(promo) {
  const v = Number(promo?.valor) || 0;
  const pesos = n => '$' + Math.round(n).toLocaleString('es-CO');
  if (promo?.tipo === 'porcentaje') return `−${Number.isInteger(v) ? v : v.toFixed(1)} %`;
  if (promo?.tipo === 'monto') return `−${pesos(v)}`;
  return `a ${pesos(v)}`;
}

function textoHasta(fecha) {
  const [, m, d] = String(fecha ?? '').slice(0, 10).split('-').map(Number);
  return m ? `${d} de ${MESES[m - 1]}` : '';
}

function textoTiendas(promo) {
  const t = promo?.tiendas ?? [];
  return t.length > 1 ? `${t.slice(0, -1).join(', ')} y ${t[t.length - 1]}` : (t[0] ?? '');
}

// Todas las promociones vigentes del producto, listas para la respuesta de una
// herramienta (regla 9: lo que depende de la base no va en el prompt).
function resumenPromociones(producto, { hoy } = {}) {
  const existe = enExistencia(producto);
  return vigentes(producto, hoy).map(p => {
    const lista = precioDeLista(producto, p);
    const version = varianteDe(producto, p)?.etiqueta ?? null;
    return {
      ...(p.nombre && { nombre: p.nombre }),
      version: version ?? 'todas las versiones',
      rebaja: textoRebaja(p),
      precio_lista: lista,
      precio_promocion: precioCon(p, lista),
      tiendas: textoTiendas(p),
      hasta: textoHasta(p.fecha_fin),
      aplica: existe,
      ...(!existe && { nota: 'La promoción es solo para lo que está en existencia: hoy este producto se fabrica sobre pedido, así que NO aplica. No la ofrezcas como si aplicara.' }),
    };
  });
}

// Una línea de texto, para el canal que arma la ficha en texto (Instagram).
function lineaPromocion(r) {
  return `PROMOCIÓN${r.nombre ? ` "${r.nombre}"` : ''} (${r.version}) ${r.rebaja}: queda en $${r.precio_promocion.toLocaleString('es-CO')} (precio de lista $${r.precio_lista.toLocaleString('es-CO')}) en ${r.tiendas}, hasta el ${r.hasta}.${r.nota ? ` ${r.nota}` : ''}`;
}

// Las promociones que aplican HOY a una lista de productos (los de una categoría), para
// decirlas junto con el catálogo sin que el cliente pregunte. Solo las que aplican: lo que
// se fabrica no lleva promoción. `max` productos como mucho, para no soltar una lista.
function promocionesDeProductos(productos, { hoy, max = 6 } = {}) {
  const lineas = [];
  for (const p of productos ?? []) {
    const aplicables = resumenPromociones(p, { hoy }).filter(r => r.aplica);
    if (aplicables.length) lineas.push(`${p.nombre}: ${aplicables.map(lineaPromocion).join(' ')}`);
    if (lineas.length >= max) break;
  }
  return lineas;
}

module.exports = {
  vigentes, precioCon, precioDeLista, promoPara, resumenPromociones, lineaPromocion, promocionesDeProductos,
  textoRebaja, textoHasta, textoTiendas, hoyIso,
};
