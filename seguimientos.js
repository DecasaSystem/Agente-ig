'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Seguimientos: los mensajes que el agente envía POR INICIATIVA PROPIA.
//
// Hasta ahora el agente solo reaccionaba. Si un cliente armaba el carrito y desaparecía,
// no volvía a saber de él; si agendaba una visita, nadie se la recordaba y no se
// presentaba. Esto lo resuelve, pero con cuidado, porque un seguimiento mal hecho es spam
// y cuesta la cuenta:
//
//   1. VENTANA DE 24 h. WhatsApp e Instagram solo permiten escribir libremente dentro de
//      las 24 h desde el último mensaje del cliente. Fuera de esa ventana, este módulo NO
//      envía nada y marca el seguimiento como caducado. (En WhatsApp se podría usar una
//      plantilla aprobada por Meta; eso es otra funcionalidad y va aparte.)
//   2. NUNCA por encima de una persona. Si el chat está con un asesor humano, el
//      seguimiento se pospone: lo último que necesita un asesor es que el bot escriba en
//      medio de su conversación.
//   3. UNO POR MOTIVO. La clave (destinatario, tipo, referencia) es única: aunque se
//      programe dos veces, se envía una. Y si no responde, no se insiste.
//
// Las dependencias se inyectan para poder probarlo entero sin base de datos ni red.

const negocio = require('./negocio');

// Cuánto dura la ventana en la que se puede escribir libremente.
const VENTANA_MENSAJERIA_MIN = 24 * 60;
// Cuánto se pospone un seguimiento cuando hay un asesor atendiendo.
const POSPONER_MIN = 60;
// Cuántas veces se pospone antes de rendirse: ~6 h de margen.
const MAX_POSPOSICIONES = 6;

const TIPOS = {
  CITA_24H: 'cita_24h',
  CITA_2H: 'cita_2h',
  CARRITO_ABANDONADO: 'carrito_abandonado',
};

// Rellena los huecos de la plantilla. Un dato que falte se sustituye por vacío, nunca por
// "undefined": el cliente no debe ver un placeholder roto.
function construirMensaje(tipo, datos = {}) {
  const plantilla = negocio.cfg.seguimientos?.[tipo];
  if (!plantilla) return null;

  // El nombre va con espacio delante en la plantilla ("¡Hola{nombre}!"), para que sin
  // nombre quede "¡Hola!" y no "¡Hola !".
  const valores = {
    nombre:   datos.nombre ? ` ${datos.nombre}` : '',
    producto: datos.producto ?? '',
    dia:      datos.dia ?? '',
    hora:     datos.hora ?? '',
    sede:     datos.sede ?? '',
  };
  return plantilla.replace(/\{(\w+)\}/g, (_, clave) => valores[clave] ?? '');
}

// ¿Se puede escribir ahora a este cliente? Devuelve el motivo por el que no, o null si sí.
async function motivoParaNoEnviar(deps, seguimiento) {
  const { minutosDesdeUltimoMensaje, hayAsesorAtendiendo } = deps;

  if (await hayAsesorAtendiendo(seguimiento.destinatario)) return 'asesor_atendiendo';

  const minutos = await minutosDesdeUltimoMensaje(seguimiento.destinatario);
  // Sin dato de última interacción se prefiere no escribir: es el caso en que más fácil
  // es molestar a alguien que lleva meses sin hablar con el negocio.
  if (minutos === null || minutos === undefined) return 'sin_datos';
  if (minutos >= VENTANA_MENSAJERIA_MIN) return 'fuera_de_ventana';

  return null;
}

// Programa un seguimiento. Si ya existe uno igual pendiente, no se duplica (lo garantiza
// la clave única de la tabla; aquí solo se evita el ruido).
async function programar(deps, { destinatario, tipo, referencia = null, cuando, datos = {} }) {
  if (!negocio.cfg.seguimientos?.activos) return false;
  if (!construirMensaje(tipo, datos)) return false; // sin plantilla configurada, no se programa
  try {
    return await deps.db.programarSeguimiento({ destinatario, tipo, referencia, cuando, datos });
  } catch (e) {
    console.warn(`[seguimientos] no se pudo programar ${tipo} para ${destinatario}:`, e.message);
    return false;
  }
}

// Cancela los seguimientos pendientes de un cliente (opcionalmente solo los de un tipo o
// una referencia). Se llama cuando el motivo desaparece: la cita se cancela, el carrito se
// confirma o se vacía.
async function cancelar(deps, { destinatario, tipo = null, referencia = null }) {
  try {
    return await deps.db.cancelarSeguimientos({ destinatario, tipo, referencia });
  } catch (e) {
    console.warn(`[seguimientos] no se pudieron cancelar los de ${destinatario}:`, e.message);
    return 0;
  }
}

// Worker: envía los seguimientos que toquen. Devuelve un resumen de lo que hizo, que es lo
// que comprueban los tests.
async function procesarPendientes(deps, limite = 20) {
  const resumen = { enviados: 0, pospuestos: 0, descartados: 0 };
  if (!negocio.cfg.seguimientos?.activos) return resumen;

  let pendientes = [];
  try {
    pendientes = await deps.db.getSeguimientosPendientes(limite);
  } catch (e) {
    console.error('[seguimientos] no se pudo leer la cola:', e.message);
    return resumen;
  }

  for (const s of pendientes) {
    const datos = typeof s.datos === 'string' ? JSON.parse(s.datos || '{}') : (s.datos ?? {});
    const motivo = await motivoParaNoEnviar(deps, s);

    if (motivo === 'asesor_atendiendo') {
      // Hay una persona en la conversación: se aparta un rato, no se descarta.
      if ((s.posposiciones ?? 0) >= MAX_POSPOSICIONES) {
        await deps.db.marcarSeguimiento(s.id, 'descartado', 'el asesor siguió atendiendo');
        resumen.descartados++;
      } else {
        await deps.db.posponerSeguimiento(s.id, POSPONER_MIN);
        resumen.pospuestos++;
      }
      continue;
    }

    if (motivo) {
      // Fuera de la ventana de 24 h no se puede escribir: se descarta en silencio. Es la
      // decisión correcta — insistir aquí es lo que hace que bloqueen el número.
      await deps.db.marcarSeguimiento(s.id, 'descartado', motivo);
      resumen.descartados++;
      continue;
    }

    const mensaje = construirMensaje(s.tipo, datos);
    if (!mensaje) {
      await deps.db.marcarSeguimiento(s.id, 'descartado', 'sin plantilla');
      resumen.descartados++;
      continue;
    }

    try {
      const entregado = await deps.enviar(s.destinatario, mensaje);
      if (entregado === false) {
        await deps.db.marcarSeguimiento(s.id, 'descartado', 'no se pudo entregar');
        resumen.descartados++;
        continue;
      }
      await deps.db.marcarSeguimiento(s.id, 'enviado');
      // Queda en el historial para que el modelo sepa qué se le dijo al cliente.
      await deps.guardarEnHistorial?.(s.destinatario, mensaje);
      deps.evento?.(s.destinatario, 'seguimiento_enviado', s.tipo);
      resumen.enviados++;
      console.log(`[seguimientos] ${s.tipo} enviado a ${s.destinatario}`);
    } catch (e) {
      console.warn(`[seguimientos] fallo enviando ${s.tipo} a ${s.destinatario}:`, e.message);
      await deps.db.posponerSeguimiento(s.id, 15);
      resumen.pospuestos++;
    }
  }

  return resumen;
}

// Arranca el worker periódico. Devuelve el intervalo para poder pararlo en tests.
function iniciarWorker(deps, minutos = 10) {
  const correr = () => procesarPendientes(deps)
    .catch(e => console.error('[seguimientos] worker:', e.message));
  const intervalo = setInterval(correr, minutos * 60 * 1000);
  if (intervalo.unref) intervalo.unref();
  return intervalo;
}

// ── Programación de los seguimientos concretos ────────────────────────────────

// Al agendar una visita: recordatorio el día antes y otro un par de horas antes. La hora
// de la cita viene como "HH:MM" y la fecha como ISO (yyyy-mm-dd).
// `referencia` identifica la cita para poder cancelar sus recordatorios después. Se usa la
// fecha ISO, que es única por cliente y día y está disponible tanto al agendar como al
// cancelar, sin necesidad de que guardarCita devuelva el id.
async function programarRecordatoriosCita(deps, { destinatario, referencia, fechaIso, hora, nombre, sede }) {
  if (!fechaIso || !hora) return false;
  const [h, m] = String(hora).split(':').map(Number);
  const cita = new Date(`${fechaIso}T00:00:00Z`);
  cita.setUTCHours(h || 0, m || 0, 0, 0);

  const datos = { nombre, dia: datosDiaLegible(fechaIso), hora, sede };
  const ahora = Date.now();
  const programados = [];

  const recordatorios = [
    { tipo: TIPOS.CITA_24H, cuando: new Date(cita.getTime() - 24 * 60 * 60 * 1000) },
    { tipo: TIPOS.CITA_2H,  cuando: new Date(cita.getTime() - 2 * 60 * 60 * 1000) },
  ];

  for (const r of recordatorios) {
    // Un recordatorio cuyo momento ya pasó no se programa: si agendan para dentro de una
    // hora, el de 24 h antes no tiene sentido.
    if (r.cuando.getTime() <= ahora) continue;
    if (await programar(deps, { destinatario, tipo: r.tipo, referencia: String(referencia), cuando: r.cuando, datos })) {
      programados.push(r.tipo);
    }
  }
  return programados;
}

function datosDiaLegible(fechaIso) {
  try {
    const fechas = require('./fechas');
    const [y, m, d] = String(fechaIso).split('-').map(Number);
    return fechas.textoLargo(fechas.fechaCivil(y, m, d));
  } catch { return fechaIso; }
}

// Al quedar un carrito sin confirmar: un único mensaje pasadas N horas. Si el cliente no
// responde, no se insiste más.
async function programarCarritoAbandonado(deps, { destinatario, producto, nombre, horas = 24 }) {
  return programar(deps, {
    destinatario,
    tipo: TIPOS.CARRITO_ABANDONADO,
    referencia: null,
    cuando: new Date(Date.now() + horas * 60 * 60 * 1000),
    datos: { producto, nombre },
  });
}

module.exports = {
  TIPOS,
  construirMensaje, motivoParaNoEnviar,
  programar, cancelar, procesarPendientes, iniciarWorker,
  programarRecordatoriosCita, programarCarritoAbandonado,
  VENTANA_MENSAJERIA_MIN, POSPONER_MIN, MAX_POSPOSICIONES,
};
