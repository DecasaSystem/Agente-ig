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

// ── Festivos de Colombia ──────────────────────────────────────────────────────
//
// Las tiendas no abren en festivo (confirmado por el dueño, 2026-10-08), y el agente
// solo rechazaba domingos: agendaba visitas el 12 de octubre o el 2 de noviembre y el
// cliente llegaba a la tienda cerrada. Se calculan con la ley (Ley 51 de 1983, "Ley
// Emiliani") en vez de una lista a mano, para que no haya que acordarse de actualizarla
// cada año:
//   - fijos: 1 ene, 1 may, 20 jul, 7 ago, 8 dic, 25 dic;
//   - trasladables al lunes siguiente: 6 ene, 19 mar, 29 jun, 15 ago, 12 oct, 1 nov, 11 nov;
//   - según la Pascua: Jueves y Viernes Santo, y Ascensión (+43), Corpus Christi (+64) y
//     Sagrado Corazón (+71), que ya caen en lunes.

// Domingo de Pascua (algoritmo anónimo gregoriano / Meeus).
function domingoDePascua(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return fechaCivil(y, mes, dia);
}

function alLunes(fecha) {
  const dow = fecha.getUTCDay();
  return dow === 1 ? fecha : sumarDias(fecha, (8 - dow) % 7);
}

const _festivosPorAnio = new Map();
// Map { 'yyyy-mm-dd' → nombre } con los festivos de ese año.
function festivosColombia(y) {
  if (_festivosPorAnio.has(y)) return _festivosPorAnio.get(y);
  const f = new Map();
  const poner = (fecha, nombre) => f.set(iso(fecha), nombre);
  poner(fechaCivil(y, 1, 1), 'Año Nuevo');
  poner(fechaCivil(y, 5, 1), 'Día del Trabajo');
  poner(fechaCivil(y, 7, 20), 'Día de la Independencia');
  poner(fechaCivil(y, 8, 7), 'Batalla de Boyacá');
  poner(fechaCivil(y, 12, 8), 'Inmaculada Concepción');
  poner(fechaCivil(y, 12, 25), 'Navidad');
  poner(alLunes(fechaCivil(y, 1, 6)), 'Reyes Magos');
  poner(alLunes(fechaCivil(y, 3, 19)), 'San José');
  poner(alLunes(fechaCivil(y, 6, 29)), 'San Pedro y San Pablo');
  poner(alLunes(fechaCivil(y, 8, 15)), 'Asunción de la Virgen');
  poner(alLunes(fechaCivil(y, 10, 12)), 'Día de la Raza');
  poner(alLunes(fechaCivil(y, 11, 1)), 'Todos los Santos');
  poner(alLunes(fechaCivil(y, 11, 11)), 'Independencia de Cartagena');
  const pascua = domingoDePascua(y);
  poner(sumarDias(pascua, -3), 'Jueves Santo');
  poner(sumarDias(pascua, -2), 'Viernes Santo');
  poner(sumarDias(pascua, 43), 'Ascensión del Señor');
  poner(sumarDias(pascua, 64), 'Corpus Christi');
  poner(sumarDias(pascua, 71), 'Sagrado Corazón');
  _festivosPorAnio.set(y, f);
  return f;
}

// Nombre del festivo de esa fecha civil, o null si no es festivo.
function festivo(fecha) {
  return festivosColombia(fecha.getUTCFullYear()).get(iso(fecha)) ?? null;
}

// Bloque para el system prompt: la fecha de hoy y los próximos días con su nombre, para
// que "el miércoles" o "el sábado" se resuelvan mirando una tabla y no calculando. Los
// festivos van marcados para que no los proponga.
function bloqueFechaParaPrompt(instante = new Date(), { cerradoEnFestivos = true } = {}) {
  const h = hoy(instante);
  const proximos = [];
  for (let i = 1; i <= 8; i++) {
    const dia = sumarDias(h, i);
    const fest = cerradoEnFestivos ? festivo(dia) : null;
    proximos.push(fest ? `${textoLargo(dia)} (FESTIVO: ${fest}, cerrado)` : textoLargo(dia));
  }
  const hoyFestivo = cerradoEnFestivos ? festivo(h) : null;
  return `FECHA ACTUAL: Hoy es ${textoLargo(h)}${hoyFestivo ? ` (festivo: ${hoyFestivo}, las tiendas están cerradas)` : ''} (hora de Colombia).\n` +
         `Próximos días: ${proximos.join(' · ')}.\n` +
         `Usa esta lista para resolver "el miércoles", "el sábado", "mañana", "la otra semana": la fecha que propongas al cliente debe estar en la lista o ser posterior, con el día de la semana que aparece aquí. Nunca agendes una fecha pasada${cerradoEnFestivos ? ' ni un festivo' : ''}.`;
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

function validarFechaHoraCita(dia, hora, { referencia = hoy(), horario = HORARIO_DEFECTO, cerradoEnFestivos = true } = {}) {
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
  const nombreFestivo = cerradoEnFestivos ? festivo(f.fecha) : null;
  if (nombreFestivo) {
    // El siguiente día hábil, para que el modelo proponga algo concreto.
    let siguiente = sumarDias(f.fecha, 1);
    while (siguiente.getUTCDay() === 0 || festivo(siguiente)) siguiente = sumarDias(siguiente, 1);
    return { ok: false, error: `El ${f.texto} es festivo (${nombreFestivo}) y las tiendas están cerradas. Ofrécele otro día; el siguiente día hábil es el ${textoLargo(siguiente)}.` };
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
  festivosColombia, festivo, domingoDePascua,
};
