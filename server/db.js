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
    y REAL,
    owner TEXT
  )
`);

const existingColumns = db.prepare("PRAGMA table_info(notes)").all().map((c) => c.name);
if (!existingColumns.includes("x")) db.exec("ALTER TABLE notes ADD COLUMN x REAL");
if (!existingColumns.includes("y")) db.exec("ALTER TABLE notes ADD COLUMN y REAL");
if (!existingColumns.includes("owner")) db.exec("ALTER TABLE notes ADD COLUMN owner TEXT");

for (const row of db.prepare("SELECT id FROM notes WHERE x IS NULL OR y IS NULL").all()) {
  const pos = scatterPosition();
  db.prepare("UPDATE notes SET x = ?, y = ? WHERE id = ?").run(pos.x, pos.y, row.id);
}

// Notas creadas antes de que existiera el login (o por el bot antes de tener owner)
// quedan asignadas al dueño de la app.
if (process.env.OWNER_EMAIL) {
  db.prepare("UPDATE notes SET owner = ? WHERE owner IS NULL").run(process.env.OWNER_EMAIL);
}

function genId() {
  return Date.now() + "-" + Math.random().toString(36).slice(2, 6);
}

function scatterPosition(owner) {
  const last = owner
    ? db.prepare("SELECT x, y FROM notes WHERE owner = ? ORDER BY created DESC LIMIT 1").get(owner)
    : null;
  if (last) {
    // al lado de la ultima nota clavada, con un poco de jitter para que no
    // queden todas pegadas si se agregan varias seguidas.
    return {
      x: Math.round(last.x + 260 + (Math.random() - 0.5) * 60),
      y: Math.round(last.y + (Math.random() - 0.5) * 180),
    };
  }
  return {
    x: Math.round((Math.random() - 0.5) * 500),
    y: Math.round((Math.random() - 0.5) * 350),
  };
}

function listNotes(owner) {
  return db.prepare("SELECT * FROM notes WHERE owner = ? ORDER BY created DESC").all(owner);
}

function createNote({ title = "", body = "", tags = "", color = "#F4EDDC", source = "web", x, y, owner }) {
  const id = genId();
  const created = Date.now();
  const pos = x !== undefined && y !== undefined ? { x, y } : scatterPosition(owner);
  db.prepare(
    "INSERT INTO notes (id, title, body, tags, color, source, created, x, y, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, title, body, tags, color, source, created, pos.x, pos.y, owner);
  return { id, title, body, tags, color, source, created, x: pos.x, y: pos.y, owner };
}

function updateNote(id, owner, { title, body, tags, color, x, y }) {
  const existing = db.prepare("SELECT * FROM notes WHERE id = ? AND owner = ?").get(id, owner);
  if (!existing) return null;
  const next = {
    title: title !== undefined ? title : existing.title,
    body: body !== undefined ? body : existing.body,
    tags: tags !== undefined ? tags : existing.tags,
    color: color !== undefined ? color : existing.color,
    x: x !== undefined ? x : existing.x,
    y: y !== undefined ? y : existing.y,
  };
  db.prepare("UPDATE notes SET title = ?, body = ?, tags = ?, color = ?, x = ?, y = ? WHERE id = ? AND owner = ?").run(
    next.title,
    next.body,
    next.tags,
    next.color,
    next.x,
    next.y,
    id,
    owner
  );
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
}

function updateNotePosition(id, owner, x, y) {
  const res = db.prepare("UPDATE notes SET x = ?, y = ? WHERE id = ? AND owner = ?").run(x, y, id, owner);
  return res.changes > 0;
}

function deleteNote(id, owner) {
  const res = db.prepare("DELETE FROM notes WHERE id = ? AND owner = ?").run(id, owner);
  return res.changes > 0;
}

module.exports = { listNotes, createNote, updateNote, updateNotePosition, deleteNote };
