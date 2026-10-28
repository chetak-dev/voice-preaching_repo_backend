// Kalpa Taru service worker: makes the app installable and keeps the shell available on flaky connections.
// API calls, shared links and media are never cached so content and permissions are always current,
// except media the user explicitly downloaded for offline listening (stored by src/offline.js).
const CACHE = 'kalpa-taru-v1';
const OFFLINE_CACHE = 'kt-offline-media';
// Files shared to the app from another app (see share_target in the manifest) wait here until the app picks them up.
const SHARE_CACHE = 'kt-share-target';
const KEEP = [CACHE, OFFLINE_CACHE, SHARE_CACHE];
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];
const OFFLINE_ROUTE = /^\/api\/content\/([^/]+)\/(file|thumbnail)$/;

// Parses a single "bytes=a-b" / "bytes=a-" / "bytes=-n" range against a known size.
// Returns null when there is no usable range header, or { invalid: true } when unsatisfiable.
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!(suffix > 0)) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size || end < start) return { invalid: true };
  return { start, end };
}

async function offlineResponse(cached, request) {
  const blob = await cached.blob();
  const type = cached.headers.get('Content-Type') || blob.type || 'application/octet-stream';
  const range = parseRange(request.headers.get('Range'), blob.size);
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Offline': '1' };
  if (!range) return new Response(blob, { status: 200, headers: { ...base, 'Content-Length': String(blob.size) } });
  if (range.invalid) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${blob.size}` } });
  return new Response(blob.slice(range.start, range.end + 1, type), {
    status: 206,
    headers: { ...base, 'Content-Length': String(range.end - range.start + 1), 'Content-Range': `bytes ${range.start}-${range.end}/${blob.size}` },
  });
}

// Downloaded files are keyed as /api/content/<id>/file?inline=1 and thumbnails without a query.
function serveOffline(event, url) {
  const [, id, kind] = OFFLINE_ROUTE.exec(url.pathname);
  const key = `${self.location.origin}/api/content/${id}/${kind}${kind === 'file' ? '?inline=1' : ''}`;
  const { request } = event;
  const fromCache = () => caches.open(OFFLINE_CACHE).then(cache => cache.match(key));
  if (kind === 'thumbnail') {
    // Thumbnails can be replaced, so prefer the network and only fall back to the saved copy.
    event.respondWith(fetch(request).catch(error => fromCache().then(cached => cached || Promise.reject(error))));
    return;
  }
  event.respondWith(fromCache()
    .catch(() => null)
    .then(cached => (cached ? offlineResponse(cached, request) : fetch(request))));
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => !KEEP.includes(key)).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter(file => file && typeof file !== 'string' && file.size);
    const text = key => String(form.get(key) || '').slice(0, 4000);
    const meta = { title: text('title'), text: text('text'), url: text('url'), at: Date.now(), files: [] };
    await caches.delete(SHARE_CACHE);
    const cache = await caches.open(SHARE_CACHE);
    for (const [index, file] of files.entries()) {
      const key = `/__share/file/${index}`;
      await cache.put(key, new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }));
      meta.files.push({ key, name: file.name || `Shared file ${index + 1}`, type: file.type || '' });
    }
    await cache.put('/__share/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  } catch { /* Open the upload page anyway; the user can pick the files there. */ }
  return Response.redirect('/?shared=1#/upload', 303);
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share-target') {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Navigations (e.g. "Download" links that save an attachment) always go straight to the network.
  if (OFFLINE_ROUTE.test(url.pathname) && request.mode !== 'navigate') { serveOffline(event, url); return; }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request)
      .then(response => {
        if (response.ok && url.pathname === '/') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put('/', copy));
        }
        return response;
      })
      .catch(() => caches.match('/')));
    return;
  }

  // Built assets have content hashes in their names, so a cached copy is always correct.
  if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy));
      }
      return response;
    })));
  }
});
