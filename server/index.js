// WSL2 suele anunciar rutas IPv6 que no funcionan de verdad; el algoritmo
// "Happy Eyeballs" de Node intenta esas rutas primero y eso termina
// tumbando tambien los intentos por IPv4 (ETIMEDOUT/AggregateError) aunque
// la red ande bien. Forzamos IPv4 puro antes de que nada haga red.
require("node:net").setDefaultAutoSelectFamily(false);
require("node:dns").setDefaultResultOrder("ipv4first");

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const {
  IMAGES_DIR,
  listNotes,
  createNote,
  updateNote,
  updateNotePosition,
  updateNoteDone,
  deleteNote,
  setReminder,
} = require("./db");
const { startBot } = require("./bot");
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
app.use(express.json());

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

app.delete("/api/notes/:id", ensureAuthApi, ensureWriteAccess, (req, res) => {
  const deleted = deleteNote(req.params.id, req.user.boardOwner);
  if (!deleted) return res.status(404).json({ error: "no encontrada" });
  if (deleted.image_path) {
    fs.unlink(path.join(IMAGES_DIR, deleted.image_path), () => {});
  }
  res.status(204).end();
});

app.get("/media/:id", ensureAuthApi, (req, res) => {
  const notes = listNotes(req.user.boardOwner);
  const note = notes.find((n) => n.id === req.params.id);
  if (!note || !note.image_path) return res.status(404).end();
  res.sendFile(path.join(IMAGES_DIR, note.image_path), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`corcho escuchando en http://localhost:${PORT}`);
});

startBot();
