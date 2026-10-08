'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// ¿Hay alguien atendiendo ahora? Horario real de atención, leído de negocio.json
// (horario.semana / horario.sabado) y, desde el 2026-10-08, con los FESTIVOS de Colombia:
// las tiendas no abren y los asesores no responden, así que un mensaje del 12 de octubre
// a las 10 am es "fuera de horario" y lo que toca decirle al cliente es cuándo le van a
// responder de verdad.
//
// Antes esta función estaba copiada igual en los dos agentes (index.js).
//
// `margenCierreMin`: minutos antes del cierre a partir de los cuales ya se considera
// fuera de horario. Se usa para las transferencias: una solicitud que entra a las 4:50
// pm ya no la va a atender nadie ese día, así que para el cliente es "mañana".
// `proximaApertura` es el texto para decirle al cliente cuándo le responderá el asesor.

const fechas = require('./fechas');

const DIAS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function estadoHorario(negocio, margenCierreMin = 0, ahora = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: negocio.zonaHoraria, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(ahora);
  const dia    = partes.find(p => p.type === 'weekday')?.value;
  let hora     = parseInt(partes.find(p => p.type === 'hour')?.value);
  if (hora === 24) hora = 0;
  const minuto = parseInt(partes.find(p => p.type === 'minute')?.value) || 0;
  const min    = hora * 60 + minuto;

  const h        = negocio.horario;
  const rango    = dia === 'Sat' ? h.sabado : h.semana;
  const apertura = rango.abre * 60;
  const cierre   = rango.cierra * 60 - margenCierreMin;

  const hoy = fechas.hoy(ahora);
  const cerradoHoy = (dia === 'Sun' && h.domingoCerrado)
    || (negocio.cerradoEnFestivos !== false && !!fechas.festivo(hoy));
  const abierto = !cerradoHoy && min >= apertura && min < cierre;
  if (abierto) return { abierto, proximaApertura: null };

  // Qué día vuelve a responder alguien (las mismas reglas de siempre: después del cierre
  // del viernes o del sábado, el lunes)…
  let dias;
  if (dia === 'Sun')                       dias = 1;
  else if (min < apertura && !cerradoHoy)  dias = 0;
  else if (dia === 'Fri')                  dias = 3;
  else if (dia === 'Sat')                  dias = 2;
  else                                     dias = 1;
  // …saltándose los domingos y los festivos.
  const cerrado = f => f.getUTCDay() === 0 || (negocio.cerradoEnFestivos !== false && !!fechas.festivo(f));
  while (cerrado(fechas.sumarDias(hoy, dias))) dias += 1;

  const destino = fechas.sumarDias(hoy, dias);
  const hora8 = `a partir de las ${h.semana.abre}am`;
  let proximaApertura;
  if (dias === 0)                                    proximaApertura = `hoy ${hora8}`;
  else if (dias === 1 && DIAS_EN[destino.getUTCDay()] === 'Mon' && dia === 'Sun') proximaApertura = `mañana lunes ${hora8}`;
  else if (dias === 1)                               proximaApertura = `mañana ${hora8}`;
  else                                               proximaApertura = `el ${fechas.diaSemana(destino)} ${hora8}`;

  return { abierto, proximaApertura };
}

module.exports = { estadoHorario };
