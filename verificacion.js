'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Revisión de la respuesta ANTES de que llegue al cliente: que Elena no diga que hizo algo
// que no hizo.
//
// En la evaluación con el modelo real (2026-10-08), aun con la regla escrita en el prompt,
// el modelo decía "te envío el catálogo" o "voy a notificar a nuestro equipo de compras" sin
// llamar la herramienta, y una vez escribió un enlace inventado (decasa.com/catalogo/camas).
// El cliente se queda esperando algo que nunca llega. El dueño lo pidió claro: que no se
// invente nada. Así que esto no se deja solo al prompt: si la respuesta promete una acción
// que no ocurrió en el turno, o trae un enlace que ninguna herramienta devolvió, NO se envía;
// se le devuelve al modelo con la corrección para que haga la acción o arregle el texto. Una
// sola vez por turno (quien llama lo controla) para no entrar en un ciclo.

// Frases afirmativas que dicen que algo YA se hizo o se está haciendo. Las preguntas
// ("¿te mando fotos?") son ofrecimientos, no promesas: se descartan por oración.
const PROMESAS = [
  {
    patron: /(te (env[ií]o|dejo|comparto|mando|paso)|aqu[ií] (tienes|est[aá]|te dejo)|ya te (envi[ée]|mand[ée])).{0,40}cat[aá]logo/i,
    herramientas: ['enviar_catalogo'],
    que: 'que le enviaste el catálogo',
    accion: 'llama enviar_catalogo con la categoría',
  },
  {
    patron: /(te (env[ií]o|mando|comparto) (la |las |unas? )?fotos?|aqu[ií] (tienes|est[aá]n?) (la |las )?fotos?)/i,
    herramientas: ['enviar_foto', 'enviar_carrusel'],
    que: 'que le enviaste fotos',
    accion: 'llama enviar_foto (o enviar_carrusel) con el nombre exacto',
  },
  {
    patron: /(ya )?(lo|la|los|las) (agregu[ée]|a[ñn]ad[ií]|puse) (al|en el|a tu) carrito/i,
    herramientas: ['agregar_al_carrito'],
    que: 'que lo agregaste al carrito',
    accion: 'llama agregar_al_carrito',
  },
  {
    patron: /(voy a|ya) (notific|avis|report|inform|pas)\w* (a |al )?(nuestro |el |un )?(equipo|asesor|[aá]rea|compras)/i,
    herramientas: ['reportar_proveedor', 'transferir_asesor', 'solicitar_asesor', 'reportar_objecion', 'confirmar_pedido', 'agendar_cita'],
    que: 'que notificaste o pasaste el caso a una persona del equipo',
    accion: 'llama la herramienta que corresponde (reportar_proveedor si es un proveedor; la del asesor si es un cliente que lo pidió)',
  },
  {
    patron: /(ya )?(qued[oó]|est[aá]) (agendad[ao]|confirmad[ao]) (tu|la) (cita|visita)|(ya )?agend[ée] (tu|la) (cita|visita)/i,
    herramientas: ['agendar_cita'],
    que: 'que agendaste la cita',
    accion: 'llama agendar_cita con los datos confirmados',
  },
];

// Parte el texto en oraciones con su signo final, para saber cuáles son preguntas.
function oraciones(texto) {
  return String(texto ?? '').match(/[^.!?\n]+[.!?]*/g) ?? [];
}

const URL = /https?:\/\/[^\s)\]>"']+/gi;

// Devuelve el texto de corrección para el modelo, o null si la respuesta está bien.
//   texto        lo que Elena le iba a decir al cliente
//   herramientas nombres de las herramientas que se llamaron en ESTE turno
//   resultados   lo que devolvieron (strings u objetos), para saber qué enlaces son reales
function revisarRespuesta({ texto, herramientas = [], resultados = [] }) {
  const problemas = [];
  const llamadas = new Set(herramientas);

  for (const o of oraciones(texto)) {
    if (o.trim().endsWith('?')) continue;
    for (const p of PROMESAS) {
      if (p.patron.test(o) && !p.herramientas.some(h => llamadas.has(h))) {
        problemas.push(`Dices ${p.que} ("${o.trim().slice(0, 80)}"), pero en este turno no llamaste la herramienta: ${p.accion} AHORA, o quita esa frase si no corresponde.`);
      }
    }
  }

  const textoResultados = resultados.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join(' ');
  for (const url of String(texto ?? '').match(URL) ?? []) {
    const limpia = url.replace(/[.,;:!?]+$/, '');
    if (!textoResultados.includes(limpia)) {
      problemas.push(`Escribiste el enlace ${limpia}, que no te devolvió ninguna herramienta: es inventado. Bórralo; si el cliente necesita un enlace, consíguelo con la herramienta (p. ej. enviar_catalogo).`);
    }
  }

  if (!problemas.length) return null;
  return `REVISIÓN ANTES DE ENVIAR — tu respuesta NO se envió al cliente:\n- ${[...new Set(problemas)].join('\n- ')}\nCorrige: haz la acción con la herramienta o reescribe la respuesta sin afirmar lo que no hiciste. No menciones esta revisión.`;
}

module.exports = { revisarRespuesta, oraciones };
