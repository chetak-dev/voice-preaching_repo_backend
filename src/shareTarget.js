// Picks up files, links and text another app shared to Kalpa Taru (stored by the service worker in public/sw.js).
const CACHE = 'kt-share-target';
const MAX_AGE_MS = 24 * 3600_000;

async function read() {
  if (typeof caches === 'undefined' || !(await caches.has(CACHE))) return null;
  const cache = await caches.open(CACHE);
  try {
    const meta = await (await cache.match('/__share/meta'))?.json();
    if (!meta || Date.now() - meta.at > MAX_AGE_MS) return null;
    const files = await Promise.all((meta.files || []).map(async entry => {
      const blob = await (await cache.match(entry.key))?.blob();
      return blob ? new File([blob], entry.name, { type: entry.type || blob.type, lastModified: meta.at }) : null;
    }));
    // Apps often put the link inside the shared text, e.g. "Watch this: https://youtu.be/…".
    const found = `${meta.url || ''} ${meta.text || ''}`.match(/https?:\/\/[^\s<>"']+/gi) || [];
    const urls = [...new Set(found.map(url => url.replace(/[.,;:!?)\]]+$/, '')))];
    const title = (meta.title || (urls.length ? meta.text.replace(/https?:\/\/[^\s<>"']+/gi, '') : '')).replace(/\s+/g, ' ').trim().slice(0, 160);
    return { files: files.filter(Boolean), urls, title };
  } finally {
    await caches.delete(CACHE);
  }
}

let inflight = null;
/** Resolves to { files, urls, title } once per share, or null when nothing was shared. */
export function takeSharedItems() {
  // Calls made at the same moment (e.g. React's double effects in development) share one read.
  if (!inflight) inflight = read().catch(() => null).finally(() => setTimeout(() => { inflight = null; }, 0));
  return inflight;
}
