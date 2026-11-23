const TelegramBot = require("node-telegram-bot-api");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const {
  IMAGES_DIR,
  createNote,
  getNote,
  listNotes,
  deleteNote,
  restoreNote,
  updateNoteDone,
  updateNoteBody,
  setTelegramMessageRef,
  findNoteByTelegramMessage,
  setReminder,
  getMeta,
  setMeta,
  deleteMeta,
} = require("./db");
const { transcribeAudioFile } = require("./transcribe");
const { deriveNote, parseReminderTime, detectReminderIntent } = require("./noteHeuristics");
const { snoozeTarget, noteLabel } = require("./reminders");

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

// Si el texto pide claramente un recordatorio ("recordame...", "avisame...")
// y se le puede sacar una fecha/hora futura, se lo pone a la nota recien
// creada y devuelve una lineita para sumar a la confirmacion del bot.
function applyAutoReminder(noteId, owner, text) {
  const date = detectReminderIntent(text);
  if (!date || date.getTime() <= Date.now()) return "";
  setReminder(noteId, owner, date.getTime());
  return `\n⏰ Te aviso el ${date.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}`;
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

// Mapea id numerico de Telegram -> email (dueño del corcho al que van sus
// notas). Junta el usuario "clasico" (TELEGRAM_ALLOWED_USER_ID + OWNER_EMAIL)
// con la lista opcional TELEGRAM_OWNERS="id1:email1,id2:email2" para poder
// sumar mas gente sin tocar la config existente.
function buildOwnersMap() {
  const map = new Map();
  if (process.env.TELEGRAM_ALLOWED_USER_ID && process.env.OWNER_EMAIL) {
    map.set(String(process.env.TELEGRAM_ALLOWED_USER_ID), process.env.OWNER_EMAIL);
  }
  if (process.env.TELEGRAM_OWNERS) {
    for (const pair of process.env.TELEGRAM_OWNERS.split(",")) {
      const [id, email] = pair.split(":").map((s) => (s || "").trim());
      if (id && email) map.set(id, email);
    }
  }
  return map;
}

function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN no configurado: el bot de Telegram no se inicia.");
    return null;
  }

  const owners = buildOwnersMap();
  if (!owners.size) {
    console.warn(
      "No hay usuarios configurados (TELEGRAM_ALLOWED_USER_ID+OWNER_EMAIL o TELEGRAM_OWNERS): nadie va a poder usar el bot."
    );
  }

  const bot = new TelegramBot(token, { polling: true });

  // Ultima nota que creo cada usuario por el bot (para /borrar y /recordar).
  // Va a la base y no a memoria para que no se pierda si se reinicia el server.
  const lastCreatedByUser = {
    get: (userId) => getMeta(`last_note:${userId}`),
    set: (userId, noteId) => setMeta(`last_note:${userId}`, noteId),
    delete: (userId) => deleteMeta(`last_note:${userId}`),
  };

  bot
    .setMyCommands([
      { command: "listar", description: "Ver las últimas notas" },
      { command: "borrar", description: "Borrar la última nota que agregué" },
      { command: "recordar", description: "Poner un recordatorio, ej: mañana a las 10" },
    ])
    .catch((err) => console.error("No se pudieron registrar los comandos en Telegram:", err.message));

  function isAllowed(msg) {
    return owners.has(String(msg.from.id));
  }
  function ownerFor(msg) {
    return owners.get(String(msg.from.id));
  }

  bot.onText(/^\/start/, (msg) => {
    if (!isAllowed(msg)) return;
    bot.sendMessage(
      msg.chat.id,
      "Hola! Mandame un texto, un audio o una foto y lo clavo en el corcho.\n\n" +
        "Respondele a un mensaje mío (reply) con texto corregido para editar esa nota.\n\n" +
        "Si decís o escribís algo como 'recordame mañana a las 10 que...' lo detecto solo y te pongo el recordatorio. También podés pedirlo aparte:\n\n" +
        "Comandos:\n" +
        "/listar - ver las ultimas notas\n" +
        "/borrar - borrar la ultima nota que mandaste (se puede deshacer)\n" +
        "/recordar <cuando> - poner un recordatorio (respondiendo a una nota, o si no a la ultima). Ej: /recordar mañana a las 10, /recordar en 2 horas, /recordar el lunes a las 9 de la mañana"
    );
  });

  bot.onText(/^\/listar/, (msg) => {
    if (!isAllowed(msg)) return;
    const notes = listNotes(ownerFor(msg)).slice(0, 5);
    if (!notes.length) {
      bot.sendMessage(msg.chat.id, "El corcho esta vacio.");
      return;
    }
    const text = notes.map((n, i) => `${i + 1}. ${n.title || n.body.slice(0, 40)}`).join("\n");
    bot.sendMessage(msg.chat.id, text);
  });

  bot.onText(/^\/borrar/, (msg) => {
    if (!isAllowed(msg)) return;
    const userId = String(msg.from.id);
    const lastId = lastCreatedByUser.get(userId);
    if (!lastId) {
      bot.sendMessage(msg.chat.id, "No hay nada reciente para borrar.");
      return;
    }
    const deleted = deleteNote(lastId, ownerFor(msg));
    lastCreatedByUser.delete(userId);
    if (!deleted) {
      bot.sendMessage(msg.chat.id, "Esa nota ya no estaba en el corcho.");
      return;
    }
    // queda en la papelera unos dias: se puede deshacer con el boton
    bot.sendMessage(msg.chat.id, "Borrada.", {
      reply_markup: { inline_keyboard: [[{ text: "↩️ Deshacer", callback_data: `undo:${lastId}` }]] },
    });
  });

  bot.onText(/^\/recordar(@\w+)?\s*$/i, (msg) => {
    if (!isAllowed(msg)) return;
    bot.sendMessage(
      msg.chat.id,
      "Decime cuándo, por ejemplo: /recordar mañana a las 10, /recordar en 2 horas o /recordar el lunes a las 9 de la mañana.\n\n" +
        "Respondé (reply) a una nota para ponerle el recordatorio a esa; si no, va a la última que mandaste."
    );
  });

  bot.onText(/^\/recordar(?:@\w+)?\s+(.+)/i, (msg, match) => {
    if (!isAllowed(msg)) return;
    const owner = ownerFor(msg);
    const userId = String(msg.from.id);
    const date = parseReminderTime(match[1]);
    if (!date) {
      bot.sendMessage(
        msg.chat.id,
        "No entendí la fecha. Probá algo como: 'mañana a las 10', 'el lunes a las 9 de la mañana', 'en 2 horas', 'pasado mañana a las 15' o '25/08 14:00'."
      );
      return;
    }
    if (date.getTime() <= Date.now()) {
      bot.sendMessage(msg.chat.id, "Esa fecha/hora ya pasó.");
      return;
    }
    let targetId = null;
    if (msg.reply_to_message) {
      const target = findNoteByTelegramMessage(owner, msg.chat.id, msg.reply_to_message.message_id);
      if (target) targetId = target.id;
    }
    if (!targetId) targetId = lastCreatedByUser.get(userId);
    if (!targetId) {
      bot.sendMessage(
        msg.chat.id,
        "No hay una nota reciente. Respondé (reply) al mensaje de la nota que querés recordar, o mandá una nota primero."
      );
      return;
    }
    if (!setReminder(targetId, owner, date.getTime())) {
      bot.sendMessage(msg.chat.id, "Esa nota ya no está en el corcho. Respondé (reply) a otra nota o mandá una nueva.");
      return;
    }
    bot.sendMessage(
      msg.chat.id,
      `Listo, te aviso el ${date.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })} ⏰`
    );
  });

  bot.on("message", async (msg) => {
    if (!isAllowed(msg)) {
      if (msg.text || msg.voice || msg.audio || msg.photo) {
        bot.sendMessage(msg.chat.id, "No estas autorizado a usar este bot.");
      }
      return;
    }
    const owner = ownerFor(msg);
    const userId = String(msg.from.id);

    if (msg.text && !msg.text.startsWith("/")) {
      if (msg.reply_to_message) {
        const target = findNoteByTelegramMessage(owner, msg.chat.id, msg.reply_to_message.message_id);
        if (target) {
          const { title, body, tags } = deriveNote(msg.text);
          updateNoteBody(target.id, owner, { title, body, tags });
          const reminderNote = applyAutoReminder(target.id, owner, msg.text);
          bot.sendMessage(msg.chat.id, `Nota actualizada ✓${reminderNote}`);
          return;
        }
      }
      const { title, body, tags } = deriveNote(msg.text);
      const note = createNote({ title, body, tags, source: "telegram", owner });
      lastCreatedByUser.set(userId, note.id);
      const reminderNote = applyAutoReminder(note.id, owner, msg.text);
      const sent = await bot.sendMessage(
        msg.chat.id,
        `Clavada en el corcho ✓${tags ? `\nEtiquetas: ${tags}` : ""}${reminderNote}`
      );
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
        lastCreatedByUser.set(userId, note.id);
        const reminderNote = applyAutoReminder(note.id, owner, text);
        const sent = await bot.sendMessage(
          msg.chat.id,
          `Clavada en el corcho ✓${tags ? `\nEtiquetas: ${tags}` : ""}${reminderNote}\n\n"${text}"`
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
        lastCreatedByUser.set(userId, note.id);
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

  // --- botones de los mensajes (recordatorios y /borrar) ---
  // callback_data = "<accion>:<id de nota>"
  bot.on("callback_query", async (query) => {
    const owner = owners.get(String(query.from.id));
    const [action, noteId] = String(query.data || "").split(":");
    const answer = (text) => bot.answerCallbackQuery(query.id, { text }).catch(() => {});
    if (!owner || !noteId) return answer("No autorizado");

    // deja el mensaje con un renglon de estado y sin botones
    const finish = (status) => {
      if (!query.message) return;
      bot
        .editMessageText(`${query.message.text}\n\n${status}`, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        })
        .catch(() => {});
    };

    if (action === "undo") {
      if (!restoreNote(noteId, owner)) return answer("Ya no se puede deshacer");
      finish("↩️ Restaurada");
      return answer("Nota restaurada");
    }

    const note = getNote(noteId, owner);
    if (!note) {
      finish("(esta nota ya no está en el corcho)");
      return answer("Esa nota ya no existe");
    }
    if (action === "done") {
      updateNoteDone(noteId, owner, true);
      finish("✅ Marcada como hecha");
      return answer("Hecha ✓");
    }
    const target = snoozeTarget(action === "snooze1h" ? "1h" : action === "tomorrow" ? "tomorrow" : null);
    if (target) {
      setReminder(noteId, owner, target);
      const when = new Date(target).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
      finish(`⏰ Pospuesto para el ${when}`);
      return answer("Pospuesto");
    }
    return answer();
  });

  const reminderButtons = (noteId) => ({
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✓ Hecha", callback_data: `done:${noteId}` },
          { text: "+1 hora", callback_data: `snooze1h:${noteId}` },
          { text: "Mañana 9hs", callback_data: `tomorrow:${noteId}` },
        ],
      ],
    },
  });

  // Canal de Telegram para el scheduler de recordatorios (server/reminders.js)
  const emailToTelegramId = new Map();
  for (const [id, email] of owners) emailToTelegramId.set(email, id);
  const reminderChannel = {
    chatIdFor: (email) => emailToTelegramId.get(email),
    sendReminder: (chatId, note, kind) =>
      bot.sendMessage(
        chatId,
        kind === "nag"
          ? `⏰ Sigue pendiente: ${noteLabel(note)}\n\nMarcala como hecha o posponela si todavía no podés.`
          : `⏰ Recordatorio: ${noteLabel(note)}`,
        reminderButtons(note.id)
      ),
  };

  // --- resumen semanal, uno por cada usuario configurado ---
  if (owners.size) {
    const targetDay = process.env.WEEKLY_SUMMARY_DAY !== undefined ? Number(process.env.WEEKLY_SUMMARY_DAY) : 0; // 0 = domingo
    const targetHour = process.env.WEEKLY_SUMMARY_HOUR !== undefined ? Number(process.env.WEEKLY_SUMMARY_HOUR) : 20;
    function weekKey(d) {
      const onejan = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
      return `${d.getFullYear()}-${week}`;
    }
    // La ultima semana enviada se guarda por usuario en la base: si el server
    // se reinicia dentro de la hora del resumen, no lo vuelve a mandar.
    function checkWeeklySummary() {
      const now = new Date();
      if (now.getDay() !== targetDay || now.getHours() !== targetHour) return;
      const key = weekKey(now);
      for (const [telegramId, ownerEmail] of owners) {
        const metaKey = `weekly_summary:${telegramId}`;
        if (getMeta(metaKey) === key) continue;
        setMeta(metaKey, key);
        bot
          .sendMessage(telegramId, buildWeeklySummary(ownerEmail))
          .catch((err) => console.error("Error mandando resumen semanal:", err.message));
      }
    }
    setInterval(checkWeeklySummary, 5 * 60 * 1000);
    checkWeeklySummary();
  }

  console.log(`Bot de Telegram iniciado (polling). Usuarios configurados: ${owners.size}.`);
  return { bot, reminderChannel };
}

module.exports = { startBot };
