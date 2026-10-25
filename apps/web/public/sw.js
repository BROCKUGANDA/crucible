// Crucible service worker — static shell only, never caches /api (gate 488).
const CACHE = "crucible-shell-v2";
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/icon-512.png"];

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
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  // API, SSE, RSC, and navigations are dynamic: never serve them cache-first.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/ticker") ||
    req.headers.has("RSC") ||
    url.searchParams.has("_rsc")
  ) return;
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }
  // Only explicitly immutable/static assets are eligible for the shell cache.
  const isStatic = url.pathname.startsWith("/_next/static/") ||
    ["/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/icon-512.png"].includes(url.pathname);
  if (!isStatic) return;
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => undefined);
      return res;
    })),
  );
});