// Offline listening: whole media files are saved in Cache Storage and served back by public/sw.js
// (including Range requests), so the normal player URL keeps working without a connection.
import { useCallback, useSyncExternalStore } from 'react';
import { fileUrl, thumbnailUrl } from './api.js';

export const OFFLINE_CACHE = 'kt-offline-media';
export const OFFLINE_EVENT = 'kt-offline';
const META_KEY = 'kt.offline';
const CHUNK = 4 * 1024 * 1024;
const RETRIES = 2;
const OFFLINE_TYPES = ['audio', 'video'];

const absolute = path => new URL(path, window.location.origin).href;
export const offlineFileKey = id => absolute(fileUrl(id, true));
export const offlineThumbKey = id => absolute(thumbnailUrl(id));

export function isOfflineSupported() {
  return typeof window !== 'undefined' && 'caches' in window && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

export function canDownload(item) {
  return Boolean(item && OFFLINE_TYPES.includes(item.type) && (!item.status || item.status === 'approved') && isOfflineSupported());
}

function readMeta() {
  try {
    const value = JSON.parse(window.localStorage.getItem(META_KEY) || '[]');
    return Array.isArray(value) ? value.filter(entry => entry && entry.id) : [];
  } catch { return []; }
}
function writeMeta(list) {
  try { window.localStorage.setItem(META_KEY, JSON.stringify(list)); } catch { /* storage may be unavailable */ }
  emit();
}

// In-progress downloads live at module level so buttons keep their state across remounts.
const active = new Map();
let snapshot = null;
function emit() {
  snapshot = null;
  window.dispatchEvent(new Event(OFFLINE_EVENT));
}

export function listDownloads() {
  return readMeta().sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}
export function isDownloaded(id) {
  return readMeta().some(entry => entry.id === id);
}
export function downloadProgress(id) {
  return active.get(id)?.fraction ?? null;
}
export function cancelDownload(id) {
  active.get(id)?.controller.abort();
}

class OfflineError extends Error {}

async function ensureSpace(size) {
  if (!size || !navigator.storage?.estimate) return;
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota == null) return;
    const free = quota - (usage || 0);
    if (size > free * 0.95) throw new OfflineError('Not enough storage space on this device to download this file. Remove some downloads and try again.');
  } catch (error) {
    if (error instanceof OfflineError) throw error;
  }
}

function friendly(error) {
  if (error?.name === 'AbortError') return error;
  if (error instanceof OfflineError) return error;
  if (error?.name === 'QuotaExceededError' || /quota/i.test(error?.message || '')) {
    return new OfflineError('Not enough storage space on this device to download this file. Remove some downloads and try again.');
  }
  if (!navigator.onLine) return new OfflineError('You are offline. Connect to the internet to download.');
  return new OfflineError(error?.message || 'The download failed. Please try again.');
}

// Reads a response body, reporting each received block so progress moves smoothly inside a chunk.
async function readBody(response, onBytes) {
  if (!response.body?.getReader) {
    const blob = await response.blob();
    onBytes(blob.size);
    return blob;
  }
  const reader = response.body.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    onBytes(value.byteLength);
  }
  return new Blob(parts);
}

async function fetchRange(url, start, end, signal) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, credentials: 'same-origin', cache: 'no-store', signal });
      if (response.status === 401 || response.status === 403) throw new OfflineError('You no longer have access to this file.');
      if (response.status === 404) throw new OfflineError('This file is no longer available.');
      if (!response.ok) throw new Error(`The download failed (HTTP ${response.status}).`);
      return response;
    } catch (error) {
      if (error?.name === 'AbortError' || error instanceof OfflineError) throw error;
      lastError = error;
      if (attempt < RETRIES) await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}

// The API caps each range response at 4 MiB (and serverless hosts cap response size), so files are
// fetched as sequential ranges and joined into one Blob.
async function fetchWholeFile(url, knownSize, mime, signal, onProgress) {
  const parts = [];
  let received = 0;
  let total = knownSize > 0 ? knownSize : null;
  const report = bytes => {
    received += bytes;
    if (total) onProgress(Math.min(received / total, 1));
  };
  while (total == null || received < total) {
    const start = received;
    const end = (total == null ? start + CHUNK : Math.min(start + CHUNK, total)) - 1;
    const response = await fetchRange(url, start, end, signal);
    if (response.status === 200) {
      // The server sent the whole file; discard anything gathered so far.
      parts.length = 0; received = 0;
      const length = Number(response.headers.get('content-length'));
      if (length > 0) total = length;
      const blob = await readBody(response, report);
      parts.push(blob);
      total = blob.size;
      break;
    }
    const match = /\/(\d+)\s*$/.exec(response.headers.get('content-range') || '');
    if (match) total = Number(match[1]);
    const before = received;
    const blob = await readBody(response, report);
    if (!blob.size) throw new OfflineError('The download stopped unexpectedly. Please try again.');
    received = before + blob.size;
    parts.push(blob);
    if (total == null) total = received;
  }
  const file = new Blob(parts, { type: mime || 'application/octet-stream' });
  if (total != null && file.size !== total) throw new OfflineError('The download was incomplete. Please try again.');
  return file;
}

let persistRequested = false;

export async function downloadForOffline(item, onProgress = () => {}, options) {
  if (!canDownload(item)) throw new OfflineError('Only audio and video can be downloaded for offline listening.');
  if (active.has(item.id)) throw new OfflineError('This item is already downloading.');
  const outer = options instanceof AbortSignal ? options : options?.signal;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (outer) { if (outer.aborted) controller.abort(); else outer.addEventListener('abort', abort, { once: true }); }

  const state = { fraction: 0, controller };
  active.set(item.id, state);
  emit();
  let lastEmit = 0;
  const progress = fraction => {
    state.fraction = fraction;
    try { onProgress(fraction); } catch { /* caller errors must not break the download */ }
    const now = Date.now();
    if (now - lastEmit > 150 || fraction >= 1) { lastEmit = now; emit(); }
  };

  try {
    if (!persistRequested) {
      persistRequested = true;
      try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
    }
    await ensureSpace(item.size);
    const blob = await fetchWholeFile(fileUrl(item.id, true), Number(item.size) || 0, item.mime, controller.signal, progress);
    const cache = await caches.open(OFFLINE_CACHE);
    const mime = item.mime || blob.type || 'application/octet-stream';
    await cache.put(offlineFileKey(item.id), new Response(blob, {
      headers: { 'Content-Type': mime, 'Content-Length': String(blob.size), 'X-Offline': '1' },
    }));
    if (item.has_thumb) {
      try {
        const thumb = await fetch(thumbnailUrl(item.id), { credentials: 'same-origin', signal: controller.signal });
        if (thumb.ok) await cache.put(offlineThumbKey(item.id), thumb);
      } catch { /* thumbnails are optional */ }
    }
    const entry = {
      id: item.id, title: item.title, type: item.type, mime, size: blob.size, uploader: item.uploader || '',
      has_thumb: Boolean(item.has_thumb), savedAt: new Date().toISOString(),
    };
    writeMeta([...readMeta().filter(other => other.id !== item.id), entry]);
    progress(1);
    return entry;
  } catch (error) {
    throw friendly(error);
  } finally {
    outer?.removeEventListener('abort', abort);
    active.delete(item.id);
    emit();
  }
}

export async function removeDownload(id) {
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    await Promise.all([cache.delete(offlineFileKey(id)), cache.delete(offlineThumbKey(id))]);
  } finally {
    writeMeta(readMeta().filter(entry => entry.id !== id));
  }
}

// Drops metadata for files the browser evicted from Cache Storage.
export async function verifyDownloads() {
  if (!isOfflineSupported()) return listDownloads();
  const list = readMeta();
  const cache = await caches.open(OFFLINE_CACHE);
  const present = await Promise.all(list.map(entry => cache.match(offlineFileKey(entry.id)).then(Boolean, () => true)));
  const kept = list.filter((_, index) => present[index]);
  if (kept.length !== list.length) writeMeta(kept);
  return listDownloads();
}

export const totalDownloadSize = list => list.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0);

function subscribe(callback) {
  const onStorage = event => { if (event.key === META_KEY) { snapshot = null; callback(); } };
  window.addEventListener(OFFLINE_EVENT, callback);
  window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(OFFLINE_EVENT, callback); window.removeEventListener('storage', onStorage); };
}
function getSnapshot() {
  if (!snapshot) snapshot = listDownloads();
  return snapshot;
}
const serverSnapshot = () => [];

export function useDownloads() {
  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}

// Returns { status: 'idle' | 'downloading' | 'downloaded', progress } for one item.
export function useDownloadState(id) {
  const downloads = useDownloads();
  const progress = useSyncExternalStore(subscribe, useCallback(() => downloadProgress(id), [id]), () => null);
  if (progress != null) return { status: 'downloading', progress };
  return { status: downloads.some(entry => entry.id === id) ? 'downloaded' : 'idle', progress: null };
}
