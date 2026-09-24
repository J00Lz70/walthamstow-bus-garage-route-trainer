// W19 Route Trainer service worker: works offline, picks up new versions when online.
// __BUILD__ is replaced with the commit id on each deploy, so every deploy installs a fresh cache.
const VERSION = "__BUILD__";
const CACHE = "w19-app-" + VERSION;
const FONTS = "w19-fonts";
const CORE = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("w19-app-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // The app's own files: network first so updates show straight away, cache when offline
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req, { cache: "no-cache" });
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        return (await cache.match(req, { ignoreSearch: true })) ||
               (req.mode === "navigate" ? await cache.match("./index.html") : undefined) ||
               Response.error();
      }
    })());
    return;
  }

  // Google Fonts: cache first, so the page looks right offline
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith((async () => {
      const cache = await caches.open(FONTS);
      const hit = await cache.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === "opaque") cache.put(req, res.clone()); return res; }
      catch (err) { return Response.error(); }
    })());
  }
  // TfL requests go straight to the network; the page keeps its own last good copy.
});
