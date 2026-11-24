# corcho

Corcho de notas multiusuario con backend propio: cada quien inicia sesión con Google y tiene su propio corcho privado. Un bot de Telegram (del dueño de la app) también puede clavar notas — escribile o mandale un audio y la nota aparece en su corcho.

## Arquitectura

- `server/index.js` — backend Node/Express. Expone `/api/notes` (CRUD, protegido), `/api/events` (cambios en vivo por Server-Sent Events) y `/api/push/*` (notificaciones del navegador), y arranca el bot de Telegram y el scheduler de recordatorios.
- `server/auth.js` — login con Google (Passport) restringido a una lista de emails permitidos.
- `server/bot.js` — bot de Telegram (texto, audio, fotos con OCR, comandos y botones de los recordatorios).
- `server/reminders.js` — manda los recordatorios vencidos por Telegram y/o Web Push, insiste con los pendientes y vacía la papelera.
- `server/noteHeuristics.js` — título/etiquetas automáticos y el parser de fechas en español ("mañana a las 10", "en media hora"...).
- `server/views/app.html` + `public/app.js` + `public/app.css` — el corcho (la página está protegida y redirige a `/login` si no hay sesión).
- `server/views/login.html` — pantalla de login con Google.
- `public/sw.js` — service worker: cachea íconos y muestra las notificaciones push.
- `data/corcho.db` — SQLite (vía el módulo nativo `node:sqlite` de Node 22+, sin dependencias que compilar). Cada nota tiene un `owner` (email) — las consultas siempre filtran por el usuario logueado.
- Transcripción de audio: 100% local con Whisper (`@huggingface/transformers`, corre en CPU vía ONNX), sin API keys ni costo por uso. `ffmpeg-static` convierte el audio de Telegram (OGG/Opus) a WAV antes de transcribir.

## Puesta en marcha

1. **Instalar dependencias** (ya hecho si seguiste el setup inicial):
   ```
   npm install
   ```

2. **Crear el bot de Telegram:**
   - Hablale a [@BotFather](https://t.me/BotFather) en Telegram.
   - `/newbot`, elegí un nombre y un username (tiene que terminar en `bot`).
   - Te da un token tipo `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.

3. **Conseguir tu Telegram user ID** (para que el bot solo te responda a vos):
   - Hablale a [@userinfobot](https://t.me/userinfobot), te devuelve tu ID numérico.

4. **Configurar `.env`** (ya existe una copia de `.env.example`, completala):
   ```
   TELEGRAM_BOT_TOKEN=el_token_de_botfather
   TELEGRAM_ALLOWED_USER_ID=tu_id_numerico
   ```
   Si dejás `TELEGRAM_ALLOWED_USER_ID` vacío, el bot le responde a cualquiera que le escriba — no recomendado.

5. **Levantar todo:**
   ```
   npm start
   ```
   Esto levanta la web en `http://localhost:3000` y el bot de Telegram (long polling, no necesita URL pública ni dominio).

   La primera vez que mandes un audio, se descargan los pesos de Whisper (~150MB, una sola vez, quedan cacheados).

4b. **Login con Google:**
   - En [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials): pantalla de consentimiento OAuth (tipo Externo) → crear credenciales → ID de cliente OAuth (Aplicación web).
   - En "URI de redireccionamiento autorizados" agregar `{APP_URL}/auth/google/callback` (ej. `https://corcho.sebadev.com.ar/auth/google/callback` en prod, `http://localhost:3000/auth/google/callback` en local).
   - Completar en `.env`:
     ```
     APP_URL=https://tu-dominio
     GOOGLE_CLIENT_ID=...
     GOOGLE_CLIENT_SECRET=...
     ALLOWED_EMAILS=vos@gmail.com,otra-persona@gmail.com
     OWNER_EMAIL=vos@gmail.com
     SESSION_SECRET=cualquier-string-largo-random
     ```
   - `OWNER_EMAIL` tiene que ser el mismo email de Google con el que el dueño del bot inicia sesión en la web — así las notas creadas por Telegram aparecen en su corcho. Solo importa para el dueño; el resto de la gente en `ALLOWED_EMAILS` tiene su corcho vacío y privado, sin acceso al bot (para eso necesitarían forkear el proyecto y poner su propio bot/variables).
   - Alguien que inicie sesión con un email fuera de `ALLOWED_EMAILS` ve un error y no entra.

## Uso del bot

- Mandale un **texto** → se crea una nota (la primera línea como título si es corta).
- Mandale una **nota de voz o audio** → se transcribe localmente y se crea la nota.
- Mandale una **foto** → se guarda en la nota, con el texto que tenga (OCR) y el pie de foto.
- Respondé (reply) a un mensaje del bot con texto nuevo → se edita esa nota.
- "recordame mañana a las 10 que..." → se detecta solo y se pone el recordatorio.
- `/listar` — últimas 5 notas.
- `/borrar` — borra la última nota que mandaste (con botón para deshacer).
- `/recordar <cuándo>` — pone un recordatorio a la nota respondida o a la última.
- Los recordatorios llegan con botones **✓ Hecha / +1 hora / Mañana 9hs**.

## Uso de la web

- Arrastrá el corcho para moverte; rueda + Ctrl (o pellizco con dos dedos en el celular) para hacer zoom.
- Filtrá por etiqueta o ocultá las notas hechas con los botones de arriba a la izquierda.
- Al borrar una nota aparece **Deshacer**; las borradas quedan 7 días en la papelera y después se eliminan solas.
- 🔔 activa las notificaciones de recordatorios en ese dispositivo (requiere `VAPID_*` en `.env`).
- **Backup** descarga todas las notas (con fotos) en un JSON; **Importar** lo restaura.
- Los cambios (incluidas las notas que llegan por Telegram) aparecen solos, sin recargar.

## Tests

```
npm test
```

Prueban el parser de fechas de los recordatorios (`test/noteHeuristics.test.js`).

## Notas técnicas

- `node:sqlite` es experimental en Node 22+ (por eso el flag `--experimental-sqlite` en los scripts de `package.json`); anda perfecto para este uso, solo tira un warning en consola.
- El modelo Whisper por defecto es `Xenova/whisper-base` (buen balance velocidad/calidad en CPU). Se puede cambiar con `WHISPER_MODEL` en `.env` (ej. `Xenova/whisper-small` para más precisión, `Xenova/whisper-tiny` para menos uso de RAM/más velocidad en máquinas chicas).
- El idioma de transcripción por defecto es español (`WHISPER_LANGUAGE=spanish` en `.env.example`).
- `server/index.js` fuerza IPv4 puro (`net.setDefaultAutoSelectFamily(false)` + `dns.setDefaultResultOrder('ipv4first')`) antes de cualquier otra cosa. Es un workaround necesario en entornos (WSL2, algunos VPS) que anuncian rutas IPv6 rotas — sin esto, el polling de Telegram falla con `EFATAL: AggregateError` de forma intermitente aunque la red ande bien.
- Título/etiquetas de las notas que crea el bot se derivan con heurísticas simples en `server/noteHeuristics.js` (primera oración como título, palabras clave para etiquetas) — no usa ningún LLM, así que es gratis pero limitado.
- Las sesiones de login se guardan en la misma base SQLite (tabla `sessions`, `server/sessionStore.js`), no en memoria — sobreviven a reinicios del proceso (deploys, crashes), así que un deploy no desloguea a nadie.

## Producción (Docker en nodo propio)

Corre 24/7 en un nodo propio (Umbrel) con **Docker Compose**, en `~/corcho` (un clon de este repo). El `Dockerfile` y el `docker-compose.yml` viven solo en el nodo, no en el repo. El `.env` de producción también está en el nodo.

Cómo está armado:

- **Imagen:** `node:24-bookworm-slim`. Corre `npm ci --omit=dev` al construir y arranca con `node --experimental-sqlite server/index.js`.
- **Puerto:** la app escucha en el 3000 del contenedor, publicado como **3010** en el nodo.
- **Datos:** `./data` del nodo está montado en `/app/data`, así que la base y las fotos sobreviven a los rebuilds.
- **Configuración:** sale del `.env` del nodo (`env_file: .env`).
- **Transcripción:** el compose fija `TRANSCRIBE_REMOTE_URL=http://host.docker.internal:4001`, o sea que los audios se transcriben en el `transcribe-service/` que corre en el propio nodo, fuera del contenedor.

**Redeployar un cambio:**

```
cd ~/corcho && git pull && sudo docker compose up -d --build
```

`--build` reconstruye la imagen y las dependencias se instalan ahí adentro, así que no hace falta correr `npm install` a mano en el nodo, aunque cambie `package.json`.

**Verificar que levantó bien:**

```
sudo docker compose ps
sudo docker compose logs --tail 30
```

En los logs tiene que aparecer `corcho escuchando en ...` y `Recordatorios activos (Telegram: si, push: si/no)`. `push: no` es normal si no hay claves `VAPID_*` en el `.env`.

**Cosas a tener en cuenta:**

- **Datos:** no saques el volumen `./data:/app/data` del compose. Sin él, la base y las fotos se pierden en cada rebuild.
- **Zona horaria:** los recordatorios se interpretan en `America/Argentina/Buenos_Aires` por defecto, sin importar la hora del nodo. Si el `docker-compose.yml` o el `.env` definen `TZ` (por ejemplo `TZ=UTC`), la app usa ese valor. Para cambiarla, poné `TZ=` con la zona que quieras.
- **Un solo bot a la vez:** no corras `npm start` en tu PC al mismo tiempo que el contenedor. Los dos usan el mismo `TELEGRAM_BOT_TOKEN` y Telegram solo permite un poller activo por bot (el segundo da error 409). El nodo es la única instancia que debe hacer polling.
- **Notificaciones del navegador:** necesitan que la web se sirva por HTTPS.
