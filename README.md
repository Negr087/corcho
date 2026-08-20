# corcho

Corcho de notas multiusuario con backend propio: cada quien inicia sesión con Google y tiene su propio corcho privado. Un bot de Telegram (del dueño de la app) también puede clavar notas — escribile o mandale un audio y la nota aparece en su corcho.

## Arquitectura

- `server/` — backend Node/Express. Expone `/api/notes` (CRUD, protegido) y corre el bot de Telegram en paralelo.
- `server/auth.js` — login con Google (Passport) restringido a una lista de emails permitidos.
- `public/index.html` — la página (protegida, redirige a `/login` si no hay sesión), consume la API.
- `public/login.html` — pantalla de login con Google.
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
- `/listar` — últimas 5 notas.
- `/borrar` — borra la última nota creada en la sesión actual del bot.

## Notas técnicas

- `node:sqlite` es experimental en Node 22+ (por eso el flag `--experimental-sqlite` en los scripts de `package.json`); anda perfecto para este uso, solo tira un warning en consola.
- El modelo Whisper por defecto es `Xenova/whisper-base` (buen balance velocidad/calidad en CPU). Se puede cambiar con `WHISPER_MODEL` en `.env` (ej. `Xenova/whisper-small` para más precisión, `Xenova/whisper-tiny` para menos uso de RAM/más velocidad en máquinas chicas).
- El idioma de transcripción por defecto es español (`WHISPER_LANGUAGE=spanish` en `.env.example`).
- `server/index.js` fuerza IPv4 puro (`net.setDefaultAutoSelectFamily(false)` + `dns.setDefaultResultOrder('ipv4first')`) antes de cualquier otra cosa. Es un workaround necesario en entornos (WSL2, algunos VPS) que anuncian rutas IPv6 rotas — sin esto, el polling de Telegram falla con `EFATAL: AggregateError` de forma intermitente aunque la red ande bien.
- Título/etiquetas de las notas que crea el bot se derivan con heurísticas simples en `server/noteHeuristics.js` (primera oración como título, palabras clave para etiquetas) — no usa ningún LLM, así que es gratis pero limitado.
- Las sesiones de login se guardan en memoria (`express-session` sin store persistente). Si el proceso se reinicia (deploy, crash), todos quedan desloheados y tienen que volver a entrar con Google — un click, sin fricción real. Si en algún momento molesta, se puede sumar un store persistente (ej. `connect-sqlite3`).

## Producción (VPS Windows)

Corriendo en un VPS Windows Server propio (`corcho.sebadev.com.ar`), 24/7, gestionado con **pm2** (ya usado ahí para otras apps) y **Caddy** como reverse proxy con HTTPS automático (Let's Encrypt).

- App: `C:\Users\Administrator\corcho` — mismo código que este repo, `.env` propio (puerto 3000, `WHISPER_MODEL=Xenova/whisper-tiny` para no comerse la RAM del VPS que es limitada).
- Proxy: `C:\Users\Administrator\caddy\caddy.exe` con `Caddyfile` apuntando `corcho.sebadev.com.ar` → `127.0.0.1:3000`.
- Ambos corren como procesos de pm2 (`pm2 list` para verlos, `pm2 logs corcho` / `pm2 logs caddy` para logs).
- DNS: registro A en Cloudflare, **DNS only** (sin proxy naranja) para que Caddy pueda validar el certificado directo.
- Reinicio ante caída del VPS: tarea programada de Windows `pm2-resurrect` (corre `pm2 resurrect` al bootear, como SYSTEM, con 30s de delay).

**Importante:** no corras `npm start` en tu PC local al mismo tiempo que el del VPS — los dos usan el mismo `TELEGRAM_BOT_TOKEN`, y Telegram solo permite un poller activo por bot (el segundo tira error 409 / conflictos de conexión). El VPS es ahora la única instancia que debe hacer polling.

Para redeployar un cambio: copiar los archivos de `server/` y `public/` al VPS (scp o git) y correr `pm2 restart corcho`.
