const TAG_RULES = [
  { tag: "tarea", keywords: ["tengo que", "hay que", "no me olvide", "no me olvidar", "pendiente", "recordar", "recordatorio", "acordarme"] },
  { tag: "idea", keywords: ["idea", "se me ocurrio", "se me ocurre", "pense", "podriamos", "propuesta"] },
  { tag: "compra", keywords: ["comprar", "compra", "supermercado", "farmacia", "pedir"] },
  { tag: "trabajo", keywords: ["reunion", "cliente", "proyecto", "jefe", "trabajo", "oficina"] },
  { tag: "llamada", keywords: ["llamar", "llamada", "telefono"] },
  { tag: "cita", keywords: ["turno", "cita", "medico", "doctor", "dentista"] },
  { tag: "personal", keywords: ["familia", "casa", "cumpleanos"] },
];

function stripAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function deriveTitle(text) {
  const clean = text.trim();
  if (!clean) return "";
  const sentenceMatch = clean.match(/^.*?[.!?](?=\s|$)/);
  let candidate = sentenceMatch ? sentenceMatch[0] : clean.split("\n")[0];
  candidate = candidate.replace(/[.!?]+$/, "").trim();
  if (!candidate) candidate = clean;

  const MAX = 60;
  if (candidate.length > MAX) {
    const cut = candidate.slice(0, MAX);
    const lastSpace = cut.lastIndexOf(" ");
    candidate = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + "…";
  }
  return candidate;
}

function deriveTags(text) {
  const normalized = stripAccents(text.toLowerCase());
  const matched = [];
  for (const rule of TAG_RULES) {
    if (rule.keywords.some((k) => normalized.includes(k))) matched.push(rule.tag);
  }
  return matched.slice(0, 3).join(", ");
}

function deriveNote(text) {
  const body = text.trim();
  return {
    title: deriveTitle(body),
    body,
    tags: deriveTags(body),
  };
}

const WEEKDAYS = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };

// Entiende un puñado de formatos comunes en español, no lenguaje natural
// libre (eso necesitaria un LLM). Devuelve un Date o null si no entendio.
function parseReminderTime(text, now = new Date()) {
  const raw = stripAccents(text.trim().toLowerCase());

  let m = raw.match(/^en\s+(\d+)\s*(h|hs|hora|horas|m|min|minutos)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const ms = m[2][0] === "h" ? n * 3600000 : n * 60000;
    return new Date(now.getTime() + ms);
  }

  m = raw.match(/^(hoy|manana)\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const d = new Date(now);
    if (m[1] === "manana") d.setDate(d.getDate() + 1);
    d.setHours(parseInt(m[2], 10), parseInt(m[3], 10), 0, 0);
    return d;
  }

  m = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : now.getFullYear();
    return new Date(year, month, day, parseInt(m[4], 10), parseInt(m[5], 10), 0, 0);
  }

  m = raw.match(/^([a-z]+)\s+(\d{1,2}):(\d{2})$/);
  if (m && WEEKDAYS[m[1]] !== undefined) {
    const targetDow = WEEKDAYS[m[1]];
    const d = new Date(now);
    let diff = (targetDow - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
    d.setHours(parseInt(m[2], 10), parseInt(m[3], 10), 0, 0);
    return d;
  }

  return null;
}

module.exports = { deriveNote, parseReminderTime };
