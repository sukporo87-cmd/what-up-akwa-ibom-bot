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

const VERSION = 'wut-shell-v3';
const SHELL = [
  '/',
  /* The lobby's Tiva clips are deliberately absent: about half a megabyte,
     for a screen only players in a live challenge ever see. They load when
     the lobby opens. The old stills went with the clip that replaced them. */
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

/* ============================================
   PUSH
   ============================================
   Every message we send is a moment the player is already waiting for: their
   lobby opening, their challenge starting. There is no marketing here.

   A push handler must ALWAYS end in a visible notification. Browsers grant
   the permission on the understanding that a push is shown to the user, and a
   handler that receives one silently gets the site's permission revoked. So
   the catch below still shows something rather than nothing. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }

  const title = data.title || "What's Up Trivia";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || 'Open the app to see what is waiting.',
      icon: '/media/icon-192.png',
      badge: '/media/icon-192.png',
      // Same tag replaces rather than stacks: two reminders for one challenge
      // should be one line in the shade, not two.
      tag: data.tag || 'wut',
      renotify: true,
      // A lobby reminder is time-critical — it should not be held back by the
      // browser's quiet heuristics.
      requireInteraction: false,
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  // Focus the app if it is already open rather than opening a second copy —
  // a player with two windows on one live match is the single-stream problem
  // all over again.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.indexOf(self.location.origin) === 0 && 'focus' in client) {
          if ('navigate' in client && target !== '/') client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

/* A push service can retire a subscription on its own — after a long silence,
   or when the browser rotates its keys. The page re-subscribes on its next
   visit; there is nothing useful to do from here without the VAPID key. */
self.addEventListener('pushsubscriptionchange', () => {});