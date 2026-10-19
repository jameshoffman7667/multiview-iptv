'use strict';
// Service worker: keeps only the app shell (page, script, styles, icons) so the installed app opens quickly and shows a
// friendly page when the server cannot be reached. It never stores video, API answers, recordings, casts or login pages.
// The cache name carries the app version (a test keeps it equal to package.json), so a new version starts a fresh cache.
const VERSION = '0.6.0';
const CACHE = 'mv-shell-' + VERSION;
const SHELL = ['/', '/styles.css', '/app.js', '/vendor/mpegts.js', '/manifest.webmanifest', '/offline.html', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon.svg'];
const NEVER = /^\/(api|stream|ws|vod|recordings|cast)(\/|$)|^\/(healthz|sw\.js)$/;

self.addEventListener('install', (event) => {
  // One missing file (or a login wall in front of the server) must not stop the worker from installing.
  event.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('mv-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// The page asks before updating, because updating restarts every stream that is playing.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok && url.pathname === '/') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match('/offline.html').then((r) => r || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }))));
    return;
  }
  if (!SHELL.includes(url.pathname)) return;
  // shell files: the network first (so a new version is picked up straight away), the cache when it cannot be reached
  event.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || Response.error())));
});
