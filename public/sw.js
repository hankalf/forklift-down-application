// Service worker: keeps the worker app usable in WiFi dead zones (steel racking
// blocks signal). Network-first for the app shell so updates arrive right away;
// falls back to the cached copy when offline. API calls are never cached here —
// the app keeps its own copy of the lift list and an outbox of unsent reports.
const CACHE = 'forklift-down-v2';
const SHELL = ['/', '/app.js', '/common.js', '/scan.js', '/styles.css', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // QR sticker links (/l/R-07) open instantly, even with no signal.
  if (url.pathname.startsWith('/l/')) {
    const unit = decodeURIComponent(url.pathname.slice(3));
    event.respondWith(Response.redirect(`/?lift=${encodeURIComponent(unit)}`, 302));
    return;
  }

  const isShell = url.pathname === '/' || SHELL.includes(url.pathname);
  if (!isShell) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.pathname === '/' ? '/' : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(url.pathname === '/' ? '/' : req, { ignoreSearch: true })),
  );
});
