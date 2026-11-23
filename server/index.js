// WSL2 suele anunciar rutas IPv6 que no funcionan de verdad; el algoritmo
// "Happy Eyeballs" de Node intenta esas rutas primero y eso termina
// tumbando tambien los intentos por IPv4 (ETIMEDOUT/AggregateError) aunque
// la red ande bien. Forzamos IPv4 puro antes de que nada haga red.
require("node:net").setDefaultAutoSelectFamily(false);
require("node:dns").setDefaultResultOrder("ipv4first");

require("dotenv").config();
// Todo lo que tiene que ver con fechas en el server (interpretar "mañana a
// las 10", el resumen semanal) usa la hora local del proceso. Los VPS suelen
// venir en UTC, asi que fijamos la zona horaria de los usuarios. Se puede
// pisar con TZ en el .env.
process.env.TZ = process.env.TZ || "America/Argentina/Buenos_Aires";
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const session = require("express-session");
const {
  IMAGES_DIR,
  getNote,
  listNotes,
  createNote,
  updateNote,
  updateNotePosition,
  updateNoteDone,
  updateNoteSize,
  deleteNote,
  restoreNote,
  setReminder,
  addPushSubscription,
  removePushSubscription,
} = require("./db");
const { startBot } = require("./bot");
const { startReminders, pushEnabled, snoozeTarget } = require("./reminders");
const { bus } = require("./events");
const {
  passport,
  configurePassport,
  ensureAuthApi,
  ensureAuthPage,
  ensureWriteAccess,
  readonlyGuestsMap,
} = require("./auth");
const SqliteSessionStore = require("./sessionStore");

configurePassport();

const app = express();
app.set("trust proxy", 1);
// El import de backups trae las imagenes embebidas en base64, asi que esa
// ruta necesita un limite mucho mas grande que el resto.
const IMPORT_PATH = "/api/notes/import";
const jsonDefault = express.json();
const jsonImport = express.json({ limit: "60mb" });
app.use((req, res, next) => (req.path === IMPORT_PATH ? jsonImport : jsonDefault)(req, res, next));

app.use(
  session({
    store: new SqliteSessionStore(),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: "auto", httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 30 },
  })
);
app.use(passport.initialize());
app.use(passport.session());

// Recalcula boardOwner/readOnly a partir de la config actual en cada
// pedido, en vez de confiar en lo que quedo serializado en la sesion al
// momento del login -- asi (a) las sesiones viejas (de antes de que
// existiera este campo) no se rompen sin tener que reloguearse, y (b) si
// cambia READONLY_GUESTS, los que ya tenian sesion lo ven sin reloguearse.
app.use((req, res, next) => {
  if (req.user) {
    const guestOf = readonlyGuestsMap().get(req.user.email);
    req.user.boardOwner = guestOf || req.user.email;
    req.user.readOnly = !!guestOf;
  }
  next();
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/login", (req, res) => {
  if (req.isAuthenticated()) return res.redirect("/");
  res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login?error=not-allowed" }),
  (req, res) => res.redirect("/")
);

app.get("/logout", (req, res) => {
  req.logout(() => res.redirect("/login"));
});

app.get("/api/me", (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: "no autenticado" });
  res.json({
    email: req.user.email,
    name: req.user.name,
    picture: req.user.picture,
    readOnly: !!req.user.readOnly,
    pushKey: pushEnabled && !req.user.readOnly ? process.env.VAPID_PUBLIC_KEY : null,
  });
});

app.get("/", ensureAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "app.html"));
});

app.get("/api/notes", ensureAuthApi, (req, res) => {
  res.json(listNotes(req.user.boardOwner));
});

app.post("/api/notes", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const { title, body, tags, color, x, y } = req.body || {};
  if (!body && !title) {
    return res.status(400).json({ error: "title o body requerido" });
  }
  const note = createNote({ title, body, tags, color, x, y, source: "web", owner: req.user.boardOwner });
  res.status(201).json(note);
});

const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/;

// Restaura un backup exportado desde la web: conserva fecha, estado,
// tamaño, recordatorio e imagen de cada nota.
app.post(IMPORT_PATH, ensureAuthApi, ensureWriteAccess, (req, res) => {
  const items = req.body && Array.isArray(req.body.notes) ? req.body.notes : null;
  if (!items) return res.status(400).json({ error: "se esperaba { notes: [...] }" });
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v) => (typeof v === "string" ? v : "");
  let imported = 0;
  for (const n of items) {
    if (!n || typeof n !== "object" || (!n.title && !n.body && !n.image)) continue;
    let imagePath = null;
    const img = typeof n.image === "string" && n.image.match(IMAGE_DATA_URL);
    if (img) {
      imagePath = crypto.randomUUID() + "." + (img[1] === "jpeg" ? "jpg" : img[1]);
      fs.writeFileSync(path.join(IMAGES_DIR, imagePath), Buffer.from(img[2], "base64"));
    }
    createNote({
      title: str(n.title),
      body: str(n.body),
      tags: str(n.tags),
      color: str(n.color) || undefined,
      source: str(n.source) || "web",
      x: num(n.x),
      y: num(n.y),
      created: num(n.created),
      done: !!n.done,
      width: num(n.width),
      height: num(n.height),
      remindAt: num(n.remind_at),
      reminded: !!n.reminded,
      imagePath,
      owner: req.user.boardOwner,
    });
    imported++;
  }
  res.status(201).json({ imported });
});

app.put("/api/notes/:id", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const note = updateNote(req.params.id, req.user.boardOwner, req.body || {});
  if (!note) return res.status(404).json({ error: "no encontrada" });
  res.json(note);
});

app.patch("/api/notes/:id/position", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const { x, y } = req.body || {};
  if (typeof x !== "number" || typeof y !== "number") {
    return res.status(400).json({ error: "x e y numericos requeridos" });
  }
  const ok = updateNotePosition(req.params.id, req.user.boardOwner, x, y);
  if (!ok) return res.status(404).json({ error: "no encontrada" });
  res.status(204).end();
});

app.patch("/api/notes/:id/size", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const { width, height } = req.body || {};
  if (typeof width !== "number" || typeof height !== "number") {
    return res.status(400).json({ error: "width y height numericos requeridos" });
  }
  const ok = updateNoteSize(req.params.id, req.user.boardOwner, width, height);
  if (!ok) return res.status(404).json({ error: "no encontrada" });
  res.status(204).end();
});

app.patch("/api/notes/:id/done", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const { done } = req.body || {};
  const ok = updateNoteDone(req.params.id, req.user.boardOwner, !!done);
  if (!ok) return res.status(404).json({ error: "no encontrada" });
  res.status(204).end();
});

app.patch("/api/notes/:id/reminder", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const { remindAt } = req.body || {};
  if (remindAt !== null && typeof remindAt !== "number") {
    return res.status(400).json({ error: "remindAt tiene que ser un timestamp o null" });
  }
  const ok = setReminder(req.params.id, req.user.boardOwner, remindAt);
  if (!ok) return res.status(404).json({ error: "no encontrada" });
  res.status(204).end();
});

// Manda la nota a la papelera; se puede deshacer con /restore durante unos
// dias (despues se purga sola, ver server/reminders.js).
app.delete("/api/notes/:id", ensureAuthApi, ensureWriteAccess, (req, res) => {
  if (!deleteNote(req.params.id, req.user.boardOwner)) return res.status(404).json({ error: "no encontrada" });
  res.status(204).end();
});

app.post("/api/notes/:id/restore", ensureAuthApi, ensureWriteAccess, (req, res) => {
  if (!restoreNote(req.params.id, req.user.boardOwner)) return res.status(404).json({ error: "no encontrada" });
  res.status(204).end();
});

// Posponer un recordatorio: { kind: "1h" | "tomorrow" }. La cuenta se hace
// en el server para que use su zona horaria (la de los recordatorios).
app.patch("/api/notes/:id/snooze", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const target = snoozeTarget((req.body || {}).kind);
  if (!target) return res.status(400).json({ error: "kind tiene que ser '1h' o 'tomorrow'" });
  if (!setReminder(req.params.id, req.user.boardOwner, target)) return res.status(404).json({ error: "no encontrada" });
  res.json({ remindAt: target });
});

// --- notificaciones del navegador (Web Push) ---
app.post("/api/push/subscribe", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const sub = req.body || {};
  if (!pushEnabled) return res.status(501).json({ error: "push no configurado en el server" });
  if (typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys) {
    return res.status(400).json({ error: "suscripcion invalida" });
  }
  addPushSubscription(req.user.email, { endpoint: sub.endpoint, keys: sub.keys });
  res.status(204).end();
});

app.post("/api/push/unsubscribe", ensureAuthApi, (req, res) => {
  const { endpoint } = req.body || {};
  if (typeof endpoint === "string") removePushSubscription(endpoint, req.user.email);
  res.status(204).end();
});

// --- cambios en vivo (Server-Sent Events) ---
// La pagina abierta se entera al instante de cualquier cambio en su corcho
// (incluidas las notas que llegan por Telegram) y recarga las notas.
app.get("/api/events", ensureAuthApi, (req, res) => {
  const owner = req.user.boardOwner;
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 5000\n\n");
  const onChange = (changedOwner) => {
    if (changedOwner === owner) res.write("event: change\ndata: {}\n\n");
  };
  bus.on("change", onChange);
  // comentario periodico para que proxies/navegadores no corten la conexion
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    bus.off("change", onChange);
  });
});

app.get("/media/:id", ensureAuthApi, (req, res) => {
  const note = getNote(req.params.id, req.user.boardOwner);
  if (!note || !note.image_path) return res.status(404).end();
  res.sendFile(path.join(IMAGES_DIR, note.image_path), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`corcho escuchando en http://localhost:${PORT}`);
});

const telegram = startBot();
startReminders({ telegram: telegram && telegram.reminderChannel });
