// Service worker: what makes Faaglarna installable, and what keeps it opening
// when the network is not there.
//
// NETWORK FIRST, CACHE AS A FALLBACK — deliberately, and not the usual advice.
// The conventional cache-first shell is faster, and it means a deploy does not
// reach anyone until the worker updates, which on a script editor under active
// development is a way to ship a bug that cannot be recalled. Here the network
// always wins when it answers; the cache exists for when it does not.
//
// WHAT IS NEVER CACHED. /api/ is the live document store, and a stale answer
// there is worse than an error: it would show a script as it was. Collaboration
// runs over a WebSocket, which does not pass through fetch at all.
//
// The app already has an offline mode of its own — backend.js falls back to
// IndexedDB when no server answers — so caching the shell is what makes that
// reachable from a home screen with no connection, rather than a new feature.

const VERSION = 'faaglarna-v1';

// The shell: enough to boot the app and open a locally stored script. The Yjs
// bundle is deliberately absent - it is fetched on demand, only in cloud mode,
// and cloud mode needs the network anyway.
const SHELL = [
  '.', 'index.html', 'style.css', 'config.js',
  'fountain.js', 'pagination.js',
  'collab.js', 'comments.js', 'suggestions.js', 'blame.js', 'review.js',
  'cloud.js', 'backend.js', 'app.js',
  'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Individually, not addAll: one 404 would otherwise abort the whole install
    // and leave the app uninstallable for a missing icon.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // someone else's server
  if (url.pathname.startsWith('/api/')) return;         // live data, never cached
  if (url.pathname === '/collab') return;               // the websocket handshake

  ev.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // Only put back what actually arrived. An opaque or error response cached
      // here would be served as the app on the next flight.
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const cache = await caches.open(VERSION);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      // A navigation with nothing cached for that exact URL still wants the
      // app, not a browser error page.
      if (req.mode === 'navigate') {
        const shell = await caches.match('index.html') || await caches.match('.');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
