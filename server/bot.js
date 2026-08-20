const TelegramBot = require("node-telegram-bot-api");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { createNote, listNotes, deleteNote } = require("./db");
const { transcribeAudioFile } = require("./transcribe");
const { deriveNote } = require("./noteHeuristics");

function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN no configurado: el bot de Telegram no se inicia.");
    return null;
  }
  const allowedId = process.env.TELEGRAM_ALLOWED_USER_ID
    ? String(process.env.TELEGRAM_ALLOWED_USER_ID)
    : null;
  if (!allowedId) {
    console.warn(
      "TELEGRAM_ALLOWED_USER_ID no configurado: cualquiera que le escriba al bot va a poder agregar notas."
    );
  }
  const owner = process.env.OWNER_EMAIL;
  if (!owner) {
    console.warn("OWNER_EMAIL no configurado: las notas del bot no van a aparecer en ningun corcho web.");
  }

  const bot = new TelegramBot(token, { polling: true });
  let lastCreatedId = null;

  function isAllowed(msg) {
    if (!allowedId) return true;
    return String(msg.from.id) === allowedId;
  }

  bot.onText(/^\/start/, (msg) => {
    if (!isAllowed(msg)) return;
    bot.sendMessage(
      msg.chat.id,
      "Hola! Mandame un texto o un audio y lo clavo en el corcho.\n\n" +
        "Comandos:\n/listar - ver las ultimas notas\n/borrar - borrar la ultima nota que agregue en esta sesion"
    );
  });

  bot.onText(/^\/listar/, (msg) => {
    if (!isAllowed(msg)) return;
    const notes = listNotes(owner).slice(0, 5);
    if (!notes.length) {
      bot.sendMessage(msg.chat.id, "El corcho esta vacio.");
      return;
    }
    const text = notes.map((n, i) => `${i + 1}. ${n.title || n.body.slice(0, 40)}`).join("\n");
    bot.sendMessage(msg.chat.id, text);
  });

  bot.onText(/^\/borrar/, (msg) => {
    if (!isAllowed(msg)) return;
    if (!lastCreatedId) {
      bot.sendMessage(msg.chat.id, "No hay nada reciente para borrar en esta sesion.");
      return;
    }
    deleteNote(lastCreatedId, owner);
    bot.sendMessage(msg.chat.id, "Borrada.");
    lastCreatedId = null;
  });

  bot.on("message", async (msg) => {
    if (!isAllowed(msg)) {
      if (msg.text || msg.voice || msg.audio) {
        bot.sendMessage(msg.chat.id, "No estas autorizado a usar este bot.");
      }
      return;
    }

    if (msg.text && !msg.text.startsWith("/")) {
      const { title, body, tags } = deriveNote(msg.text);
      const note = createNote({ title, body, tags, source: "telegram", owner });
      lastCreatedId = note.id;
      bot.sendMessage(msg.chat.id, `Clavada en el corcho ✓${tags ? `\nEtiquetas: ${tags}` : ""}`);
      return;
    }

    const voice = msg.voice || msg.audio;
    if (voice) {
      let tmpPath = null;
      try {
        await bot.sendChatAction(msg.chat.id, "typing");
        const downloadedPath = await bot.downloadFile(voice.file_id, os.tmpdir());
        tmpPath = path.join(os.tmpdir(), `corcho-${voice.file_id}.ogg`);
        fs.renameSync(downloadedPath, tmpPath);

        const text = await transcribeAudioFile(tmpPath);
        if (!text) {
          bot.sendMessage(msg.chat.id, "No pude entender el audio, proba de nuevo.");
          return;
        }
        const { title, body, tags } = deriveNote(text);
        const note = createNote({ title, body, tags, source: "telegram-audio", owner });
        lastCreatedId = note.id;
        bot.sendMessage(
          msg.chat.id,
          `Clavada en el corcho ✓${tags ? `\nEtiquetas: ${tags}` : ""}\n\n"${text}"`
        );
      } catch (err) {
        console.error("Error transcribiendo audio:", err);
        bot.sendMessage(
          msg.chat.id,
          "No pude procesar el audio (problema momentáneo del servidor). Mandalo de nuevo en un rato, o escribime el texto directamente."
        );
      } finally {
        if (tmpPath) fs.unlink(tmpPath, () => {});
      }
    }
  });

  bot.on("polling_error", (err) => console.error("Telegram polling error:", err.message));

  console.log("Bot de Telegram iniciado (polling).");
  return bot;
}

module.exports = { startBot };
