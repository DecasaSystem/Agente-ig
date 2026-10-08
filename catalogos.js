// Los catálogos que el agente le manda al cliente. Salen de tres sitios del sistema de
// ventas, en este orden (ver resolverCatalogo):
//
//   1. Catálogos VISUALES de Gestión → Catálogos (<app>/c/<slug>): EL catálogo oficial
//      desde el 2026-09-20. Reemplazaron a los PDF de Drive: las páginas viven dentro
//      del sistema y se ven como revista, sin descargar nada.
//   2. La página de la SECCIÓN del inventario (<app>/catalogo/<categoría>): la del botón
//      Compartir de Inventario, con los productos y precios de hoy. Cubre lo que todavía
//      no tiene catálogo visual (p. ej. Cunas).
//   3. Los enlaces viejos de Herramientas (`catalogo_*`, PDF de Drive): solo si no hay
//      nada de lo anterior. Ya nadie los actualiza y pueden traer precios viejos, así que
//      no le ganan a la página del inventario.
//
// ── Enlaces de Herramientas (los viejos PDF) ─────────────────────────────────────────
//
// Desde el 2026-09-13 el sistema de ventas los edita en `herramientas` (migración
// los_catalogos_son_herramientas): antes vivían en `configuracion` y no había pantalla
// para cambiarlos. Las filas viejas de `configuracion` se dejaron por compatibilidad,
// pero ya NADIE las actualiza: si el agente seguía leyendo de ahí, un catálogo cambiado
// o desactivado en el panel seguía saliendo con el enlace viejo.
//
// Orden de búsqueda:
//   1. herramientas (activo = 1, clave catalogo_*): la fuente de verdad.
//   2. configuracion (clave catalogo_*): solo si la 1 no existe todavía (BD sin la
//      migración) o no trae ninguna fila, para no quedarse sin catálogos.
//
// Devuelve { fuente, catalogos } con las claves SIN el prefijo `catalogo_`
// (p.ej. { sillas: 'https://…' }), que es como las usa el resto del código.

async function leerCatalogos(pool) {
  const aMapa = (rows) => {
    const out = {};
    for (const { clave, valor } of rows) {
      if (!clave || !valor) continue;
      out[String(clave).replace(/^catalogo_/, '')] = String(valor);
    }
    return out;
  };

  try {
    const [rows] = await pool.query(
      `SELECT clave, contenido AS valor FROM herramientas
       WHERE activo = 1 AND clave LIKE 'catalogo_%'
       ORDER BY orden`
    );
    const catalogos = aMapa(rows);
    if (Object.keys(catalogos).length > 0) return { fuente: 'herramientas', catalogos };
  } catch {
    // Tabla o columna `clave` todavía no existe: se sigue con la tabla vieja.
  }

  const [rows] = await pool.query(
    "SELECT clave, valor FROM configuracion WHERE clave LIKE 'catalogo_%'"
  );
  return { fuente: 'configuracion', catalogos: aMapa(rows) };
}

// ── Catálogos visuales y secciones del inventario ────────────────────────────────
//
//   - Catálogos VISUALES (Gestión → Catálogos): maquetados hoja por hoja, en
//     <app>/c/<slug>. Tablas `catalogos` y `catalogo_paginas`. La portada con todos
//     está en <app>/c.
//   - La página de la SECCIÓN del inventario: <app>/catalogo/<categoría>. Es la que
//     genera el botón "Compartir" del módulo de inventario. Lista en vivo los productos
//     activos de esa categoría con foto, nombre, precio y medidas
//     (CatalogoPublicoController::seccion). Existe para TODA categoría con productos
//     activos, aunque nadie haya armado un PDF: hoy hay página de Cunas y no hay PDF.
//
// Las dos son públicas y de solo lectura (las ve cualquiera con el enlace), así que
// mandarlas no expone nada que no se vea en la tienda.

// Lo que no se pudo leer queda sin definir (no vacío): así quien llama conserva la última
// carga buena en vez de quedarse sin catálogos por un fallo momentáneo de la base.
async function leerOtrasFuentes(pool) {
  const fuentes = {};

  try {
    // Solo los activos y con al menos una página: uno vacío da 404 en el visor.
    const [rows] = await pool.query(
      `SELECT c.nombre, c.slug FROM catalogos c
       WHERE c.activo = 1 AND EXISTS (SELECT 1 FROM catalogo_paginas p WHERE p.catalogo_id = c.id)
       ORDER BY c.orden, c.nombre`
    );
    fuentes.visuales = rows.filter(r => r.slug).map(r => ({ nombre: String(r.nombre ?? r.slug), slug: String(r.slug) }));
  } catch {
    // BD sin catálogos visuales (o caída): no se toca lo que había.
  }

  try {
    const [rows] = await pool.query(
      `SELECT categoria, COUNT(*) AS productos FROM productos
       WHERE activo = 1 AND categoria IS NOT NULL AND categoria <> ''
       GROUP BY categoria`
    );
    fuentes.secciones = rows.map(r => ({ categoria: String(r.categoria), productos: Number(r.productos) }));
  } catch {
    // Sin secciones el agente sigue con PDF y visuales.
  }

  return fuentes;
}

// ── Emparejar lo que pidió el cliente con un catálogo ─────────────────────────────
//
// Las claves no se escriben igual en ningún lado: el agente dice "mesas_centro", el
// catálogo visual se llama "mesas-de-centro", la categoría del inventario "Mesas de
// Centro" y el cliente "mesa de centro". Se comparan por PALABRAS: sin tildes, sin
// conectores (de, y, la…) y tolerando singular/plural, y tienen que ser LAS MISMAS
// palabras. Nada de "contiene": "comedores" está dentro de "sillas de comedor" y se
// mandaba el catálogo de sillas a quien pedía mesas de comedor. Si no hay uno igual, no
// se adivina: devuelve null y el agente pregunta.

const CONECTORES = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'para', 'con', 'catalogo', 'catalogos']);

function palabras(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(p => p && !CONECTORES.has(p));
}

function mismaPalabra(a, b) {
  return a === b || a + 's' === b || b + 's' === a || a + 'es' === b || b + 'es' === a;
}

// Todas las palabras de `a` están en `b` (con singular/plural).
function contenidas(a, b) {
  return a.every(x => b.some(y => mismaPalabra(x, y)));
}

function mismasPalabras(a, b) {
  return a.length > 0 && a.length === b.length && contenidas(a, b) && contenidas(b, a);
}

// "Mesas de Centro" → "mesas-de-centro", igual que el botón del inventario
// (InventarioView::linkSeccion). El backend compara sin separadores, así que cualquier
// forma llega a la misma sección; se usa la misma para que el enlace se vea igual.
function slugSeccion(categoria) {
  return String(categoria)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Las formas de nombrar lo que pidió el cliente: la clave tal cual, las categorías crudas
// de la BD que el agente traduce a esa clave (mapaCategoriasBD: "comedores" →
// "bases_comedores") y su nombre legible ("Comedores").
function formasDelPedido(pedido, { mapaCategoriasBD = {}, etiquetas = {} } = {}) {
  const clave = String(pedido ?? '').trim();
  const claveNorm = palabras(clave).join('_');
  const formas = [clave];
  for (const [crudo, canonica] of Object.entries(mapaCategoriasBD)) {
    if (palabras(canonica).join('_') === claveNorm) formas.push(crudo);
  }
  for (const [k, etiqueta] of Object.entries(etiquetas)) {
    if (palabras(k).join('_') === claveNorm) formas.push(etiqueta);
  }
  return formas.map(palabras).filter(p => p.length);
}

// El único candidato con las mismas palabras. `nombresDe(c)` da el texto (o los
// textos) con que se compara cada candidato; basta con que encaje uno. Dos candidatos
// iguales → null (no se adivina).
function elegir(candidatos, formas, nombresDe) {
  const textos = c => [].concat(nombresDe(c)).map(palabras);
  const iguales = candidatos.filter(c => textos(c).some(t => formas.some(f => mismasPalabras(f, t))));
  return iguales.length === 1 ? iguales[0] : null;
}

// "El catálogo" a secas ("¿tienen catálogo?", "mándame todo"): la portada con todos los
// catálogos visuales, en vez de preguntarle de qué categoría.
const PEDIDOS_GENERALES = new Set(['', 'todo', 'todos', 'general', 'completo', 'catalogo', 'catalogos', 'portada']);

/**
 * El mejor catálogo para lo que pidió el cliente, en este orden:
 *   1. catálogo visual de Gestión (el oficial),
 *   2. la página de la sección del inventario (productos y precios de hoy),
 *   3. el enlace viejo de Herramientas (PDF de Drive), solo si no hay nada de lo anterior.
 * Un enlace de Herramientas que se comprobó roto (404/410) no se manda.
 * Sin categoría ("el catálogo") → la portada <app>/c con todos.
 *
 * fuentes:  { herramientas: {clave: url}, visuales: [{nombre, slug}], secciones: [{categoria, productos}] }
 * opciones: { urlBase, mapaCategoriasBD, etiquetas, rotos: Set<url> }
 * Devuelve { url, fuente: 'visual'|'inventario'|'pdf'|'portada', nombre } o null.
 */
function resolverCatalogo(pedido, fuentes = {}, opciones = {}) {
  const base = String(opciones.urlBase ?? '').replace(/\/+$/, '');
  const rotos = opciones.rotos ?? new Set();

  if (PEDIDOS_GENERALES.has(palabras(pedido).join(' ')) || palabras(pedido).every(p => PEDIDOS_GENERALES.has(p))) {
    return base && (fuentes.visuales ?? []).length
      ? { url: `${base}/c`, fuente: 'portada', nombre: 'todos los catálogos' }
      : null;
  }

  const formas = formasDelPedido(pedido, opciones);
  if (!formas.length) return null;

  if (base) {
    const visual = elegir(fuentes.visuales ?? [], formas, c => [c.nombre, c.slug]);
    if (visual) return { url: `${base}/c/${visual.slug}`, fuente: 'visual', nombre: visual.nombre };

    const seccion = elegir((fuentes.secciones ?? []).filter(s => s.productos > 0), formas, s => s.categoria);
    if (seccion) return { url: `${base}/catalogo/${slugSeccion(seccion.categoria)}`, fuente: 'inventario', nombre: seccion.categoria };
  }

  const pdfs = Object.entries(fuentes.herramientas ?? {})
    .filter(([, url]) => url && !rotos.has(url))
    .map(([clave, url]) => ({ clave, url }));
  // Con las mismas palabras, como los demás. El agente antes aceptaba un prefijo
  // ("sillas" → "sillas_comedor") y así mandaba las sillas de comedor a quien no había
  // dicho cuáles quería: lo ambiguo se pregunta.
  const pdf = elegir(pdfs, formas, c => c.clave);
  return pdf ? { url: pdf.url, fuente: 'pdf', nombre: pdf.clave } : null;
}

// Para cuando no se encontró: qué catálogos sí hay, en palabras que el agente pueda
// ofrecerle al cliente ("camas, cunas, comedores…"). Va en la RESPUESTA de la herramienta,
// no en el prompt, para que el prompt no cambie cuando cambia el catálogo (caché).
function catalogosDisponibles(fuentes = {}, { etiquetas = {}, mapaCategoriasBD = {} } = {}) {
  const nombres = new Map(); // palabras normalizadas → como se muestra
  const agregar = (texto) => {
    const clave = palabras(texto).join(' ');
    if (!clave || [...nombres.keys()].some(k => mismasPalabras(palabras(k), palabras(clave)))) return;
    nombres.set(clave, String(texto).replace(/[_-]+/g, ' ').trim().toLowerCase());
  };
  for (const clave of Object.keys(fuentes.herramientas ?? {})) agregar(etiquetas[clave] ?? clave);
  for (const v of fuentes.visuales ?? []) agregar(v.nombre);
  for (const s of fuentes.secciones ?? []) {
    if (s.productos > 0) agregar(etiquetas[mapaCategoriasBD[s.categoria]] ?? etiquetas[s.categoria] ?? s.categoria);
  }
  return [...nombres.values()].sort();
}

// ── Enlaces de PDF rotos ─────────────────────────────────────────────────────────
//
// Los PDF viven fuera (Drive, Cloudinary…) y un día dejan de existir sin que nadie se
// entere: el cliente recibía un enlace muerto. Se comprueban al cargar los catálogos y
// solo se dan por rotos con una respuesta DEFINITIVA (404 / 410). Un timeout, un 403 o
// un 405 (hay servidores que no aceptan HEAD) no cuentan: un fallo pasajero no puede
// dejar al cliente sin catálogo.
async function revisarEnlaces(urls, { timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const rotos = new Set();
  if (typeof fetchImpl !== 'function') return rotos;
  await Promise.all([...new Set(urls)].filter(Boolean).map(async (url) => {
    try {
      const r = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 404 || r.status === 410) rotos.add(url);
    } catch {
      // Red o timeout: no se sabe, se deja como está.
    }
  }));
  return rotos;
}

// ── El catálogo del agente: carga, resuelve y vigila ───────────────────────────────
//
// Un solo objeto por agente con el estado de las tres fuentes, para que los dos agentes
// hagan exactamente lo mismo sin repetir la lógica en sus index.js.
//
//   pool      — conexión a la BD del sistema de ventas
//   respaldo  — catálogos PDF de reserva si la BD no responde (knowledge.json)
//   opciones  — { urlBase, mapaCategoriasBD, etiquetas }
//   alertar   — (titulo, detalle) para avisar de PDF rotos
function crearCatalogos({ pool, respaldo = {}, opciones = {}, alertar = () => {}, log = console } = {}) {
  const estado = {
    herramientas: { ...respaldo },
    fuente: 'respaldo',
    visuales: [],
    secciones: [],
    rotos: new Set(),
  };
  const fuentes = () => ({ herramientas: estado.herramientas, visuales: estado.visuales, secciones: estado.secciones });

  async function cargar() {
    try {
      const { fuente, catalogos } = await leerCatalogos(pool);
      if (Object.keys(catalogos).length > 0) {
        // Desde herramientas manda la BD completa: un catálogo desactivado en el panel no
        // puede seguir saliendo porque quedó escrito en el respaldo.
        estado.herramientas = fuente === 'herramientas' ? catalogos : { ...respaldo, ...catalogos };
        estado.fuente = fuente;
      }
    } catch (e) {
      log.warn('[catalogos] no se pudieron leer los PDF, sigue lo último bueno:', e.message);
    }

    const otras = await leerOtrasFuentes(pool);
    if (otras.visuales)  estado.visuales  = otras.visuales;
    if (otras.secciones) estado.secciones = otras.secciones;

    log.log(`[catalogos] ${Object.keys(estado.herramientas).length} PDF (${estado.fuente}) · ` +
      `${estado.visuales.length} visuales · ${estado.secciones.length} secciones del inventario`);

    // Los enlaces se revisan sin hacer esperar a nadie. Se avisa solo de los que se
    // rompieron desde la última revisión, no cada hora de los mismos.
    revisarEnlaces(Object.values(estado.herramientas)).then((rotos) => {
      const nuevos = [...rotos].filter(u => !estado.rotos.has(u));
      estado.rotos = rotos;
      if (nuevos.length) {
        const cuales = Object.entries(estado.herramientas).filter(([, u]) => nuevos.includes(u)).map(([k]) => k);
        alertar('Enlace de catálogo roto en Herramientas', `${cuales.join(', ')}: el enlace da 404 y el agente ya no lo manda. Si esa categoría no tiene catálogo en Gestión ni productos activos, el cliente se queda sin catálogo: corregir o quitar el enlace en Gestión → Herramientas.`);
      }
    }).catch(() => {});
  }

  return {
    cargar,
    resolver: (pedido) => resolverCatalogo(pedido, fuentes(), { ...opciones, rotos: estado.rotos }),
    disponibles: () => catalogosDisponibles(fuentes(), opciones),
    cuantos: () => Object.keys(estado.herramientas).length + estado.visuales.length + estado.secciones.length,
    // Para el comentario de Instagram y las pruebas.
    estado,
  };
}

module.exports = {
  leerCatalogos, leerOtrasFuentes, resolverCatalogo, catalogosDisponibles, revisarEnlaces, crearCatalogos,
  // Para pruebas
  palabras, slugSeccion,
};
