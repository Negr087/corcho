# corcho-transcribe-service

Servicio standalone de transcripción Whisper, pensado para correr en una máquina con más RAM que el VPS (ej. una mini PC en casa) y ser consumido por el VPS a través de Tailscale, en vez de cargar el modelo en el propio proceso del VPS.

## Deploy en la mini PC (Umbrel / Linux)

Todo esto lo corrés vos por SSH en tu propia máquina — no necesito acceso.

1. **Instalá Tailscale en la mini PC** (si todavía no lo hiciste): desde `http://umbrel.local` → App Store → "Tailscale" → instalar → conectar a tu cuenta.

2. **Chequeá que tengas Node.js** (v20 o más nuevo):
   ```
   node -v
   ```
   Si no está instalado (umbrelOS es Ubuntu por debajo):
   ```
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

3. **Traé este proyecto** a la mini PC (clonalo o copiá la carpeta `transcribe-service/` nada más):
   ```
   git clone https://github.com/Negr087/corcho.git
   cd corcho/transcribe-service
   npm install
   ```

4. **Configurá el `.env`:**
   ```
   cp .env.example .env
   ```
   Y completá:
   ```
   PORT=4001
   WHISPER_MODEL=Xenova/whisper-base
   WHISPER_LANGUAGE=spanish
   TRANSCRIBE_SECRET=b7a17ca0d022b59bcc42354d436a6394b7de3e6809001fa2
   ```
   (Ese secret ya lo generé — tiene que ser **exactamente el mismo** que voy a poner en el `.env` del VPS. Si preferís generar el tuyo propio, avisame el valor para que coincida.)

5. **Probalo una vez a mano** para que descargue el modelo (puede tardar uno o dos minutos la primera vez):
   ```
   npm start
   ```
   Deberías ver `Modelo Whisper "Xenova/whisper-base" listo.` y `Servicio de transcripcion de corcho escuchando en :4001`. Probá en otra terminal:
   ```
   curl http://localhost:4001/health
   ```
   Si responde `{"ok":true}`, anda. `Ctrl+C` para cortarlo.

6. **Dejalo corriendo siempre** con `systemd` (así sobrevive a reinicios y se reinicia solo si se cae):
   ```
   sudo tee /etc/systemd/system/corcho-transcribe.service > /dev/null << 'EOF'
   [Unit]
   Description=corcho transcribe service
   After=network.target

   [Service]
   Type=simple
   WorkingDirectory=REEMPLAZAR_CON_LA_RUTA_COMPLETA/corcho/transcribe-service
   ExecStart=/usr/bin/node server.js
   Restart=always
   RestartSec=5
   User=REEMPLAZAR_CON_TU_USUARIO

   [Install]
   WantedBy=multi-user.target
   EOF

   sudo systemctl daemon-reload
   sudo systemctl enable --now corcho-transcribe
   sudo systemctl status corcho-transcribe
   ```
   (Reemplazá `WorkingDirectory` con la ruta real, ej. `/home/tu-usuario/corcho/transcribe-service`, y `User` con tu usuario de Linux — `whoami` te lo dice.)

7. **Conseguí la IP de Tailscale de esta máquina:**
   ```
   tailscale ip -4
   ```
   Pasame ese valor (algo como `100.x.x.x`) — es lo único que necesito para que el VPS le hable a este servicio.

## Notas

- El puerto 4001 solo necesita ser alcanzable dentro de la red privada de Tailscale — no hace falta abrir nada en tu router ni exponer esto a internet.
- `TRANSCRIBE_SECRET` es una capa extra de seguridad (por si algo se configura mal en la red); no reemplaza a Tailscale, lo complementa.
- Si en algún momento la carga del modelo falla por una descarga incompleta (bug conocido con el backend "Xet" de HuggingFace), el servicio detecta el archivo corrupto, lo borra solo y reintenta desde cero — no hace falta intervenir a mano.
