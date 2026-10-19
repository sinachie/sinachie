const CACHE = 'sinachie-v2.2';
self.addEventListener('install', e => {
  self.skipWaiting(); // Force the new service worker to take over immediately
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/index.html', '/app.js', '/manifest.json'])));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.map(k => { if (k !== CACHE) return caches.delete(k); }) // Delete old caches
  )));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); // Network first to get updates
});