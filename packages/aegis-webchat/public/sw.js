/* U3 (Sprint 34): offline shell — no API cache */
const CACHE = 'aegis-webchat-v1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then((r) => r ?? caches.match('/index.html')),
    ),
  );
});
