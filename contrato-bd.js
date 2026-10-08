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
  productos:                 ['id', 'nombre', 'precio_base', 'foto_url', 'foto_url_2', 'medidas', 'material', 'categoria', 'activo',
                              'descripcion', 'piezas_por_juego', 'precio_pieza'],
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
const OPCIONALES = new Set(['configuracion', 'catalogos', 'catalogo_paginas']);
const CONTRATO_OPCIONAL = {
  configuracion:    ['clave', 'valor'],
  // Catálogos visuales de Gestión (catalogos.js). Sin ellos el agente sigue con PDF y
  // con la página de la sección del inventario.
  catalogos:        ['id', 'nombre', 'slug', 'activo', 'orden'],
  catalogo_paginas: ['catalogo_id'],
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

// ¿Las sedes de negocio.json siguen abiertas en el sistema de ventas? Compara cada
// `tiendaId` con la tabla `tiendas`. Devuelve los ids de SEDE cuya tienda está inactiva
// (cerradas) o no existe (faltantes). Nunca lanza: si la consulta falla, { error }.
async function verificarSedes(pool, sedes) {
  const ids = [...new Set(sedes.map(s => Number(s.tiendaId ?? s.id)))];
  if (!ids.length) return { cerradas: [], faltantes: [] };
  let rows;
  try {
    [rows] = await pool.query('SELECT id, nombre, activa FROM tiendas WHERE id IN (?)', [ids]);
  } catch (e) {
    return { cerradas: [], faltantes: [], error: e.message };
  }
  const porId = new Map(rows.map(r => [Number(r.id), r]));
  const cerradas = [];
  const faltantes = [];
  for (const s of sedes) {
    const t = porId.get(Number(s.tiendaId ?? s.id));
    if (!t) faltantes.push(s.id);
    else if (!Number(t.activa)) cerradas.push(s.id);
  }
  return { cerradas, faltantes, tiendas: rows };
}

// Categorías del inventario que negocio.json no conoce (ni como clave ni en
// mapaCategoriasBD). Sus productos se venden igual, pero el prompt no las nombra y no
// tienen nombre bonito: es la señal de que alguien creó una categoría nueva en el
// sistema de ventas (pasó con Cunas, Puff, Relojes y Eléctrica).
function categoriasSinConfigurar(secciones, { categorias = {}, mapaCategoriasBD = {} } = {}) {
  const conocidas = new Set([...Object.keys(categorias), ...Object.keys(mapaCategoriasBD)].map(c => String(c).toLowerCase()));
  return (secciones ?? [])
    .filter(s => s.productos > 0 && !conocidas.has(String(s.categoria).toLowerCase()))
    .map(s => s.categoria)
    .sort();
}

// La revisión completa de lo que el agente toma del sistema de ventas, para correr al
// arrancar y cada hora: esquema (verificarContrato), sedes abiertas (verificarSedes) y
// categorías nuevas. Avisa UNA vez por cada cambio, no en cada vuelta.
function crearRevisionSistema({ pool, negocio, alertar = () => {}, log = console, secciones = () => [] }) {
  const yaAvisado = new Map();
  const avisarSiCambio = (clave, titulo, detalle) => {
    if (yaAvisado.get(clave) === detalle) return;
    yaAvisado.set(clave, detalle);
    if (detalle) alertar(titulo, detalle);
  };

  return async function revisar() {
    const contrato = await verificarContrato(pool);
    if (contrato.error) log.warn('[contrato-bd] no se pudo verificar:', contrato.error);
    else if (contrato.faltantes.length) {
      const detalle = describirFaltantes(contrato.faltantes);
      log.error('[contrato-bd] ❌ faltan:', detalle);
      avisarSiCambio('esquema', 'El sistema de ventas cambió columnas que usa el agente', `Faltan: ${detalle}. Revisar la última migración de decasa-api y contrato-bd.js.`);
    } else log.log('[contrato-bd] ✅ esquema del sistema de ventas compatible');

    const sedes = await verificarSedes(pool, negocio.sedes);
    if (sedes.error) log.warn('[contrato-bd] no se pudieron revisar las sedes:', sedes.error);
    else {
      negocio.marcarSedesCerradas(sedes.cerradas);
      // Solo preocupa la que negocio.json todavía ofrece: la que ya está marcada
      // "activa": false está bien cerrada en los dos lados.
      const ofrecidas = new Set(negocio.sedes.filter(s => s.activa !== false).map(s => s.id));
      const problemas = [
        ...sedes.cerradas.filter(id => ofrecidas.has(id)).map(id => `sede ${id} (${negocio.SEDE_NOMBRE[id]}) está CERRADA en el sistema de ventas`),
        ...sedes.faltantes.filter(id => ofrecidas.has(id)).map(id => `sede ${id} apunta a la tienda ${negocio.SEDE_TIENDA_ID[id]}, que no existe`),
      ];
      if (problemas.length) log.error('[contrato-bd] ❌ sedes:', problemas.join('; '));
      avisarSiCambio('sedes', 'Sedes del agente desactualizadas',
        problemas.length ? `${problemas.join('; ')}. El agente ya no la ofrece para citas; actualizar las sedes en negocio.json.` : '');
    }

    const nuevas = categoriasSinConfigurar(secciones(), { categorias: negocio.CATEGORIAS, mapaCategoriasBD: negocio.mapaCategoriasBD });
    if (nuevas.length) log.warn('[contrato-bd] categorías sin configurar:', nuevas.join(', '));
    avisarSiCambio('categorias', 'Categorías nuevas en el inventario',
      nuevas.length ? `${nuevas.join(', ')}: el agente vende sus productos, pero conviene agregarlas a categorias / mapaCategoriasBD en negocio.json.` : '');
  };
}

// Texto corto para la alerta: "productos.foto_url, tabla herramientas".
function describirFaltantes(faltantes) {
  return faltantes.map(f => (f.columna ? `${f.tabla}.${f.columna}` : `tabla ${f.tabla}`)).join(', ');
}

module.exports = {
  CONTRATO, CONTRATO_OPCIONAL, verificarContrato, verificarSedes, describirFaltantes,
  categoriasSinConfigurar, crearRevisionSistema,
};
