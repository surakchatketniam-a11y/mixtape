const VER = 'mixtape-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || r.headers.has('range')) return;
  // หน้าแอป: ลองเน็ตก่อน ถ้าออฟไลน์ใช้ของที่แคชไว้ (ไม่สนใจ ?code= จากการล็อกอิน Spotify)
  if (r.mode === 'navigate' && u.origin === location.origin) {
    e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(VER).then(c => c.put('/', cp)); return res; })
      .catch(() => caches.match('/')));
    return;
  }
  // ฟอนต์และไฟล์สถิตของแอป: ใช้แคชก่อน แล้วอัปเดตเบื้องหลัง
  const cacheable = u.origin === location.origin ? SHELL.includes(u.pathname) : (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com');
  if (cacheable) {
    e.respondWith(caches.open(VER).then(async c => {
      const hit = await c.match(r);
      const net = fetch(r).then(res => { if (res.ok || res.type === 'opaque') c.put(r, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
  // /api, /stream, Spotify ฯลฯ ไม่แตะ ให้ไปเน็ตตามปกติ
});
