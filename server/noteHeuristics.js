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

module.exports = { deriveNote };
