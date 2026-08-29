// Service Worker for ChatMux PWA
// Cache only manifest (needed for PWA install). HTML and JS are never pre-cached
// so a rebuild + refresh always picks up the latest assets.
// v2: purges v1 caches that could hold poisoned asset entries (404/HTML bodies
// cached under hashed asset URLs during a release swap → permanent white
// screen on installed PWAs, because /assets/ is served cache-first forever).
const CACHE_NAME = 'chatmux-v2-__CHATMUX_RUNNING_VERSION__';
const urlsToCache = [
  '/manifest.json'
];

const ACTIVATE_MESSAGE = 'chatmux:activate';

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

// Fetch event — network-first for everything except hashed assets
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept API requests or WebSocket upgrades
  if (url.includes('/api/') || url.includes('/ws')) {
    return;
  }

  // Navigation requests (HTML) — always go to network, no caching
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/manifest.json').then(() =>
        new Response('<h1>Offline</h1><p>Please check your connection.</p>', {
          headers: { 'Content-Type': 'text/html' }
        })
      ))
    );
    return;
  }

  // Hashed assets (JS/CSS in /assets/) — cache-first since filenames change per build
  if (url.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          // Only cache real module/style responses. A 404 or an HTML error
          // page cached under a hashed asset URL would be served cache-first
          // forever and permanently blank the app (no reload can recover).
          const contentType = response.headers.get('content-type') || '';
          const isCacheable = response.ok
            && response.status === 200
            && !contentType.includes('text/html');
          if (isCacheable) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else — network-first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

self.addEventListener('message', event => {
  if (event.data === ACTIVATE_MESSAGE) {
    event.waitUntil(self.skipWaiting());
  }
});

// Activate event — purge old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

const MAX_NOTIFICATION_TITLE_LENGTH = 256;

function notificationTitle(value) {
  return typeof value === 'string' && value.trim() && value.length <= MAX_NOTIFICATION_TITLE_LENGTH
    ? value
    : 'ChatMux';
}

function completionTag(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NOTIFICATION_TITLE_LENGTH
    ? value
    : null;
}

function navigationHref(navigation) {
  if (!navigation || typeof navigation.href !== 'string' || !navigation.href.startsWith('/')) {
    return null;
  }

  try {
    const url = new URL(navigation.href, self.location.origin);
    return url.origin === self.location.origin ? navigation.href : null;
  } catch {
    return null;
  }
}

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A session deep link is either the legacy local route or a host-qualified one.
// A host segment that is not a canonical host id yields no session at all: the
// same local id exists on other installations, so guessing would open the wrong
// machine's conversation.
function sessionTargetFromNavigationHref(href) {
  try {
    const url = new URL(href, self.location.origin);
    const local = url.pathname.match(/^\/session\/([^/]+)$/);
    if (local) {
      return { sessionId: decodeURIComponent(local[1]), hostId: null };
    }
    const qualified = url.pathname.match(/^\/hosts\/([^/]+)\/session\/([^/]+)$/);
    if (!qualified) {
      return { sessionId: null, hostId: null };
    }
    const hostId = decodeURIComponent(qualified[1]);
    return HOST_ID.test(hostId)
      ? { sessionId: decodeURIComponent(qualified[2]), hostId }
      : { sessionId: null, hostId: null };
  } catch {
    return { sessionId: null, hostId: null };
  }
}

function completionNavigation(navigation) {
  const href = navigationHref(navigation) || '/';
  const target = sessionTargetFromNavigationHref(href);
  return { href, sessionId: target.sessionId, hostId: target.hostId };
}
function isSameOriginClient(client) {
  try {
    return new URL(client.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

function focusClientOrOpen(target, onFocused) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
    const client = clientList.find(isSameOriginClient);
    if (client) {
      await client.focus();
      return onFocused(client);
    }
    return self.clients.openWindow(target);
  });
}

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'ChatMux', body: event.data.text() };
  }

  const tag = completionTag(payload.tag);
  const isCompletion = Object.prototype.hasOwnProperty.call(payload, 'navigation');
  const options = isCompletion
    ? {
      body: typeof payload.body === 'string' ? payload.body : '',
      icon: '/logo-256.png',
      badge: '/logo-128.png',
      data: { navigation: completionNavigation(payload.navigation) },
      ...(tag ? { tag, renotify: true } : { renotify: false })
    }
    : {
      body: payload.body || '',
      icon: '/logo-256.png',
      badge: '/logo-128.png',
      data: payload.data || {},
      tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
      renotify: true
    };

  event.waitUntil(
    self.registration.showNotification(notificationTitle(payload.title), options)
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const navigation = navigationHref(event.notification.data?.navigation);
  if (navigation) {
    // Notifications created by an older installed worker only stored href.
    // Recover the id from the already same-origin-validated route so the
    // focused-client fallback still opens the right chat when navigate()
    // rejects (notably on iOS standalone PWAs).
    const storedTarget = sessionTargetFromNavigationHref(navigation);
    const storedSessionId = event.notification.data?.navigation?.sessionId;
    const sessionId = typeof storedSessionId === 'string' && storedSessionId
      ? storedSessionId
      : storedTarget.sessionId;
    const storedHostId = event.notification.data?.navigation?.hostId;
    const hostId = typeof storedHostId === 'string' && HOST_ID.test(storedHostId)
      ? storedHostId
      : storedTarget.hostId;
    event.waitUntil(
      focusClientOrOpen(navigation, client => {
        client.postMessage({
          type: 'notification:navigate',
          sessionId,
          hostId,
          provider: null,
          urlPath: navigation
        });
        try {
          return Promise.resolve(client.navigate(navigation)).catch(() => undefined);
        } catch {
          return Promise.resolve();
        }
      })
    );
    return;
  }

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  // Legacy payloads carry no installation id and stay local-only.
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    focusClientOrOpen(urlPath, client => {
      client.postMessage({
        type: 'notification:navigate',
        sessionId: sessionId || null,
        hostId: null,
        provider,
        urlPath
      });
    })
  );
});
