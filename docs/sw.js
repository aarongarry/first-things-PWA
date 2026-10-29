// Bump on every release that changes a shell asset. One version = one full shell.
const CACHE = 'first-things-shell-v5';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './model.js', './session.js',
  './offline.js', './cloud.js', './supabase-config.js', './pwa.js',
  './george.png', './manifest.webmanifest', './icons/icon-192.png',
  './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/icon.svg',
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys())
      if (key.startsWith('first-things-shell-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') void self.skipWaiting();
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  // No account/API responses or third-party requests enter the app-shell cache.
  if (request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const shell = new Set(ASSETS.map(path => new URL(path, scope).href));
  if (request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match('./index.html')) || fetch(request)));
  } else if (shell.has(url.href)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(request)) || fetch(request)));
  }
});
