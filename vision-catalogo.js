'use strict';
// ⚠️  ARCHIVO COMPARTIDO — la fuente está en core/ de la raíz del proyecto.
//     Edítalo ahí y corre `npm run sync`. Si editas esta copia, el test
//     core-sincronizado la detectará y fallará.

// Identificación visual de productos del catálogo a partir de una foto o captura del
// cliente, en cascada de lo más barato a lo más costoso:
//
//   0. dHash exacto (image-hash.js, fuera de este módulo): misma foto del catálogo.
//   1. clasificarImagen: GPT-4o a baja resolución dice QUÉ tipo de mueble es (una o
//      varias categorías del catálogo), si es una captura de pantalla y qué texto se lee.
//      Si el texto visible nombra un producto del inventario, se acaba aquí.
//   2. compararConCategoria: la foto del cliente (alta resolución) junto a las
//      miniaturas de los productos de ESA categoría (baja resolución, ~85 tokens cada
//      una). El modelo devuelve las 3 más parecidas con una similitud de 0 a 100.
//      Comparar solo dentro de la categoría es lo que lo hace fiable y barato: un
//      comedor nunca se compara con sofás, y 20 miniaturas cuestan ~1.700 tokens
//      frente a los ~27.000 del catálogo entero.
//   3. construirContextoVision: traduce el resultado a una instrucción para Elena con
//      el nivel de certeza correcto ("es este" / "se parece a" / "no lo identifiqué").
//
// El cliente de OpenAI se inyecta para poder probar el módulo sin red.

const MODELO = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';

// Umbrales de similitud (0-100) que devuelve el comparador.
const SIMILITUD_ALTA  = 85; // se presenta como el producto identificado
const SIMILITUD_MEDIA = 60; // se presenta como "se parece mucho a…"

// Máximo de miniaturas por llamada; con más se hacen tandas y se mezclan resultados.
const LOTE_MINIATURAS = 20;
// Máximo de categorías a comparar cuando la foto tiene varios muebles (comedor completo).
const MAX_CATEGORIAS = 2;

// Miniatura de Cloudinary para no mandar la foto completa del catálogo: 256 px bastan
// para comparar formas y acabados. f_jpg y no f_auto: OpenAI acepta jpg/png/webp/gif y
// f_auto puede devolver avif.
function urlMiniatura(url, px = 256) {
  if (!url || !url.includes('cloudinary.com') || !url.includes('/upload/')) return url;
  return url.replace('/upload/', `/upload/w_${px},h_${px},c_fit,q_auto,f_jpg/`);
}

function dataUrl(base64, mime) {
  return `data:${mime || 'image/jpeg'};base64,${base64}`;
}

function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Paso 1: clasificar ────────────────────────────────────────────────────────

// `categorias`: [{ clave, nombre }] con las categorías del catálogo.
async function clasificarImagen(openai, imagen, categorias) {
  const claves = categorias.map(c => c.clave);
  const lista  = categorias.map(c => `- ${c.clave}: ${c.nombre}`).join('\n');

  const schema = {
    name: 'clasificacion_imagen',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        es_mueble:      { type: 'boolean', description: 'true si en la imagen hay al menos un mueble u objeto de decoración del hogar' },
        categorias:     { type: 'array', items: { type: 'string', enum: claves }, description: 'Categorías del catálogo presentes en la imagen, la principal primero. Vacío si no aplica ninguna.' },
        es_captura:     { type: 'boolean', description: 'true si es una captura de pantalla (se ve interfaz de app, barra de estado, texto de publicación)' },
        texto_visible:  { type: 'string', description: 'Texto legible en la imagen que pueda identificar el producto (nombre, modelo). Cadena vacía si no hay.' },
        descripcion:    { type: 'string', description: 'Descripción breve del mueble principal: forma, material aparente, color, nº de puestos o piezas. Máx. 30 palabras.' },
      },
      required: ['es_mueble', 'categorias', 'es_captura', 'texto_visible', 'descripcion'],
    },
  };

  const resp = await openai.chat.completions.create({
    model: MODELO,
    temperature: 0,
    max_tokens: 250,
    response_format: { type: 'json_schema', json_schema: schema },
    messages: [
      {
        role: 'system',
        content: `Clasificas fotos que envían clientes a una tienda de muebles. Devuelve SOLO el JSON pedido. Las categorías posibles son exactamente estas claves:\n${lista}\nSi la imagen muestra un comedor completo (mesa con sillas) incluye ambas categorías (bases_comedores y sillas_comedor). Si es un sofá que se convierte en cama, es sofas_camas. Si hay texto con el nombre de un producto, transcríbelo tal cual.`,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Clasifica esta imagen.' },
          { type: 'image_url', image_url: { url: dataUrl(imagen.base64, imagen.mime), detail: 'low' } },
        ],
      },
    ],
  });

  const contenido = resp.choices?.[0]?.message?.content;
  const usage = resp.usage || {};
  let datos;
  try { datos = JSON.parse(contenido); } catch { return null; }
  return {
    es_mueble:     !!datos.es_mueble,
    categorias:    (datos.categorias || []).filter(c => claves.includes(c)).slice(0, MAX_CATEGORIAS),
    es_captura:    !!datos.es_captura,
    texto_visible: String(datos.texto_visible || '').trim(),
    descripcion:   String(datos.descripcion || '').trim(),
    tokens: { entrada: usage.prompt_tokens ?? 0, salida: usage.completion_tokens ?? 0 },
  };
}

// ── Paso 2: comparar dentro de la categoría ───────────────────────────────────

// `candidatos`: [{ nombre, imagen, medidas, material }] — productos de UNA categoría con foto.
// Devuelve [{ nombre, similitud, razon }] ordenado de mayor a menor similitud.
async function compararConCategoria(openai, imagen, candidatos, { descripcion = '' } = {}) {
  const conFoto = candidatos.filter(c => c.imagen);
  if (!conFoto.length) return { coincidencias: [], tokens: { entrada: 0, salida: 0 } };

  const schema = {
    name: 'comparacion_catalogo',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        coincidencias: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              indice:    { type: 'integer', description: 'Número del producto del catálogo (el # que aparece junto a su foto)' },
              similitud: { type: 'integer', description: '0 a 100. 100 = es exactamente el mismo modelo; 85+ = mismo modelo casi seguro; 60-84 = muy parecido (misma forma y estilo); <60 = solo comparte el tipo de mueble' },
              razon:     { type: 'string', description: 'Qué coincide o difiere, en una frase corta' },
            },
            required: ['indice', 'similitud', 'razon'],
          },
        },
      },
      required: ['coincidencias'],
    },
  };

  const resultados = [];
  let tokEntrada = 0, tokSalida = 0;

  for (let i = 0; i < conFoto.length; i += LOTE_MINIATURAS) {
    const lote = conFoto.slice(i, i + LOTE_MINIATURAS);
    const contenido = [
      { type: 'text', text: `FOTO DEL CLIENTE${descripcion ? ` (${descripcion})` : ''}:` },
      { type: 'image_url', image_url: { url: dataUrl(imagen.base64, imagen.mime), detail: 'high' } },
      { type: 'text', text: `CATÁLOGO (${lote.length} productos, cada uno con su número):` },
    ];
    lote.forEach((p, idx) => {
      contenido.push({ type: 'text', text: `#${idx + 1} ${p.nombre}${p.medidas ? ` — ${p.medidas}` : ''}${p.material ? ` — ${p.material}` : ''}` });
      contenido.push({ type: 'image_url', image_url: { url: urlMiniatura(p.imagen), detail: 'low' } });
    });
    contenido.push({ type: 'text', text: 'Devuelve las 3 fotos del catálogo más parecidas al mueble de la foto del cliente, con su similitud. Compara forma, proporciones, patas/base, respaldo, material y acabado — no el fondo ni la iluminación. Si la foto del cliente es una captura de pantalla, ignora la interfaz y fíjate solo en el mueble. Si ninguna se parece de verdad, dalo con similitud baja.' });

    const resp = await openai.chat.completions.create({
      model: MODELO,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_schema', json_schema: schema },
      messages: [
        { role: 'system', content: 'Eres un comparador visual de muebles. Respondes únicamente con el JSON pedido.' },
        { role: 'user', content: contenido },
      ],
    });
    tokEntrada += resp.usage?.prompt_tokens ?? 0;
    tokSalida  += resp.usage?.completion_tokens ?? 0;

    let datos;
    try { datos = JSON.parse(resp.choices?.[0]?.message?.content); } catch { continue; }
    for (const c of datos.coincidencias || []) {
      const prod = lote[Number(c.indice) - 1];
      if (!prod) continue;
      const similitud = Math.max(0, Math.min(100, Math.round(Number(c.similitud) || 0)));
      resultados.push({ nombre: prod.nombre, similitud, razon: String(c.razon || '').trim(), producto: prod });
    }
  }

  // Un mismo producto puede salir en dos tandas: se conserva la mejor puntuación.
  const porNombre = new Map();
  for (const r of resultados) {
    if (!porNombre.has(r.nombre) || porNombre.get(r.nombre).similitud < r.similitud) porNombre.set(r.nombre, r);
  }
  const coincidencias = [...porNombre.values()].sort((a, b) => b.similitud - a.similitud).slice(0, 3);
  return { coincidencias, tokens: { entrada: tokEntrada, salida: tokSalida } };
}

// ── Orquestación ──────────────────────────────────────────────────────────────

// `inventarioPlano`: [{ nombre, imagen, medidas, material, categoria }]
// `categorias`:      [{ clave, nombre }]
// `resolverPorNombre(texto)`: función del agente que devuelve el producto si el texto
//                     leído en la imagen nombra uno del catálogo (o null).
// Devuelve null si no se pudo hacer nada (sin categoría reconocible, error de red...).
async function identificarPorVision(openai, imagen, { inventarioPlano, categorias, resolverPorNombre }) {
  const clasif = await clasificarImagen(openai, imagen, categorias);
  if (!clasif) return null;

  const base = { clasificacion: clasif, tokens: { ...clasif.tokens } };

  // El texto visible (captura de un post) nombra un producto: identificación directa.
  if (clasif.texto_visible && resolverPorNombre) {
    const prod = resolverPorNombre(clasif.texto_visible);
    if (prod) return { ...base, tipo: 'nombre', producto: prod, coincidencias: [] };
  }

  if (!clasif.es_mueble || !clasif.categorias.length) {
    return { ...base, tipo: 'sin_categoria', producto: null, coincidencias: [] };
  }

  const todas = [];
  for (const cat of clasif.categorias) {
    const candidatos = inventarioPlano.filter(p => p.categoria === cat && p.imagen);
    if (!candidatos.length) continue;
    const { coincidencias, tokens } = await compararConCategoria(openai, imagen, candidatos, { descripcion: clasif.descripcion });
    base.tokens.entrada += tokens.entrada;
    base.tokens.salida  += tokens.salida;
    for (const c of coincidencias) todas.push({ ...c, categoria: cat });
  }
  todas.sort((a, b) => b.similitud - a.similitud);

  const mejor = todas[0];
  const tipo = !mejor ? 'sin_coincidencia'
    : mejor.similitud >= SIMILITUD_ALTA  ? 'alta'
    : mejor.similitud >= SIMILITUD_MEDIA ? 'media'
    : 'baja';

  return { ...base, tipo, producto: tipo === 'alta' ? mejor.producto : null, coincidencias: todas.slice(0, 4) };
}

// Bloque de contexto para el modelo, con el nivel de certeza que corresponde. `formatear`
// es la función del agente que describe un producto con sus datos reales (nombre,
// precio, medidas, material) para que Elena no los invente.
function construirContextoVision(resultado, formatear) {
  if (!resultado) return null;
  const nombresCat = (resultado.clasificacion?.categorias || []).join(' y ');
  const desc = resultado.clasificacion?.descripcion ? ` Lo que se ve: ${resultado.clasificacion.descripcion}.` : '';

  switch (resultado.tipo) {
    case 'nombre':
      return `[IDENTIFICADO POR EL TEXTO DE LA IMAGEN: en la captura se lee "${resultado.clasificacion.texto_visible}", que es este producto del catálogo:\n${formatear(resultado.producto)}\nPreséntalo con estos datos EXACTOS, sin cambiar el nombre ni inventar medidas o material.]`;

    case 'alta':
      return `[COINCIDENCIA VISUAL ALTA (${resultado.coincidencias[0].similitud}/100, ${resultado.coincidencias[0].razon}). La foto del cliente corresponde casi con certeza a este producto del catálogo:\n${formatear(resultado.producto)}\nPreséntaselo como "es nuestra/nuestro ${resultado.producto.nombre}" con estos datos EXACTOS, y ofrécele la foto con enviar_foto. NO le preguntes qué tipo de mueble es: ya está identificado.]`;

    case 'media': {
      const lista = resultado.coincidencias
        .filter(c => c.similitud >= SIMILITUD_MEDIA)
        .map(c => `- ${c.nombre} (parecido ${c.similitud}/100: ${c.razon})`)
        .join('\n');
      return `[PARECIDOS VISUALES en la categoría ${nombresCat}.${desc} La foto NO es exactamente ninguno del catálogo, pero se parece a:\n${lista}\nDíselo con honestidad ("se parece mucho a…"), pregúntale si alguno es el que busca, y llama buscar_productos con el nombre exacto del más parecido para darle precio y datos reales (no inventes nada). Recuerda que en DeCasa fabricamos a la medida: si quiere uno igual al de su foto, ofrécele pasarlo con un asesor (personalización). NO le preguntes qué tipo de mueble es: es ${nombresCat}.]`;
    }

    case 'baja':
    case 'sin_coincidencia':
      return `[IMAGEN ANALIZADA: es ${nombresCat}.${desc} No se parece a ningún producto del catálogo. Llama reportar_imagen_no_identificada. Dile al cliente que ese modelo exacto no lo tenemos, pero que lo FABRICAMOS a la medida (pregúntale medidas/color/material y ofrécele pasarlo con un asesor con tipo 'personalizacion'), y muéstrale 2-3 opciones de ${nombresCat} con buscar_productos por si alguna le sirve. NO le preguntes qué tipo de mueble es.]`;

    case 'sin_categoria':
      return `[IMAGEN ANALIZADA:${desc || ' no se reconoce un mueble del catálogo.'} Pregúntale al cliente con amabilidad qué producto le interesa o qué tipo de mueble busca, y si mandó una captura, pídele el nombre del producto si lo alcanza a leer.]`;

    default:
      return null;
  }
}

module.exports = {
  clasificarImagen, compararConCategoria, identificarPorVision, construirContextoVision,
  urlMiniatura, normalizar,
  SIMILITUD_ALTA, SIMILITUD_MEDIA, LOTE_MINIATURAS, MAX_CATEGORIAS,
};
