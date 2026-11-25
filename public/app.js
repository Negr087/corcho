const $ = s => document.querySelector(s);

// --- tema claro/oscuro ---
const THEME_KEY = "corcho.theme.v1";
function applyTheme(theme){
  if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
  const btn = $("#themeToggle");
  if (btn){
    const isDark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    btn.textContent = isDark ? "☀️" : "🌙";
  }
}
function toggleTheme(){
  const current = localStorage.getItem(THEME_KEY);
  const isDark = current === "dark" || (!current && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const next = isDark ? "light" : "dark";
  try{ localStorage.setItem(THEME_KEY, next); }catch(e){}
  applyTheme(next);
}
applyTheme(localStorage.getItem(THEME_KEY));
const COLORS = [
  "#F4EDDC","#ECD3CD","#CFD3BD","#CFC6E0","#F7C99B","#F6F2EA",
  "#BFD8D2","#F5B8B0","#FFE29A","#B8CDE0","#D9B8D4","#C9B79C","#A8C3A0","#E8A87C"
];
let notes = [];
let links = []; // hilos rojos: { id, a, b }
let marks = []; // marcador y textos sueltos: { id, kind: "stroke"|"text", x, y, color, size, data }
let editingId = null;
let pickedColor = COLORS[0];
let pendingPos = null;
// Ctrl+Z: lo ultimo que se hizo (mover una nota, un trazo, un texto, borrar)
const undoStack = [];
function pushUndo(label, run){
  undoStack.push({ label, run });
  if (undoStack.length > 40) undoStack.shift();
}
let knownNoteIds = new Set();
let hasRenderedOnce = false;
let isReadOnly = false;
const REDUCE_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// --- estado del lienzo (pan/zoom) ---
let pan = { x: 0, y: 0 };
let zoom = 1;
const MIN_ZOOM = 0.2, MAX_ZOOM = 2.5;
let isPanning = false, panStart = null;
let interacting = false;

function applyTransform(){
  $("#world").style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  $("#zoomLabel").textContent = Math.round(zoom * 100) + "%";
  // parallax sutil: el fondo de corcho se mueve mas lento que las notas,
  // da sensacion de profundidad sin ser un canvas 3D de verdad.
  document.body.style.backgroundPosition = `${pan.x * 0.15}px ${pan.y * 0.15}px`;
}
function screenToWorld(sx, sy){ return { x: (sx - pan.x) / zoom, y: (sy - pan.y) / zoom }; }
function setZoomAt(cx, cy, newZoom){
  newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
  const pt = screenToWorld(cx, cy);
  zoom = newZoom;
  pan.x = cx - pt.x * zoom;
  pan.y = cy - pt.y * zoom;
  applyTransform();
  scheduleSaveView();
}
function fitAll(){
  const rect = $("#viewport").getBoundingClientRect();
  if(!notes.length && !marks.length){ zoom = 1; pan.x = rect.width/2; pan.y = rect.height/2; applyTransform(); saveView(); return; }
  // margen generoso: las notas miden hasta ~270px y arriba estan los filtros
  const xs = [], ys = [];
  for (const n of notes){ xs.push((n.x ?? 0) - 190, (n.x ?? 0) + 190); ys.push((n.y ?? 0) - 260, (n.y ?? 0) + 190); }
  for (const m of marks){
    if (m.kind === "stroke"){
      for (const [px, py] of m.data.points){ xs.push(px - 40, px + 40); ys.push(py - 60, py + 40); }
    } else {
      const lines = m.data.text.split("\n");
      const longest = Math.max(...lines.map(l => l.length));
      xs.push(m.x - 40, m.x + longest * m.size * 0.45 + 40);
      ys.push(m.y - 80, m.y + lines.length * m.size * 1.1 + 40);
    }
  }
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(rect.width / w, rect.height / h)));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  pan.x = rect.width / 2 - cx * zoom;
  pan.y = rect.height / 2 - cy * zoom;
  applyTransform();
  saveView();
}

// --- persistencia de la vista (pan/zoom) entre visitas ---
const VIEW_KEY = "corcho.view.v1";
let saveViewTimer = null;
function saveView(){
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ x: pan.x, y: pan.y, zoom })); } catch(e){}
}
function scheduleSaveView(){
  clearTimeout(saveViewTimer);
  saveViewTimer = setTimeout(saveView, 400);
}
function loadSavedView(){
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY));
    if (v && typeof v.x === "number" && typeof v.y === "number" && typeof v.zoom === "number") return v;
  } catch(e){}
  return null;
}
function initView(){
  const saved = loadSavedView();
  if (saved){
    pan.x = saved.x; pan.y = saved.y; zoom = saved.zoom;
    applyTransform();
  } else {
    const rect = $("#viewport").getBoundingClientRect();
    zoom = 1; pan.x = rect.width/2; pan.y = rect.height/2;
    applyTransform();
    saveView();
  }
}

function checkAuth(res){
  if (res.status === 401){ location.href = "/login"; throw new Error("no autenticado"); }
  return res;
}
async function loadMe(){
  const r = await fetch("/api/me");
  if (r.status === 401){ location.href = "/login"; return; }
  const me = await r.json();
  $("#userAvatar").src = me.picture || "";
  $("#userName").textContent = (me.name || me.email) + (me.readOnly ? " (solo lectura)" : "");
  $("#userBox").style.display = "flex";
  isReadOnly = !!me.readOnly;
  document.body.classList.toggle("readonly", isReadOnly);
  setupPush(me.pushKey);
}
async function loadNotes(){
  const [rn, rl, rm] = await Promise.all([fetch("/api/notes"), fetch("/api/links"), fetch("/api/marks")]);
  notes = await checkAuth(rn).json();
  links = await checkAuth(rl).json();
  marks = await checkAuth(rm).json();
}
async function apiCreate(note){
  const r = checkAuth(await fetch("/api/notes", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(note) }));
  return r.json();
}
async function apiUpdate(id, note){
  const r = checkAuth(await fetch("/api/notes/"+encodeURIComponent(id), { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(note) }));
  return r.json();
}
async function apiDelete(id){
  checkAuth(await fetch("/api/notes/"+encodeURIComponent(id), { method:"DELETE" }));
}
async function apiRestore(id){
  checkAuth(await fetch("/api/notes/"+encodeURIComponent(id)+"/restore", { method:"POST" }));
}
// Borrar va a la papelera del server: en vez de pedir confirmacion, se
// ofrece deshacer unos segundos.
async function deleteWithUndo(id){
  await apiDelete(id);
  notes = notes.filter(n => n.id !== id);
  render();
  toast("Nota eliminada", {
    action: "Deshacer", duration: 6000,
    onAction: async () => { await apiRestore(id); await loadNotes(); render(); toast("Nota restaurada"); },
  });
}
async function apiPosition(id, x, y){
  await fetch("/api/notes/"+encodeURIComponent(id)+"/position", {
    method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({x, y})
  }).catch(()=>{});
}
async function apiSize(id, width, height){
  await fetch("/api/notes/"+encodeURIComponent(id)+"/size", {
    method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({width, height})
  }).catch(()=>{});
}
async function apiDone(id, done){
  await fetch("/api/notes/"+encodeURIComponent(id)+"/done", {
    method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({done})
  }).catch(()=>{});
}
async function apiReminder(id, remindAt){
  await fetch("/api/notes/"+encodeURIComponent(id)+"/reminder", {
    method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({remindAt})
  }).catch(()=>{});
}
function toDatetimeLocal(ts){
  if(!ts) return "";
  const d = new Date(ts);
  const pad = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fdatetime(ts){
  try{ return new Date(ts).toLocaleString("es-AR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}); }catch(e){ return ""; }
}

let toastTimer = null;
// toast("texto") o toast("texto", { action:"Deshacer", onAction, duration })
function toast(m, opts = {}){
  const t = $("#toast");
  t.textContent = m;
  if (opts.action){
    const b = document.createElement("button");
    b.className = "toast-action";
    b.textContent = opts.action;
    b.onclick = () => { t.classList.remove("show"); clearTimeout(toastTimer); opts.onAction(); };
    t.append(b);
  }
  t.classList.toggle("actionable", !!opts.action);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), opts.duration || 1600);
}
function rot(id){ let h=0; for(const c of id) h=(h*31+c.charCodeAt(0))%1000; return ((h%7)-3); }
// minusculas y sin acentos, para que "reunion" encuentre "Reunión"
function norm(s){ return (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase(); }
function noteMatches(n, q){ return norm(n.title+" "+n.body+" "+n.tags).includes(q); }
function esc(s){ return (s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function fdate(ts){ try{ return new Date(ts).toLocaleDateString("es-AR",{day:"2-digit",month:"short",year:"numeric"}); }catch(e){ return ""; } }
function linkify(s){ return esc(s).replace(/(https?:\/\/[^\s]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>'); }
function srcBadge(n){
  if(n.source==="telegram") return "💬 ";
  if(n.source==="telegram-audio") return "🎙️ ";
  if(n.source==="telegram-photo") return "📷 ";
  return "";
}

function anyOverlayOpen(){
  return $("#editOverlay").classList.contains("open") || $("#detailOverlay").classList.contains("open");
}

// --- cada nota en su papel ---
const PAPERS = {
  "":         "Automático (según lo que diga)",
  card:       "Tarjeta",
  postit:     "Post-it",
  notebook:   "Hoja de cuaderno",
  index:      "Ficha",
  receipt:    "Ticket",
  polaroid:   "Polaroid",
};
const PIN_COLORS = ["#D63B2F", "#2F6FD6", "#2E9E5B", "#E0B21B", "#D97A3F", "#8A4FC7", "#2B2B2B"];
const TAPE_COLORS = ["rgba(240,226,190,.72)", "rgba(196,224,214,.72)", "rgba(244,196,196,.72)", "rgba(206,214,240,.72)"];
// numero estable a partir del id: la misma nota siempre sale igual
function hash(s, salt = 0){ let h = 7 + salt; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
// El papel sale del contenido, salvo que se haya elegido uno a mano.
function paperOf(n){
  if (n.paper && PAPERS[n.paper]) return n.paper;
  if (n.image_path) return "polaroid";
  const tags = norm(n.tags);
  if (/\bcompras?\b/.test(tags)) return "receipt";
  if (n.remind_at || /\btareas?\b/.test(tags)) return "index";
  const len = ((n.title || "") + (n.body || "")).length;
  if (len > 220) return "notebook";
  if (len <= 90) return "postit";
  return ["card", "postit", "notebook"][hash(n.id) % 3];
}
function fastenerHtml(n, paper){
  const title = isReadOnly ? "" : ` title="Arrastrá desde acá hasta otra nota para unirlas con un hilo"`;
  if (paper === "receipt"){
    return `<div class="fastener clip"${title}><svg viewBox="0 0 20 50"><path d="M6 15v22a4 4 0 0 0 8 0V9a6 6 0 0 0-12 0v31a8 8 0 0 0 16 0V16" fill="none" stroke="#8d949b" stroke-width="2.2" stroke-linecap="round"/></svg></div>`;
  }
  if (paper === "polaroid" || hash(n.id, 3) % 5 === 0){
    const tape = TAPE_COLORS[hash(n.id, 5) % TAPE_COLORS.length];
    const tilt = (hash(n.id, 9) % 11) - 5;
    return `<div class="fastener tape" style="--tape:${tape};--tilt:${tilt}deg"${title}></div>`;
  }
  return `<div class="fastener pin" style="--pin:${PIN_COLORS[hash(n.id, 1) % PIN_COLORS.length]}"${title}></div>`;
}
function createCardEl(n){
  const el = document.createElement("div");
  const paper = paperOf(n);
  el.className = `card paper-${paper}` + (n.done ? " done" : "") + (n.width || n.height ? " sized" : "");
  el.dataset.id = n.id;
  el.style.setProperty("--pc", n.color || COLORS[0]);
  el.style.left = (n.x ?? 0) + "px";
  el.style.top = (n.y ?? 0) + "px";
  if (n.width) el.style.width = n.width + "px";
  if (n.height) el.style.height = n.height + "px";
  gsap.set(el, { xPercent: -50, yPercent: -50, rotation: rot(n.id) });
  el.innerHTML = `
    ${fastenerHtml(n, paper)}
    ${n.done ? `<div class="stamp">HECHO</div>` : ""}
    <button class="del" data-del="${n.id}" title="Sacar del corcho">×</button>
    <button class="check" data-done="${n.id}" title="Marcar como hecha">✓</button>
    ${n.image_path?`<img class="thumb" src="/media/${n.id}" alt="" draggable="false">`:""}
    ${n.title?`<h3>${esc(n.title)}</h3>`:""}
    <div class="body">${esc(n.body)}</div>
    ${n.tags?`<div class="tags">${esc(n.tags)}</div>`:""}
    ${n.remind_at && !n.reminded?`<div class="reminder">⏰ ${fdatetime(n.remind_at)}</div>`:""}
    <div class="date">${srcBadge(n)}${fdate(n.created)}</div>
    <div class="resize-handle" data-resize="${n.id}" title="Arrastrá para cambiar el tamaño">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15 15 21M21 8 8 21"/></svg>
    </div>
  `;
  el.addEventListener("pointerdown", (e) => onCardPointerDown(e, n, el));
  el.querySelector(".resize-handle").addEventListener("pointerdown", (e) => onResizePointerDown(e, n, el));
  return el;
}

function onCardPointerDown(e, note, el){
  if (e.target.closest(".del") || e.target.closest(".check") || e.target.closest(".resize-handle")) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.stopPropagation();
  if (isReadOnly){ openDetail(note, el); return; }
  if (e.target.closest(".fastener")){ startLinking(e, note, el); return; }
  const pointerId = e.pointerId;
  const startX = e.clientX, startY = e.clientY;
  const startLeft = note.x ?? 0, startTop = note.y ?? 0;
  // ultima posicion conocida del puntero: al soltar se usa esta y no la del
  // evento final, porque pointercancel (ej. el navegador arranca un arrastre
  // nativo de la foto, o un toque largo en el celu) llega con coordenadas 0,0
  // y mandaba la nota lejisimos.
  let lastX = startX, lastY = startY;
  let moved = false;
  interacting = true;
  el.setPointerCapture(pointerId);

  function onMove(ev){
    if (ev.pointerId !== pointerId) return;
    // que el movimiento no llegue tambien al lienzo y lo arrastre a la vez
    ev.stopPropagation();
    lastX = ev.clientX; lastY = ev.clientY;
    const dx = (lastX - startX) / zoom;
    const dy = (lastY - startY) / zoom;
    if (!moved && Math.hypot(lastX - startX, lastY - startY) > 4){
      moved = true;
      el.classList.add("dragging");
      gsap.to(el, { scale: 1.08, duration: 0.18, ease: "power2.out" });
    }
    if (moved){
      el.style.left = (startLeft + dx) + "px";
      el.style.top = (startTop + dy) + "px";
      drawStrings();
    }
  }
  function onUp(ev){
    if (ev.pointerId !== pointerId) return;
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.classList.remove("dragging");
    interacting = false;
    if (ev.type === "pointerup"){ lastX = ev.clientX; lastY = ev.clientY; }
    if (moved){
      gsap.to(el, { scale: 1, duration: 0.55, ease: "elastic.out(1, 0.5)" });
      const dx = (lastX - startX) / zoom;
      const dy = (lastY - startY) / zoom;
      el.style.left = (startLeft + dx) + "px";
      el.style.top = (startTop + dy) + "px";
      drawStrings();
      const newX = Math.round(startLeft + dx), newY = Math.round(startTop + dy);
      const id = note.id;
      pushUndo("Movimiento deshecho", () => {
        const n = notes.find(x => x.id === id);
        if (n){ n.x = startLeft; n.y = startTop; apiPosition(id, startLeft, startTop); render(); }
      });
      note.x = newX; note.y = newY;
      apiPosition(note.id, newX, newY);
    } else if (ev.type === "pointerup"){
      openDetail(note, el);
    }
  }
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}

const MIN_CARD_W = 180, MIN_CARD_H = 140, MAX_CARD_W = 560, MAX_CARD_H = 640;
function onResizePointerDown(e, note, el){
  if (isReadOnly) return;
  e.stopPropagation();
  e.preventDefault();
  const handle = e.currentTarget;
  const startX = e.clientX, startY = e.clientY;
  const rect = el.getBoundingClientRect();
  const startW = rect.width / zoom, startH = rect.height / zoom;
  interacting = true;
  handle.setPointerCapture(e.pointerId);

  function onMove(ev){
    const dx = (ev.clientX - startX) / zoom;
    const dy = (ev.clientY - startY) / zoom;
    const w = Math.min(MAX_CARD_W, Math.max(MIN_CARD_W, Math.round(startW + dx)));
    const h = Math.min(MAX_CARD_H, Math.max(MIN_CARD_H, Math.round(startH + dy)));
    el.style.width = w + "px";
    el.style.height = h + "px";
    drawStrings();
    el.classList.add("sized");
  }
  function onUp(){
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    interacting = false;
    const w = parseInt(el.style.width, 10), h = parseInt(el.style.height, 10);
    note.width = w; note.height = h;
    apiSize(note.id, w, h);
  }
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

function render(){
  if (textEditing) finishTextEdit();
  const world = $("#world");
  world.innerHTML = "";
  // lo escrito sobre el corcho va primero: queda debajo de las notas
  const layer = document.createElement("div");
  layer.className = "marks";
  layer.id = "marks";
  world.appendChild(layer);
  renderMarks();
  $("#emptyState").style.display = notes.length || marks.length ? "none" : "flex";
  if (notes.length){
    const freshIds = [];
    // notes viene ordenado mas-nuevo-primero (para /listar del bot, etc).
    // Para el pintado hay que invertirlo: el ultimo <div> agregado al DOM
    // es el que queda arriba visualmente cuando dos notas se superponen,
    // asi que pintamos las mas viejas primero y la mas nueva al final.
    const byCreatedAsc = [...notes].sort((a, b) => a.created - b.created);
    byCreatedAsc.forEach(n => {
      const el = createCardEl(n);
      world.appendChild(el);
      if (!knownNoteIds.has(n.id)) freshIds.push({ n, el });
    });
    if (freshIds.length && !REDUCE_MOTION && hasRenderedOnce){
      freshIds.forEach(({ el }) => {
        gsap.from(el, {
          y: -70, scale: 0.4, opacity: 0,
          duration: 0.6, ease: "back.out(1.8)",
        });
      });
    }
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("strings");
  svg.id = "strings";
  world.appendChild(svg);
  knownNoteIds = new Set(notes.map(n => n.id));
  hasRenderedOnce = true;
  renderFilterChips();
  applySearchFilter();
}

// --- filtros: etiqueta y ocultar hechas (se recuerdan entre visitas) ---
const FILTER_KEY = "corcho.filters.v1";
let filters = { tag: null, hideDone: false };
try { filters = { ...filters, ...JSON.parse(localStorage.getItem(FILTER_KEY)) }; } catch(e){}
function saveFilters(){ try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch(e){} }
function noteTags(n){ return (n.tags||"").split(",").map(t => t.trim()).filter(Boolean); }
function passesFilters(n){
  if (filters.hideDone && n.done) return false;
  if (filters.tag && !noteTags(n).some(t => norm(t) === norm(filters.tag))) return false;
  return true;
}
function renderFilterChips(){
  const counts = new Map();
  for (const n of notes) for (const t of noteTags(n)){
    const k = norm(t);
    if (!counts.has(k)) counts.set(k, { label: t, count: 0 });
    counts.get(k).count++;
  }
  // si la etiqueta elegida ya no existe en ninguna nota, se suelta el filtro
  if (filters.tag && !counts.has(norm(filters.tag))){ filters.tag = null; saveFilters(); }
  const tags = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 12);
  $("#tagChips").innerHTML = tags.map(t =>
    `<button class="chip${filters.tag && norm(filters.tag)===norm(t.label) ? " on" : ""}" data-tag="${esc(t.label)}">#${esc(t.label)}</button>`
  ).join("");
  $("#hideDoneBtn").classList.toggle("on", filters.hideDone);
  $("#hideDoneBtn").style.display = notes.some(n => n.done) || filters.hideDone ? "" : "none";
}
$("#filters").addEventListener("click", (e) => {
  const tagBtn = e.target.closest("[data-tag]");
  if (tagBtn){
    filters.tag = filters.tag && norm(filters.tag) === norm(tagBtn.dataset.tag) ? null : tagBtn.dataset.tag;
  } else if (e.target.closest("#hideDoneBtn")){
    filters.hideDone = !filters.hideDone;
  } else return;
  saveFilters();
  renderFilterChips();
  applySearchFilter();
});
// --- hilos rojos ---
const SVG_NS = "http://www.w3.org/2000/svg";
function cardEl(id){ return document.querySelector(`.card[data-id="${CSS.escape(id)}"]`); }
// Punto de donde sale el hilo: el centro de arriba de la nota (donde esta la
// chinche), teniendo en cuenta que cada nota esta un poco girada.
function anchorOf(el){
  const n = notes.find(x => x.id === el.dataset.id);
  const angle = (n ? rot(n.id) : 0) * Math.PI / 180;
  const cx = parseFloat(el.style.left) || 0, cy = parseFloat(el.style.top) || 0;
  const h = el.offsetHeight;
  return { x: cx + (h / 2) * Math.sin(angle), y: cy - (h / 2) * Math.cos(angle) };
}
// Un hilo tensado pero no del todo: cuelga un poco por su propio peso.
function stringPath(a, b){
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const sag = Math.min(90, 12 + dist * 0.12);
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + sag;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}
function svgEl(tag, attrs){
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function drawStrings(){
  const svg = document.getElementById("strings");
  if (!svg) return;
  svg.querySelectorAll("g[data-link]").forEach(g => g.remove());
  for (const l of links){
    const ea = cardEl(l.a), eb = cardEl(l.b);
    if (!ea || !eb || ea.style.display === "none" || eb.style.display === "none") continue;
    const a = anchorOf(ea), b = anchorOf(eb), d = stringPath(a, b);
    const g = svgEl("g", { "data-link": l.id });
    // si alguna punta no coincide con la busqueda, el hilo tambien se apaga
    if (ea.style.opacity === "0.2" || eb.style.opacity === "0.2") g.setAttribute("opacity", "0.2");
    g.append(
      svgEl("path", { d, class: "string-shadow", transform: "translate(2 5)" }),
      svgEl("path", { d, class: "string" }),
      svgEl("path", { d, class: "string-hi" }),
      svgEl("circle", { cx: a.x, cy: a.y, r: 3.2, class: "knot" }),
      svgEl("circle", { cx: b.x, cy: b.y, r: 3.2, class: "knot" }),
      svgEl("path", { d, class: "string-hit", "data-cut": l.id }),
    );
    svg.insertBefore(g, svg.firstChild);
  }
}
async function apiLink(a, b){
  const r = checkAuth(await fetch("/api/links", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ a, b }) }));
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function apiUnlink(id){
  checkAuth(await fetch("/api/links/" + encodeURIComponent(id), { method:"DELETE" }));
}
async function cutLink(id){
  const prev = links.find(l => l.id === id);
  links = links.filter(l => l.id !== id);
  drawStrings();
  await apiUnlink(id);
  if (prev) toast("Hilo cortado", {
    action: "Deshacer", duration: 5000,
    onAction: async () => { const l = await apiLink(prev.a, prev.b); links.push(l); drawStrings(); },
  });
}
// Arrastrar desde la chinche (o cinta/clip) de una nota hasta otra las une.
// Si se suelta sin moverse, es un toque comun: abre la nota.
function startLinking(e, note, el){
  e.preventDefault();
  const handle = e.target.closest(".fastener");
  handle.setPointerCapture(e.pointerId);
  interacting = true;
  const svg = document.getElementById("strings");
  const from = anchorOf(el);
  const temp = svgEl("path", { class: "string temp" });
  svg.appendChild(temp);
  const startX = e.clientX, startY = e.clientY;
  let moved = false, target = null;
  function targetAt(ev){
    const hit = document.elementFromPoint(ev.clientX, ev.clientY);
    const c = hit && hit.closest(".card");
    return c && c !== el && c.style.display !== "none" ? c : null;
  }
  function onMove(ev){
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) moved = true;
    if (!moved) return;
    const rect = viewport.getBoundingClientRect();
    const p = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
    const t = targetAt(ev);
    if (t !== target){
      if (target) target.classList.remove("link-target");
      target = t;
      if (target) target.classList.add("link-target");
    }
    temp.setAttribute("d", stringPath(from, target ? anchorOf(target) : p));
  }
  async function onUp(){
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    temp.remove();
    interacting = false;
    if (target) target.classList.remove("link-target");
    if (!moved){ openDetail(note, el); return; }
    if (!target) return;
    const otherId = target.dataset.id;
    if (links.some(l => (l.a === note.id && l.b === otherId) || (l.b === note.id && l.a === otherId))){
      toast("Esas notas ya están unidas");
      return;
    }
    try{
      links.push(await apiLink(note.id, otherId));
      drawStrings();
      toast("Notas unidas con un hilo 🧵");
    }catch(err){ toast("No se pudo unir las notas"); }
  }
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

// --- marcador y textos sueltos, escritos directo sobre el corcho ---
// Quedan debajo de las notas. Todo se guarda en coordenadas del lienzo, asi
// que acompaña el pan y el zoom sin hacer nada.
const INKS = [
  { c: "#2B241C", n: "Negro" },
  { c: "#C8312B", n: "Rojo" },
  { c: "#2457A6", n: "Azul" },
  { c: "#2E7D4F", n: "Verde" },
  { c: "#F7F3EA", n: "Tiza blanca" },
];
const INK_SIZES = { thin: { stroke: 5, text: 32 }, thick: { stroke: 11, text: 58 } };
const INK_KEY = "corcho.ink.v1";
const MAX_STROKE_POINTS = 2800; // el server acepta hasta 3000
let ink = { color: INKS[0].c, size: "thin" };
try { ink = { ...ink, ...JSON.parse(localStorage.getItem(INK_KEY)) }; } catch(e){}
if (!INKS.some(i => i.c === ink.color)) ink.color = INKS[0].c;
if (!INK_SIZES[ink.size]) ink.size = "thin";
function saveInk(){ try { localStorage.setItem(INK_KEY, JSON.stringify(ink)); } catch(e){} }

let tool = "move";       // move | marker | text | eraser
let spaceDown = false;   // espacio apretado: arrastrar mueve el lienzo con cualquier herramienta
let inkGesture = null;   // trazo, borrado o toque de texto en curso
let textEditing = null;  // texto que se esta escribiendo

async function apiMarkCreate(m){
  const r = checkAuth(await fetch("/api/marks", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(m) }));
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function apiMarkUpdate(id, fields){
  const r = checkAuth(await fetch("/api/marks/" + encodeURIComponent(id), { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify(fields) }));
  if (!r.ok) throw new Error("HTTP " + r.status);
}
async function apiMarkDelete(id){
  checkAuth(await fetch("/api/marks/" + encodeURIComponent(id), { method:"DELETE" }));
}
async function apiMarkRestore(id){
  checkAuth(await fetch("/api/marks/" + encodeURIComponent(id) + "/restore", { method:"POST" }));
}

// Contorno de un trazo de marcador: la linea se suaviza un poco y el ancho
// varia con la presion del lapiz (o, con mouse/dedo, con la velocidad: mas
// rapido = mas fino), como en Excalidraw. Devuelve el path SVG relleno.
function inkPath(points, size, pen){
  const STREAMLINE = 0.45, THINNING = 0.5;
  const pts = [];
  let prev = null;
  for (const [x, y, p] of points){
    const cur = prev ? [prev[0] + (x - prev[0]) * (1 - STREAMLINE), prev[1] + (y - prev[1]) * (1 - STREAMLINE), p] : [x, y, p];
    if (prev && Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) < 0.5) continue;
    pts.push(cur); prev = cur;
  }
  // el suavizado se queda atras: que el trazo termine donde se solto
  const last = points[points.length - 1];
  if (pts.length > 1 && Math.hypot(last[0] - prev[0], last[1] - prev[1]) >= 0.5) pts.push(last);
  const n = pts.length;
  const f = v => Math.round(v * 10) / 10;
  if (n === 1){
    const [x, y] = pts[0], r = size / 2;
    return `M${f(x - r)},${f(y)} a${r},${r} 0 1,0 ${r * 2},0 a${r},${r} 0 1,0 ${-r * 2},0Z`;
  }
  // radio de cada punto
  const radii = [];
  let pr = 0.5;
  for (let i = 0; i < n; i++){
    if (pen) pr = pts[i][2];
    else if (i > 0){
      const sp = Math.min(1, Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]) / size);
      pr = Math.min(1, pr + (Math.min(1, 1 - sp) - pr) * sp * 0.275);
    }
    radii.push(Math.max(0.6, (size / 2) * (1 - THINNING * (0.5 - pr))));
  }
  // direccion de avance en cada punto
  const dirs = [];
  let lastDir = [1, 0];
  for (let i = 0; i < n; i++){
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    if (len > 1e-6) lastDir = [dx / len, dy / len];
    dirs.push(lastDir);
  }
  const left = [], right = [];
  for (let i = 0; i < n; i++){
    const [x, y] = pts[i], [dx, dy] = dirs[i], r = radii[i];
    left.push([x - dy * r, y + dx * r]);
    right.push([x + dy * r, y - dx * r]);
  }
  // puntas redondeadas: media vuelta alrededor del primer y el ultimo punto
  const cap = (i, sign) => {
    const out = [], [x, y] = pts[i], [dx, dy] = dirs[i], r = radii[i];
    for (let k = 1; k < 8; k++){
      const t = Math.PI * k / 8, c = Math.cos(t) * sign, s = Math.sin(t) * sign;
      out.push([x + r * (-dy * c + dx * s), y + r * (dx * c + dy * s)]);
    }
    return out;
  };
  const poly = [...left, ...cap(n - 1, 1), ...right.reverse(), ...cap(0, -1)];
  let d = `M${f(poly[0][0])},${f(poly[0][1])} Q`;
  for (let i = 0; i < poly.length; i++){
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    d += `${f(x0)},${f(y0)} ${f((x0 + x1) / 2)},${f((y0 + y1) / 2)} `;
  }
  return d + "Z";
}

function markEl(id){ return document.querySelector(`#marks [data-mark="${CSS.escape(id)}"]`); }
function createTextEl(m){
  const el = document.createElement("div");
  el.className = "mark-text";
  el.dataset.mark = m.id;
  el.textContent = m.data.text;
  el.style.left = m.x + "px";
  el.style.top = m.y + "px";
  el.style.color = m.color;
  el.style.fontSize = m.size + "px";
  el.addEventListener("pointerdown", (e) => onTextPointerDown(e, m, el));
  return el;
}
function renderMarks(){
  const layer = document.getElementById("marks");
  if (!layer) return;
  layer.innerHTML = "";
  const svg = svgEl("svg", { class: "marks-svg" });
  layer.appendChild(svg);
  for (const m of marks){
    if (m.kind === "stroke"){
      svg.appendChild(svgEl("path", { d: inkPath(m.data.points, m.size, m.data.pen), fill: m.color, "data-mark": m.id }));
    } else if (m.kind === "text"){
      layer.appendChild(createTextEl(m));
    }
  }
}

function eventWorld(e){
  const rect = viewport.getBoundingClientRect();
  return screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
}
function setTool(t){
  if (textEditing) finishTextEdit();
  tool = t;
  document.body.classList.remove("tool-move", "tool-marker", "tool-text", "tool-eraser");
  document.body.classList.add("tool-" + t);
  document.querySelectorAll("#drawTools [data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === t));
  updateToolOpts();
}
// colores y grosor: se ven con el marcador, con el texto o mientras se
// escribe un texto (y en ese caso cambian ese texto)
function updateToolOpts(){
  const show = tool === "marker" || tool === "text" || !!textEditing;
  $("#toolOpts").classList.toggle("show", show);
  const color = textEditing ? textEditing.color : ink.color;
  const size = textEditing ? (textEditing.size >= INK_SIZES.thick.text ? "thick" : "thin") : ink.size;
  $("#inkColors").innerHTML = INKS.map(i =>
    `<button class="ink-swatch${i.c === color ? " sel" : ""}" data-ink="${i.c}" title="${i.n}" style="background:${i.c}"></button>`
  ).join("");
  $("#inkSize").classList.toggle("thick", size === "thick");
  $("#inkSize").title = size === "thick" ? "Grueso (tocá para fino)" : "Fino (tocá para grueso)";
}
// que tocar la barra no le saque el foco al texto que se esta escribiendo
$("#drawTools").addEventListener("pointerdown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
$("#drawTools").addEventListener("click", (e) => {
  const t = e.target.closest("[data-tool]");
  if (t){ setTool(t.dataset.tool); return; }
  const sw = e.target.closest("[data-ink]");
  if (sw){
    if (textEditing){ textEditing.color = sw.dataset.ink; textEditing.el.style.color = sw.dataset.ink; }
    else { ink.color = sw.dataset.ink; saveInk(); }
    updateToolOpts();
    return;
  }
  if (e.target.closest("#inkSize")){
    if (textEditing){
      const thick = textEditing.size < INK_SIZES.thick.text;
      textEditing.size = INK_SIZES[thick ? "thick" : "thin"].text;
      textEditing.el.style.fontSize = textEditing.size + "px";
    } else { ink.size = ink.size === "thick" ? "thin" : "thick"; saveInk(); }
    updateToolOpts();
  }
});

// --- gestos de dibujo sobre el lienzo (los llama el manejo de punteros) ---
function startInk(e){
  if (tool === "marker"){
    const path = svgEl("path", { fill: ink.color, class: "drawing" });
    document.querySelector("#marks .marks-svg").appendChild(path);
    inkGesture = { type: "stroke", pointerId: e.pointerId, pen: e.pointerType === "pen", color: ink.color, size: INK_SIZES[ink.size].stroke, points: [], path, raf: 0 };
    interacting = true;
    addInkPoint(e);
    return true;
  }
  if (tool === "eraser"){
    inkGesture = { type: "eraser", pointerId: e.pointerId, erased: new Set() };
    interacting = true;
    eraseAt(e);
    return true;
  }
  if (tool === "text"){
    inkGesture = { type: "text", pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, at: eventWorld(e) };
    return true;
  }
  return false;
}
function addInkPoint(e){
  const g = inkGesture;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of evs.length ? evs : [e]){
    const p = eventWorld(ev);
    const last = g.points[g.points.length - 1];
    if (last && Math.hypot(p.x - last[0], p.y - last[1]) < 1 / zoom) continue;
    g.points.push([Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, g.pen ? (ev.pressure || 0.5) : 0.5]);
  }
  if (!g.raf) g.raf = requestAnimationFrame(() => {
    g.raf = 0;
    if (g.points.length) g.path.setAttribute("d", inkPath(g.points, g.size, g.pen));
  });
  // un trazo larguisimo se parte en varios, asi cada uno entra en el server
  if (g.points.length >= MAX_STROKE_POINTS){
    const tail = g.points[g.points.length - 1];
    commitStroke(g);
    const path = svgEl("path", { fill: g.color, class: "drawing" });
    document.querySelector("#marks .marks-svg").appendChild(path);
    inkGesture = { ...g, points: [tail], path, raf: 0 };
  }
}
function moveInk(e){
  const g = inkGesture;
  if (g.type === "stroke") addInkPoint(e);
  else if (g.type === "eraser") eraseAt(e);
  else if (g.type === "text" && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 6){
    // con la herramienta de texto, arrastrar sigue moviendo el lienzo
    inkGesture = null;
    startPanFrom({ x: g.sx, y: g.sy });
  }
}
function endInk(e){
  const g = inkGesture;
  inkGesture = null;
  interacting = false;
  if (g.type === "stroke"){
    if (g.raf) cancelAnimationFrame(g.raf);
    commitStroke(g);
  } else if (g.type === "eraser"){
    if (g.erased.size) eraseCommit([...g.erased]);
  } else if (g.type === "text" && e.type === "pointerup"){
    editText(null, g.at);
  }
}
// otro dedo apoyado = es un pellizco, no un trazo: se descarta lo empezado
function cancelInk(){
  const g = inkGesture;
  if (!g) return;
  inkGesture = null;
  interacting = false;
  if (g.type === "stroke"){ if (g.raf) cancelAnimationFrame(g.raf); g.path.remove(); }
  if (g.type === "eraser") g.erased.forEach(id => { const el = markEl(id); if (el) el.style.display = ""; });
}
async function commitStroke(g){
  if (!g.points.length){ g.path.remove(); return; }
  g.path.setAttribute("d", inkPath(g.points, g.size, g.pen));
  const xs = g.points.map(p => p[0]), ys = g.points.map(p => p[1]);
  try{
    const m = await apiMarkCreate({ kind: "stroke", x: Math.min(...xs), y: Math.min(...ys), color: g.color, size: g.size, data: { points: g.points, pen: g.pen } });
    marks.push(m);
    g.path.setAttribute("data-mark", m.id);
    g.path.classList.remove("drawing");
    pushUndo("Trazo deshecho", () => removeMarks([m.id]));
  }catch(err){
    g.path.remove();
    toast("No se pudo guardar el trazo");
  }
}

// --- goma: borra trazos y textos enteros, como en Excalidraw ---
function distToSegment(px, py, ax, ay, bx, by){
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function eraseAt(e){
  const g = inkGesture;
  const p = eventWorld(e);
  const tol = 10 / zoom;
  for (const m of marks){
    if (g.erased.has(m.id)) continue;
    let hit = false;
    if (m.kind === "stroke"){
      const pts = m.data.points, reach = m.size / 2 + tol;
      if (pts.length === 1) hit = Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= reach;
      for (let i = 1; i < pts.length && !hit; i++){
        hit = distToSegment(p.x, p.y, pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]) <= reach;
      }
    } else {
      const el = markEl(m.id);
      const r = el && el.getBoundingClientRect();
      hit = !!r && e.clientX >= r.left - 6 && e.clientX <= r.right + 6 && e.clientY >= r.top - 6 && e.clientY <= r.bottom + 6;
    }
    if (hit){
      g.erased.add(m.id);
      const el = markEl(m.id);
      if (el) el.style.display = "none";
    }
  }
}
async function removeMarks(ids){
  marks = marks.filter(m => !ids.includes(m.id));
  renderMarks();
  applySearchFilter();
  await Promise.all(ids.map(id => apiMarkDelete(id).catch(() => {})));
}
async function restoreMarks(ids){
  await Promise.all(ids.map(id => apiMarkRestore(id).catch(() => {})));
  await loadNotes();
  render();
}
async function eraseCommit(ids){
  await removeMarks(ids);
  const undo = () => restoreMarks(ids);
  pushUndo("Borrado deshecho", undo);
  toast(ids.length === 1 ? "Borrado" : `${ids.length} cosas borradas`, {
    action: "Deshacer", duration: 5000,
    onAction: async () => { const i = undoStack.findIndex(u => u.run === undo); if (i >= 0) undoStack.splice(i, 1); await undo(); },
  });
}

// --- textos sueltos ---
function onTextPointerDown(e, mark, el){
  if (el.classList.contains("editing")){ e.stopPropagation(); return; }
  // solo lectura, marcador o goma: el toque sigue de largo al lienzo
  if (isReadOnly || spaceDown) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (tool === "text"){ e.stopPropagation(); e.preventDefault(); editText(mark); return; }
  if (tool !== "move") return;
  // con la herramienta de mover: arrastrar lo mueve, tocarlo lo edita
  e.stopPropagation();
  e.preventDefault();
  const pointerId = e.pointerId;
  const startX = e.clientX, startY = e.clientY, startLeft = mark.x, startTop = mark.y;
  let lastX = startX, lastY = startY, moved = false;
  interacting = true;
  el.setPointerCapture(pointerId);
  function onMove(ev){
    if (ev.pointerId !== pointerId) return;
    ev.stopPropagation();
    lastX = ev.clientX; lastY = ev.clientY;
    if (!moved && Math.hypot(lastX - startX, lastY - startY) > 4){ moved = true; el.classList.add("dragging"); }
    if (moved){
      el.style.left = (startLeft + (lastX - startX) / zoom) + "px";
      el.style.top = (startTop + (lastY - startY) / zoom) + "px";
    }
  }
  function onUp(ev){
    if (ev.pointerId !== pointerId) return;
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.classList.remove("dragging");
    interacting = false;
    if (moved){
      const x = Math.round(startLeft + (lastX - startX) / zoom), y = Math.round(startTop + (lastY - startY) / zoom);
      el.style.left = x + "px"; el.style.top = y + "px";
      mark.x = x; mark.y = y;
      apiMarkUpdate(mark.id, { x, y }).catch(() => toast("No se pudo mover el texto"));
      const id = mark.id;
      pushUndo("Movimiento deshecho", async () => {
        const m = marks.find(x => x.id === id);
        if (!m) return;
        m.x = startLeft; m.y = startTop;
        renderMarks(); applySearchFilter();
        await apiMarkUpdate(id, { x: startLeft, y: startTop }).catch(() => {});
      });
    } else if (ev.type === "pointerup"){
      editText(mark);
    }
  }
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}
// Abre un texto para escribir: uno existente (mark) o uno nuevo en `at`.
function editText(mark, at){
  if (isReadOnly) return;
  if (textEditing) finishTextEdit();
  let el;
  if (mark){
    el = markEl(mark.id);
    if (!el) return;
  } else {
    const size = INK_SIZES[ink.size].text;
    // que el punto tocado quede a la altura de la primera linea
    at = { x: Math.round(at.x - 6), y: Math.round(at.y - size * 0.6) };
    el = createTextEl({ id: "", x: at.x, y: at.y, color: ink.color, size, data: { text: "" } });
    document.getElementById("marks").appendChild(el);
  }
  textEditing = {
    el, mark,
    x: mark ? mark.x : at.x, y: mark ? mark.y : at.y,
    color: mark ? mark.color : ink.color,
    size: mark ? mark.size : INK_SIZES[ink.size].text,
  };
  el.classList.add("editing");
  try { el.contentEditable = "plaintext-only"; } catch(err){ el.contentEditable = "true"; }
  if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
  el.addEventListener("keydown", onTextKey);
  el.addEventListener("blur", onTextBlur);
  el.focus();
  // cursor al final
  const sel = window.getSelection(), range = document.createRange();
  range.selectNodeContents(el); range.collapse(false);
  sel.removeAllRanges(); sel.addRange(range);
  updateToolOpts();
}
function onTextKey(e){
  e.stopPropagation(); // que las teclas no cambien de herramienta
  if (e.key === "Escape"){ e.preventDefault(); finishTextEdit(true); }
  else if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); finishTextEdit(); }
}
function onTextBlur(){ finishTextEdit(); }
async function finishTextEdit(cancel = false){
  const st = textEditing;
  if (!st) return;
  textEditing = null;
  const { el, mark } = st;
  el.removeEventListener("keydown", onTextKey);
  el.removeEventListener("blur", onTextBlur);
  el.classList.remove("editing");
  el.contentEditable = "false";
  if (document.activeElement === el) el.blur();
  updateToolOpts();
  const text = el.innerText.replace(/ /g, " ").replace(/\s+$/, "");
  if (cancel){
    if (!mark) el.remove();
    else { el.textContent = mark.data.text; el.style.color = mark.color; el.style.fontSize = mark.size + "px"; }
    return;
  }
  if (!mark){
    if (!text.trim()){ el.remove(); return; }
    try{
      const m = await apiMarkCreate({ kind: "text", x: st.x, y: st.y, color: st.color, size: st.size, data: { text } });
      marks.push(m);
      el.remove();
      document.getElementById("marks").appendChild(createTextEl(m));
      applySearchFilter();
      pushUndo("Texto deshecho", () => removeMarks([m.id]));
    }catch(err){ el.remove(); toast("No se pudo guardar el texto"); }
    return;
  }
  if (!text.trim()){ eraseCommit([mark.id]); return; }
  if (text === mark.data.text && st.color === mark.color && st.size === mark.size){ el.textContent = text; return; }
  const prev = { color: mark.color, size: mark.size, data: mark.data };
  mark.color = st.color; mark.size = st.size; mark.data = { text };
  el.textContent = text;
  const id = mark.id;
  try{ await apiMarkUpdate(id, { color: mark.color, size: mark.size, data: mark.data }); }
  catch(err){ toast("No se pudo guardar el texto"); }
  applySearchFilter();
  pushUndo("Cambio deshecho", async () => {
    const m = marks.find(x => x.id === id);
    if (!m) return;
    Object.assign(m, prev);
    renderMarks(); applySearchFilter();
    await apiMarkUpdate(id, prev).catch(() => {});
  });
}

function applySearchFilter(){
  const q = norm($("#search").value.trim());
  const cards = $("#world").querySelectorAll(".card");
  let visible = 0, matches = 0;
  cards.forEach(el => {
    const n = notes.find(x => x.id === el.dataset.id);
    const shown = !n || passesFilters(n);
    const isMatch = !n || !q || noteMatches(n, q);
    el.style.display = shown ? "" : "none";
    el.style.opacity = isMatch ? "1" : "0.2";
    el.style.pointerEvents = isMatch ? "auto" : "none";
    if (shown){ visible++; if (isMatch) matches++; }
  });
  // textos sueltos: tambien se buscan; los trazos se apagan mientras se busca
  $("#world").querySelectorAll(".mark-text:not(.editing)").forEach(el => {
    el.style.opacity = !q || norm(el.textContent).includes(q) ? "" : "0.2";
  });
  const msvg = $("#world .marks-svg");
  if (msvg) msvg.style.opacity = q ? "0.35" : "";
  drawStrings();
  const filtered = visible !== notes.length;
  $("#count").textContent = notes.length
    ? (filtered ? `${visible} de ${notes.length} notas` : `${notes.length} nota${notes.length>1?"s":""}`) + (q ? ` · ${matches} coinciden` : "")
    : "";
}

function focusFirstMatch(){
  const q = norm($("#search").value.trim());
  if (!q) return;
  const match = notes.find(n => passesFilters(n) && noteMatches(n, q));
  const textMatch = !match && marks.find(m => m.kind === "text" && norm(m.data.text).includes(q));
  if (!match && !textMatch){ toast("Sin resultados"); return; }
  const rect = $("#viewport").getBoundingClientRect();
  zoom = Math.max(zoom, 0.8);
  const fx = match ? (match.x ?? 0) : textMatch.x + 80, fy = match ? (match.y ?? 0) : textMatch.y + textMatch.size / 2;
  pan.x = rect.width/2 - fx * zoom;
  pan.y = rect.height/2 - fy * zoom;
  applyTransform();
  saveView();
}

function openEditor(note){
  editingId = note ? note.id : null;
  pickedColor = note ? (note.color||COLORS[0]) : COLORS[0];
  if (!note){
    const rect = $("#viewport").getBoundingClientRect();
    const center = screenToWorld(rect.width/2, rect.height/2);
    pendingPos = { x: Math.round(center.x + (Math.random()-0.5)*80), y: Math.round(center.y + (Math.random()-0.5)*80) };
  }
  $("#editTitle").textContent = note ? "Editar nota" : "Nueva nota";
  $("#titleInput").value = note ? note.title : "";
  $("#bodyInput").value = note ? note.body : "";
  $("#tagsInput").value = note ? note.tags : "";
  $("#reminderInput").value = note ? toDatetimeLocal(note.remind_at) : "";
  $("#paperInput").innerHTML = Object.entries(PAPERS).map(([k, label]) => `<option value="${k}">${label}</option>`).join("");
  $("#paperInput").value = note && note.paper && PAPERS[note.paper] ? note.paper : "";
  $("#colorRow").innerHTML = COLORS.map(c=>`<span data-c="${c}" style="background:${c}" class="${c===pickedColor?'sel':''}"></span>`).join("");
  $("#editOverlay").classList.add("open");
  setTimeout(()=>$("#bodyInput").focus(),50);
}

function linksBoxHtml(n){
  const mine = links
    .filter(l => l.a === n.id || l.b === n.id)
    .map(l => ({ link: l, other: notes.find(x => x.id === (l.a === n.id ? l.b : l.a)) }))
    .filter(x => x.other);
  if (!mine.length){
    return isReadOnly ? "" : `<div class="links-box"><div class="tip">🧵 Tip: arrastrá la chinche de esta nota hasta otra para unirlas con un hilo rojo.</div></div>`;
  }
  return `<div class="links-box"><div class="lbl">Conectada con</div>${mine.map(({ link, other }) => `
    <span class="link-chip">
      <button class="go" data-goto="${esc(other.id)}" title="Ir a esa nota">${esc(other.title || other.body.slice(0, 40) || "Nota")}</button>
      ${isReadOnly ? "" : `<button class="cut" data-unlink="${esc(link.id)}" title="Cortar el hilo">×</button>`}
    </span>`).join("")}</div>`;
}
function openDetail(n, sourceEl){
  $("#detailContent").innerHTML=`
    ${n.image_path?`<img src="/media/${n.id}" style="width:100%;border-radius:12px;margin-bottom:14px;display:block">`:""}
    ${n.title?`<h2>${esc(n.title)}</h2>`:""}
    <div class="body-full">${linkify(n.body)}</div>
    ${n.tags?`<div style="font-family:var(--hand);font-size:18px;color:var(--accent-dk);margin-top:10px">${esc(n.tags)}</div>`:""}
    ${n.remind_at?`<div style="font-size:13px;font-weight:600;color:var(--accent-dk);margin-top:10px">⏰ ${fdatetime(n.remind_at)}${n.reminded?" (ya avisado)":""}</div>`:""}
    <div style="font-size:11px;color:var(--mut);margin-top:8px">${srcBadge(n)}${fdate(n.created)}</div>
    ${linksBoxHtml(n)}
    <div class="row">
      ${isReadOnly ? "" : `<button class="btn ghost" data-toggledone="${n.id}">${n.done?"Marcar pendiente":"Marcar hecha"}</button>`}
      ${isReadOnly ? "" : `<button class="btn ghost" data-edit="${n.id}">Editar</button>`}
      <button class="btn ghost" data-copy="${n.id}">Copiar</button>
      ${(!isReadOnly && n.remind_at)?`<button class="btn ghost" data-clearreminder="${n.id}">Quitar recordatorio</button>`:""}
      ${isReadOnly ? "" : `<button class="btn ghost" data-delfull="${n.id}" style="color:#a33">Eliminar</button>`}
      <button class="btn" data-close>Cerrar</button>
    </div>`;
  const overlay = $("#detailOverlay");
  const sheet = overlay.querySelector(".sheet");
  overlay.classList.add("open");
  if (REDUCE_MOTION){
    return;
  }
  gsap.set(overlay, { backgroundColor: "rgba(43,36,28,0)" });
  gsap.to(overlay, { backgroundColor: "rgba(43,36,28,.5)", duration: 0.25, ease: "power1.out" });
  if (sourceEl){
    const r = sourceEl.getBoundingClientRect();
    const sr = sheet.getBoundingClientRect();
    gsap.fromTo(sheet,
      {
        x: (r.left + r.width/2) - (sr.left + sr.width/2),
        y: (r.top + r.height/2) - (sr.top + sr.height/2),
        scale: Math.max(0.15, Math.min(1, r.width / sr.width)),
        opacity: 0.7,
      },
      { x: 0, y: 0, scale: 1, opacity: 1, duration: 0.45, ease: "power3.out" }
    );
  } else {
    gsap.from(sheet, { scale: 0.9, opacity: 0, duration: 0.3, ease: "power2.out" });
  }
}

$("#addBtn").onclick=()=>openEditor(null);
$("#themeToggle").onclick=toggleTheme;
$("#cancelEdit").onclick=()=>$("#editOverlay").classList.remove("open");
$("#colorRow").onclick=(e)=>{ const s=e.target.closest("[data-c]"); if(!s)return; pickedColor=s.dataset.c; [...$("#colorRow").children].forEach(x=>x.classList.toggle("sel",x.dataset.c===pickedColor)); };
$("#saveEdit").onclick=async ()=>{
  const title=$("#titleInput").value.trim();
  const body=$("#bodyInput").value.trim();
  const tags=$("#tagsInput").value.trim();
  const paper=$("#paperInput").value;
  const reminderVal=$("#reminderInput").value;
  const remindAt = reminderVal ? new Date(reminderVal).getTime() : null;
  if(!body && !title){ toast("Escribí algo primero"); return; }
  let id = editingId;
  if(editingId){
    await apiUpdate(editingId, { title, body, tags, color:pickedColor, paper });
  }else{
    const created = await apiCreate({ title, body, tags, color:pickedColor, paper, x: pendingPos.x, y: pendingPos.y });
    id = created.id;
  }
  await apiReminder(id, remindAt);
  await loadNotes(); render();
  $("#editOverlay").classList.remove("open");
  toast(editingId?"Nota actualizada ✓":"Clavada en el corcho ✓");
  editingId=null;
};
$("#search").oninput = applySearchFilter;
$("#search").addEventListener("keydown", (e) => { if (e.key === "Enter") focusFirstMatch(); });
$("#world").addEventListener("click", async (e) => {
  const cut = e.target.closest("[data-cut]");
  if (cut && !isReadOnly){
    const id = cut.getAttribute("data-cut");
    toast("¿Cortar este hilo?", { action: "Cortar", duration: 4000, onAction: () => cutLink(id) });
    return;
  }
  const del = e.target.closest("[data-del]");
  if (del){
    e.stopPropagation();
    await deleteWithUndo(del.dataset.del);
    return;
  }
  const doneBtn = e.target.closest("[data-done]");
  if (doneBtn){
    e.stopPropagation();
    const n = notes.find(x => x.id === doneBtn.dataset.done);
    const cardEl = doneBtn.closest(".card");
    if (n) playDoneToggle(n, cardEl);
  }
});

function playDoneToggle(n, cardEl){
  n.done = n.done ? 0 : 1;
  apiDone(n.id, !!n.done);
  if (cardEl && !REDUCE_MOTION){
    gsap.timeline()
      .to(cardEl, { scale: 0.9, rotation: "+=8", duration: 0.15, ease: "power1.inOut" })
      .to(cardEl, { scale: 1, rotation: rot(n.id), duration: 0.3, ease: "power2.out", onComplete: render });
  } else {
    render();
  }
}
$("#detailOverlay").onclick=async (e)=>{
  if(e.target.id==="detailOverlay"||e.target.hasAttribute("data-close")){ $("#detailOverlay").classList.remove("open"); return; }
  const go=e.target.closest("[data-goto]"); if(go){ $("#detailOverlay").classList.remove("open"); openNoteById(go.dataset.goto); return; }
  const ul=e.target.closest("[data-unlink]"); if(ul){ $("#detailOverlay").classList.remove("open"); await cutLink(ul.dataset.unlink); return; }
  const ed=e.target.closest("[data-edit]"); if(ed){ const n=notes.find(x=>x.id===ed.dataset.edit); $("#detailOverlay").classList.remove("open"); openEditor(n); return; }
  const cp=e.target.closest("[data-copy]"); if(cp){ const n=notes.find(x=>x.id===cp.dataset.copy); navigator.clipboard.writeText((n.title?n.title+"\n\n":"")+n.body); toast("Copiado"); return; }
  const td=e.target.closest("[data-toggledone]"); if(td){ const n=notes.find(x=>x.id===td.dataset.toggledone); if(n){ $("#detailOverlay").classList.remove("open"); playDoneToggle(n, document.querySelector(`.card[data-id="${n.id}"]`)); } return; }
  const cr=e.target.closest("[data-clearreminder]"); if(cr){ const n=notes.find(x=>x.id===cr.dataset.clearreminder); if(n){ n.remind_at=null; await apiReminder(n.id, null); $("#detailOverlay").classList.remove("open"); render(); } return; }
  const df=e.target.closest("[data-delfull]"); if(df){ $("#detailOverlay").classList.remove("open"); await deleteWithUndo(df.dataset.delfull); }
};
$("#editOverlay").onclick=(e)=>{ if(e.target.id==="editOverlay") $("#editOverlay").classList.remove("open"); };
function blobToDataUrl(blob){
  return new Promise((resolve, reject)=>{ const r=new FileReader(); r.onload=()=>resolve(r.result); r.onerror=reject; r.readAsDataURL(blob); });
}
$("#exportBtn").onclick=async ()=>{
  if(!notes.length && !marks.length){ toast("No hay nada para exportar"); return; }
  toast("Armando backup…");
  // las fotos van embebidas en el backup, asi el archivo se restaura solo
  const out = await Promise.all(notes.map(async n=>{
    const copy = { ...n };
    delete copy.image_path; delete copy.telegram_chat_id; delete copy.telegram_message_id;
    if(n.image_path){
      try{
        const r = await fetch("/media/"+encodeURIComponent(n.id));
        if(r.ok) copy.image = await blobToDataUrl(await r.blob());
      }catch(e){}
    }
    return copy;
  }));
  const backup = {
    version: 3, notes: out, links: links.map(l => ({ a: l.a, b: l.b })),
    marks: marks.map(({ id, ...m }) => m),
  };
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download="corcho-backup-"+new Date().toISOString().slice(0,10)+".json"; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  toast("Backup descargado");
};
$("#importBtn").onclick=()=>{ if(isReadOnly){ toast("Solo lectura"); return; } $("#importFile").click(); };
$("#importFile").onchange=(e)=>{
  const f=e.target.files[0]; if(!f)return;
  e.target.value = ""; // permite volver a elegir el mismo archivo
  const r=new FileReader();
  r.onload=async ()=>{
    let d;
    try{ d=JSON.parse(r.result); }catch(err){ toast("Archivo inválido"); return; }
    // backups viejos: una lista de notas; nuevos: { notes, links }
    const bNotes = Array.isArray(d) ? d : (d && Array.isArray(d.notes) ? d.notes : null);
    const bLinks = d && Array.isArray(d.links) ? d.links : [];
    const bMarks = d && Array.isArray(d.marks) ? d.marks : [];
    if(!bNotes){ toast("Archivo inválido"); return; }
    const extra = bMarks.length ? ` (y ${bMarks.length} trazo${bMarks.length===1?"":"s"}/texto${bMarks.length===1?"":"s"} escritos en el corcho)` : "";
    if(!confirm(`¿Importar ${bNotes.length} nota${bNotes.length===1?"":"s"}${extra} al corcho? Se suman a lo que ya tenés.`)) return;
    try{
      const res = checkAuth(await fetch("/api/notes/import", {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ notes:bNotes, links:bLinks, marks:bMarks })
      }));
      if(!res.ok) throw new Error("HTTP "+res.status);
      const { imported, marks: importedMarks = 0 } = await res.json();
      await loadNotes(); render();
      toast(`${imported} nota${imported===1?"":"s"} importada${imported===1?"":"s"}` + (importedMarks ? ` + ${importedMarks} trazos/textos` : ""));
    }catch(err){ toast("No se pudo importar el backup"); }
  };
  r.readAsText(f);
};
document.addEventListener("keydown",e=>{
  if(e.key==="Escape"&&anyOverlayOpen()){ document.querySelectorAll(".overlay.open").forEach(o=>o.classList.remove("open")); return; }
  if((e.ctrlKey||e.metaKey)&&e.key==="Enter"&&$("#editOverlay").classList.contains("open")){ $("#saveEdit").click(); }
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"&&!anyOverlayOpen()&&!isTypingTarget(e.target)&&undoStack.length){
    e.preventDefault();
    const u = undoStack.pop();
    Promise.resolve(u.run()).then(() => toast(u.label));
    return;
  }
  if (isTypingTarget(e.target) || anyOverlayOpen() || e.ctrlKey || e.metaKey || e.altKey || isReadOnly) return;
  // atajos de herramientas, como en Excalidraw
  const toolKeys = { v: "move", h: "move", m: "marker", p: "marker", t: "text", e: "eraser" };
  const k = e.key.toLowerCase();
  if (toolKeys[k]){ setTool(toolKeys[k]); return; }
  if (e.key === "Escape" && tool !== "move"){ setTool("move"); return; }
  // espacio apretado: arrastrar mueve el lienzo con cualquier herramienta
  if (e.key === " "){
    e.preventDefault();
    if (!spaceDown){ spaceDown = true; document.body.classList.add("space-pan"); }
  }
});
document.addEventListener("keyup", (e) => {
  if (e.key === " " && spaceDown){ spaceDown = false; document.body.classList.remove("space-pan"); }
});
window.addEventListener("blur", () => { spaceDown = false; document.body.classList.remove("space-pan"); });
function isTypingTarget(t){
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

// --- pan y zoom del lienzo ---
const viewport = $("#viewport");
// Un dedo (o el mouse) arrastra el lienzo; dos dedos hacen zoom (pellizco)
// alrededor del punto medio entre ellos, y moverlos juntos tambien arrastra.
// Con el marcador, la goma o el texto, un dedo dibuja/borra/escribe; para
// moverse quedan los dos dedos, la rueda, espacio + arrastrar o el boton
// del medio del mouse.
const activePointers = new Map();
let pinch = null;
function startPanFrom(p){
  isPanning = true; interacting = true;
  viewport.classList.add("panning");
  panStart = { clientX:p.x, clientY:p.y, panX:pan.x, panY:pan.y };
}
function pinchInfo(){
  const [a, b] = [...activePointers.values()];
  const rect = viewport.getBoundingClientRect();
  return {
    dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    mid: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top },
  };
}
viewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".card") || e.target.closest("[data-cut]") || e.target.closest(".mark-text.editing")) return;
  if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
  // tocar afuera de un texto que se esta escribiendo lo cierra (y con la
  // herramienta de texto, ese toque no abre otro)
  if (textEditing){ finishTextEdit(); if (tool === "text") return; }
  viewport.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
  if (activePointers.size === 2){
    cancelInk();
    const { dist, mid } = pinchInfo();
    isPanning = false; panStart = null; interacting = true;
    pinch = { dist, world: screenToWorld(mid.x, mid.y), zoom };
  } else if (activePointers.size === 1){
    const wantsPan = tool === "move" || spaceDown || e.button === 1 || isReadOnly;
    if (!wantsPan && startInk(e)) return;
    startPanFrom({ x:e.clientX, y:e.clientY });
  }
});
// doble clic en el corcho vacio: un texto ahi mismo
viewport.addEventListener("dblclick", (e) => {
  if (tool !== "move" || isReadOnly || e.target.closest(".card") || e.target.closest(".mark-text") || e.target.closest("[data-cut]")) return;
  editText(null, eventWorld(e));
});
viewport.addEventListener("pointermove", (e) => {
  if (!activePointers.has(e.pointerId)) return;
  // si se perdio el pointerup (ej. se solto el boton fuera de la ventana),
  // no seguir arrastrando el lienzo con el mouse suelto
  if (e.pointerType === "mouse" && e.buttons === 0){ endPan(e); return; }
  activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
  if (inkGesture && inkGesture.pointerId === e.pointerId){ moveInk(e); return; }
  if (pinch && activePointers.size >= 2){
    const { dist, mid } = pinchInfo();
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.zoom * dist / pinch.dist));
    // el punto del corcho que estaba bajo los dedos sigue bajo los dedos
    pan.x = mid.x - pinch.world.x * zoom;
    pan.y = mid.y - pinch.world.y * zoom;
    applyTransform();
    return;
  }
  if (!isPanning || !panStart) return;
  pan.x = panStart.panX + (e.clientX - panStart.clientX);
  pan.y = panStart.panY + (e.clientY - panStart.clientY);
  applyTransform();
});
function endPan(e){
  if (inkGesture && inkGesture.pointerId === e.pointerId) endInk(e);
  activePointers.delete(e.pointerId);
  if (pinch && activePointers.size < 2){
    pinch = null;
    // si queda un dedo apoyado, sigue arrastrando desde donde esta
    if (activePointers.size === 1){ startPanFrom([...activePointers.values()][0]); return; }
  }
  if (activePointers.size === 0){
    isPanning = false; interacting = false; panStart = null;
    viewport.classList.remove("panning");
    saveView();
  }
}
viewport.addEventListener("pointerup", endPan);
viewport.addEventListener("pointercancel", endPan);
viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = viewport.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  if (e.ctrlKey){
    setZoomAt(cx, cy, zoom * Math.exp(-e.deltaY * 0.01));
  } else {
    pan.x -= e.deltaX; pan.y -= e.deltaY;
    applyTransform();
    scheduleSaveView();
  }
}, { passive:false });
$("#zoomIn").onclick = () => { const r=viewport.getBoundingClientRect(); setZoomAt(r.width/2, r.height/2, zoom*1.25); };
$("#zoomOut").onclick = () => { const r=viewport.getBoundingClientRect(); setZoomAt(r.width/2, r.height/2, zoom/1.25); };
$("#centerBtn").onclick = () => fitAll();

// --- cambios en vivo ---
// El server avisa por /api/events cada vez que cambia algo en el corcho
// (desde otra pestaña, otro dispositivo o el bot). Si en ese momento hay un
// editor abierto o un arrastre en curso, se recarga apenas termine.
let refreshPending = false, refreshTimer = null;
async function refresh(){
  if (anyOverlayOpen() || interacting || textEditing || inkGesture){ refreshPending = true; return; }
  refreshPending = false;
  try{ await loadNotes(); render(); }catch(e){}
}
// demora un poco para no cortar la animacion de soltar una nota y para
// juntar varios cambios seguidos en una sola recarga.
function scheduleRefresh(){ clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 700); }
if (window.EventSource){
  const events = new EventSource("/api/events");
  events.addEventListener("change", scheduleRefresh);
  // al reconectar (ej. se reinicio el server) puede haberse perdido algo
  let connectedOnce = false;
  events.addEventListener("open", () => { if (connectedOnce) scheduleRefresh(); connectedOnce = true; });
}
setInterval(() => { if (refreshPending) refresh(); }, 2000);
setInterval(refresh, 120000); // red de seguridad por si se cae la conexion en vivo

// --- abrir una nota puntual (desde una notificacion: /?note=<id>) ---
function openNoteById(id){
  const n = notes.find(x => x.id === id);
  if (!n){ toast("Esa nota ya no está en el corcho"); return; }
  const rect = $("#viewport").getBoundingClientRect();
  zoom = Math.max(zoom, 0.8);
  pan.x = rect.width/2 - (n.x ?? 0) * zoom;
  pan.y = rect.height/2 - (n.y ?? 0) * zoom;
  applyTransform();
  openDetail(n, document.querySelector(`.card[data-id="${CSS.escape(n.id)}"]`));
}

// --- notificaciones del navegador para los recordatorios (Web Push) ---
let pushKey = null;
function urlBase64ToUint8Array(b64){
  const padded = (b64 + "=".repeat((4 - b64.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
async function pushSubscription(){
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function updatePushBtn(){
  const sub = await pushSubscription();
  $("#pushBtn").textContent = sub ? "🔔" : "🔕";
  $("#pushBtn").title = sub ? "Avisos activados en este dispositivo (tocá para desactivar)" : "Activar avisos de recordatorios en este dispositivo";
  return sub;
}
async function setupPush(key){
  if (!key || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  pushKey = key;
  $("#pushBtn").style.display = "";
  const sub = await updatePushBtn();
  // re-sincroniza la suscripcion de este dispositivo con el server
  if (sub) fetch("/api/push/subscribe", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(sub) }).catch(()=>{});
}
$("#pushBtn").onclick = async () => {
  try{
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub){
      await fetch("/api/push/unsubscribe", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
      toast("Avisos desactivados en este dispositivo");
    } else {
      if (await Notification.requestPermission() !== "granted"){ toast("El navegador no dio permiso para avisos"); return; }
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(pushKey) });
      const r = await fetch("/api/push/subscribe", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(sub) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      toast("Listo: te aviso los recordatorios acá");
    }
  }catch(err){
    console.error(err);
    toast("No se pudieron cambiar los avisos");
  }
  updatePushBtn();
};

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(()=>{});
  // la notificacion pide abrir una nota en una pestaña que ya estaba abierta
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "open-note") openNoteById(e.data.id);
  });
}

setTool("move");
loadMe();
loadNotes().then(() => {
  initView();
  render();
  const params = new URLSearchParams(location.search);
  if (params.get("note")){
    openNoteById(params.get("note"));
    history.replaceState(null, "", "/");
  }
});
