const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const {
  IMAGES_DIR,
  getDueReminders,
  markReminded,
  getOverdueNags,
  touchNagged,
  listPushSubscriptions,
  removePushSubscription,
  purgeDeletedNotes,
} = require("./db");

const TRASH_DAYS = 7;

// --- Web Push (notificaciones del navegador) ---
// Solo se activa si estan las claves VAPID en el .env (se generan una vez
// con `npx web-push generate-vapid-keys`).
const pushEnabled = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || process.env.APP_URL || "mailto:admin@localhost",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

function noteLabel(note) {
  return note.title || (note.body || "").slice(0, 80) || "Nota";
}

// Resultado de cada canal: "ok" (entregado), "dead" (no tiene sentido
// reintentar: el usuario bloqueo al bot, la suscripcion vencio...) o
// "retry" (falla momentanea, probar en el proximo chequeo).
async function sendPush(owner, note, kind) {
  if (!pushEnabled) return [];
  const payload = JSON.stringify({
    title: kind === "nag" ? "⏰ Sigue pendiente" : "⏰ Recordatorio",
    body: noteLabel(note),
    noteId: note.id,
  });
  return Promise.all(
    listPushSubscriptions(owner).map((sub) =>
      webpush.sendNotification(sub, payload, { TTL: 60 * 60 }).then(
        () => "ok",
        (err) => {
          if (err.statusCode === 404 || err.statusCode === 410) {
            removePushSubscription(sub.endpoint);
            return "dead";
          }
          console.error("Error mandando push:", err.statusCode || "", err.message);
          return "retry";
        }
      )
    )
  );
}

function isPermanentTelegramError(err) {
  const code = err && err.response && err.response.statusCode;
  return code === 400 || code === 403;
}

function startReminders({ telegram } = {}) {
  // telegram (opcional): { chatIdFor(email), sendReminder(chatId, note, kind) }
  const nagIntervalMs = (Number(process.env.REMINDER_NAG_HOURS) || 24) * 60 * 60 * 1000;
  // Envios en curso: si un canal tarda mas que el intervalo de chequeo, no
  // hay que mandar el mismo aviso dos veces.
  const inFlight = new Set();

  async function deliver(note, kind) {
    const attempts = [];
    const chatId = telegram && telegram.chatIdFor(note.owner);
    if (chatId) {
      attempts.push(
        telegram.sendReminder(chatId, note, kind).then(
          () => "ok",
          (err) => {
            console.error(`Error mandando ${kind === "nag" ? "aviso de vencido" : "recordatorio"} por Telegram:`, err.message);
            return isPermanentTelegramError(err) ? "dead" : "retry";
          }
        )
      );
    }
    attempts.push(sendPush(note.owner, note, kind).then((r) => r));
    const results = (await Promise.all(attempts)).flat();
    // Listo si algun canal lo entrego, o si no queda ningun canal que valga
    // la pena reintentar (incluye el caso de no tener ningun canal).
    return results.includes("ok") || !results.includes("retry");
  }

  function run(note, kind, onDone) {
    const key = `${kind}:${note.id}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    deliver(note, kind)
      .then((finished) => finished && onDone(note.id))
      .catch((err) => console.error("Error entregando recordatorio:", err))
      .finally(() => inFlight.delete(key));
  }

  function tick() {
    for (const note of getDueReminders()) run(note, "due", markReminded);
    // avisos de "sigue pendiente" para recordatorios que ya sonaron y
    // todavia no se marcaron como hechos.
    for (const note of getOverdueNags(nagIntervalMs)) run(note, "nag", touchNagged);
  }

  function purgeTrash() {
    for (const img of purgeDeletedNotes(TRASH_DAYS * 24 * 60 * 60 * 1000)) {
      fs.unlink(path.join(IMAGES_DIR, img), () => {});
    }
  }

  setInterval(tick, 60 * 1000);
  setInterval(purgeTrash, 60 * 60 * 1000);
  purgeTrash();
  console.log(`Recordatorios activos (Telegram: ${telegram ? "si" : "no"}, push: ${pushEnabled ? "si" : "no"}).`);
}

// Fechas para "posponer" un recordatorio (botones del bot y de la notificacion).
function snoozeTarget(kind, now = new Date()) {
  if (kind === "1h") return now.getTime() + 60 * 60 * 1000;
  if (kind === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  }
  return null;
}

module.exports = { startReminders, pushEnabled, snoozeTarget, noteLabel };
