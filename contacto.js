'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Datos de contacto que Elena pide ANTES de pasar al cliente con un asesor humano.
//
// Pedido del dueño (2026-10-08): "siempre que lo vaya a transferir a un asesor pida el
// nombre de la persona y el número de teléfono, y eso quede en el sistema de ventas". En
// Instagram la tarjeta de Redes llegaba solo con el username: el asesor no tenía a quién
// llamar. En WhatsApp llegaba el nombre del perfil ("💕Caro💕"), no el de la persona.
//
// La regla tiene una válvula a propósito: si el cliente NO quiere dar los datos, se le
// transfiere igual. Un formulario nunca debe costar una venta.

// "3001234567", "300 123 4567", "+57 300-123-4567", "57 3001234567" → "+573001234567".
// Fijos nuevos de Colombia (601…, 606…) también. Un número extranjero con "+" se acepta
// tal cual (8-15 dígitos). Lo que no parezca un teléfono devuelve null.
function normalizarTelefono(texto) {
  if (texto === null || texto === undefined) return null;
  const crudo = String(texto).trim();
  if (!crudo) return null;
  const conMas = crudo.startsWith('+');
  let digitos = crudo.replace(/\D/g, '');
  if (!digitos) return null;

  if (digitos.startsWith('57') && digitos.length === 12) digitos = digitos.slice(2);
  if (digitos.length === 10 && /^(3|60)/.test(digitos)) return `+57${digitos}`;

  if (conMas && !digitos.startsWith('57') && digitos.length >= 8 && digitos.length <= 15) {
    return `+${digitos}`;
  }
  return null;
}

// Lo que el cliente escribe cuando le piden el nombre no siempre es un nombre: "hola",
// "sí", "ok", un número. Se exige al menos una palabra de 2+ letras que no sea muletilla.
const NO_SON_NOMBRES = new Set([
  'hola', 'si', 'sí', 'no', 'ok', 'okay', 'vale', 'listo', 'gracias', 'buenas', 'buenos',
  'dias', 'días', 'tardes', 'noches', 'cliente', 'usuario', 'asesor', 'desconocido', 'nombre',
]);

function nombreValido(texto) {
  if (!texto) return false;
  const limpio = String(texto).trim();
  if (limpio.length < 2 || limpio.length > 80) return false;
  if (/\d{3,}/.test(limpio)) return false; // un teléfono o una cédula no son un nombre
  const palabras = limpio.toLowerCase().split(/\s+/).map(p => p.replace(/[^\p{L}]/gu, '')).filter(Boolean);
  return palabras.some(p => p.length >= 2 && !NO_SON_NOMBRES.has(p));
}

// "me llamo Laura Gómez" → "Laura Gómez". Primera letra de cada palabra en mayúscula.
function limpiarNombre(texto) {
  if (!texto) return null;
  const sinFrase = String(texto).trim()
    .replace(/^(hola[,!.\s]*)?(me llamo|mi nombre es|soy|habla)\s+/i, '')
    .replace(/[^\p{L}\s'.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  if (!nombreValido(sinFrase)) return null;
  return sinFrase.split(' ')
    .map(p => p ? p[0].toLocaleUpperCase('es-CO') + p.slice(1).toLocaleLowerCase('es-CO') : p)
    .join(' ');
}

// Resuelve el contacto con el que se transfiere, combinando lo que mandó el modelo con lo
// que ya se sabía del cliente (su perfil) y, en WhatsApp, con el número del chat.
//
//   canal          'whatsapp' | 'instagram'
//   args           { nombre, telefono_contacto, cliente_no_quiso_dar_datos }
//   perfil         { nombre, telefono_contacto } guardado de conversaciones anteriores
//   telefonoCanal  número verificado del chat (solo WhatsApp)
//
// Devuelve { nombre, telefono, faltan: [...], negado }.
function resolverContacto({ canal, args = {}, perfil = {}, telefonoCanal = null }) {
  const nombre = limpiarNombre(args.nombre) || limpiarNombre(perfil?.nombre) || null;

  let telefono = null;
  const pedido = String(args.telefono_contacto ?? '').trim().toLowerCase();
  if (canal === 'whatsapp' && /^(este[_\s]?mismo|mismo|este)$/.test(pedido)) {
    telefono = normalizarTelefono(telefonoCanal);
  } else {
    telefono = normalizarTelefono(args.telefono_contacto) || normalizarTelefono(perfil?.telefono_contacto);
  }

  const faltan = [];
  if (!nombre) faltan.push('nombre');
  if (!telefono) faltan.push('telefono');

  // Si en esta conversación ya dijo que no quería dar sus datos, no se le vuelven a pedir al
  // transferir: preguntar dos veces lo mismo es lo que hace que el cliente se vaya.
  const negado = args.cliente_no_quiso_dar_datos === true || perfil?.no_quiso_dar_datos === true;
  return { nombre, telefono, faltan, negado };
}

// Texto para el modelo cuando faltan datos: pedirlos en UN mensaje natural, sin sonar a
// formulario, y volver a llamar la herramienta con lo que dé.
function instruccionPedirDatos({ canal, faltan, herramienta }) {
  const queFalta = faltan.length === 2 ? 'su nombre y un número de celular'
    : faltan[0] === 'nombre' ? 'su nombre' : 'un número de celular';
  const extraWa = canal === 'whatsapp' && faltan.includes('telefono')
    ? ' En WhatsApp puedes preguntarle si lo contactan a este mismo número: si dice que sí, pasa telefono_contacto="este_mismo".'
    : '';
  return `Antes de pasarlo con un asesor necesitas ${queFalta}. NO lo transfieras todavía. ` +
    `Pídeselo en UN solo mensaje, cálido y natural (por ejemplo: "¡Claro que sí! 😊 Para que el asesor te contacte, ¿me regalas ${queFalta}?").${extraWa} ` +
    `Cuando te lo dé, vuelve a llamar ${herramienta} con nombre y telefono_contacto. ` +
    `Si el cliente NO quiere darlos, no insistas: llama ${herramienta} con cliente_no_quiso_dar_datos=true.`;
}

// Línea que va en el resumen de la tarjeta de Redes. Se ve aunque el sistema de ventas
// todavía no conozca el campo `contacto` del webhook.
function lineaContacto({ nombre, telefono, negado }) {
  if (!nombre && !telefono) return negado ? 'Contacto: el cliente prefirió no dejar nombre ni teléfono' : null;
  return `Contacto: ${[nombre, telefono].filter(Boolean).join(' · ')}`;
}

// Lo que viaja al sistema de ventas en el campo `contacto` del webhook (crea o actualiza
// el cliente de redes). Solo lo que hay: nada de claves vacías.
function payloadContacto({ nombre, telefono, negado } = {}, perfil = {}, extra = {}) {
  const c = {
    nombre: nombre || undefined,
    telefono: telefono || undefined,
    ciudad: extra.ciudad ? String(extra.ciudad).slice(0, 80) : undefined,
    forma_pago: extra.forma_pago ? String(extra.forma_pago).slice(0, 40) : undefined,
    presupuesto: Number(perfil?.presupuesto) > 0 ? Number(perfil.presupuesto) : undefined,
    espacio: perfil?.espacio || undefined,
    preferencias: perfil?.preferencias?.length ? perfil.preferencias.slice(0, 5) : undefined,
    productos_interes: perfil?.productos_interes?.length ? perfil.productos_interes.slice(0, 6) : undefined,
    categorias_interes: perfil?.categorias_interes?.length ? perfil.categorias_interes.slice(0, 6) : undefined,
    interes: perfil?.interes ? String(perfil.interes).slice(0, 300) : undefined,
    no_quiso_dar_datos: negado ? true : undefined,
  };
  for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
  return Object.keys(c).length ? c : null;
}

// Todo lo que se sabe del cliente según su perfil, en la forma del campo `contacto`. Es lo
// que se manda al sistema de ventas cada vez que se aprende algo (contacto o interés).
function contactoDesdePerfil(perfil = {}, extra = {}) {
  return payloadContacto(
    { nombre: limpiarNombre(perfil?.nombre), telefono: normalizarTelefono(perfil?.telefono_contacto), negado: perfil?.no_quiso_dar_datos },
    perfil,
    { ciudad: perfil?.ciudad, ...extra },
  );
}

module.exports = {
  normalizarTelefono, nombreValido, limpiarNombre,
  resolverContacto, instruccionPedirDatos, lineaContacto, payloadContacto, contactoDesdePerfil,
};
