const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const IMAGES_DIR = path.join(dataDir, "images");
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

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
    owner TEXT,
    done INTEGER DEFAULT 0,
    telegram_chat_id TEXT,
    telegram_message_id TEXT,
    image_path TEXT,
    remind_at INTEGER,
    reminded INTEGER DEFAULT 0
  )
`);

const existingColumns = db.prepare("PRAGMA table_info(notes)").all().map((c) => c.name);
if (!existingColumns.includes("x")) db.exec("ALTER TABLE notes ADD COLUMN x REAL");
if (!existingColumns.includes("y")) db.exec("ALTER TABLE notes ADD COLUMN y REAL");
if (!existingColumns.includes("owner")) db.exec("ALTER TABLE notes ADD COLUMN owner TEXT");
if (!existingColumns.includes("done")) db.exec("ALTER TABLE notes ADD COLUMN done INTEGER DEFAULT 0");
if (!existingColumns.includes("telegram_chat_id")) db.exec("ALTER TABLE notes ADD COLUMN telegram_chat_id TEXT");
if (!existingColumns.includes("telegram_message_id"))
  db.exec("ALTER TABLE notes ADD COLUMN telegram_message_id TEXT");
if (!existingColumns.includes("image_path")) db.exec("ALTER TABLE notes ADD COLUMN image_path TEXT");
if (!existingColumns.includes("remind_at")) db.exec("ALTER TABLE notes ADD COLUMN remind_at INTEGER");
if (!existingColumns.includes("reminded")) db.exec("ALTER TABLE notes ADD COLUMN reminded INTEGER DEFAULT 0");
if (!existingColumns.includes("last_nagged_at")) db.exec("ALTER TABLE notes ADD COLUMN last_nagged_at INTEGER");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  )
`);
db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());

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

function createNote({
  title = "",
  body = "",
  tags = "",
  color = "#F4EDDC",
  source = "web",
  x,
  y,
  owner,
  telegramChatId,
  telegramMessageId,
  imagePath,
}) {
  const id = genId();
  const created = Date.now();
  const pos = x !== undefined && y !== undefined ? { x, y } : scatterPosition(owner);
  db.prepare(
    `INSERT INTO notes (id, title, body, tags, color, source, created, x, y, owner, telegram_chat_id, telegram_message_id, image_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    title,
    body,
    tags,
    color,
    source,
    created,
    pos.x,
    pos.y,
    owner,
    telegramChatId || null,
    telegramMessageId || null,
    imagePath || null
  );
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
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

function updateNoteDone(id, owner, done) {
  const res = db.prepare("UPDATE notes SET done = ? WHERE id = ? AND owner = ?").run(done ? 1 : 0, id, owner);
  return res.changes > 0;
}

function setTelegramMessageRef(id, chatId, messageId) {
  db.prepare("UPDATE notes SET telegram_chat_id = ?, telegram_message_id = ? WHERE id = ?").run(
    String(chatId),
    String(messageId),
    id
  );
}

function findNoteByTelegramMessage(owner, chatId, messageId) {
  return db
    .prepare("SELECT * FROM notes WHERE owner = ? AND telegram_chat_id = ? AND telegram_message_id = ?")
    .get(owner, String(chatId), String(messageId));
}

function updateNoteBody(id, owner, { title, body, tags }) {
  const existing = db.prepare("SELECT * FROM notes WHERE id = ? AND owner = ?").get(id, owner);
  if (!existing) return null;
  db.prepare("UPDATE notes SET title = ?, body = ?, tags = ? WHERE id = ?").run(
    title !== undefined ? title : existing.title,
    body !== undefined ? body : existing.body,
    tags !== undefined ? tags : existing.tags,
    id
  );
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
}

function deleteNote(id, owner) {
  const existing = db.prepare("SELECT image_path FROM notes WHERE id = ? AND owner = ?").get(id, owner);
  const res = db.prepare("DELETE FROM notes WHERE id = ? AND owner = ?").run(id, owner);
  return res.changes > 0 ? existing : null;
}

function setReminder(id, owner, remindAt) {
  const res = db
    .prepare("UPDATE notes SET remind_at = ?, reminded = 0 WHERE id = ? AND owner = ?")
    .run(remindAt, id, owner);
  return res.changes > 0;
}

function getDueReminders() {
  return db.prepare("SELECT * FROM notes WHERE remind_at IS NOT NULL AND reminded = 0 AND remind_at <= ?").all(Date.now());
}

function markReminded(id) {
  db.prepare("UPDATE notes SET reminded = 1, last_nagged_at = ? WHERE id = ?").run(Date.now(), id);
}

// Notas cuyo recordatorio ya sono pero siguen sin marcarse hechas: hay que
// insistir cada `intervalMs` hasta que se completen o le saquen el
// recordatorio.
function getOverdueNags(intervalMs) {
  return db
    .prepare(
      `SELECT * FROM notes
       WHERE remind_at IS NOT NULL AND reminded = 1 AND done = 0
         AND (last_nagged_at IS NULL OR last_nagged_at <= ?)`
    )
    .all(Date.now() - intervalMs);
}

function touchNagged(id) {
  db.prepare("UPDATE notes SET last_nagged_at = ? WHERE id = ?").run(Date.now(), id);
}

function getSession(sid) {
  return db.prepare("SELECT sess, expires FROM sessions WHERE sid = ?").get(sid);
}

function setSession(sid, sess, expires) {
  db.prepare(
    "INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires"
  ).run(sid, sess, expires);
}

function destroySession(sid) {
  db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
}

function pruneExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
}

module.exports = {
  IMAGES_DIR,
  listNotes,
  createNote,
  updateNote,
  updateNotePosition,
  updateNoteDone,
  updateNoteBody,
  setTelegramMessageRef,
  findNoteByTelegramMessage,
  deleteNote,
  setReminder,
  getDueReminders,
  markReminded,
  getOverdueNags,
  touchNagged,
  getSession,
  setSession,
  destroySession,
  pruneExpiredSessions,
};
