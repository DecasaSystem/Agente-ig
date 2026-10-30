'use strict';

// Las dos fotos de un producto (Inventario → Gestionar: `foto_url` y la "foto adicional"
// `foto_url_2`, que llegan aquí como `imagen` e `imagen2`).
//
// Pedido del dueño (2026-10-30): "subir 2 imágenes a inventario para que la IA tenga 2
// opciones". La segunda ya se mandaba al cliente con enviar_foto, pero para reconocer la
// foto que manda el cliente solo se miraba la primera: si la mandaba desde otro ángulo
// (justo el de la foto adicional) no se reconocía. Este módulo arma la lista de fotos a
// indexar (hash exacto) con las dos.
//
// La tabla del hash (`producto_imagen_hash`) es del agente y tiene una fila por clave
// (`producto_nombre`, PRIMARY KEY). La segunda foto se guarda con la clave
// `<nombre>${SUFIJO_FOTO2}` para no cambiar la tabla; `nombreDeClave` la devuelve al
// nombre del producto.

const SUFIJO_FOTO2 = ' · foto 2';
const LARGO_CLAVE = 150; // VARCHAR(150) de producto_imagen_hash.producto_nombre

function tieneFoto2(p) {
  return !!(p && p.imagen2 && p.imagen2 !== p.imagen);
}

// [{ nombre, imagen, imagen2? }] → [{ clave, imagen }]: una entrada por foto distinta.
// Un nombre tan largo que con el sufijo no cabe en la columna se queda solo con la
// primera foto (antes que fallar la inserción en cada ciclo).
function fotosParaIndexar(productos) {
  const lista = [];
  for (const p of productos || []) {
    if (!p || !p.nombre) continue;
    if (p.imagen) lista.push({ clave: p.nombre, imagen: p.imagen });
    if (tieneFoto2(p) && (p.nombre + SUFIJO_FOTO2).length <= LARGO_CLAVE) {
      lista.push({ clave: p.nombre + SUFIJO_FOTO2, imagen: p.imagen2 });
    }
  }
  return lista;
}

function nombreDeClave(clave) {
  if (typeof clave !== 'string') return clave;
  return clave.endsWith(SUFIJO_FOTO2) ? clave.slice(0, -SUFIJO_FOTO2.length) : clave;
}

module.exports = { SUFIJO_FOTO2, tieneFoto2, fotosParaIndexar, nombreDeClave };
