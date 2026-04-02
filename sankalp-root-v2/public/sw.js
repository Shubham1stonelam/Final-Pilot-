// SANKALP 2026 — Service Worker
// Handles: offline caching, push notifications, background sync

const CACHE_VERSION = 'sankalp-v2';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`;

// Files to cache on install
const STATIC_ASSETS = [
  '/',
  '/attendee',
  '/manifest.json',
  '/logo-sankalp.svg',
  '/logo-stonelam.svg'
];

// ─── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        // Non-fatal: some assets may not exist yet
        console.warn('[SW] Static cache partial failure:', err);
      });
    })
  );
});

// ─── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('sankalp-') && k !== STATIC_CACHE && k !== DYNAMIC_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── FETCH ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Don't intercept SSE, push subscription, or non-GET requests
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/events')) return;  // SSE stream
  if (url.pathname.startsWith('/api/')) return;         // API calls — always fresh

  // For navigation requests: try network first, fallback to cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(DYNAMIC_CACHE).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request).then(r => r || caches.match('/')))
    );
    return;
  }

  // Static assets: cache first, then network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(DYNAMIC_CACHE).then(c => c.put(event.request, clone));
        }
        return res;
      }).catch(() => null);
    })
  );
});

// ─── PUSH NOTIFICATIONS ───────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'SANKALP', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'SANKALP 2026';
  const options = {
    body: data.body || '',
    icon: '/logo-sankalp.svg',
    badge: '/logo-sankalp.svg',
    tag: data.id || 'sankalp-notification',
    renotify: true,
    requireInteraction: data.type === 'critical' || data.type === 'urgent',
    silent: false,
    vibrate: data.type === 'critical'
      ? [200, 100, 200, 100, 400]
      : data.type === 'urgent'
        ? [200, 100, 200]
        : [200],
    data: {
      id: data.id,
      type: data.type || 'normal',
      url: self.registration.scope,
      requiresAck: data.requiresAck || false
    },
    actions: data.type === 'critical' || data.type === 'urgent'
      ? [{ action: 'ack', title: '✓ Acknowledge' }]
      : []
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ─── NOTIFICATION CLICK ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const notifData = event.notification.data || {};

  // Handle acknowledge action
  if (event.action === 'ack' && notifData.id) {
    // Fire-and-forget ack
    fetch(`/api/ack/${notifData.id}`, { method: 'POST' }).catch(() => {});
  }

  // Open or focus the app
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If app is already open, focus it
      for (const client of windowClients) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow(notifData.url || '/');
      }
    })
  );
});

// ─── MESSAGE FROM CLIENT ──────────────────────────────────────────────────────
self.addEventListener('message', event => {
  const msg = event.data || {};

  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // Client can request cache clear
  if (msg.type === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
    return;
  }

  // Ping from attendee page to keep SW alive
  if (msg.type === 'PING') {
    event.source && event.source.postMessage({ type: 'PONG' });
    return;
  }
});

// ─── BACKGROUND SYNC (if supported) ──────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-feedback') {
    event.waitUntil(syncPendingFeedback());
  }
});

async function syncPendingFeedback() {
  // Retrieve any pending feedback from IDB and retry submission
  // Implementation can be extended when IndexedDB is wired up
  console.log('[SW] Background sync: feedback');
}
