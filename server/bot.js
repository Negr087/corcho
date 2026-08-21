const TelegramBot = require("node-telegram-bot-api");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const {
  IMAGES_DIR,
  createNote,
  listNotes,
  deleteNote,
  updateNoteBody,
  setTelegramMessageRef,
  findNoteByTelegramMessage,
} = require("./db");
const { transcribeAudioFile } = require("./transcribe");
const { deriveNote } = require("./noteHeuristics");

async function ocrImage(imagePath) {
  const { createWorker } = require("tesseract.js");
  const worker = await createWorker("spa+eng");
  try {
    const { data } = await worker.recognize(imagePath);
    return (data.text || "").trim();
  } finally {
    await worker.terminate();
  }
}

function buildWeeklySummary(owner) {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const notes = listNotes(owner);
  const thisWeek = notes.filter((n) => n.created >= weekAgo);
  const pending = notes.filter((n) => !n.done);

  let msg = `📋 Resumen semanal de tu corcho\n\n`;
  msg += `Esta semana clavaste ${thisWeek.length} nota${thisWeek.length === 1 ? "" : "s"}.\n`;
  if (pending.length) {
    msg += `\nPendientes (${pending.length}):\n`;
    msg += pending
      .slice(0, 12)
      .map((n) => `• ${n.title || n.body.slice(0, 50)}`)
      .join("\n");
    if (pending.length > 12) msg += `\n… y ${pending.length - 12} más`;
  } else {
    msg += `\nNo tenés nada pendiente 🎉`;
  }
  return msg;
}

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
      "Hola! Mandame un texto, un audio o una foto y lo clavo en el corcho.\n\n" +
        "Respondele a un mensaje mío (reply) con texto corregido para editar esa nota.\n\n" +
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
      if (msg.text || msg.voice || msg.audio || msg.photo) {
        bot.sendMessage(msg.chat.id, "No estas autorizado a usar este bot.");
      }
      return;
    }

    if (msg.text && !msg.text.startsWith("/")) {
      if (msg.reply_to_message) {
        const target = findNoteByTelegramMessage(owner, msg.chat.id, msg.reply_to_message.message_id);
        if (target) {
          const { title, body, tags } = deriveNote(msg.text);
          updateNoteBody(target.id, owner, { title, body, tags });
          bot.sendMessage(msg.chat.id, "Nota actualizada ✓");
          return;
        }
      }
      const { title, body, tags } = deriveNote(msg.text);
      const note = createNote({ title, body, tags, source: "telegram", owner });
      lastCreatedId = note.id;
      const sent = await bot.sendMessage(msg.chat.id, `Clavada en el corcho ✓${tags ? `\nEtiquetas: ${tags}` : ""}`);
      setTelegramMessageRef(note.id, msg.chat.id, sent.message_id);
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
        const sent = await bot.sendMessage(
          msg.chat.id,
          `Clavada en el corcho ✓${tags ? `\nEtiquetas: ${tags}` : ""}\n\n"${text}"`
        );
        setTelegramMessageRef(note.id, msg.chat.id, sent.message_id);
      } catch (err) {
        console.error("Error transcribiendo audio:", err);
        bot.sendMessage(
          msg.chat.id,
          "No pude procesar el audio (problema momentáneo del servidor). Mandalo de nuevo en un rato, o escribime el texto directamente."
        );
      } finally {
        if (tmpPath) fs.unlink(tmpPath, () => {});
      }
      return;
    }

    if (msg.photo && msg.photo.length) {
      let downloadedPath = null;
      try {
        await bot.sendChatAction(msg.chat.id, "upload_photo");
        const largest = msg.photo[msg.photo.length - 1];
        downloadedPath = await bot.downloadFile(largest.file_id, os.tmpdir());
        const ext = path.extname(downloadedPath) || ".jpg";
        const imageFilename = crypto.randomUUID() + ext;
        fs.copyFileSync(downloadedPath, path.join(IMAGES_DIR, imageFilename));

        let ocrText = "";
        try {
          ocrText = await ocrImage(path.join(IMAGES_DIR, imageFilename));
        } catch (ocrErr) {
          console.error("Error en OCR:", ocrErr);
        }

        const caption = (msg.caption || "").trim();
        const combined = [caption, ocrText].filter(Boolean).join("\n\n");
        const derived = combined ? deriveNote(combined) : { title: "", body: "", tags: "" };
        const note = createNote({
          title: derived.title || "Foto",
          body: derived.body,
          tags: derived.tags,
          source: "telegram-photo",
          owner,
          imagePath: imageFilename,
        });
        lastCreatedId = note.id;
        const sent = await bot.sendMessage(
          msg.chat.id,
          `Clavada en el corcho ✓${ocrText ? `\n\nTexto detectado:\n"${ocrText}"` : ""}`
        );
        setTelegramMessageRef(note.id, msg.chat.id, sent.message_id);
      } catch (err) {
        console.error("Error procesando foto:", err);
        bot.sendMessage(msg.chat.id, "No pude procesar la foto.");
      } finally {
        if (downloadedPath) fs.unlink(downloadedPath, () => {});
      }
    }
  });

  bot.on("polling_error", (err) => console.error("Telegram polling error:", err.message));

  // --- resumen semanal ---
  if (owner && allowedId) {
    const targetDay = process.env.WEEKLY_SUMMARY_DAY !== undefined ? Number(process.env.WEEKLY_SUMMARY_DAY) : 0; // 0 = domingo
    const targetHour = process.env.WEEKLY_SUMMARY_HOUR !== undefined ? Number(process.env.WEEKLY_SUMMARY_HOUR) : 20;
    let lastSentWeekKey = null;
    function weekKey(d) {
      const onejan = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
      return `${d.getFullYear()}-${week}`;
    }
    setInterval(() => {
      const now = new Date();
      const key = weekKey(now);
      if (now.getDay() === targetDay && now.getHours() === targetHour && lastSentWeekKey !== key) {
        lastSentWeekKey = key;
        bot.sendMessage(allowedId, buildWeeklySummary(owner)).catch((err) =>
          console.error("Error mandando resumen semanal:", err.message)
        );
      }
    }, 60 * 60 * 1000);
  }

  console.log("Bot de Telegram iniciado (polling).");
  return bot;
}

module.exports = { startBot };
