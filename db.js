'use strict'
require('dotenv').config()
const mysql = require('mysql2/promise')

const pool = mysql.createPool({
  host:               process.env.DB_HOST,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME,
  port:               parseInt(process.env.DB_PORT ?? '3306'),
  ssl:                { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit:    5,
})

// Prefijo para no colisionar con teléfonos de Agentews
const igTel = psid => `ig_${psid}`

async function runMigrations() {
  try {
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

// ── Historial de conversación ─────────────────────────────────────────────────

async function getHistorial(psid, limite = 12) {
  const [rows] = await pool.query(
    `SELECT role, content FROM ig_conversaciones
     WHERE instagram_psid = ?
     ORDER BY created_at DESC LIMIT ?`,
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

// ── Inventario ────────────────────────────────────────────────────────────────

async function getInventario() {
  try {
    const [rows] = await pool.query(
      `SELECT nombre, precio_base AS precio, foto_url AS imagen, medidas, material, categoria AS subcategoria
       FROM productos WHERE activo = 1 ORDER BY categoria, nombre`
    )
    return rows
  } catch {
    const [rows] = await pool.query(
      `SELECT nombre, precio, imagen, medidas, material, subcategoria
       FROM productos WHERE activo IS NULL OR activo = 1 ORDER BY subcategoria, nombre`
    )
    return rows
  }
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
  getHistorial,
  guardarMensaje,
  limpiarHistorialAntiguo,
  getInventario,
}
