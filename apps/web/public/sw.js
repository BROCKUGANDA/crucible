// Crucible service worker — static shell only, never caches /api (gate 488).
//
// Navigations are network-first: the cached "/" from the old cache-first rule
// kept serving the previous build's HTML to returning visitors, so a new
// deploy was invisible to anyone whose browser had the shell cached, and the
// stale HTML referenced chunks the new build no longer emits (404s under
// strict MIME checking). The manifest and icons stay cache-first.
const CACHE = "crucible-shell-v2";
const SHELL = ["/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Never cache API, SSE, or dynamic data.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ticker")) {
    return;
  }
  if (req.method !== "GET") return;

  if (req.mode === "navigate") {
    // network-first for navigations, so a deploy is never hidden behind a
    // stale precache; offline falls back to the last cached shell.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached ?? caches.match("/"))),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
          }
          return res;
        });
    }),
  );
});
