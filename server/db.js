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
    created INTEGER NOT NULL,
    x REAL,
    y REAL
  )
`);

const existingColumns = db.prepare("PRAGMA table_info(notes)").all().map((c) => c.name);
if (!existingColumns.includes("x")) db.exec("ALTER TABLE notes ADD COLUMN x REAL");
if (!existingColumns.includes("y")) db.exec("ALTER TABLE notes ADD COLUMN y REAL");

for (const row of db.prepare("SELECT id FROM notes WHERE x IS NULL OR y IS NULL").all()) {
  const pos = scatterPosition();
  db.prepare("UPDATE notes SET x = ?, y = ? WHERE id = ?").run(pos.x, pos.y, row.id);
}

function genId() {
  return Date.now() + "-" + Math.random().toString(36).slice(2, 6);
}

function scatterPosition() {
  return {
    x: Math.round((Math.random() - 0.5) * 700),
    y: Math.round((Math.random() - 0.5) * 500),
  };
}

function listNotes() {
  return db.prepare("SELECT * FROM notes ORDER BY created DESC").all();
}

function createNote({ title = "", body = "", tags = "", color = "#F4EDDC", source = "web", x, y }) {
  const id = genId();
  const created = Date.now();
  const pos = x !== undefined && y !== undefined ? { x, y } : scatterPosition();
  db.prepare(
    "INSERT INTO notes (id, title, body, tags, color, source, created, x, y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, title, body, tags, color, source, created, pos.x, pos.y);
  return { id, title, body, tags, color, source, created, x: pos.x, y: pos.y };
}

function updateNote(id, { title, body, tags, color, x, y }) {
  const existing = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  if (!existing) return null;
  const next = {
    title: title !== undefined ? title : existing.title,
    body: body !== undefined ? body : existing.body,
    tags: tags !== undefined ? tags : existing.tags,
    color: color !== undefined ? color : existing.color,
    x: x !== undefined ? x : existing.x,
    y: y !== undefined ? y : existing.y,
  };
  db.prepare("UPDATE notes SET title = ?, body = ?, tags = ?, color = ?, x = ?, y = ? WHERE id = ?").run(
    next.title,
    next.body,
    next.tags,
    next.color,
    next.x,
    next.y,
    id
  );
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
}

function updateNotePosition(id, x, y) {
  const res = db.prepare("UPDATE notes SET x = ?, y = ? WHERE id = ?").run(x, y, id);
  return res.changes > 0;
}

function deleteNote(id) {
  const res = db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  return res.changes > 0;
}

module.exports = { listNotes, createNote, updateNote, updateNotePosition, deleteNote };
