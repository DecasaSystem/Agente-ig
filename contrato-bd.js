// Contrato con la base de datos del sistema de ventas (decasa-api, Laravel).
//
// Los agentes leen DIRECTO tablas que son de Laravel: el catálogo, los precios, las
// variantes, las tiendas, los catálogos PDF y el estado de las tarjetas de Redes. Nadie
// del lado de Laravel lo veía, así que una migración que renombrara `precio_base` o
// `foto_url` dejaba al bot sin inventario (o, peor, cotizando con el esquema viejo del
// fallback) sin que nadie se enterara hasta que un cliente se quejara.
//
// Esta lista es el contrato: lo que el agente necesita que exista. Al arrancar se
// compara con INFORMATION_SCHEMA y, si falta algo, se avisa por la alerta del agente.
// La misma lista está escrita para el lado de Laravel en
// Sistema-De-Ventas/docs/contrato-agentes.md — si cambias una, cambia la otra.
//
// También es la lista de permisos de SOLO LECTURA que necesita el usuario de BD propio
// de los agentes cuando se deje de usar el superusuario (ver PLAN-INTEGRACION…md, Fase 3).

const CONTRATO = {
  productos:                 ['id', 'nombre', 'precio_base', 'foto_url', 'foto_url_2', 'medidas', 'material', 'categoria', 'activo'],
  inventario:                ['producto_id', 'tienda_id', 'cantidad_disponible', 'cantidad_reservada'],
  tiendas:                   ['id', 'nombre', 'es_fabrica', 'activa'],
  producto_variante_configs: ['producto_id', 'tipo_variante_id', 'opcion_id', 'precio_adicional'],
  tipos_variante:            ['id', 'nombre', 'afecta_precio', 'activo'],
  tipo_variante_opciones:    ['id', 'nombre', 'activo'],
  producto_variantes:        ['producto_id', 'medida', 'precio_variante', 'activo'],
  herramientas:              ['clave', 'contenido', 'activo', 'orden'],
  conversaciones_wa:         ['telefono', 'estado', 'tipo', 'created_at'],
};

// Tablas de las que el agente puede prescindir: si no están, tiene un respaldo.
const OPCIONALES = new Set(['configuracion']);
const CONTRATO_OPCIONAL = {
  configuracion: ['clave', 'valor'],
};

// Devuelve la lista de { tabla, columna } que faltan (columna null = falta la tabla).
// Nunca lanza: si no se puede leer INFORMATION_SCHEMA devuelve { error }.
async function verificarContrato(pool) {
  const todas = { ...CONTRATO, ...CONTRATO_OPCIONAL };
  const tablas = Object.keys(todas);
  let rows;
  try {
    [rows] = await pool.query(
      `SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
      [tablas]
    );
  } catch (e) {
    return { faltantes: [], error: e.message };
  }

  const existentes = new Map();
  for (const r of rows) {
    const t = r.tabla ?? r.TABLE_NAME;
    const c = r.columna ?? r.COLUMN_NAME;
    if (!existentes.has(t)) existentes.set(t, new Set());
    existentes.get(t).add(c);
  }

  const faltantes = [];
  for (const [tabla, columnas] of Object.entries(todas)) {
    const cols = existentes.get(tabla);
    if (!cols) {
      if (!OPCIONALES.has(tabla)) faltantes.push({ tabla, columna: null });
      continue;
    }
    for (const c of columnas) if (!cols.has(c)) faltantes.push({ tabla, columna: c });
  }
  return { faltantes };
}

// Texto corto para la alerta: "productos.foto_url, tabla herramientas".
function describirFaltantes(faltantes) {
  return faltantes.map(f => (f.columna ? `${f.tabla}.${f.columna}` : `tabla ${f.tabla}`)).join(', ');
}

module.exports = { CONTRATO, CONTRATO_OPCIONAL, verificarContrato, describirFaltantes };
