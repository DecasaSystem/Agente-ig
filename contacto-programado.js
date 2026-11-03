'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// "Que el asesor me contacte mañana a las 11". Caso real del 2026-11-03: el cliente quería la
// cotización de una base a la medida pero "ahorita no puedo, que tal mañana a las 11 de la
// mañana", y Elena le contestó "te agendamos" sin que nada llegara al sistema de ventas.
//
// El sistema de ventas no tiene un "contactar a tal hora" (las tarjetas de Redes son para ya),
// así que el agente lo programa en su propia cola de avisos (wa_/ig_notificaciones_pendientes
// ya tiene proximo_envio): la tarjeta y el aviso al celular del asesor llegan unos minutos
// ANTES de la hora pedida, con la hora en la primera línea. La hora tiene que ser de atención
// (negocio.json → horario, sin domingos ni festivos) y dejar el margen de cierre: a las 4:30 pm
// ya no hay quién llame.

const fechas = require('./fechas');
const { aMinutos } = require('./horario');

const ANTICIPACION_MIN = 10;   // la tarjeta llega 10 min antes de la hora pedida
const MAX_DIAS = 30;           // más allá de un mes no se programa: que escriba más cerca

function hhmm(minutos) {
  const h = Math.floor(minutos / 60), m = minutos % 60;
  const h12 = h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}

function parsearHora(hora) {
  const hm = String(hora ?? '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!hm) return null;
  let h = parseInt(hm[1]);
  const min = hm[2] ? parseInt(hm[2]) : 0;
  const sufijo = (hm[3] || '').replace(/\./g, '');
  if (sufijo === 'pm' && h < 12) h += 12;
  if (sufijo === 'am' && h === 12) h = 0;
  // Sin sufijo, "2" o "3" a secas casi siempre es de la tarde en horario comercial.
  if (!sufijo && h >= 1 && h <= 5) h += 12;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// dia: "miércoles 4 de noviembre de 2026" (como en agendar_cita) · hora: "11:00".
// Devuelve { ok: false, error } con lo que Elena le debe proponer al cliente, o
// { ok: true, cuando, texto, retrasoSegundos, lineaResumen }.
function programarContacto(negocio, dia, hora, { ahora = new Date(), herramienta = 'transferir_asesor' } = {}) {
  const horario = negocio.cfg?.horario ?? {};
  const f = fechas.parsearFechaCita(dia, fechas.hoy(ahora));
  if (!f) {
    return { ok: false, error: `No entendí el día "${dia}". Pregúntale al cliente qué día le sirve (día de la semana, número y mes) y vuelve a llamar ${herramienta}.` };
  }
  if (f.enPasado) return { ok: false, error: `El ${f.texto} ya pasó. Pregúntale qué día próximo le sirve.` };
  if (!f.coherente) {
    return { ok: false, error: `El ${f.iso} NO es ${f.diaDicho}: es ${f.diaSemana}. Confirma con el cliente el día y vuelve a llamar ${herramienta}.` };
  }
  if (f.esDomingo) return { ok: false, error: `El ${f.texto} es domingo y no atendemos. Ofrécele de lunes a sábado (${negocio.horarioTexto}).` };
  const nombreFestivo = negocio.cerradoEnFestivos !== false ? fechas.festivo(f.fecha) : null;
  if (nombreFestivo) return { ok: false, error: `El ${f.texto} es festivo (${nombreFestivo}) y no atendemos. Ofrécele otro día (${negocio.horarioTexto}).` };

  const minutos = parsearHora(hora);
  if (minutos == null) return { ok: false, error: 'No entendí la hora. Pídesela al cliente (ej. "11:00" o "3:30 pm") y vuelve a llamar.' };
  const rango = f.fecha.getUTCDay() === 6 ? horario.sabado : horario.semana;
  const desde = aMinutos(rango?.abre);
  const hasta = aMinutos(rango?.cierra) - (negocio.margenCierreTransferenciaMin ?? 20);
  if (!(minutos >= desde && minutos <= hasta)) {
    return {
      ok: false,
      fuera_de_horario: true,
      error: `Esa hora no es de atención: el ${f.diaSemana} el asesor puede contactarlo entre las ${hhmm(desde)} y las ${hhmm(hasta)} (horario: ${negocio.horarioTexto}). Propónle al cliente una hora en ese rango y vuelve a llamar ${herramienta} con la que elija.`,
    };
  }

  const [y, m, d] = f.iso.split('-').map(Number);
  // Bogotá es UTC-5 todo el año (sin horario de verano).
  const cuando = new Date(Date.UTC(y, m - 1, d, 5, 0) + minutos * 60000);
  const faltanMin = (cuando - ahora) / 60000;
  if (faltanMin <= 0) return { ok: false, error: `Las ${hhmm(minutos)} de hoy ya pasaron. Pregúntale al cliente otra hora.` };
  if (faltanMin > MAX_DIAS * 24 * 60) return { ok: false, error: `Es dentro de más de ${MAX_DIAS} días: pídele que nos escriba más cerca de la fecha o ofrécele una fecha más próxima.` };

  const texto = `${f.texto} a las ${hhmm(minutos)}`;
  return {
    ok: true,
    cuando,
    texto,
    retrasoSegundos: Math.max(0, Math.round((faltanMin - ANTICIPACION_MIN) * 60)),
    lineaResumen: `⏰ CONTACTAR EL ${texto.toUpperCase()} (lo pidió el cliente)`,
  };
}

// Parámetros que suman transferir_asesor (WS) y solicitar_asesor (IG).
const PARAMS_PROGRAMAR = {
  contactar_dia: {
    type: 'string',
    description: 'SOLO si el cliente pide que el asesor lo contacte en OTRO momento ("mañana a las 11", "el sábado en la mañana"): el día completo, como en agendar_cita ("miércoles 4 de noviembre de 2026"). Omítelo si lo quiere ya.',
  },
  contactar_hora: {
    type: 'string',
    description: 'Hora a la que quiere que lo contacten, en 24 h ("11:00", "15:30"). Va siempre con contactar_dia.',
  },
};

module.exports = { programarContacto, parsearHora, PARAMS_PROGRAMAR, ANTICIPACION_MIN, MAX_DIAS };
