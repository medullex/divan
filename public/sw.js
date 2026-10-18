// Service worker «Общего дивана»: нужен, чтобы сайт можно было установить как приложение.
// Страницу всегда берём из сети (чтобы обновления приходили сразу), иконки — из кэша.
const CACHE = 'divan-v1';
const STATIC = ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/config') return;
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
    return;
  }
  // страницы: сначала сеть; без сети — понятное сообщение
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<body style="margin:0;background:#141012;color:#f2e9e4;font:16px system-ui;display:grid;place-items:center;height:100vh;text-align:center;padding:20px">' +
      '<div><h2 style="color:#f5a742">Нет интернета</h2><p>Общему дивану нужен интернет. Проверьте подключение и откройте приложение снова.</p></div>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
  }
});
