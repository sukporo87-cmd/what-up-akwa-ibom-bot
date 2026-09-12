/* ============================================
   FILE: src/views/sw.js — web-play service worker
   ============================================

   WHAT THIS IS FOR, AND WHAT IT MUST NEVER DO.

   It exists so web-play can be installed to a home screen: standalone display,
   a faster cold start, and — the reason it is on the roadmap at all — because
   an installed PWA is the ONLY way an iPhone can receive web push. A normal
   Safari tab cannot receive push at all.

   It is deliberately almost empty of caching. A trivia game is live: the
   question, the clock, the lobby and the scoreboard are worthless a second
   after they were true, and a service worker that served any of them from a
   cache would hand a player a stale question with a dead timer. So:

     * NOTHING under /web, /challenge, /api, /admin, /auth or /c is ever
       cached or served from cache. Those requests are passed straight to the
       network and this file gets out of the way.
     * The event stream (/web/game/stream) is not touched. A service worker
       that buffers an EventSource breaks the live match outright.
     * Only GET is ever considered. A POST going through a cache is a bug
       waiting for a bad network.

   What IS cached is the shell: the page itself, the icons, Tiva. The page is
   network-first so a deploy is picked up on the next load; the cache is only
   the fallback for a player who opens the app with no signal.
*/

const VERSION = 'wut-shell-v1';
const SHELL = [
  '/',
  '/media/tiva.webp',
  '/media/tiva.png',
  '/media/icon-192.png',
  '/media/icon-512.png',
  '/media/icon-maskable-512.png',
  '/manifest.webmanifest'
];

// Anything that is live, private, or an action. Never cached, never replayed.
const NEVER_CACHE = /^\/(web|challenge|api|admin|auth|c)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // addAll fails the whole install if ANY entry 404s, which would leave
      // the app uninstallable because one icon was renamed. Add them
      // individually and let the misses go.
      .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Someone else's origin: fonts, media, a payment gateway. Not ours to cache.
  if (url.origin !== self.location.origin) return;

  // Live game traffic and the event stream. Hands off entirely.
  if (NEVER_CACHE.test(url.pathname)) return;
  if (req.headers.get('accept') === 'text/event-stream') return;

  // The page itself: network first, so a deploy shows up on the next load.
  // The cached copy is only for opening the app with no signal.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/').then(hit => hit || Response.error()))
    );
    return;
  }

  // Static shell files: cache first, they are versioned by deploy.
  event.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});

// The page asks for a fresh worker after a deploy.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

/* PUSH is not wired up yet — that is the next step, and it needs a signing key
   pair and a subscription store on the server. When it lands, the handlers go
   here: 'push' to show the notification, 'notificationclick' to focus or open
   the lobby. Leaving them out is deliberate; an empty push handler shows the
   browser's own "This site has been updated in the background" notice, which
   is worse than no push at all. */
