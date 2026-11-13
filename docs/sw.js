// Bump on every release that changes a shell asset. One version = one full shell.
const CACHE = 'first-things-shell-v43';
const ASSETS = [
  './', './index.html', './styles.css', './notebook.css', './app.js', './model.js', './session.js',
  './shortcut.js', './offline.js', './cloud.js', './supabase-config.js', './pwa.js', './reminders.js',
  './notebook-binding.svg', './george-stick.svg', './george.png', './george-face.png', './manifest.webmanifest', './icons/icon-192.png',
  './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/icon.svg',
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(path => new Request(path, { cache: 'reload' })))));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys())
      if (key.startsWith('first-things-shell-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* plain-text push */ }
  event.waitUntil(self.registration.showNotification(data.title || 'First Things', {
    body: data.body || 'You still have first things to finish.',
    icon: './icons/icon-192.png', badge: './icons/icon-192.png',
    tag: 'first-things-daily', data: { url: './' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) if ('focus' in client) return client.focus();
    return self.clients.openWindow(event.notification.data?.url || './');
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
