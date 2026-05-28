'use strict'
require('dotenv').config()
const mysql = require('mysql2/promise')

async function main() {
  const connection = await mysql.createConnection({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port:     parseInt(process.env.DB_PORT ?? '3306'),
    ssl:      { rejectUnauthorized: false },
  })

  console.log('[init-db] Conectado a la base de datos')

  // Agregar columnas de Instagram a clientes_wa si no existen
  const alteraciones = [
    `ALTER TABLE clientes_wa ADD COLUMN instagram_psid VARCHAR(50) UNIQUE NULL`,
    `ALTER TABLE clientes_wa ADD COLUMN instagram_username VARCHAR(100) NULL`,
  ]

  for (const sql of alteraciones) {
    try {
      await connection.query(sql)
      console.log('[init-db] OK:', sql.substring(0, 60))
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('[init-db] Ya existe, ok')
      } else {
        console.error('[init-db] Error:', e.message)
      }
    }
  }

  // Agregar instagram_psid a conversaciones si la tabla la maneja el agente local
  // (Si no existe la tabla, no hacer nada — la maneja decasa-api via migración Laravel)
  try {
    await connection.query(
      `ALTER TABLE conversaciones ADD COLUMN instagram_psid VARCHAR(50) NULL`
    )
    console.log('[init-db] Columna instagram_psid agregada a conversaciones')
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') console.log('[init-db] conversaciones:', e.message)
  }

  await connection.end()
  console.log('[init-db] Listo')
}

main().catch(e => { console.error(e); process.exit(1) })
