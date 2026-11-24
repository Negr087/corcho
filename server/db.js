const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");
const { emitChange } = require("./events");

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
    width REAL,
    height REAL,
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
if (!existingColumns.includes("width")) db.exec("ALTER TABLE notes ADD COLUMN width REAL");
if (!existingColumns.includes("height")) db.exec("ALTER TABLE notes ADD COLUMN height REAL");
// borrado "blando": la nota va a la papelera y se puede deshacer; se purga
// de verdad despues de unos dias (ver purgeDeletedNotes).
if (!existingColumns.includes("deleted_at")) db.exec("ALTER TABLE notes ADD COLUMN deleted_at INTEGER");
// tipo de papel elegido a mano ("" = automatico segun el contenido)
if (!existingColumns.includes("paper")) db.exec("ALTER TABLE notes ADD COLUMN paper TEXT DEFAULT ''");

// Hilos rojos que unen dos notas. Se guardan con a < b para que no haya
// duplicados en los dos sentidos.
db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    created INTEGER NOT NULL
  )
`);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS links_pair ON links (owner, a, b)");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  )
`);
db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());

// Suscripciones de Web Push (notificaciones del navegador), una por
// dispositivo/navegador en el que el usuario las activo.
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    subscription TEXT NOT NULL,
    created INTEGER NOT NULL
  )
`);

// Estado chico que tiene que sobrevivir a un reinicio del server (ultima
// nota creada por cada usuario del bot, ultima semana en que se mando el
// resumen, etc).
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

for (const row of db.prepare("SELECT id FROM notes WHERE x IS NULL OR y IS NULL").all()) {
  const pos = scatterPosition();
  db.prepare("UPDATE notes SET x = ?, y = ? WHERE id = ?").run(pos.x, pos.y, row.id);
}

// Notas creadas antes de que existiera el login (o por el bot antes de tener owner)
// quedan asignadas al dueño de la app.
if (process.env.OWNER_EMAIL) {
  db.prepare("UPDATE notes SET owner = ? WHERE owner IS NULL").run(process.env.OWNER_EMAIL);
}

// Avisa a las paginas abiertas solo si la escritura toco alguna fila.
function changed(res, owner) {
  if (res.changes > 0) {
    emitChange(owner);
    return true;
  }
  return false;
}

function genId() {
  return Date.now() + "-" + Math.random().toString(36).slice(2, 6);
}

function scatterPosition(owner) {
  const last = owner
    ? db.prepare("SELECT x, y FROM notes WHERE owner = ? AND deleted_at IS NULL ORDER BY created DESC LIMIT 1").get(owner)
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

function getNote(id, owner) {
  return db.prepare("SELECT * FROM notes WHERE id = ? AND owner = ? AND deleted_at IS NULL").get(id, owner);
}

function listNotes(owner) {
  return db.prepare("SELECT * FROM notes WHERE owner = ? AND deleted_at IS NULL ORDER BY created DESC").all(owner);
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
  created,
  done,
  width,
  height,
  remindAt,
  reminded,
  paper,
}) {
  const id = genId();
  if (typeof created !== "number") created = Date.now();
  const pos = typeof x === "number" && typeof y === "number" ? { x, y } : scatterPosition(owner);
  db.prepare(
    `INSERT INTO notes (id, title, body, tags, color, source, created, x, y, owner, telegram_chat_id, telegram_message_id, image_path,
                        done, width, height, remind_at, reminded, paper)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    imagePath || null,
    done ? 1 : 0,
    typeof width === "number" ? width : null,
    typeof height === "number" ? height : null,
    typeof remindAt === "number" ? remindAt : null,
    reminded ? 1 : 0,
    paper || ""
  );
  emitChange(owner);
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
}

function updateNote(id, owner, { title, body, tags, color, x, y, paper }) {
  const existing = getNote(id, owner);
  if (!existing) return null;
  const next = {
    title: title !== undefined ? title : existing.title,
    body: body !== undefined ? body : existing.body,
    tags: tags !== undefined ? tags : existing.tags,
    color: color !== undefined ? color : existing.color,
    x: x !== undefined ? x : existing.x,
    y: y !== undefined ? y : existing.y,
    paper: paper !== undefined ? paper : existing.paper,
  };
  db.prepare(
    "UPDATE notes SET title = ?, body = ?, tags = ?, color = ?, x = ?, y = ?, paper = ? WHERE id = ? AND owner = ?"
  ).run(
    next.title,
    next.body,
    next.tags,
    next.color,
    next.x,
    next.y,
    next.paper || "",
    id,
    owner
  );
  emitChange(owner);
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
}

function updateNotePosition(id, owner, x, y) {
  const res = db.prepare("UPDATE notes SET x = ?, y = ? WHERE id = ? AND owner = ?").run(x, y, id, owner);
  return changed(res, owner);
}

function updateNoteDone(id, owner, done) {
  const res = db.prepare("UPDATE notes SET done = ? WHERE id = ? AND owner = ?").run(done ? 1 : 0, id, owner);
  return changed(res, owner);
}

function updateNoteSize(id, owner, width, height) {
  const res = db.prepare("UPDATE notes SET width = ?, height = ? WHERE id = ? AND owner = ?").run(width, height, id, owner);
  return changed(res, owner);
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
    .prepare(
      "SELECT * FROM notes WHERE owner = ? AND telegram_chat_id = ? AND telegram_message_id = ? AND deleted_at IS NULL"
    )
    .get(owner, String(chatId), String(messageId));
}

function updateNoteBody(id, owner, { title, body, tags }) {
  const existing = getNote(id, owner);
  if (!existing) return null;
  db.prepare("UPDATE notes SET title = ?, body = ?, tags = ? WHERE id = ?").run(
    title !== undefined ? title : existing.title,
    body !== undefined ? body : existing.body,
    tags !== undefined ? tags : existing.tags,
    id
  );
  emitChange(owner);
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
}

// Manda la nota a la papelera (se puede deshacer con restoreNote).
function deleteNote(id, owner) {
  const res = db
    .prepare("UPDATE notes SET deleted_at = ? WHERE id = ? AND owner = ? AND deleted_at IS NULL")
    .run(Date.now(), id, owner);
  return changed(res, owner);
}

function restoreNote(id, owner) {
  const res = db
    .prepare("UPDATE notes SET deleted_at = NULL WHERE id = ? AND owner = ? AND deleted_at IS NOT NULL")
    .run(id, owner);
  return changed(res, owner);
}

// Borra definitivamente lo que esta en la papelera hace mas de
// `olderThanMs`. Devuelve las imagenes que quedaron huerfanas para que el
// que llama las saque del disco.
function purgeDeletedNotes(olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  const images = db
    .prepare("SELECT image_path FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ? AND image_path IS NOT NULL")
    .all(cutoff)
    .map((r) => r.image_path);
  db.prepare(
    `DELETE FROM links WHERE a IN (SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?)
                          OR b IN (SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?)`
  ).run(cutoff, cutoff);
  db.prepare("DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff);
  return images;
}

function setReminder(id, owner, remindAt) {
  const res = db
    .prepare("UPDATE notes SET remind_at = ?, reminded = 0 WHERE id = ? AND owner = ?")
    .run(remindAt, id, owner);
  return changed(res, owner);
}

function getDueReminders() {
  return db
    .prepare(
      "SELECT * FROM notes WHERE remind_at IS NOT NULL AND reminded = 0 AND remind_at <= ? AND deleted_at IS NULL"
    )
    .all(Date.now());
}

function markReminded(id) {
  db.prepare("UPDATE notes SET reminded = 1, last_nagged_at = ? WHERE id = ?").run(Date.now(), id);
  const row = db.prepare("SELECT owner FROM notes WHERE id = ?").get(id);
  if (row) emitChange(row.owner);
}

// Notas cuyo recordatorio ya sono pero siguen sin marcarse hechas: hay que
// insistir cada `intervalMs` hasta que se completen o le saquen el
// recordatorio.
function getOverdueNags(intervalMs) {
  return db
    .prepare(
      `SELECT * FROM notes
       WHERE remind_at IS NOT NULL AND reminded = 1 AND done = 0 AND deleted_at IS NULL
         AND (last_nagged_at IS NULL OR last_nagged_at <= ?)`
    )
    .all(Date.now() - intervalMs);
}

function touchNagged(id) {
  db.prepare("UPDATE notes SET last_nagged_at = ? WHERE id = ?").run(Date.now(), id);
}

// Hilos de las notas visibles (si una punta esta en la papelera, el hilo no
// se muestra, pero vuelve si se restaura la nota).
function listLinks(owner) {
  return db
    .prepare(
      `SELECT l.id, l.a, l.b, l.created FROM links l
       JOIN notes na ON na.id = l.a AND na.deleted_at IS NULL
       JOIN notes nb ON nb.id = l.b AND nb.deleted_at IS NULL
       WHERE l.owner = ?`
    )
    .all(owner);
}

function createLink(owner, noteA, noteB) {
  if (!noteA || !noteB || noteA === noteB) return null;
  if (!getNote(noteA, owner) || !getNote(noteB, owner)) return null;
  const [a, b] = noteA < noteB ? [noteA, noteB] : [noteB, noteA];
  const existing = db.prepare("SELECT id, a, b, created FROM links WHERE owner = ? AND a = ? AND b = ?").get(owner, a, b);
  if (existing) return existing;
  const link = { id: genId(), a, b, created: Date.now() };
  db.prepare("INSERT INTO links (id, owner, a, b, created) VALUES (?, ?, ?, ?, ?)").run(link.id, owner, a, b, link.created);
  emitChange(owner);
  return link;
}

function deleteLink(id, owner) {
  return changed(db.prepare("DELETE FROM links WHERE id = ? AND owner = ?").run(id, owner), owner);
}

function addPushSubscription(owner, subscription) {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, owner, subscription, created) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET owner = excluded.owner, subscription = excluded.subscription`
  ).run(subscription.endpoint, owner, JSON.stringify(subscription), Date.now());
}

function removePushSubscription(endpoint, owner) {
  if (owner) db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND owner = ?").run(endpoint, owner);
  else db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

function listPushSubscriptions(owner) {
  return db
    .prepare("SELECT subscription FROM push_subscriptions WHERE owner = ?")
    .all(owner)
    .map((r) => JSON.parse(r.subscription));
}

function getMeta(key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

function deleteMeta(key) {
  db.prepare("DELETE FROM meta WHERE key = ?").run(key);
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
  getNote,
  listNotes,
  createNote,
  updateNote,
  updateNotePosition,
  updateNoteDone,
  updateNoteSize,
  updateNoteBody,
  setTelegramMessageRef,
  findNoteByTelegramMessage,
  deleteNote,
  restoreNote,
  purgeDeletedNotes,
  listLinks,
  createLink,
  deleteLink,
  setReminder,
  getDueReminders,
  markReminded,
  getOverdueNags,
  touchNagged,
  getMeta,
  setMeta,
  deleteMeta,
  addPushSubscription,
  removePushSubscription,
  listPushSubscriptions,
  getSession,
  setSession,
  destroySession,
  pruneExpiredSessions,
};
