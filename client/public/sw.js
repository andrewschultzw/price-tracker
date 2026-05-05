// client/public/sw.js
// Plain JS — not bundled by Vite. Served directly at /sw.js with root scope.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', e => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; }
  catch { payload = { title: 'Price Tracker', body: (e.data && e.data.text()) || '' }; }
  e.waitUntil(self.registration.showNotification(payload.title || 'Price Tracker', {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: { url: payload.url || '/' },
    tag: payload.tag,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.location.origin)) {
        await w.focus();
        w.postMessage({ type: 'navigate', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
