// Service worker: caches the app shell + engine bundle for offline launch.
//
// Strategy:
//   - App shell (HTML, JS modules, manifest, icons): cache-first, so the app
//     opens instantly and works with no network.
//   - API calls (/games/*): never cached — always go to the network. When the
//     scorer is offline these simply fail, and the page's offline queue holds
//     the events until connectivity returns.
//   - Cross-origin (web fonts): stale-while-revalidate.
const VERSION = "scorekeeper-v2";
const SHELL = [
  "./",
  "setup.html",
  "scoring-app.html",
  "follower.html",
  "dist/engine.js",
  "playlog.js",
  "sync-client.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // never touch POSTs (event sync)
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // API + live stream: always network, never cached.
  if (sameOrigin && url.pathname.startsWith("/games")) return;

  if (sameOrigin) {
    // App shell: cache-first, fall back to network, then to the app page.
    e.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => (req.mode === "navigate" ? caches.match("scoring-app.html") : Response.error()));
      })
    );
    return;
  }

  // Cross-origin (fonts): stale-while-revalidate.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
