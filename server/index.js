// WSL2 suele anunciar rutas IPv6 que no funcionan de verdad; el algoritmo
// "Happy Eyeballs" de Node intenta esas rutas primero y eso termina
// tumbando tambien los intentos por IPv4 (ETIMEDOUT/AggregateError) aunque
// la red ande perfecto. Forzamos IPv4 puro antes de que nada haga red.
require("node:net").setDefaultAutoSelectFamily(false);
require("node:dns").setDefaultResultOrder("ipv4first");

require("dotenv").config();
const express = require("express");
const path = require("path");
const { listNotes, createNote, updateNote, deleteNote } = require("./db");
const { startBot } = require("./bot");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/notes", (req, res) => {
  res.json(listNotes());
});

app.post("/api/notes", (req, res) => {
  const { title, body, tags, color } = req.body || {};
  if (!body && !title) {
    return res.status(400).json({ error: "title o body requerido" });
  }
  const note = createNote({ title, body, tags, color, source: "web" });
  res.status(201).json(note);
});

app.put("/api/notes/:id", (req, res) => {
  const note = updateNote(req.params.id, req.body || {});
  if (!note) return res.status(404).json({ error: "no encontrada" });
  res.json(note);
});

app.delete("/api/notes/:id", (req, res) => {
  const ok = deleteNote(req.params.id);
  if (!ok) return res.status(404).json({ error: "no encontrada" });
  res.status(204).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`corcho escuchando en http://localhost:${PORT}`);
});

startBot();
