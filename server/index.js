// WSL2 suele anunciar rutas IPv6 que no funcionan de verdad; el algoritmo
// "Happy Eyeballs" de Node intenta esas rutas primero y eso termina
// tumbando tambien los intentos por IPv4 (ETIMEDOUT/AggregateError) aunque
// la red ande bien. Forzamos IPv4 puro antes de que nada haga red.
require("node:net").setDefaultAutoSelectFamily(false);
require("node:dns").setDefaultResultOrder("ipv4first");

require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const { listNotes, createNote, updateNote, updateNotePosition, deleteNote } = require("./db");
const { startBot } = require("./bot");
const { passport, configurePassport, ensureAuthApi, ensureAuthPage } = require("./auth");

configurePassport();

const app = express();
app.set("trust proxy", 1);
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: "auto", httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 30 },
  })
);
app.use(passport.initialize());
app.use(passport.session());

app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));

app.get("/login", (req, res) => {
  if (req.isAuthenticated()) return res.redirect("/");
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
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
  res.json({ email: req.user.email, name: req.user.name, picture: req.user.picture });
});

app.get("/", ensureAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/api/notes", ensureAuthApi, (req, res) => {
  res.json(listNotes(req.user.email));
});

app.post("/api/notes", ensureAuthApi, (req, res) => {
  const { title, body, tags, color, x, y } = req.body || {};
  if (!body && !title) {
    return res.status(400).json({ error: "title o body requerido" });
  }
  const note = createNote({ title, body, tags, color, x, y, source: "web", owner: req.user.email });
  res.status(201).json(note);
});

app.put("/api/notes/:id", ensureAuthApi, (req, res) => {
  const note = updateNote(req.params.id, req.user.email, req.body || {});
  if (!note) return res.status(404).json({ error: "no encontrada" });
  res.json(note);
});

app.patch("/api/notes/:id/position", ensureAuthApi, (req, res) => {
  const { x, y } = req.body || {};
  if (typeof x !== "number" || typeof y !== "number") {
    return res.status(400).json({ error: "x e y numericos requeridos" });
  }
  const ok = updateNotePosition(req.params.id, req.user.email, x, y);
  if (!ok) return res.status(404).json({ error: "no encontrada" });
  res.status(204).end();
});

app.delete("/api/notes/:id", ensureAuthApi, (req, res) => {
  const ok = deleteNote(req.params.id, req.user.email);
  if (!ok) return res.status(404).json({ error: "no encontrada" });
  res.status(204).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`corcho escuchando en http://localhost:${PORT}`);
});

startBot();
