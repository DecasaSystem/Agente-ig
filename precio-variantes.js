// Qué variantes de un producto deciden su PRECIO, con la misma regla del sistema de
// ventas.
//
// En el sistema (NuevaOrdenView.vue) el precio de lo que se vende es la SUMA de los
// `precio_adicional` de las opciones elegidas, uno por tipo de variante, y si la suma da
// 0 se usa el precio_base. De ahí salen tres casos:
//
//   - Tipos cuyas opciones tienen todas precio_adicional = 0 (color, tela, acabado): no
//     cambian el precio. Antes el agente los mezclaba en la lista de precios con el valor
//     del precio_base, y el rango "desde" podía salir de un color en vez de una medida.
//   - UN solo tipo con precio propio (lo normal: las medidas de una cama): cada opción
//     vale su precio (o el base si su adicional es 0). El agente lo maneja bien.
//   - DOS o más tipos con precio propio: el precio es la suma de lo que se elija en cada
//     uno. El agente NO arma esa combinación: es una regla de plata del sistema y no se
//     copia aquí. Da el "desde" y pasa el precio exacto a un asesor.
//
// Cada variante llega de db.js como { etiqueta, precio, tipo, afectaPrecio, precioPropio }.
// `precioPropio` = el precio_adicional de esa opción es > 0. Si falta (datos viejos o de
// pruebas) se toma como true, que es como se comportaba antes.

// Lo que de verdad cobra el sistema: Nueva orden suma el precio_adicional de lo elegido
// SIN mirar `afecta_precio` del tipo (esa marca solo esconde el campo de precio en
// Inventario). Si un tipo pasó a "Solo diferencia" con precios ya cargados, el sistema
// los sigue cobrando, así que el agente también. P. ej. Mecanismo: Manual (palanca, 0 →
// precio base) / Eléctrica (botón, su precio): el tipo es de precio por la Eléctrica.
// `afectaPrecio` solo decide cuando no se sabe el precio_adicional (datos viejos).
function tienePrecioPropio(v) {
  if (typeof v.precioPropio === 'boolean') return v.precioPropio;
  return v.afectaPrecio !== false;
}

function analizarVariantes(producto) {
  const todas = (producto?.variantes || []).filter(v => v.etiqueta && v.precio > 0);

  // Un tipo "es de precio" si al menos una de sus opciones tiene precio propio.
  const tiposDePrecio = [...new Set(todas.filter(tienePrecioPropio).map(v => v.tipo ?? 'Opciones'))];
  const dePrecio = todas.filter(v => tiposDePrecio.includes(v.tipo ?? 'Opciones'));
  const cosmeticas = todas.filter(v => !tiposDePrecio.includes(v.tipo ?? 'Opciones'));

  return {
    dePrecio,              // las opciones que deciden el precio (de un tipo, o de varios si combina)
    cosmeticas,            // opciones que no cambian el precio (solo informativas)
    tiposDePrecio,
    combinaTipos: tiposDePrecio.length > 1,
  };
}

// El "desde" de un producto que combina varios tipos con precio, calculado como lo
// calcularía el sistema: se elige una opción por tipo, se suman los precio_adicional
// (las opciones sin precio propio suman 0) y si la suma da 0 vale el precio base. Se
// prueban todas las combinaciones (son pocas: un par de tipos con pocas opciones) y se
// queda la más barata. Solo informa el "desde": el precio exacto lo cotiza un asesor.
const MAX_COMBINACIONES = 5000;

function precioMinimoCombinado(producto, precioBase) {
  const { dePrecio, tiposDePrecio } = analizarVariantes(producto);
  const grupos = tiposDePrecio.map(t =>
    dePrecio.filter(v => (v.tipo ?? 'Opciones') === t).map(v => (tienePrecioPropio(v) ? v.precio : 0))
  );
  if (!grupos.length) return precioBase;

  let sumas = [0];
  for (const g of grupos) {
    if (sumas.length * g.length > MAX_COMBINACIONES) {
      // Catálogo raro con demasiadas opciones: cota inferior simple (no debería pasar).
      return Math.min(...dePrecio.map(v => v.precio));
    }
    sumas = sumas.flatMap(s => g.map(p => s + p));
  }
  return Math.min(...sumas.map(s => (s > 0 ? s : precioBase)));
}

// Productos que se venden EN JUEGO (p. ej. mesas de noche de a 2). En el sistema de
// ventas `piezas_por_juego = N` significa que el precio_base es el del JUEGO completo, y
// una pieza suelta vale `precio_pieza` (o, si está vacío, el juego entre N) — ver la
// migración venta_por_juego y Producto::seVendeEnJuego. El agente no leía esas columnas:
// le decía al cliente "$800.000" sin aclarar que era el precio del par.
//
// Devuelve null si se vende por unidad, o lo que el modelo necesita saber. El precio de
// la pieza suelta solo se da si el producto no tiene variantes de precio: con variantes,
// cuánto vale una pieza de cada opción lo confirma un asesor.
function infoVentaPorJuego(producto, precioJuego) {
  const n = Number(producto?.piezasPorJuego ?? 0);
  if (!(n > 1)) return null;
  const { dePrecio } = analizarVariantes(producto);
  // Misma cuenta que Producto::precioPieza: el precio propio de la pieza o, si no tiene,
  // el del juego repartido (hacia abajo).
  const pieza = dePrecio.length
    ? null
    : (producto.precioPieza != null && producto.precioPieza !== '' ? Number(producto.precioPieza) : Math.floor(Number(precioJuego) / n));
  // Una opción puede tener su propio número de piezas ("juego de 6"): Producto::piezasDelJuego.
  const porOpcion = dePrecio.filter(v => Number(v.piezasPorJuego) > 1 && Number(v.piezasPorJuego) !== n);
  return {
    piezas_por_juego: n,
    ...(pieza ? { precio_pieza_suelta: pieza } : {}),
    ...(porOpcion.length ? { piezas_por_opcion: porOpcion.map(v => `${v.etiqueta}: juego de ${v.piezasPorJuego}`) } : {}),
    nota_juego: `Se vende en JUEGO de ${n} piezas${porOpcion.length ? ' (algunas opciones traen otro número: mira piezas_por_opcion)' : ''}: todos los precios de este producto son por el juego completo, no por pieza. Díselo así al cliente ("el juego de ${n}").` +
      (pieza ? ' Si quiere una sola pieza, la pieza suelta tiene su propio precio (precio_pieza_suelta).' : ' Si quiere una sola pieza, el precio de la pieza suelta lo confirma un asesor.'),
  };
}

module.exports = { analizarVariantes, precioMinimoCombinado, infoVentaPorJuego };
