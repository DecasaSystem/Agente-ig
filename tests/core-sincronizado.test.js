'use strict'
// Los archivos compartidos con el otro agente se copian desde core/ (ver core/README.md:
// no se importan con require('../core/...') porque cada agente se despliega por separado y
// esa ruta no existe en producción).
//
// El riesgo de copiar no es la copia: es que nadie se entere cuando las dos versiones se
// separan — que es exactamente lo que ya había pasado con los prompts. Este test lo detecta.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs   = require('fs')
const path = require('path')

const AGENTE = path.join(__dirname, '..')
const CORE   = path.join(AGENTE, '../core')

const ESPERADOS = ['fechas.js', 'negocio.js', 'negocio.json', 'prompt.js', 'reintentos.js', 'vision-catalogo.js']

test('los archivos compartidos coinciden con core/', t => {
  // En un despliegue aislado (solo la carpeta del agente) core/ no existe: nada que comparar.
  if (!fs.existsSync(CORE)) return t.skip('core/ no está disponible en este entorno')

  const compartidos = fs.readdirSync(CORE).filter(f => /\.(js|json)$/.test(f)).sort()
  for (const esperado of ESPERADOS) {
    assert.ok(compartidos.includes(esperado), `core/ debería contener ${esperado}`)
  }

  const distintos = compartidos.filter(archivo => {
    const enCore   = fs.readFileSync(path.join(CORE, archivo), 'utf8')
    const enAgente = fs.existsSync(path.join(AGENTE, archivo))
      ? fs.readFileSync(path.join(AGENTE, archivo), 'utf8')
      : null
    return enAgente !== enCore
  })

  assert.deepEqual(distintos, [],
    `Estos archivos difieren de core/: ${distintos.join(', ')}.\n` +
    'Los archivos compartidos se editan en core/ y se copian con:  npm run sync  (desde la raíz del proyecto).')
})
