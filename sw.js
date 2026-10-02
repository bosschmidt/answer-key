// Service worker: keeps the app files so the app opens offline.
// Bump VERSION whenever any file listed in SHELL changes; devices then fetch the new files on their next online open.
const VERSION = 'v1';
const CACHE = `answer-key-${VERSION}`;
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'store.js', 'crypto.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('answer-key-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // The index and the encrypted books always come from the network; the app keeps them in IndexedDB.
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/data/')) return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(event.request).catch(() =>
        (event.request.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    }));
});
