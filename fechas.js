'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Fechas en la zona horaria del negocio. El servidor (Render) corre en UTC, así que
// `new Date().getDate()` a las 8 pm de Bogotá ya devuelve el día siguiente: el prompt
// le decía a Elena que era "mañana" y "agéndame el miércoles" caía en la fecha
// equivocada. Todo lo que tenga que ver con "qué día es hoy" pasa por aquí.

const ZONA = process.env.TIMEZONE || 'America/Bogota';

const DIAS  = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
               'septiembre', 'octubre', 'noviembre', 'diciembre'];

function sinAcentos(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Componentes de la fecha local (año, mes 1-12, día) para un instante dado.
function componentesLocales(instante = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(instante);
  const get = t => parseInt(partes.find(p => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

// Fecha "civil" (sin hora) como objeto Date en UTC medianoche: sirve para calcular el
// día de la semana y comparar fechas sin que la zona horaria vuelva a meterse.
function fechaCivil(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d));
}

function hoy(instante = new Date()) {
  const { y, m, d } = componentesLocales(instante);
  return fechaCivil(y, m, d);
}

function diaSemana(fecha) { return DIAS[fecha.getUTCDay()]; }

// "sábado 19 de septiembre de 2026"
function textoLargo(fecha) {
  return `${diaSemana(fecha)} ${fecha.getUTCDate()} de ${MESES[fecha.getUTCMonth()]} de ${fecha.getUTCFullYear()}`;
}

function iso(fecha) {
  return `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}-${String(fecha.getUTCDate()).padStart(2, '0')}`;
}

function sumarDias(fecha, n) {
  return new Date(fecha.getTime() + n * 86400000);
}

// Bloque para el system prompt: la fecha de hoy y los próximos días con su nombre, para
// que "el miércoles" o "el sábado" se resuelvan mirando una tabla y no calculando.
function bloqueFechaParaPrompt(instante = new Date()) {
  const h = hoy(instante);
  const proximos = [];
  for (let i = 1; i <= 8; i++) proximos.push(textoLargo(sumarDias(h, i)));
  return `FECHA ACTUAL: Hoy es ${textoLargo(h)} (hora de Colombia).\n` +
         `Próximos días: ${proximos.join(' · ')}.\n` +
         `Usa esta lista para resolver "el miércoles", "el sábado", "mañana", "la otra semana": la fecha que propongas al cliente debe estar en la lista o ser posterior, con el día de la semana que aparece aquí. Nunca agendes una fecha pasada.`;
}

// Interpreta la fecha que el modelo pasa a agendar_cita. Acepta:
//   "miércoles 18 de junio de 2026", "18 de junio de 2026", "18 de junio" (asume el
//   próximo año en que caiga en el futuro), "18/06/2026", "2026-06-18".
// Devuelve null si no se entiende. Si el texto trae un día de la semana, comprueba que
// coincida con la fecha real: "martes 3 de junio de 2026" es incoherente (es miércoles)
// y el asesor no sabría a cuál de los dos días atenerse.
function parsearFechaCita(texto, referencia = hoy()) {
  const t = sinAcentos(texto).replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  const diaDicho = DIAS.map(sinAcentos).find(d => new RegExp(`\\b${d}\\b`).test(t)) ?? null;

  let y = null, m = null, d = null;
  let mm;
  if ((mm = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    [y, m, d] = [+mm[1], +mm[2], +mm[3]];
  } else if ((mm = t.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/))) {
    [d, m, y] = [+mm[1], +mm[2], +mm[3]];
  } else if ((mm = t.match(/(\d{1,2})\s+(?:de\s+)?([a-z]+)(?:\s+(?:de|del)\s+(\d{4}))?/))) {
    const idx = MESES.map(sinAcentos).findIndex(mes => mes === mm[2] || mes.startsWith(mm[2].slice(0, 3)));
    if (idx === -1) return null;
    d = +mm[1]; m = idx + 1; y = mm[3] ? +mm[3] : null;
  } else {
    return null;
  }

  if (!y) {
    // Sin año: el próximo en que esa fecha caiga hoy o más adelante.
    y = referencia.getUTCFullYear();
    if (fechaCivil(y, m, d) < referencia) y += 1;
  }

  const fecha = fechaCivil(y, m, d);
  // Fecha inexistente (31 de febrero): Date la "corrige" al mes siguiente.
  if (fecha.getUTCMonth() !== m - 1 || fecha.getUTCDate() !== d) return null;

  const diaReal = diaSemana(fecha);
  return {
    fecha,
    iso: iso(fecha),
    texto: textoLargo(fecha),
    diaSemana: diaReal,
    diaDicho: diaDicho ? DIAS.find(x => sinAcentos(x) === diaDicho) : null,
    coherente: !diaDicho || sinAcentos(diaReal) === diaDicho,
    enPasado: fecha < referencia,
    esDomingo: fecha.getUTCDay() === 0,
  };
}

// Valida la pareja fecha + hora que el modelo pasa a agendar_cita contra el horario del
// negocio. Devuelve { ok: true, fecha, hora } o { ok: false, error } con un texto pensado
// para que el modelo se lo explique al cliente y vuelva a preguntar.
//
// Horario por defecto: Lun-Vie 8am-5pm (última cita 4pm), Sáb 8am-12pm (última 11am),
// domingo cerrado. Antes se aceptaba 17:45 un martes porque el tope era `h > 17`.
const HORARIO_DEFECTO = {
  semana: { desde: 8, ultima: 16 },
  sabado: { desde: 8, ultima: 11 },
};

function validarFechaHoraCita(dia, hora, { referencia = hoy(), horario = HORARIO_DEFECTO } = {}) {
  const f = parsearFechaCita(dia, referencia);
  if (!f) {
    return { ok: false, error: `No entendí la fecha "${dia}". Pídele al cliente el día completo (día de la semana, número, mes y año) y vuelve a llamar agendar_cita.` };
  }
  if (f.enPasado) {
    return { ok: false, error: `La fecha ${f.texto} ya pasó (hoy es ${textoLargo(referencia)}). Pregúntale al cliente qué día próximo le sirve.` };
  }
  if (f.esDomingo) {
    return { ok: false, error: `El ${f.texto} es domingo y no atendemos. Ofrécele de lunes a sábado.` };
  }
  if (!f.coherente) {
    return { ok: false, error: `El ${f.iso} NO es ${f.diaDicho}: es ${f.diaSemana}. Confirma con el cliente si quiere el ${f.texto} u otro día, y vuelve a llamar agendar_cita con la fecha correcta.` };
  }

  const hm = String(hora ?? '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if (!hm) {
    return { ok: false, error: 'Formato de hora inválido. Ejemplo válido: "14:00" o "9:30". Vuelve a pedirle la hora al cliente.' };
  }
  let h = parseInt(hm[1]);
  const min = hm[2] ? parseInt(hm[2]) : 0;
  const sufijo = (hm[3] || '').toLowerCase().replace(/\./g, '');
  if (sufijo === 'pm' && h < 12) h += 12;
  if (sufijo === 'am' && h === 12) h = 0;
  // Sin sufijo, "2" o "3" a secas casi siempre es de la tarde en horario comercial.
  if (!sufijo && h >= 1 && h <= 5) h += 12;

  const esSabado = f.fecha.getUTCDay() === 6;
  const rango = esSabado ? horario.sabado : horario.semana;
  if (h < rango.desde || h > rango.ultima || (h === rango.ultima && min > 0) || min < 0 || min > 59) {
    const txt = esSabado
      ? `Sábado atendemos de ${rango.desde}am a 12pm (última cita ${rango.ultima}:00).`
      : `De lunes a viernes atendemos de ${rango.desde}am a 5pm (última cita ${rango.ultima - 12}:00 pm).`;
    return { ok: false, error: `Hora fuera de horario. ${txt} Pídele al cliente otra hora dentro de ese rango.` };
  }

  return {
    ok: true,
    fecha: f,
    hora: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
    esSabado,
  };
}

module.exports = {
  ZONA, DIAS, MESES,
  hoy, fechaCivil, diaSemana, textoLargo, iso, sumarDias,
  bloqueFechaParaPrompt, parsearFechaCita, validarFechaHoraCita, HORARIO_DEFECTO,
};
