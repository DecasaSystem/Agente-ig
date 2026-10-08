'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Memoria del cliente: lo que el agente recuerda de él entre conversaciones, y el resumen
// de lo hablado cuando la conversación se hace larga.
//
// Dos problemas que resuelve:
//
//   1. PERFIL. Cada conversación arrancaba en blanco: nombre, presupuesto, para qué espacio
//      busca, qué materiales le gustan, qué productos ya vio. El cliente volvía a los tres
//      días y tenía que contarlo todo otra vez. La diferencia entre un bot y un asesor que
//      te conoce es exactamente esto.
//
//   2. RESUMEN. El historial se corta en los últimos mensajes: en una conversación larga el
//      agente olvidaba el principio, incluido lo que el cliente ya había descartado ("esa
//      no, es muy grande"), y volvía a ofrecérselo.
//
// La mayor parte del perfil se captura GRATIS de lo que ya pasa por las herramientas: el
// presupuesto sale de buscar_por_presupuesto, los productos de interés de lo que se le
// muestra, el nombre de agendar_cita. Solo lo cualitativo (el espacio, los gustos) necesita
// que el modelo lo cuente, y para eso existe la herramienta recordar_preferencia.

// Cuántos mensajes se conservan literales; lo anterior se resume.
const MENSAJES_LITERALES = 8;
// A partir de cuántos mensajes tiene sentido resumir.
const UMBRAL_RESUMEN = 12;
// Cuántos mensajes nuevos hacen falta para volver a resumir (evita una llamada por turno).
const MENSAJES_ENTRE_RESUMENES = 6;
// Máximo de preferencias y productos que se recuerdan, para no inflar el prompt.
const MAX_PREFERENCIAS = 5;
const MAX_PRODUCTOS = 6;

// ── Perfil ────────────────────────────────────────────────────────────────────

function perfilVacio() {
  return { nombre: null, telefono_contacto: null, ciudad: null, presupuesto: null, espacio: null, preferencias: [], productos_interes: [], actualizado: null };
}

// Funde los datos nuevos con los que ya había. Lo nuevo manda, salvo que venga vacío: un
// turno en el que el cliente no menciona su presupuesto no debe borrar el que ya dijo.
function fusionarPerfil(actual, cambios = {}) {
  const base = { ...perfilVacio(), ...(actual ?? {}) };

  if (cambios.nombre)      base.nombre = String(cambios.nombre).trim().substring(0, 60);
  if (cambios.espacio)     base.espacio = String(cambios.espacio).trim().substring(0, 80);
  // El celular que dio para que lo contacte un asesor (ya normalizado por contacto.js) y su
  // ciudad: con esto una segunda transferencia no le vuelve a pedir los datos.
  if (cambios.telefono_contacto) base.telefono_contacto = String(cambios.telefono_contacto).trim().substring(0, 20);
  if (cambios.ciudad)      base.ciudad = String(cambios.ciudad).trim().substring(0, 80);
  if (Number(cambios.presupuesto) > 0) base.presupuesto = Number(cambios.presupuesto);

  for (const lista of ['preferencias', 'productos_interes']) {
    const nuevos = (cambios[lista] ?? []).map(v => String(v).trim()).filter(Boolean);
    if (!nuevos.length) continue;
    const limite = lista === 'preferencias' ? MAX_PREFERENCIAS : MAX_PRODUCTOS;
    // Sin duplicados (ignorando mayúsculas) y quedándose con los más recientes.
    const vistos = new Set();
    base[lista] = [...nuevos.reverse(), ...base[lista]]
      .filter(v => { const k = v.toLowerCase(); if (vistos.has(k)) return false; vistos.add(k); return true; })
      .slice(0, limite);
  }

  base.actualizado = Date.now();
  return base;
}

function perfilTieneAlgo(perfil) {
  if (!perfil) return false;
  return !!(perfil.nombre || perfil.telefono_contacto || perfil.ciudad || perfil.presupuesto || perfil.espacio ||
    perfil.preferencias?.length || perfil.productos_interes?.length);
}

// Bloque para el modelo con lo que ya se sabe del cliente. Devuelve null si no hay nada,
// para no gastar tokens en un mensaje vacío.
function construirContextoPerfil(perfil, { formatearMoneda } = {}) {
  if (!perfilTieneAlgo(perfil)) return null;

  const lineas = [];
  if (perfil.nombre)      lineas.push(`Se llama ${perfil.nombre}`);
  if (perfil.telefono_contacto) lineas.push(`Celular que dejó para que lo contacten: ${perfil.telefono_contacto}`);
  if (perfil.ciudad)      lineas.push(`Ciudad: ${perfil.ciudad}`);
  if (perfil.presupuesto) lineas.push(`Presupuesto que mencionó: ${formatearMoneda ? formatearMoneda(perfil.presupuesto) : perfil.presupuesto}`);
  if (perfil.espacio)     lineas.push(`Para: ${perfil.espacio}`);
  if (perfil.preferencias?.length)      lineas.push(`Le interesa: ${perfil.preferencias.join(', ')}`);
  if (perfil.productos_interes?.length) lineas.push(`Productos que ya vio: ${perfil.productos_interes.join(', ')}`);

  return `LO QUE YA SABES DE ESTE CLIENTE (de conversaciones anteriores):\n${lineas.map(l => `- ${l}`).join('\n')}\n` +
    'Úsalo con naturalidad para no hacerle repetir lo que ya contó (por ejemplo, retoma su presupuesto o el espacio que mencionó). ' +
    'NO se lo recites como una ficha, y si algo ya no aplica porque te dice otra cosa, manda lo que diga ahora.';
}

// ── Resumen de la conversación ────────────────────────────────────────────────

function necesitaResumen(totalMensajes, resumenPrevio) {
  if (totalMensajes < UMBRAL_RESUMEN) return false;
  if (!resumenPrevio?.texto) return true;
  return totalMensajes - (resumenPrevio.hasta ?? 0) >= MENSAJES_ENTRE_RESUMENES;
}

// Genera el resumen de los mensajes antiguos con el modelo rápido. Devuelve null si falla:
// perder el resumen degrada la conversación, pero no debe romper el turno.
async function generarResumen(openai, mensajes, { modelo = 'gpt-4o-mini' } = {}) {
  if (!mensajes.length) return null;
  const transcripcion = mensajes
    .map(m => `${m.role === 'assistant' ? 'Asesora' : 'Cliente'}: ${String(m.content).substring(0, 300)}`)
    .join('\n');

  try {
    const resp = await openai.chat.completions.create({
      model: modelo,
      temperature: 0,
      max_tokens: 220,
      messages: [
        {
          role: 'system',
          content: 'Resume esta conversación de ventas de muebles en 3 o 4 líneas, para que otra asesora pueda continuarla sin leerla entera. ' +
            'Incluye: qué busca el cliente, presupuesto o condiciones si los dijo, productos que le gustaron y —muy importante— los que DESCARTÓ y por qué. ' +
            'Escribe en tercera persona, sin saludos ni florituras. Si algo no se dijo, no lo inventes.',
        },
        { role: 'user', content: transcripcion },
      ],
    });
    const texto = resp.choices?.[0]?.message?.content?.trim();
    return texto || null;
  } catch (e) {
    console.warn('[memoria] no se pudo resumir la conversación:', e.message);
    return null;
  }
}

function construirContextoResumen(resumen) {
  if (!resumen?.texto) return null;
  return `RESUMEN DE LO YA HABLADO EN ESTA CONVERSACIÓN (los mensajes más antiguos ya no están en el historial):\n${resumen.texto}\n` +
    'No le vuelvas a ofrecer lo que ya descartó ni le preguntes lo que ya respondió.';
}

// Prepara el historial que se le pasa al modelo: los últimos mensajes literales y, si hace
// falta, un resumen de los anteriores. Si el resumen se acaba de regenerar, se devuelve para
// que el agente lo guarde.
async function prepararHistorial(deps, destinatario, { openai, modeloRapido } = {}) {
  const { db } = deps;
  const todos = await db.getHistorial(destinatario, 40);
  const resumenPrevio = await db.getResumenConversacion?.(destinatario) ?? null;

  if (todos.length <= UMBRAL_RESUMEN) {
    return { mensajes: todos, resumen: resumenPrevio, resumenNuevo: null };
  }

  const literales = todos.slice(-MENSAJES_LITERALES);
  const antiguos = todos.slice(0, -MENSAJES_LITERALES);

  let resumen = resumenPrevio;
  let resumenNuevo = null;

  if (openai && necesitaResumen(todos.length, resumenPrevio)) {
    const texto = await generarResumen(openai, antiguos, { modelo: modeloRapido });
    if (texto) {
      resumen = { texto, hasta: todos.length };
      resumenNuevo = resumen;
      await db.setResumenConversacion?.(destinatario, resumen).catch?.(() => {});
    }
  }

  return { mensajes: literales, resumen, resumenNuevo };
}

module.exports = {
  perfilVacio, fusionarPerfil, perfilTieneAlgo, construirContextoPerfil,
  necesitaResumen, generarResumen, construirContextoResumen, prepararHistorial,
  MENSAJES_LITERALES, UMBRAL_RESUMEN, MENSAJES_ENTRE_RESUMENES, MAX_PREFERENCIAS, MAX_PRODUCTOS,
};
