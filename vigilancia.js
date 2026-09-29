'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Vigilancia del negocio: detectar que el agente dejó de vender EN SILENCIO.
//
// Las alertas que ya existían avisan cuando el proceso se cae. El problema real es el
// otro: el token de Meta caduca, el inventario carga vacío, el webhook deja de llegar…
// y todo "funciona" mientras nadie responde a ningún cliente. Eso puede durar días sin
// que nadie lo note, y son ventas perdidas.
//
// Este módulo comprueba cada cierto tiempo unas pocas señales de vida y avisa una vez
// por problema (el `alertar` de cada agente ya silencia repeticiones durante 10 min).

const negocio = require('./negocio');

// Horas sin una sola conversación, en horario de atención, que se consideran anómalas.
const HORAS_SIN_CONVERSACIONES = 2;
// Días de antelación con los que avisar de que un token está por caducar.
const DIAS_AVISO_TOKEN = 7;

// `deps` se inyecta para poder probar esto sin base de datos ni red:
//   contarConversaciones(horas) -> número de conversaciones en las últimas N horas
//   contarInventario()          -> productos cargados en memoria
//   contarNotificacionesAtascadas() -> notificaciones con varios intentos fallidos
//   expiracionToken()           -> timestamp de caducidad del token, o null
//   estadoHorario()             -> { abierto } del agente
//   alertar(titulo, detalle)    -> alerta ya existente del agente
async function revisarSaludDelNegocio(deps) {
  const {
    contarConversaciones,
    contarInventario,
    contarNotificacionesAtascadas,
    expiracionToken,
    estadoHorario,
    alertar,
    ahora = new Date(),
  } = deps;

  const hallazgos = [];

  // 1. Inventario vacío: el agente responde "no encontré nada" a todo el mundo y nadie se
  //    entera. Se comprueba siempre, haya o no horario.
  try {
    const productos = await contarInventario();
    if (!productos) {
      hallazgos.push({
        titulo: 'Inventario vacío',
        detalle: 'El agente no tiene productos cargados: va a responder que no encuentra nada a todos los clientes. Revisar la conexión a la base de datos y la tabla de productos.',
      });
    }
  } catch (e) {
    hallazgos.push({ titulo: 'No se pudo comprobar el inventario', detalle: e.message });
  }

  // 2. Silencio en horario de atención. Fuera de horario no significa nada: es normal.
  try {
    if (estadoHorario().abierto) {
      const conversaciones = await contarConversaciones(HORAS_SIN_CONVERSACIONES);
      if (conversaciones === 0) {
        hallazgos.push({
          titulo: `Sin conversaciones en ${HORAS_SIN_CONVERSACIONES} h de horario laboral`,
          detalle: 'Puede ser un día flojo, pero también un webhook caído, un token caducado o el número desconectado. Mandar un mensaje de prueba al agente.',
        });
      }
    }
  } catch (e) {
    hallazgos.push({ titulo: 'No se pudo comprobar la actividad', detalle: e.message });
  }

  // 3. Notificaciones que no logran llegar al sistema de ventas: son pedidos, citas y
  //    solicitudes de asesor que el equipo no está viendo.
  try {
    const atascadas = await contarNotificacionesAtascadas();
    if (atascadas > 0) {
      hallazgos.push({
        titulo: `${atascadas} notificación(es) sin poder entregarse`,
        detalle: 'Hay pedidos, citas o solicitudes de asesor que llevan varios intentos sin llegar al panel. Revisar que la API del sistema de ventas responda y que el token sea el correcto.',
      });
    }
  } catch (e) {
    hallazgos.push({ titulo: 'No se pudo revisar la cola de notificaciones', detalle: e.message });
  }

  // 4. Token a punto de caducar (Instagram): avisar ANTES de quedarse mudo, no después.
  if (expiracionToken) {
    try {
      const vence = await expiracionToken();
      if (vence) {
        const dias = (Number(vence) - ahora.getTime()) / 86400000;
        if (dias <= 0) {
          hallazgos.push({ titulo: 'Token de Instagram caducado', detalle: 'El agente no puede responder. Renovar el token de larga duración ya.' });
        } else if (dias <= DIAS_AVISO_TOKEN) {
          hallazgos.push({ titulo: `Token de Instagram caduca en ${Math.floor(dias)} día(s)`, detalle: 'Renovarlo antes de que el agente se quede mudo.' });
        }
      }
    } catch (e) {
      hallazgos.push({ titulo: 'No se pudo comprobar el token', detalle: e.message });
    }
  }

  for (const h of hallazgos) alertar(h.titulo, h.detalle);
  return hallazgos;
}

// Arranca la vigilancia periódica. Devuelve el intervalo para poder pararlo en tests.
function iniciarVigilancia(deps, minutos = 30) {
  const correr = () => revisarSaludDelNegocio(deps)
    .catch(e => console.error('[vigilancia] fallo al revisar:', e.message));
  const intervalo = setInterval(correr, minutos * 60 * 1000);
  if (intervalo.unref) intervalo.unref(); // que no impida cerrar el proceso
  return intervalo;
}

module.exports = {
  revisarSaludDelNegocio,
  iniciarVigilancia,
  HORAS_SIN_CONVERSACIONES,
  DIAS_AVISO_TOKEN,
  negocio, // reexportado por comodidad para los agentes
};
