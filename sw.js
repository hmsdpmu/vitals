/*
 * HDMP VITALS 2.0 Field App — offline worker
 * Version 0.2.0 (28 November 2026) — Phase 2, Task 4 (no change to how the worker works; new version so devices pick up the new app)
 * Keeps the app's own files on the device so it opens with no internet.
 * Never stores sync service replies: hospital data lives in the app's database only.
 */
const APP_VERSION = '0.2.0';
const SHELL_CACHE = 'vitals2-shell-' + APP_VERSION;
const FONT_CACHE = 'vitals2-fonts';
const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('vitals2-shell-') && n !== SHELL_CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'SW_VERSION', version: APP_VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App files: from the device first, so the app opens offline.
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith((async () => {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('./index.html')) || (await cache.match('./')) || fetch(req);
      })());
      return;
    }
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      return hit || fetch(req);
    })());
    return;
  }

  // Brand fonts: keep a copy after the first online open.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return new Response('', { status: 503 });
      }
    })());
  }
  // Everything else (the sync service) goes straight to the network and is never stored here.
});
