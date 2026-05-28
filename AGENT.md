
# InstagramAgent — DeCasa Instagram DM Bot

Agente de Instagram para la tienda de muebles **DeCasa**. Maneja ventas, dudas de productos, agendamiento de citas y visualización de muebles en fotos del cliente vía Instagram DMs. Usa Meta Graph API (mensajería), Gemini 2.5-flash-lite (AI), MySQL compartido con Agentews, y notifica al sistema de ventas (decasa-api/redes/webhook).

---

## Estado del plan

- [x] **Fase 0** — Estructura base y configuración
- [x] **Fase 1** — Meta webhook (verificación + parseo de mensajes)
- [x] **Fase 2** — Cliente Graph API (enviar texto, imágenes, descargar media)
- [x] **Fase 3** — Flujo AI (reutilizar lógica de Agentews)
- [x] **Fase 4** — DB (fuente + instagram_psid en tablas compartidas)
- [x] **Fase 5** — Notificaciones al sistema de ventas (Redes)
- [x] **Fase 6** — Visualización de muebles en fotos
- [x] **Fase 7** — Actualizar RedesView (badge fuente, link IG)
- [ ] **Fase 8** — Deploy en Render

---

## Arquitectura general

```
POST /webhook/instagram (Meta)
  → Verificar x-hub-signature-256
  → Parsear entry[].messaging[] o entry[].changes[] (comentarios)
  → Por cada mensaje:
      → Obtener/crear cliente en clientes_wa (por instagram_psid)
      → Detectar tipo: texto | imagen | story_reply | postback
      → Si imagen → descargar INMEDIATAMENTE (expira en ~1h)
      → Subir a Cloudinary para URL permanente
      → Flujo AI (mismo que Agentews):
          → Gemini con inventario + historial
          → Herramientas: buscar_producto, enviar_foto, agendar_cita, etc.
      → Responder via Graph API (sendTextMessage / sendImageMessage)
      → Si necesita asesor → POST decasa-api/redes/webhook
```

---

## Archivos del proyecto

| Archivo | Rol |
|---|---|
| `index.js` | Servidor Express, webhook GET/POST, orquestación principal |
| `instagram.js` | Cliente Meta Graph API: send, download media, get user info |
| `ai.js` | Llamadas a Gemini, system prompt, tools (reutiliza lógica de Agentews) |
| `db.js` | CRUD MySQL: clientes_wa (por psid), conversaciones, estado, pedidos, citas |
| `image-processor.js` | Descarga media IG, sube a Cloudinary, composita mueble sobre foto |
| `knowledge.json` | Symlink o copia de Agentews/knowledge.json (catálogos, empresa) |
| `init-db.js` | Verifica/crea columnas instagram_psid, fuente en tablas compartidas |
| `AGENT.md` | Este archivo |

---

## Variables de entorno requeridas

```
# Meta / Instagram
INSTAGRAM_PAGE_ACCESS_TOKEN=   # Token de acceso de la página de Facebook
INSTAGRAM_VERIFY_TOKEN=        # Token inventado por ti para verificar el webhook
INSTAGRAM_APP_SECRET=          # Secret de la app Meta (para validar firma)
INSTAGRAM_BUSINESS_ACCOUNT_ID= # ID del Instagram Business Account

# AI
GEMINI_API_KEY=                # Compartida con Agentews

# Base de datos (misma que Agentews/decasa-api)
DB_HOST=
DB_USER=
DB_PASSWORD=
DB_NAME=
DB_PORT=

# Cloudinary (misma cuenta)
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

# Sistema de ventas
DECASA_API_URL=                # https://decasa-api-b91v.onrender.com
DECASA_AGENT_TOKEN=            # Mismo token que Agentews usa

# Servidor
PORT=3001                      # Puerto diferente a Agentews (3000) si se corren juntos
```

---

## Fase 0 — Estructura base

**Objetivo**: proyecto Node.js funcional con Express corriendo.

### Tareas
- [x] Crear carpeta `InstagramAgent/`
- [ ] `npm init -y`
- [ ] Instalar dependencias: `express`, `axios`, `mysql2`, `@google/generative-ai`, `cloudinary`, `sharp`, `dotenv`, `crypto`
- [ ] Crear `.env` con variables vacías
- [ ] Crear `index.js` con servidor Express básico + health check `GET /`
- [ ] Verificar que corre con `node index.js`

---

## Fase 1 — Meta Webhook

**Objetivo**: Meta puede verificar y enviar mensajes al endpoint.

### GET /webhook/instagram — Verificación
Meta llama con query params:
```
hub.mode=subscribe
hub.verify_token=TU_TOKEN
hub.challenge=12345
```
Responder con `hub.challenge` si `hub.verify_token` coincide.

### POST /webhook/instagram — Mensajes entrantes
Meta envía un body así para DMs:
```json
{
  "entry": [{
    "messaging": [{
      "sender": { "id": "PSID_DEL_USUARIO" },
      "recipient": { "id": "ID_DE_TU_PAGINA" },
      "timestamp": 1234567890,
      "message": {
        "mid": "msg_id",
        "text": "Hola quiero ver sillas",
        "attachments": [{
          "type": "image",
          "payload": { "url": "https://..." }
        }]
      }
    }]
  }]
}
```

Y así para story replies:
```json
{
  "message": {
    "text": "Cuánto cuesta?",
    "reply_to": {
      "story": {
        "url": "https://...",
        "id": "story_id"
      }
    }
  }
}
```

### Validación de firma
```javascript
const crypto = require('crypto')
function verificarFirma(req) {
  const sig  = req.headers['x-hub-signature-256']?.replace('sha256=', '')
  const expected = crypto
    .createHmac('sha256', process.env.INSTAGRAM_APP_SECRET)
    .update(req.rawBody)           // necesita rawBody, no body parseado
    .digest('hex')
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}
```

**IMPORTANTE**: Para obtener `rawBody`, guardar el buffer crudo ANTES de `express.json()`:
```javascript
app.use((req, res, next) => {
  let data = ''
  req.on('data', chunk => data += chunk)
  req.on('end', () => { req.rawBody = data; next() })
})
```

### Tareas
- [ ] Implementar GET /webhook/instagram
- [ ] Implementar POST /webhook/instagram con parseo de entry[].messaging[]
- [ ] Validar firma x-hub-signature-256
- [ ] Detectar y separar: texto, imagen, story_reply, echo (ignorar mensajes propios)

---

## Fase 2 — Cliente Graph API (instagram.js)

**Objetivo**: enviar y recibir mensajes/imágenes via Meta Graph API.

### Endpoints usados

```
POST https://graph.facebook.com/v19.0/me/messages
  Authorization: Bearer PAGE_ACCESS_TOKEN
  Body: { recipient: { id: psid }, message: { text } }

GET https://graph.facebook.com/v19.0/{PSID}?fields=name,username
  → nombre e username del usuario

GET {media_url}
  Authorization: Bearer PAGE_ACCESS_TOKEN
  → descargar imagen (expira, hacer INMEDIATAMENTE)
```

### Funciones a implementar

```javascript
// instagram.js
async function sendTextMessage(psid, texto)
async function sendImageMessage(psid, imageUrl)    // URL pública (Cloudinary)
async function sendTypingOn(psid)                  // indicador "escribiendo..."
async function getUserInfo(psid)                   // { name, username }
async function downloadMediaToBuffer(mediaUrl)     // descarga antes de que expire
```

### Límites importantes
- Máximo 1000 caracteres por mensaje (dividir si necesario)
- Solo se puede responder dentro de la ventana de 24h desde el último mensaje del usuario
- Fuera de ventana: solo se puede enviar "message tags" (pedido confirmado, etc.)

### Tareas
- [ ] Implementar `sendTextMessage`
- [ ] Implementar `sendImageMessage`
- [ ] Implementar `sendTypingOn`
- [ ] Implementar `getUserInfo`
- [ ] Implementar `downloadMediaToBuffer`
- [ ] Manejar errores Graph API (190 = token expirado, 10 = sin permisos, 613 = rate limit)

---

## Fase 3 — Flujo AI (ai.js)

**Objetivo**: Gemini responde con el mismo contexto que Agentews, adaptado a Instagram.

### System prompt adaptado
Igual al de Agentews con estas diferencias:
- "Eres Elena, asistente de DeCasa en Instagram"
- Sin mención de WhatsApp para links o números de contacto
- Mencionar que pueden ver más en `@decasa_colombia` (o el handle real)

### Herramientas (tools) — mismas que Agentews
```
buscar_producto(nombre)
enviar_foto(nombre_producto)
ver_carrito()
agregar_al_carrito(producto, cantidad)
confirmar_pedido()
agendar_cita(datos)
solicitar_asesor(motivo)
comparar_productos(nombres[])
```

### Diferencias vs Agentews
- No hay número de teléfono → no generar links wa.me
- El usuario se identifica por `instagram_psid` y `username`
- Las imágenes ya vienen descargadas como buffer (no como URL de Twilio)

### Tareas
- [ ] Copiar y adaptar system prompt de Agentews
- [ ] Adaptar `ejecutarHerramienta()` para enviar via Graph API en lugar de Twilio
- [ ] Adaptar `callGemini()` con las tools correctas
- [ ] Manejar respuestas largas (dividir en chunks de <1000 chars)

---

## Fase 4 — Base de datos (db.js)

**Objetivo**: reutilizar las tablas compartidas con Agentews adaptando para Instagram.

### Cambios en schema (init-db.js)

```sql
-- Agregar a clientes_wa
ALTER TABLE clientes_wa ADD COLUMN instagram_psid VARCHAR(50) UNIQUE NULL;
ALTER TABLE clientes_wa ADD COLUMN instagram_username VARCHAR(100) NULL;

-- Agregar a conversaciones_wa (en decasa-api via migración Laravel)
ALTER TABLE conversaciones_wa ADD COLUMN fuente ENUM('whatsapp','instagram') DEFAULT 'whatsapp';
ALTER TABLE conversaciones_wa ADD COLUMN contacto_url VARCHAR(500) NULL; -- reemplaza whatsapp_url
```

### Funciones de db.js

```javascript
// Buscar/crear cliente por PSID (no por teléfono)
async function getOrCreateClienteByPsid(psid, username, nombre)

// Estado por psid (mismo formato que Agentews usa por teléfono)
async function getEstado(psid)
async function setEstado(psid, campos)
async function getUltimoProducto(psid)
async function setUltimoProducto(psid, data)

// Conversaciones (historial para contexto AI)
async function getHistorial(psid, limite)
async function guardarMensaje(psid, role, content)
```

### Tareas
- [ ] Implementar `init-db.js` con ALTER TABLE seguros (IF NOT EXISTS)
- [ ] Implementar todas las funciones de `db.js`
- [ ] Verificar que las tablas compartidas no rompen Agentews

---

## Fase 5 — Notificaciones al sistema de ventas

**Objetivo**: cuando el bot necesita un asesor, aparece en el módulo Redes del sistema de ventas con badge "IG".

### Payload al webhook de decasa-api
```javascript
{
  tipo: 'asesor' | 'pedido' | 'cita' | 'personalizacion',
  telefono: psid,                    // se usa como identificador
  nombre_cliente: username || nombre,
  resumen: '...',
  historial: [...],
  whatsapp_url: null,               // no aplica para Instagram
  fuente: 'instagram',              // NUEVO campo
  contacto_url: `https://ig.me/m/${username}` // link directo si hay username
}
```

### En decasa-api (migración Laravel)
Agregar columna `fuente` a `conversaciones_wa`:
```php
$table->enum('fuente', ['whatsapp', 'instagram'])->default('whatsapp');
```

### Tareas
- [ ] Implementar `enviarNotificacionSistema(psid, username, mensaje, historial, tipo)`
- [ ] Crear migración Laravel para columna `fuente` en `conversaciones_wa`
- [ ] Actualizar `RedesController` para aceptar el campo `fuente`

---

## Fase 6 — Visualización de muebles (image-processor.js)

**Objetivo**: cliente manda foto de su cuarto por Instagram DM, el bot responde con el mueble superpuesto.

### Flujo
```
1. Llega attachment de imagen → downloadMediaToBuffer(url) INMEDIATAMENTE
2. Subir buffer a Cloudinary → obtener URL permanente
3. Detectar si es foto de cuarto (misma regex que Agentews)
4. Buscar último producto visto en estado del usuario
5. Si hay producto con imagen Cloudinary:
   - urlProductoSinFondo(productoUrl) → Cloudinary e_make_transparent
   - Componer con sharp: mueble sobre fondo del cuarto
   - Subir resultado a Cloudinary
   - sendImageMessage(psid, resultUrl)
6. Si no hay producto: pedir que primero pregunte por un mueble
```

### Diferencia vs Agentews
- En Agentews la imagen del cuarto viene de Twilio (URL con auth)
- En Instagram viene de Meta (URL que expira) → descargar PRIMERO
- El resto del pipeline (Cloudinary + sharp) es idéntico

### Tareas
- [ ] `downloadMediaToBuffer(metaUrl)` con auth header Bearer
- [ ] `uploadBufferToCloudinary(buffer)` → URL permanente
- [ ] Reutilizar `composeImage(roomUrl, productUrl)` de Agentews (o copiar)
- [ ] Integrar en el flujo principal al detectar imagen entrante

---

## Fase 7 — Actualizar RedesView en decasa-app

**Objetivo**: las conversaciones de Instagram se ven diferente a las de WhatsApp.

### Cambios en RedesView.vue
- Badge de fuente junto al badge de tipo:
  - Verde "WA" con icono WhatsApp
  - Morado "IG" con icono Instagram (usar `@heroicons` o SVG inline)
- Botón de contacto:
  - Si `fuente = 'whatsapp'` → "Abrir WA" (actual)
  - Si `fuente = 'instagram'` → "Abrir IG" (link a `contacto_url`)
- Nombre mostrado: `username` de Instagram en vez de teléfono

### Cambios en RedesController (Laravel)
- Aceptar `fuente` en el webhook
- Incluir `fuente` en el JSON que retorna `index()`

### Mensaje de bienvenida al abrir IG
```javascript
function igUrl(conv) {
  if (conv.contacto_url) return conv.contacto_url
  return 'https://www.instagram.com/direct/inbox/'
}
```

### Tareas
- [ ] Migración Laravel: agregar `fuente` y `contacto_url` a `conversaciones_wa`
- [ ] Actualizar `RedesController::webhook()` para guardar `fuente`
- [ ] Actualizar `RedesController::index()` para devolver `fuente` y `contacto_url`
- [ ] Actualizar `RedesView.vue`: badge fuente, botón dinámico

---

## Fase 8 — Deploy en Render

**Objetivo**: el agente corre 24/7 en Render escuchando mensajes de Instagram.

### Configuración en Render
- Nuevo servicio Web: `instagram-agent`
- Build command: `npm install`
- Start command: `node index.js`
- Variables de entorno: todas las de la sección de variables arriba

### Configurar webhook en Meta Dashboard
- URL: `https://instagram-agent.onrender.com/webhook/instagram`
- Eventos a suscribir: `messages`, `messaging_postbacks`, `messaging_optins`

### Tareas
- [ ] Crear `package.json` con scripts de start
- [ ] Crear `Procfile` o `render.yaml` si necesario
- [ ] Configurar variables en Render dashboard
- [ ] Registrar webhook URL en Meta Developer Dashboard
- [ ] Prueba end-to-end: DM desde cuenta personal → respuesta del bot

---

## Decisiones confirmadas

1. **Username de Instagram**: `muebles_decasa`
2. **Facebook Page / Business Account**: pendiente de crear (ver guía abajo)
3. **Scope**: solo DMs — no comentarios en publicaciones
4. **Nombre del asistente**: Elena (igual que WhatsApp)

### Guía: crear Instagram Business Account y conectar a Facebook Page

Pasos que el usuario hace manualmente (una sola vez):

1. Ir a Instagram → Configuración → Cuenta → **Cambiar a cuenta profesional** → Empresa
2. Ir a [facebook.com/pages/create](https://facebook.com/pages/create) → crear página "DeCasa Muebles"
3. En Instagram → Configuración → **Cuenta de creador / Empresa** → Conectar a Facebook Page → seleccionar la que creaste
4. Ir a [developers.facebook.com](https://developers.facebook.com) → Mis Apps → **Crear App** → Tipo: Empresa
5. Agregar producto: **Instagram Graph API**
6. En "Configuración de Instagram" → conectar tu Instagram Business Account
7. Generar **Page Access Token** (permanente con `pages_messaging` + `instagram_manage_messages`)
8. Copiar: `App ID`, `App Secret`, `Page Access Token`, `Instagram Business Account ID`

---

## Notas técnicas

### Por qué las media URLs de Instagram expiran
Meta genera URLs firmadas temporalmente por seguridad. Si no se descargan en ~1 hora, retornan 403. La solución es descargar y subir a Cloudinary en el mismo manejador del webhook, antes de responder al usuario.

### Ventana de mensajes de 24h
Meta solo permite responder libremente dentro de las 24h posteriores al último mensaje del usuario. Pasado ese tiempo, solo se pueden enviar mensajes con "message tags" específicos (confirmación de pedido, actualización de cita). El bot debe detectar cuándo está fuera de ventana.

### Eco de mensajes propios
Cuando el bot envía un mensaje, Meta también lo reenvía al webhook con `message.is_echo = true`. HAY QUE IGNORAR ESTOS para no entrar en bucle infinito.

### Rate limits Graph API
- 200 llamadas por hora por PSID
- 4800 llamadas por hora por página
- Si se supera → esperar y reintentar con backoff exponencial
