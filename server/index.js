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
  listLinks,
  createLink,
  deleteLink,
  listMarks,
  createMark,
  updateMark,
  deleteMark,
  restoreMark,
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

// La pagina pide app.css/app.js con una huella de su contenido en la URL
// (?v=...). Cloudflare y el navegador guardan esos archivos varias horas; al
// cambiar el contenido cambia la URL, asi que despues de cada deploy se baja
// la version nueva sin esperar a que venza la cache.
function assetVersion(file) {
  const content = fs.readFileSync(path.join(__dirname, "..", "public", file));
  return crypto.createHash("sha1").update(content).digest("hex").slice(0, 10);
}
const APP_HTML = fs
  .readFileSync(path.join(__dirname, "views", "app.html"), "utf8")
  .replace('href="/app.css"', `href="/app.css?v=${assetVersion("app.css")}"`)
  .replace('src="/app.js"', `src="/app.js?v=${assetVersion("app.js")}"`);

app.get("/", ensureAuthPage, (req, res) => {
  // la pagina en si nunca se guarda en cache: es la que trae las URLs nuevas
  res.set("Cache-Control", "no-cache");
  res.type("html").send(APP_HTML);
});

app.get("/api/notes", ensureAuthApi, (req, res) => {
  res.json(listNotes(req.user.boardOwner));
});

// Tipos de papel validos ("" = automatico, lo decide la web segun el contenido)
const PAPERS = ["", "card", "postit", "notebook", "receipt", "index", "polaroid"];
const cleanPaper = (p) => (PAPERS.includes(p) ? p : undefined);

app.post("/api/notes", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const { title, body, tags, color, x, y, paper } = req.body || {};
  if (!body && !title) {
    return res.status(400).json({ error: "title o body requerido" });
  }
  const note = createNote({
    title,
    body,
    tags,
    color,
    x,
    y,
    paper: cleanPaper(paper),
    source: "web",
    owner: req.user.boardOwner,
  });
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
  const idMap = new Map(); // id del backup -> id nuevo, para rearmar los hilos
  for (const n of items) {
    if (!n || typeof n !== "object" || (!n.title && !n.body && !n.image)) continue;
    let imagePath = null;
    const img = typeof n.image === "string" && n.image.match(IMAGE_DATA_URL);
    if (img) {
      imagePath = crypto.randomUUID() + "." + (img[1] === "jpeg" ? "jpg" : img[1]);
      fs.writeFileSync(path.join(IMAGES_DIR, imagePath), Buffer.from(img[2], "base64"));
    }
    const created = createNote({
      paper: cleanPaper(n.paper),
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
    if (typeof n.id === "string") idMap.set(n.id, created.id);
    imported++;
  }
  let linked = 0;
  for (const l of Array.isArray(req.body.links) ? req.body.links : []) {
    if (l && idMap.has(l.a) && idMap.has(l.b) && createLink(req.user.boardOwner, idMap.get(l.a), idMap.get(l.b))) linked++;
  }
  let marks = 0;
  for (const m of Array.isArray(req.body.marks) ? req.body.marks : []) {
    if (!m || !MARK_KINDS.includes(m.kind)) continue;
    const fields = cleanMark(m, m.kind);
    if (!fields) continue;
    createMark(req.user.boardOwner, { kind: m.kind, ...fields, created: num(m.created) });
    marks++;
  }
  res.status(201).json({ imported, linked, marks });
});

app.put("/api/notes/:id", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const fields = { ...(req.body || {}) };
  if ("paper" in fields) fields.paper = cleanPaper(fields.paper);
  const note = updateNote(req.params.id, req.user.boardOwner, fields);
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

// --- hilos rojos entre notas ---
app.get("/api/links", ensureAuthApi, (req, res) => {
  res.json(listLinks(req.user.boardOwner));
});

app.post("/api/links", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const { a, b } = req.body || {};
  const link = createLink(req.user.boardOwner, a, b);
  if (!link) return res.status(400).json({ error: "hacen falta dos notas distintas que existan" });
  res.status(201).json(link);
});

app.delete("/api/links/:id", ensureAuthApi, ensureWriteAccess, (req, res) => {
  if (!deleteLink(req.params.id, req.user.boardOwner)) return res.status(404).json({ error: "no encontrado" });
  res.status(204).end();
});

// --- marcador y textos sueltos escritos sobre el corcho ---
const MARK_KINDS = ["stroke", "text"];
const MAX_STROKE_POINTS = 3000;
const MAX_TEXT_LENGTH = 1000;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
// Valida lo que manda la web. Con partial = true (al editar) los campos que
// no vienen se dejan como estan. Devuelve null si algo no tiene sentido.
function cleanMark(input, kind, partial = false) {
  const out = {};
  for (const k of ["x", "y"]) {
    if (input[k] === undefined && partial) continue;
    if (!isNum(input[k])) return null;
    out[k] = Math.round(input[k] * 10) / 10;
  }
  if (input.color !== undefined || !partial) {
    if (typeof input.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(input.color)) return null;
    out.color = input.color;
  }
  if (input.size !== undefined || !partial) {
    if (!isNum(input.size)) return null;
    // trazos: grosor del marcador; textos: tamaño de letra (se pueden agrandar mucho)
    out.size = Math.min(400, Math.max(1, input.size));
  }
  if (input.data !== undefined || !partial) {
    const d = input.data;
    if (!d || typeof d !== "object") return null;
    if (kind === "stroke") {
      const pts = d.points;
      if (!Array.isArray(pts) || pts.length < 1 || pts.length > MAX_STROKE_POINTS) return null;
      if (!pts.every((p) => Array.isArray(p) && p.length === 3 && p.every(isNum))) return null;
      out.data = {
        points: pts.map(([px, py, pr]) => [Math.round(px * 10) / 10, Math.round(py * 10) / 10, Math.round(Math.min(1, Math.max(0, pr)) * 100) / 100]),
        pen: !!d.pen,
        // trazos escritos seguidos y cerca (una palabra) comparten grupo y se
        // seleccionan juntos
        group: typeof d.group === "string" && /^[\w-]{1,40}$/.test(d.group) ? d.group : undefined,
      };
    } else {
      if (typeof d.text !== "string" || !d.text.trim() || d.text.length > MAX_TEXT_LENGTH) return null;
      out.data = { text: d.text };
    }
  }
  return out;
}

app.get("/api/marks", ensureAuthApi, (req, res) => {
  res.json(listMarks(req.user.boardOwner));
});

app.post("/api/marks", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const body = req.body || {};
  if (!MARK_KINDS.includes(body.kind)) return res.status(400).json({ error: "kind tiene que ser 'stroke' o 'text'" });
  const fields = cleanMark(body, body.kind);
  if (!fields) return res.status(400).json({ error: "marca invalida" });
  res.status(201).json(createMark(req.user.boardOwner, { kind: body.kind, ...fields }));
});

app.patch("/api/marks/:id", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const body = req.body || {};
  // el tipo no se puede cambiar; se usa solo para validar "data"
  const kind = body.data && typeof body.data.text === "string" ? "text" : "stroke";
  const fields = cleanMark(body, kind, true);
  if (!fields) return res.status(400).json({ error: "marca invalida" });
  if (!updateMark(req.params.id, req.user.boardOwner, fields, kind)) return res.status(404).json({ error: "no encontrada" });
  res.status(204).end();
});

app.delete("/api/marks/:id", ensureAuthApi, ensureWriteAccess, (req, res) => {
  if (!deleteMark(req.params.id, req.user.boardOwner)) return res.status(404).json({ error: "no encontrada" });
  res.status(204).end();
});

app.post("/api/marks/:id/restore", ensureAuthApi, ensureWriteAccess, (req, res) => {
  if (!restoreMark(req.params.id, req.user.boardOwner)) return res.status(404).json({ error: "no encontrada" });
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
