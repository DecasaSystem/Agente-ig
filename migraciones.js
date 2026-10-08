'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Migraciones de esquema con registro de versión.
//
// El esquema se creaba con `CREATE TABLE IF NOT EXISTS` y `ALTER TABLE` envueltos en
// try/catch. Funciona y es idempotente, pero tiene dos problemas: no se sabe en qué versión
// está cada despliegue (¿ese servidor tiene ya la columna nueva?), y un error real de SQL se
// confunde con "la columna ya existía", porque los dos acaban en el mismo catch silencioso.
//
// Aquí cada cambio tiene un id, se aplica una sola vez y queda registrado con su fecha. Lo
// anterior se deja como está —es idempotente y corre sin problema—, pero **los cambios nuevos
// van aquí**.

const TABLA = 'esquema_migraciones';

async function asegurarTabla(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLA} (
      id          VARCHAR(80) PRIMARY KEY,
      aplicada_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ms          INT
    )
  `);
}

async function yaAplicadas(pool) {
  const [filas] = await pool.query(`SELECT id FROM ${TABLA}`);
  return new Set(filas.map(f => f.id));
}

// `migraciones` es una lista de { id, descripcion, sql } o { id, descripcion, ejecutar(pool) }.
// Se aplican en orden y se detiene en la primera que falle: seguir aplicando cambios sobre un
// esquema a medio migrar es peor que parar y avisar.
async function aplicar(pool, migraciones, { log = console } = {}) {
  await asegurarTabla(pool);
  const aplicadas = await yaAplicadas(pool);
  const resultado = { aplicadas: [], omitidas: [], fallo: null };

  for (const m of migraciones) {
    if (aplicadas.has(m.id)) { resultado.omitidas.push(m.id); continue; }

    const desde = Date.now();
    try {
      if (typeof m.ejecutar === 'function') await m.ejecutar(pool);
      else await pool.query(m.sql);

      const ms = Date.now() - desde;
      await pool.query(`INSERT INTO ${TABLA} (id, ms) VALUES (?, ?)`, [m.id, ms]);
      resultado.aplicadas.push(m.id);
      log.log?.(`[migraciones] ✅ ${m.id} — ${m.descripcion ?? ''} (${ms} ms)`);
    } catch (e) {
      resultado.fallo = { id: m.id, error: e.message };
      log.error?.(`[migraciones] ❌ ${m.id} falló: ${e.message}`);
      break;
    }
  }

  if (resultado.aplicadas.length === 0 && !resultado.fallo) {
    log.log?.(`[migraciones] esquema al día (${resultado.omitidas.length} ya aplicadas)`);
  }
  return resultado;
}

// Para diagnosticar un despliegue: qué versión tiene y desde cuándo.
async function estado(pool) {
  try {
    await asegurarTabla(pool);
    const [filas] = await pool.query(`SELECT id, aplicada_at FROM ${TABLA} ORDER BY aplicada_at ASC`);
    return { total: filas.length, ultima: filas[filas.length - 1] ?? null, todas: filas };
  } catch (e) {
    return { total: 0, ultima: null, todas: [], error: e.message };
  }
}

module.exports = { aplicar, estado, asegurarTabla, TABLA };
