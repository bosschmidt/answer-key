// Service worker: keeps the app files so the app opens offline.
// Bump VERSION whenever any file listed in SHELL changes. A device then fetches the new files the next time
// the app is opened (or brought back to the front) while online, and the open page reloads itself into them.
const VERSION = 'v2';
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
      .then(() => self.clients.claim()));      // the open page sees a new controller and reloads itself (app.js)
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
