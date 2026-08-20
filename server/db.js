const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "corcho.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT DEFAULT '',
    body TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    color TEXT DEFAULT '#F4EDDC',
    source TEXT DEFAULT 'web',
    created INTEGER NOT NULL
  )
`);

function genId() {
  return Date.now() + "-" + Math.random().toString(36).slice(2, 6);
}

function listNotes() {
  const rows = db.prepare("SELECT * FROM notes ORDER BY created DESC").all();
  return rows;
}

function createNote({ title = "", body = "", tags = "", color = "#F4EDDC", source = "web" }) {
  const id = genId();
  const created = Date.now();
  db.prepare(
    "INSERT INTO notes (id, title, body, tags, color, source, created) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, title, body, tags, color, source, created);
  return { id, title, body, tags, color, source, created };
}

function updateNote(id, { title, body, tags, color }) {
  const existing = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  if (!existing) return null;
  const next = {
    title: title !== undefined ? title : existing.title,
    body: body !== undefined ? body : existing.body,
    tags: tags !== undefined ? tags : existing.tags,
    color: color !== undefined ? color : existing.color,
  };
  db.prepare("UPDATE notes SET title = ?, body = ?, tags = ?, color = ? WHERE id = ?").run(
    next.title,
    next.body,
    next.tags,
    next.color,
    id
  );
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
}

function deleteNote(id) {
  const res = db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  return res.changes > 0;
}

module.exports = { listNotes, createNote, updateNote, deleteNote };
