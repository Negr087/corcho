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
const NUMBER_WORDS = {
  una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
};
const REMINDER_HINTS = [
  "recordar", "recordame", "recordame", "recordatorio", "acordarme", "acordate",
  "avisame", "aviame", "no te olvides", "no me olvides", "no olvidarme",
];

// Busca, en cualquier parte del texto (no hace falta que sea todo el
// mensaje), una expresion de fecha/hora en espanol hablado/escrito de forma
// natural: "mañana a las 10", "el lunes a las 9 de la mañana", "en 2 horas",
// "pasado mañana a las 15", "25/12 20:00", etc. No es lenguaje natural
// libre (para eso haria falta un LLM), pero tolera bastante variacion de
// conectores, mayusculas/minusculas, con o sin minutos, con o sin "hs".
// Devuelve un Date o null si no encontro nada reconocible.
function parseReminderTime(text, now = new Date()) {
  let raw = stripAccents(text.toLowerCase());
  // "10.30" es una hora, no un fin de oracion: lo pasamos a "10:30" antes de
  // limpiar la puntuacion.
  raw = raw.replace(/\b(\d{1,2})\.(\d{2})\b/g, "$1:$2");
  raw = raw.replace(/[.,;!?¡¿]/g, " ").replace(/\s+/g, " ").trim();

  // "en media hora", "en N horas/minutos", "en una hora y media" (admite el
  // numero en palabras: "en dos horas")
  const relWords = Object.keys(NUMBER_WORDS).join("|");
  if (/\ben\s+media\s+hora\b/.test(raw)) return new Date(now.getTime() + 30 * 60000);
  let m = raw.match(new RegExp(`\\ben\\s+(\\d+|${relWords})\\s*(horas?|hs|h|minutos?|mins?)\\b(\\s+y\\s+media)?`));
  if (m) {
    const n = NUMBER_WORDS[m[1]] ?? parseInt(m[1], 10);
    const ms = m[2][0] === "h" ? (n + (m[3] ? 0.5 : 0)) * 3600000 : n * 60000;
    return new Date(now.getTime() + ms);
  }

  // dia base: en N dias/semanas / hoy / mañana / pasado mañana / dia de la
  // semana / DD/MM(/YYYY) / la semana que viene.
  // "mañana" es ambiguo en español (dia siguiente vs. hora del dia, como en
  // "de la mañana") -- para decidir el dia, ignoramos las apariciones que
  // son en realidad un calificador horario.
  const dayDetectionText = raw.replace(/\b(de|por)\s+la\s+manana\b/g, "");
  let base = new Date(now);
  let dayFound = false;
  const relDays = raw.match(new RegExp(`\\ben\\s+(\\d+|${relWords})\\s*(dias?|semanas?)\\b`));
  if (relDays) {
    const n = NUMBER_WORDS[relDays[1]] ?? parseInt(relDays[1], 10);
    base.setDate(base.getDate() + n * (relDays[2][0] === "s" ? 7 : 1));
    dayFound = true;
  } else if (/\bpasado\s*manana\b/.test(dayDetectionText)) {
    base.setDate(base.getDate() + 2);
    dayFound = true;
  } else if (/\bmanana\b/.test(dayDetectionText)) {
    base.setDate(base.getDate() + 1);
    dayFound = true;
  } else if (/\bhoy\b/.test(raw)) {
    dayFound = true;
  } else {
    for (const [name, idx] of Object.entries(WEEKDAYS)) {
      if (new RegExp(`\\b${name}\\b`).test(raw)) {
        let diff = (idx - base.getDay() + 7) % 7;
        if (diff === 0) diff = 7;
        base.setDate(base.getDate() + diff);
        dayFound = true;
        break;
      }
    }
    if (!dayFound) {
      const dm = raw.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
      if (dm) {
        const day = parseInt(dm[1], 10);
        const month = parseInt(dm[2], 10) - 1;
        const year = dm[3] ? (dm[3].length === 2 ? 2000 + parseInt(dm[3], 10) : parseInt(dm[3], 10)) : base.getFullYear();
        base = new Date(year, month, day);
        // sin año explicito y la fecha ya paso este año: es la del año que viene.
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (!dm[3] && base < startOfToday) base.setFullYear(base.getFullYear() + 1);
        dayFound = true;
      }
    }
    if (!dayFound && /\b(la\s+)?semana\s+que\s+viene\b|\bproxima\s+semana\b/.test(raw)) {
      base.setDate(base.getDate() + 7);
      dayFound = true;
    }
  }

  // hora: "10:00", "10.30", "a las 10", "10 y media", "a las 10hs", "10hs",
  // con "de la mañana/tarde/noche" o "am/pm" para desambiguar.
  const QUAL = "(am|pm|de la manana|de la tarde|de la noche)";
  let hour = null;
  let minute = 0;
  let qual = null;
  let leadingZero = false;
  let tm = raw.match(new RegExp(`\\b(\\d{1,2}):(\\d{2})\\s*${QUAL}?`));
  if (tm) {
    hour = parseInt(tm[1], 10);
    minute = parseInt(tm[2], 10);
    qual = tm[3];
    leadingZero = tm[1].length === 2 && tm[1][0] === "0";
  } else if (
    (tm = raw.match(
      /\b(?:a|para|tipo)\s+la?s?\s+(\d{1,2})\s*(y\s*media)?\s*(am|pm|de la manana|de la tarde|de la noche|hs|horas?)?/
    ))
  ) {
    hour = parseInt(tm[1], 10);
    minute = tm[2] ? 30 : 0;
    qual = tm[3] && !/^h/.test(tm[3]) ? tm[3] : null;
  } else if ((tm = raw.match(new RegExp(`\\b(\\d{1,2})\\s*(?:hs|h)\\b\\s*${QUAL}?`)))) {
    hour = parseInt(tm[1], 10);
    qual = tm[2];
  }

  if (hour !== null && (hour > 23 || minute > 59)) hour = null;
  if (hour !== null) {
    if (qual) {
      if (/tarde|noche|pm/.test(qual) && hour < 12) hour += 12;
      else if (/noche/.test(qual) && hour === 12) hour = 24; // medianoche: 00:00 del dia siguiente
      else if (/manana|am/.test(qual) && hour === 12) hour = 0;
    } else if (!leadingZero && hour >= 1 && hour <= 7) {
      // "a las 3" sin aclarar casi nunca son las 3 de la madrugada.
      hour += 12;
    }
  }

  if (hour === null && !dayFound) return null;

  if (hour === null) {
    // solo se identifico el dia (ej. "recordame mañana"): asumimos una
    // hora razonable por default.
    base.setHours(9, 0, 0, 0);
    return base;
  }

  if (!dayFound) {
    // solo se identifico la hora (ej. "a las 10"): hoy, y si ya paso, mañana.
    const candidate = new Date(base);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  base.setHours(hour, minute, 0, 0);
  return base;
}

// Si el texto tiene intencion clara de recordatorio ("recordame", "avisame",
// etc.) Y se le puede sacar una fecha/hora, la devuelve -- para poner el
// recordatorio solo cuando el pedido es inequivoco, no cada vez que una
// nota menciona una hora de pasada (ej. "reunion a las 10" como nota suelta
// no deberia disparar un recordatorio sin que se lo pidan).
function detectReminderIntent(text, now = new Date()) {
  const normalized = stripAccents(text.toLowerCase());
  const hasHint = REMINDER_HINTS.some((h) => normalized.includes(stripAccents(h)));
  if (!hasHint) return null;
  return parseReminderTime(text, now);
}

module.exports = { deriveNote, parseReminderTime, detectReminderIntent };
