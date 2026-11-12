// Offline support: always try the network first so updates arrive at once,
// and fall back to the saved copy when there is no connection.
const CACHE = 'notes-app-v30';
const SHELL = ['./', 'index.html', 'app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/db.js', 'js/vault.js', 'js/markdown.js', 'js/graph.js', 'js/sync.js',
  'js/editor.js', 'js/editmenu.js','js/schema.js', 'js/yadisk.js', 'js/media.js', 'js/calendar.js', 'js/calendar-data.js', 'js/push.js', 'js/native.js', 'vendor/codemirror.js'];

self.addEventListener('install', e => {
  // cache: 'reload' — take the files from the site, not from the browser's HTTP cache.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/mock-github')) return;
  // 'no-cache': always ask the site whether the file changed (GitHub Pages lets
  // browsers keep files for 10 minutes, which delayed updates in the Android app).
  e.respondWith(
    fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(hit => hit || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});

// A tap on a reminder opens (or focuses) the app on that event.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '#calendar', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const win = list.find(c => c.url.startsWith(self.registration.scope));
    if (win) { win.postMessage({ type: 'open', url }); return win.focus(); }
    return self.clients.openWindow(url);
  }));
});

// A reminder from the push server (the app may be closed).
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Напоминание', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Напоминание', {
    body: d.body || '', tag: d.tag || undefined, renotify: Boolean(d.tag),
    // Sound and vibration make Android show it as a pop-up at the top, not only in the shade.
    silent: false, vibrate: [250, 120, 250], timestamp: Date.now(),
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: d.url || '#calendar' },
  }));
});
