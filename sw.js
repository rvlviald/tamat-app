const V = 'tamat-pwa-v4';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'pwa.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'us.jpg',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/jszip.min.js', 'vendor/en-freq.txt',
  'vendor/fonts/Bookerly-Regular.ttf', 'vendor/fonts/Bookerly-RegularItalic.ttf', 'vendor/fonts/Bookerly-Bold.ttf', 'vendor/fonts/Bookerly-BoldItalic.ttf',
  'vendor/fonts/literata-latin-wght-normal.woff2', 'vendor/fonts/literata-latin-wght-italic.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// network-first supaya update langsung terlihat; cache dipakai saat offline
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const c = r.clone(); caches.open(V).then(ch => ch.put(e.request, c)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
