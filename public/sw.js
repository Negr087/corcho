const STATIC_CACHE = "corcho-static-v1";
const STATIC_ASSETS = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/logocorcho.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Solo cacheamos assets estaticos que no dependen de la sesion del usuario
// (logo, iconos, manifest). Las paginas y /api/* siempre van a la red: son
// datos privados por usuario, cachearlos podria mostrarle a alguien
// contenido de otra sesion en el mismo dispositivo.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  if (!STATIC_ASSETS.includes(url.pathname)) return;

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

// --- notificaciones de recordatorios (Web Push) ---
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || "⏰ Recordatorio", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.noteId ? `note-${data.noteId}` : undefined,
      renotify: true,
      data: { noteId: data.noteId },
      actions: data.noteId
        ? [
            { action: "done", title: "✓ Hecha" },
            { action: "snooze", title: "+1 hora" },
          ]
        : [],
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  const noteId = event.notification.data && event.notification.data.noteId;
  event.notification.close();
  const api = (path, body) =>
    fetch(`/api/notes/${encodeURIComponent(noteId)}/${path}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  if (noteId && event.action === "done") {
    event.waitUntil(api("done", { done: true }));
    return;
  }
  if (noteId && event.action === "snooze") {
    event.waitUntil(api("snooze", { kind: "1h" }));
    return;
  }
  // click en la notificacion: abre (o enfoca) el corcho en esa nota
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => new URL(w.url).origin === location.origin);
      if (win) {
        if (noteId) win.postMessage({ type: "open-note", id: noteId });
        return win.focus();
      }
      return self.clients.openWindow(noteId ? `/?note=${encodeURIComponent(noteId)}` : "/");
    })
  );
});
