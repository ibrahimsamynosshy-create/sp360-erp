/* =====================================================================
 * SP360 ERP — Service Worker (PWA)                        sw.js v1.0.0
 *
 * Strategy
 *   • App shell (same-origin GET: index.html, app.js, supabase.min.js,
 *     manifest, icons) → NETWORK-FIRST, cache as fallback.
 *     Every online launch gets the latest files from GitHub Pages;
 *     the cache is only used when the network is down.
 *   • Supabase / Groq / any other origin → NEVER cached (live data,
 *     auth tokens and AI calls always go straight to the network).
 *   • Navigation while offline with nothing cached → built-in
 *     "No connection" page (Navy & Gold).
 *
 * Update: bump CACHE_VERSION when you change this file. index.html /
 * app.js updates do NOT need a bump (network-first picks them up).
 * ===================================================================== */

const CACHE_VERSION = 'sp360-shell-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './supabase.min.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // Cache what exists; one missing file must not break installation
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // POST/PATCH (Supabase writes) untouched
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // Supabase, Groq, CDNs → browser default

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const copy = fresh.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(stripQuery(req), copy)).catch(() => {});
      }
      return fresh;
    } catch (_) {
      const cached = await caches.match(stripQuery(req)) || await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html') || await caches.match('./');
        return shell || offlinePage();
      }
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

/* app.js?v=4.3.1 and app.js?v=4.3.2 share one cache entry */
function stripQuery(req) {
  const u = new URL(req.url);
  u.search = '';
  return new Request(u.toString(), { method: 'GET' });
}

function offlinePage() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SP360 ERP — Offline</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0B1933;color:#E5E7EB;font-family:Segoe UI,Tahoma,Arial,sans-serif;text-align:center}
  .box{padding:32px 24px;max-width:420px}
  .logo{width:72px;height:72px;margin:0 auto 18px;border-radius:14px;background:#D4AF37;color:#0B1933;
        display:flex;align-items:center;justify-content:center;font-weight:800;font-size:28px}
  h1{color:#D4AF37;font-size:20px;margin:0 0 8px}
  p{color:#9CA3AF;font-size:14px;line-height:1.6;margin:6px 0}
  a{display:inline-block;margin-top:18px;padding:10px 22px;border-radius:8px;background:#D4AF37;
    color:#0B1933;font-weight:700;text-decoration:none}
</style></head><body><div class="box">
  <div class="logo">SP</div>
  <h1>No internet connection</h1>
  <p>SP360 ERP needs a connection to load live project data.</p>
  <p dir="rtl">لا يوجد اتصال بالإنترنت — يرجى التحقق من الشبكة ثم إعادة المحاولة.</p>
  <a href="./">Retry · إعادة المحاولة</a>
</div></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
