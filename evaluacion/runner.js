'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Motor de evaluación del prompt.
//
// Los tests normales usan un modelo simulado: comprueban que el CÓDIGO hace lo que debe
// cuando el modelo pide algo. Esto es lo contrario: usa el modelo REAL para comprobar que
// el PROMPT consigue que el modelo haga lo correcto. Sin esto, cada cambio de prompt es a
// ciegas — se prueba a mano con dos mensajes y se cruza los dedos.
//
// Cuesta dinero (llama a OpenAI de verdad), así que no va en `npm test`: se corre a mano
// antes de dar por bueno un cambio de prompt, con `npm run eval`.
//
// El modelo se inyecta, así que este motor también se puede probar con uno simulado.

// Ejecuta un caso: recorre los turnos del cliente y registra qué herramientas pidió el
// modelo y qué le respondió al cliente en cada uno.
// `notaPorTurno({ historial })` (opcional) devuelve un mensaje de sistema efímero para ese
// turno, igual que los que agregan los agentes de verdad (p. ej. memoria.notaPedirDatos):
// así la evaluación ve lo mismo que el modelo en producción.
// `revisarRespuesta({ texto, herramientas, resultados })` (opcional) es la revisión antes de
// enviar de los agentes (verificacion.js): si devuelve una corrección, la respuesta no cuenta
// y el modelo la rehace, una vez por turno.
async function ejecutarCaso(caso, { openai, modelo, systemPrompt, tools, ejecutarHerramienta, maxRondas = 6, notaPorTurno = null, revisarRespuesta = null }) {
  const mensajes = [{ role: 'system', content: systemPrompt }];
  const turnos = [];

  for (const textoCliente of caso.mensajes) {
    const historial = mensajes.filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
    const nota = notaPorTurno?.({ historial }) ?? null;
    mensajes.push({ role: 'user', content: textoCliente });
    // La nota va detrás del prompt fijo y no queda en el historial (como en los agentes).
    const conNota = () => (nota ? [mensajes[0], { role: 'system', content: nota }, ...mensajes.slice(1)] : mensajes);

    const herramientasLlamadas = [];
    const resultadosTurno = [];
    let respuestaFinal = '';
    let yaCorregida = false;

    for (let ronda = 0; ronda < maxRondas; ronda++) {
      const respuesta = await openai.chat.completions.create({
        model: modelo,
        messages: conNota(),
        tools,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 900,
      });

      const eleccion = respuesta.choices[0];
      const llamadas = eleccion.message.tool_calls ?? [];

      if (!llamadas.length) {
        const texto = eleccion.message.content ?? '';
        const correccion = !yaCorregida && ronda < maxRondas - 1 && revisarRespuesta
          ? revisarRespuesta({ texto, herramientas: herramientasLlamadas.map(h => h.nombre), resultados: resultadosTurno })
          : null;
        if (correccion) {
          yaCorregida = true;
          mensajes.push({ role: 'assistant', content: texto });
          mensajes.push({ role: 'system', content: correccion });
          continue;
        }
        respuestaFinal = texto;
        mensajes.push({ role: 'assistant', content: respuestaFinal });
        break;
      }

      mensajes.push(eleccion.message);
      for (const llamada of llamadas) {
        let args = {};
        try { args = JSON.parse(llamada.function.arguments); } catch { /* el modelo mandó basura */ }
        herramientasLlamadas.push({ nombre: llamada.function.name, args });
        const resultado = await ejecutarHerramienta(llamada.function.name, args);
        resultadosTurno.push(resultado);
        mensajes.push({ role: 'tool', tool_call_id: llamada.id, content: typeof resultado === 'string' ? resultado : JSON.stringify(resultado) });
      }
    }

    turnos.push({ cliente: textoCliente, herramientas: herramientasLlamadas, respuesta: respuestaFinal });
  }

  return turnos;
}

// Comprueba un caso ejecutado contra lo que se esperaba. Devuelve los fallos: lista vacía
// significa que pasó.
function evaluarResultado(caso, turnos) {
  const fallos = [];
  const esperado = caso.esperado ?? {};

  const todasLasHerramientas = turnos.flatMap(t => t.herramientas);
  const nombres = todasLasHerramientas.map(h => h.nombre);
  const textoCompleto = turnos.map(t => t.respuesta).join('\n');

  for (const requerida of esperado.herramientas ?? []) {
    if (!nombres.includes(requerida)) fallos.push(`no llamó a ${requerida}`);
  }

  for (const prohibida of esperado.herramientas_prohibidas ?? []) {
    if (nombres.includes(prohibida)) fallos.push(`llamó a ${prohibida}, que no debía`);
  }

  for (const frase of esperado.texto_contiene ?? []) {
    if (!new RegExp(frase, 'i').test(textoCompleto)) fallos.push(`la respuesta no menciona /${frase}/`);
  }

  for (const frase of esperado.texto_prohibido ?? []) {
    if (new RegExp(frase, 'i').test(textoCompleto)) fallos.push(`la respuesta menciona /${frase}/, que no debía`);
  }

  // Comprobaciones sobre los argumentos con los que llamó a una herramienta: es donde se
  // ven los errores caros (agregar al carrito sin variante, agendar con fecha inventada).
  for (const comprobacion of esperado.argumentos ?? []) {
    const llamada = todasLasHerramientas.find(h => h.nombre === comprobacion.herramienta);
    if (!llamada) { fallos.push(`no llamó a ${comprobacion.herramienta} (se esperaban argumentos)`); continue; }
    for (const [campo, esperadoValor] of Object.entries(comprobacion.tiene ?? {})) {
      const real = llamada.args[campo];
      if (esperadoValor === '*') {
        if (real === undefined || real === null || real === '') fallos.push(`${comprobacion.herramienta}.${campo} vino vacío`);
      } else if (String(real ?? '').toLowerCase() !== String(esperadoValor).toLowerCase()) {
        fallos.push(`${comprobacion.herramienta}.${campo} fue "${real}" y se esperaba "${esperadoValor}"`);
      }
    }
  }

  return fallos;
}

// Corre todos los casos y devuelve el informe. `alAvanzar` permite ir imprimiendo.
async function evaluarTodos(casos, opciones, alAvanzar) {
  const resultados = [];

  for (const caso of casos) {
    // Cada caso empieza de cero (carrito, perfil simulados).
    opciones.alEmpezarCaso?.(caso);
    try {
      const turnos = await ejecutarCaso(caso, opciones);
      const fallos = evaluarResultado(caso, turnos);
      const resultado = { caso, turnos, fallos, paso: fallos.length === 0 };
      resultados.push(resultado);
      alAvanzar?.(resultado);
    } catch (e) {
      // Un error de red no debe tirar la evaluación entera: se marca el caso y se sigue.
      const resultado = { caso, turnos: [], fallos: [`error ejecutando: ${e.message}`], paso: false };
      resultados.push(resultado);
      alAvanzar?.(resultado);
    }
  }

  return resumir(resultados);
}

function resumir(resultados) {
  const porCategoria = {};
  for (const r of resultados) {
    const cat = r.caso.categoria ?? 'sin categoría';
    porCategoria[cat] ??= { total: 0, pasaron: 0, fallos: [] };
    porCategoria[cat].total++;
    if (r.paso) porCategoria[cat].pasaron++;
    else porCategoria[cat].fallos.push({ id: r.caso.id, motivos: r.fallos });
  }

  const total = resultados.length;
  const pasaron = resultados.filter(r => r.paso).length;

  return {
    total,
    pasaron,
    porcentaje: total ? Math.round((pasaron / total) * 100) : 0,
    porCategoria,
    resultados,
  };
}

module.exports = { ejecutarCaso, evaluarResultado, evaluarTodos, resumir };
