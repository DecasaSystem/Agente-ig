// Enlaces de los catálogos (PDF / flipbook) que el agente le manda al cliente.
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

module.exports = { leerCatalogos };
