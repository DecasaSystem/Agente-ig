'use strict'
require('dotenv').config()
const mysql = require('mysql2/promise')

const pool = mysql.createPool({
  host:               process.env.DB_HOST,
  user:               process.env.DB_USER     || process.env.DB_USERNAME,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME     || process.env.DB_DATABASE,
  port:               parseInt(process.env.DB_PORT ?? '3306'),
  ssl:                { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit:    5,
})

// Prefijo para no colisionar con teléfonos de Agentews
const igTel = psid => `ig_${psid}`

async function runMigrations() {
  try {
    // clientes_wa y estado_usuario son tablas compartidas con el agente de WhatsApp.
    // NO están en las migraciones de Laravel (decasa-api), así que el agente IG debe
    // poder crearlas por sí mismo: no puede depender de que el agente WA arranque primero.
    // telefono VARCHAR(50): los PSID de Instagram (ig_<17-18 dígitos>) no caben en VARCHAR(20).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clientes_wa (
        id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        telefono         VARCHAR(50) UNIQUE NOT NULL,
        nombre           VARCHAR(100),
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_interaction DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `)
    // Si la tabla ya existía (creada por el agente WA con VARCHAR(20)), ampliarla.
    try {
      await pool.query(`ALTER TABLE clientes_wa MODIFY telefono VARCHAR(50) NOT NULL`)
    } catch (e) { /* ya es VARCHAR(50) o sin permisos — ignorar */ }

    // Esquema COMPLETO idéntico al del agente WhatsApp: así, arranque quien arranque
    // primero, el CREATE IF NOT EXISTS del otro es un no-op y nunca faltan columnas.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS estado_usuario (
        usuario_id                     BIGINT UNSIGNED PRIMARY KEY,
        categoria_actual               VARCHAR(50),
        producto_pendiente             JSON,
        carrito                        JSON,
        transferido                    BOOLEAN DEFAULT FALSE,
        greeting_sent                  BOOLEAN DEFAULT FALSE,
        tiene_pedido                   BOOLEAN DEFAULT FALSE,
        ultimo_producto                JSON,
        agendando_cita                 BOOLEAN DEFAULT FALSE,
        paso_agenda                    INT DEFAULT 0,
        datos_agenda                   JSON,
        transferencia_medida_pendiente JSON,
        candidatos_pendientes          JSON,
        subtipo_pendiente              JSON,
        comparacion_pendiente          JSON,
        comparacion_productos          JSON,
        presupuesto                    VARCHAR(100),
        FOREIGN KEY (usuario_id) REFERENCES clientes_wa(id) ON DELETE CASCADE
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ig_conversaciones (
        id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        instagram_psid VARCHAR(50) NOT NULL,
        role           ENUM('user','assistant') NOT NULL,
        content        TEXT NOT NULL,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_psid_created (instagram_psid, created_at)
      )
    `)

    // Cache de perceptual hash (dHash) de las fotos de productos.productos, para
    // poder identificar por comparación de imagen cuando un cliente reenvía/captura
    // una foto que ya está en nuestro propio catálogo. No pertenece a Laravel: es
    // solo un índice derivado que este agente reconstruye por su cuenta.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS producto_imagen_hash (
        producto_nombre VARCHAR(150) PRIMARY KEY,
        imagen_url      VARCHAR(500) NOT NULL,
        hash            CHAR(16) NOT NULL,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `)

    // pedidos y citas_agentes también son compartidas con el agente de WhatsApp (las
    // crea su init-db.js). Igual que con clientes_wa, este agente debe poder crearlas
    // por sí mismo: no puede asumir que el agente WA arrancó primero.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        usuario_id BIGINT UNSIGNED NOT NULL,
        producto   VARCHAR(255) NOT NULL,
        precio     VARCHAR(50) NOT NULL,
        cantidad   INT DEFAULT 1,
        estado     ENUM('confirmado','entregado','cancelado') DEFAULT 'confirmado',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES clientes_wa(id) ON DELETE CASCADE
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS citas_agentes (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        usuario_id BIGINT UNSIGNED NOT NULL,
        telefono   VARCHAR(50) NOT NULL,
        nombre     VARCHAR(100),
        dia        VARCHAR(60),
        hora       VARCHAR(20),
        razon      TEXT,
        ubicacion  INT,
        estado     ENUM('pendiente','confirmada','cancelada') DEFAULT 'pendiente',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES clientes_wa(id) ON DELETE CASCADE
      )
    `)
    // Si la tabla ya existía (creada por el agente WA), ampliarla: un `ig_<psid>` no
    // cabe en VARCHAR(20), y una fecha completa ("miércoles 18 de junio de 2026")
    // tampoco cabe en el dia VARCHAR(20) original.
    try { await pool.query('ALTER TABLE citas_agentes MODIFY telefono VARCHAR(50) NOT NULL') } catch { /* ya está */ }
    try { await pool.query('ALTER TABLE citas_agentes MODIFY dia VARCHAR(60)') } catch { /* ya está */ }

    // Deduplicación durable de eventos de Meta. Antes vivía solo en un Set en memoria:
    // tras cada redeploy de Render (frecuentes) un reintento de Meta podía re-procesar
    // un mensaje ya contestado, y con más de una instancia no funcionaba en absoluto.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ig_mids_procesados (
        mid        VARCHAR(180) PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created (created_at)
      )
    `)

    // Eventos para métricas de negocio (conversaciones, transferencias, citas,
    // pedidos, productos vistos, consultas sin resolver). Tabla propia del agente.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ig_eventos (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        psid       VARCHAR(50),
        tipo       VARCHAR(40) NOT NULL,
        detalle    VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_tipo_created (tipo, created_at)
      )
    `)

    // Comentarios ya respondidos (respuesta privada al DM). Meta permite una sola
    // respuesta privada por comentario; esto garantiza no intentarlo dos veces aunque
    // el webhook reentregue el evento.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ig_comentarios_respondidos (
        comment_id VARCHAR(180) PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created (created_at)
      )
    `)

    // Cola durable de notificaciones al sistema de ventas. Si el POST a Redes falla,
    // el pedido/cita ya está en BD, pero la tarjeta del asesor no existía y nadie la
    // reintentaba: había que crearla a mano.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ig_notificaciones_pendientes (
        id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        psid          VARCHAR(50) NOT NULL,
        tipo          VARCHAR(30) NOT NULL,
        payload       JSON NOT NULL,
        intentos      INT DEFAULT 0,
        ultimo_error  TEXT,
        proximo_envio DATETIME NOT NULL,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_proximo (proximo_envio)
      )
    `)

    console.log('[db] migraciones OK')
  } catch (e) {
    console.error('[db] migración error:', e.message)
  }
}

// ── Clientes ──────────────────────────────────────────────────────────────────

async function getOrCreateClienteByPsid(psid, username, nombre) {
  const tel = igTel(psid)
  const [rows] = await pool.query(
    'SELECT id FROM clientes_wa WHERE telefono = ? LIMIT 1', [tel]
  )
  if (rows.length) return rows[0].id

  const [res] = await pool.query(
    'INSERT INTO clientes_wa (telefono, nombre, last_interaction) VALUES (?,?,NOW())',
    [tel, nombre ?? username ?? psid]
  )
  return res.insertId
}

async function actualizarInteraccion(psid) {
  await pool.query(
    'UPDATE clientes_wa SET last_interaction = NOW() WHERE telefono = ?', [igTel(psid)]
  )
}

// ── Estado del usuario ────────────────────────────────────────────────────────

async function getEstado(psid) {
  const [rows] = await pool.query(
    `SELECT eu.* FROM estado_usuario eu
     JOIN clientes_wa c ON c.id = eu.usuario_id
     WHERE c.telefono = ? LIMIT 1`,
    [igTel(psid)]
  )
  return rows[0] ?? null
}

async function setEstado(psid, campos) {
  const clienteId = await _clienteId(psid)
  if (!clienteId) return

  const [existing] = await pool.query(
    'SELECT 1 FROM estado_usuario WHERE usuario_id = ?', [clienteId]
  )

  const keys   = Object.keys(campos)
  const values = Object.values(campos).map(v =>
    typeof v === 'object' && v !== null ? JSON.stringify(v) : v
  )

  if (existing.length) {
    const sets = keys.map(k => `${k} = ?`).join(', ')
    await pool.query(
      `UPDATE estado_usuario SET ${sets} WHERE usuario_id = ?`,
      [...values, clienteId]
    )
  } else {
    const cols = ['usuario_id', ...keys].join(', ')
    const phs  = ['?', ...keys.map(() => '?')].join(', ')
    await pool.query(
      `INSERT INTO estado_usuario (${cols}) VALUES (${phs})`,
      [clienteId, ...values]
    )
  }
}

async function getUltimoProducto(psid) {
  const estado = await getEstado(psid)
  if (!estado?.ultimo_producto) return null
  try { return JSON.parse(estado.ultimo_producto) } catch { return null }
}

async function setUltimoProducto(psid, data) {
  await setEstado(psid, { ultimo_producto: JSON.stringify(data) })
}

async function limpiarEstado(psid) {
  const clienteId = await _clienteId(psid)
  if (!clienteId) return
  await pool.query('DELETE FROM estado_usuario WHERE usuario_id = ?', [clienteId])
}

// true mientras el cliente sigue "transferido a asesor" y dentro de la ventana de
// inactividad (la IA no debe intervenir). Si ya pasó el tiempo sin actividad, libera
// el estado automáticamente y devuelve false para que la IA vuelva a atenderlo.
// Es una red de seguridad para cuando el asesor olvida dar "Terminar" en el panel de
// Redes (que es el que normalmente libera este flag, ver RedesController en
// decasa-api) — 45 min sería demasiado corto y podría reactivar la IA mientras el
// asesor sigue trabajando el caso sin que el cliente le haya vuelto a escribir.
async function debeEsperarAsesor(psid, timeoutMinutos = 360) {
  const [rows] = await pool.query(
    `SELECT eu.transferido, TIMESTAMPDIFF(MINUTE, c.last_interaction, NOW()) AS minutos_inactivo
     FROM estado_usuario eu JOIN clientes_wa c ON c.id = eu.usuario_id
     WHERE c.telefono = ? LIMIT 1`,
    [igTel(psid)]
  )
  const row = rows[0]
  if (!row?.transferido) return false
  if (row.minutos_inactivo >= timeoutMinutos) {
    await setEstado(psid, { transferido: false })
    return false
  }
  return true
}

// Silencia (o reactiva) a la IA para este cliente. Lo llama la herramienta
// solicitar_asesor; el panel de Redes hace lo mismo por SQL directo al pulsar
// Tomar/Terminar (ver RedesController::silenciarBot en decasa-api).
async function marcarTransferido(psid, transferido = true) {
  await setEstado(psid, { transferido })
}

// ── Historial de conversación ─────────────────────────────────────────────────

// Se ordena por id, no por created_at: created_at es un TIMESTAMP con resolución de
// un segundo, así que la pregunta del cliente y la respuesta de la IA suelen caer en
// el mismo segundo y MySQL puede devolverlas invertidas — el modelo terminaba leyendo
// una conversación donde contestó antes de que le preguntaran.
async function getHistorial(psid, limite = 12) {
  const [rows] = await pool.query(
    `SELECT role, content FROM ig_conversaciones
     WHERE instagram_psid = ?
     ORDER BY id DESC LIMIT ?`,
    [psid, limite]
  )
  return rows.reverse()
}

async function guardarMensaje(psid, role, content) {
  await pool.query(
    'INSERT INTO ig_conversaciones (instagram_psid, role, content) VALUES (?, ?, ?)',
    [psid, role, typeof content === 'object' ? JSON.stringify(content) : content]
  )
}

async function limpiarHistorialAntiguo(dias = 90) {
  const [res] = await pool.query(
    'DELETE FROM ig_conversaciones WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
    [dias]
  )
  console.log(`[db] limpieza historial: ${res.affectedRows} registros eliminados (>${dias} días)`)
}

// ── Configuración / Catálogos ─────────────────────────────────────────────────

async function getCatalogos() {
  const [rows] = await pool.query(
    "SELECT clave, valor FROM configuracion WHERE clave LIKE 'catalogo_%'"
  )
  return rows
}

// Promoción temporal (20% dcto sofás/comedores, vigente hasta el 6 de julio de 2026).
// Se deja como seed idempotente en vez de requerir acceso manual a la BD.
async function seedCatalogosDescuento() {
  const catalogos = [
    ['catalogo_descuento_sofas', 'https://drive.google.com/file/d/1ZsxbGlUHoIOOkriFO3hTrgNnwD2y0fw0/view?usp=drive_link'],
    ['catalogo_descuento_comedores', 'https://drive.google.com/file/d/1lHQbTEoaV-OBE4CQN89_A6YShJ4kj-Ok/view?usp=drive_link'],
  ]
  try {
    for (const [clave, valor] of catalogos) {
      await pool.query(
        'INSERT INTO configuracion (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)',
        [clave, valor]
      )
    }
    console.log('[db] catálogos de descuento sembrados OK')
  } catch (e) {
    console.error('[db] error sembrando catálogos de descuento:', e.message)
  }
}

// ── Inventario ────────────────────────────────────────────────────────────────

// Traduce las categorías crudas de la BD oficial (productos.categoria) a las
// claves canónicas que usan el system prompt y las tools. Sin este mapa, el
// filtro por categoría de buscar_productos devuelve 0 resultados para estas 5.
const CATEGORIA_KEY_MAP = {
  comedores:  'bases_comedores',
  mesas_aux:  'mesas_auxiliares',
  sillas_aux: 'sillas_auxiliares',
  cajoneros:  'cajoneros_bifes',
  sofa_camas: 'sofas_camas',
}

function normalizarCategoria(cat) {
  return CATEGORIA_KEY_MAP[cat] ?? cat
}

async function consultarStock(nombreProducto) {
  const like = `%${nombreProducto}%`
  const [rows] = await pool.query(
    `SELECT t.nombre AS tienda, t.es_fabrica, i.cantidad_disponible
     FROM inventario i
     JOIN productos p ON i.producto_id = p.id
     JOIN tiendas t   ON i.tienda_id   = t.id
     WHERE p.nombre LIKE ? AND t.activa = 1 AND i.cantidad_disponible > 0
     ORDER BY t.es_fabrica ASC, t.nombre ASC`,
    [like]
  )
  return rows
}

async function getInventario() {
  let rows
  try {
    [rows] = await pool.query(
      `SELECT nombre, precio_base AS precio, foto_url AS imagen, foto_url_2 AS imagen2, medidas, material, categoria AS subcategoria
       FROM productos WHERE activo = 1 ORDER BY categoria, nombre`
    )
  } catch {
    [rows] = await pool.query(
      `SELECT nombre, precio, imagen, medidas, material, subcategoria
       FROM productos WHERE activo IS NULL OR activo = 1 ORDER BY subcategoria, nombre`
    )
  }
  return rows.map(r => ({ ...r, subcategoria: normalizarCategoria(r.subcategoria) }))
}

// ── Pedidos y citas ───────────────────────────────────────────────────────────

// La notificación al sistema de ventas (POST /api/redes/webhook) puede fallar. Antes
// estos dos eran la ÚNICA constancia de un pedido o una cita: si el POST fallaba, el
// cliente veía "¡Pedido confirmado!" y no quedaba registro en ningún lado. Ahora se
// escribe primero en la BD y la notificación es un aviso, no el sistema de registro.

async function guardarPedido(psid, items) {
  const clienteId = await _clienteId(psid)
  if (!clienteId) return false
  for (const item of items) {
    await pool.query(
      'INSERT INTO pedidos (usuario_id, producto, precio, cantidad) VALUES (?,?,?,?)',
      [clienteId, item.producto, String(item.precio), item.cantidad || 1]
    )
  }
  return true
}

async function guardarCita(psid, datos) {
  const clienteId = await _clienteId(psid)
  if (!clienteId) return false
  await pool.query(
    `INSERT INTO citas_agentes (usuario_id, telefono, nombre, dia, hora, razon, ubicacion)
     VALUES (?,?,?,?,?,?,?)`,
    [clienteId, igTel(psid), datos.nombre, datos.dia, datos.hora, datos.motivo ?? null, datos.ubicacion]
  )
  return true
}

// ── Deduplicación de eventos de Meta ─────────────────────────────────────────

// Devuelve true si el mid es nuevo (hay que procesarlo), false si ya se procesó.
// Ante un fallo de BD preferimos procesar (arriesgar un duplicado) antes que perder
// el mensaje del cliente en silencio.
async function registrarMid(mid) {
  try {
    await pool.query('INSERT INTO ig_mids_procesados (mid) VALUES (?)', [mid])
    return true
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return false
    console.error('[db] registrarMid falló, se procesa igual:', e.message)
    return true
  }
}

async function limpiarMidsAntiguos(dias = 2) {
  const [res] = await pool.query(
    'DELETE FROM ig_mids_procesados WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [dias]
  )
  if (res.affectedRows) console.log(`[db] limpieza mids: ${res.affectedRows} eliminados`)
}

// ── Métricas ──────────────────────────────────────────────────────────────────

async function registrarEvento(psid, tipo, detalle = null) {
  await pool.query(
    'INSERT INTO ig_eventos (psid, tipo, detalle) VALUES (?, ?, ?)',
    [psid ?? null, tipo, detalle ? String(detalle).substring(0, 255) : null]
  )
}

async function getMetricas(dias = 30) {
  const [totales] = await pool.query(
    `SELECT tipo, COUNT(*) AS n FROM ig_eventos
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY tipo`,
    [dias]
  )
  const [topProductos] = await pool.query(
    `SELECT detalle AS nombre, COUNT(*) AS veces FROM ig_eventos
     WHERE tipo = 'producto_visto' AND detalle IS NOT NULL
       AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY detalle ORDER BY veces DESC LIMIT 10`,
    [dias]
  )
  const [topBusquedas] = await pool.query(
    `SELECT detalle AS termino, COUNT(*) AS veces FROM ig_eventos
     WHERE tipo = 'busqueda' AND detalle IS NOT NULL
       AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY detalle ORDER BY veces DESC LIMIT 10`,
    [dias]
  )
  const [clientes] = await pool.query(
    `SELECT COUNT(DISTINCT psid) AS n FROM ig_eventos
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [dias]
  )

  const totalesObj = {}
  for (const r of totales) totalesObj[r.tipo] = r.n
  const conversaciones = totalesObj.conversacion ?? 0
  const pedidos        = totalesObj.pedido ?? 0

  return {
    dias,
    clientes_unicos: clientes[0].n,
    totales: totalesObj,
    tasa_conversion: conversaciones ? +(pedidos / conversaciones * 100).toFixed(1) : 0,
    top_productos: topProductos,
    top_busquedas: topBusquedas,
  }
}

// true si el comentario es nuevo (hay que responderlo), false si ya se respondió.
async function registrarComentario(commentId) {
  try {
    await pool.query('INSERT INTO ig_comentarios_respondidos (comment_id) VALUES (?)', [commentId])
    return true
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return false
    console.error('[db] registrarComentario falló:', e.message)
    return false // ante la duda, NO responder de nuevo (evita spam público)
  }
}

// ── Cola de notificaciones pendientes ────────────────────────────────────────

async function encolarNotificacion(psid, tipo, payload, retrasoSegundos = 60) {
  await pool.query(
    `INSERT INTO ig_notificaciones_pendientes (psid, tipo, payload, proximo_envio)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [psid, tipo, JSON.stringify(payload), retrasoSegundos]
  )
}

async function getNotificacionesPendientes(limite = 10) {
  const [rows] = await pool.query(
    `SELECT id, psid, tipo, payload, intentos FROM ig_notificaciones_pendientes
     WHERE proximo_envio <= NOW() ORDER BY proximo_envio ASC LIMIT ?`,
    [limite]
  )
  return rows.map(r => ({ ...r, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload }))
}

async function eliminarNotificacion(id) {
  await pool.query('DELETE FROM ig_notificaciones_pendientes WHERE id = ?', [id])
}

// Backoff exponencial entre reintentos: 2, 4, 8, 16... minutos.
async function reprogramarNotificacion(id, intentos, error) {
  const minutos = Math.min(2 ** intentos, 120)
  await pool.query(
    `UPDATE ig_notificaciones_pendientes
     SET intentos = ?, ultimo_error = ?, proximo_envio = DATE_ADD(NOW(), INTERVAL ? MINUTE)
     WHERE id = ?`,
    [intentos, String(error).substring(0, 500), minutos, id]
  )
}

// ── Hash de imágenes de productos ────────────────────────────────────────────

async function getHashesProductos() {
  const [rows] = await pool.query(
    'SELECT producto_nombre, imagen_url, hash FROM producto_imagen_hash'
  )
  return rows
}

async function upsertHashProducto(nombre, imagenUrl, hash) {
  await pool.query(
    `INSERT INTO producto_imagen_hash (producto_nombre, imagen_url, hash) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE imagen_url = VALUES(imagen_url), hash = VALUES(hash)`,
    [nombre, imagenUrl, hash]
  )
}

// ── Interno ───────────────────────────────────────────────────────────────────

async function _clienteId(psid) {
  const [rows] = await pool.query(
    'SELECT id FROM clientes_wa WHERE telefono = ? LIMIT 1', [igTel(psid)]
  )
  return rows[0]?.id ?? null
}

module.exports = {
  runMigrations,
  getOrCreateClienteByPsid,
  actualizarInteraccion,
  getEstado,
  setEstado,
  getUltimoProducto,
  setUltimoProducto,
  limpiarEstado,
  debeEsperarAsesor,
  marcarTransferido,
  guardarPedido,
  guardarCita,
  registrarMid,
  limpiarMidsAntiguos,
  registrarComentario,
  registrarEvento,
  getMetricas,
  encolarNotificacion,
  getNotificacionesPendientes,
  eliminarNotificacion,
  reprogramarNotificacion,
  getHistorial,
  guardarMensaje,
  limpiarHistorialAntiguo,
  getInventario,
  getCatalogos,
  seedCatalogosDescuento,
  consultarStock,
  getHashesProductos,
  upsertHashProducto,
}
