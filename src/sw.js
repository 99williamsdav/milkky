// Service worker: shows push notifications from the game server (games played at leisure) and opens the game when
// one is tapped. Nothing is cached; the game always loads fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Milkky', {
    body: d.body || '', tag: d.tag || 'milkky', renotify: true,
    icon: '/icon-192.png', badge: '/favicon-32.png', data: { url: d.url || '/' },
  }));
});

// Back to the game: an open Milkky tab if there is one (showing that room), otherwise a new one
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find(c => new URL(c.url).origin === self.location.origin);
    if (tab) { await tab.focus(); return tab.navigate(url).catch(() => {}); }
    return self.clients.openWindow(url);
  })());
});
