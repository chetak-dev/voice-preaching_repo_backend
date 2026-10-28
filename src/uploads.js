import { api, saveThumbnail, sendUpload, startUpload } from './api.js';
import { makeThumbnail } from './thumbnails.js';
import { saveText } from './textExtract.js';

// Uploads run here, outside any page, so they continue while the user moves around the app. Files waiting to finish
// are also kept in IndexedDB: if the tab is closed (or the phone suspends it), they resume next time the app opens.
const DB_NAME = 'voice-uploads';
const STORE = 'jobs';
const MAX_AGE_MS = 23 * 3600_000; // The server discards unfinished uploads after 24 hours.

function openDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transact(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(request?.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  });
}
const saved = {
  put: record => transact('readwrite', store => store.put(record)).catch(() => {}),
  remove: id => transact('readwrite', store => store.delete(id)).catch(() => {}),
  all: () => transact('readonly', store => store.getAll()).catch(() => []),
  clear: () => transact('readwrite', store => store.clear()).catch(() => {}),
};

let jobs = [];
let owner = null;
let running = false;
let controller = null;
let wakeLock = null;
let notify = () => {};
const listeners = new Set();
const thumbnailListeners = new Set();
/** Notifies when a freshly uploaded item gets its thumbnail, so open lists can refresh. */
export const onThumbnail = listener => { thumbnailListeners.add(listener); return () => thumbnailListeners.delete(listener); };
const ACTIVE = ['queued', 'uploading', 'waiting'];

const emit = () => listeners.forEach(listener => listener());
export const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const getJobs = () => jobs;
export const isActive = job => ACTIVE.includes(job.status);
const find = id => jobs.find(job => job.id === id);

function patch(id, changes) {
  jobs = jobs.map(job => (job.id === id ? { ...job, ...changes } : job));
  const job = find(id);
  job?.onUpdate?.({ status: job.status, progress: job.progress, error: job.error });
  emit();
}

async function holdScreen(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* Wake lock is a best-effort extra. */ }
}

function waitForNetwork() {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); window.removeEventListener('online', done); resolve(); };
    const timer = setTimeout(done, navigator.onLine ? 10_000 : 60_000);
    window.addEventListener('online', done);
  });
}

function attachThumbnail(job, contentId) {
  if (job.kind !== 'file' || !contentId || !job.file) return;
  // Runs after the file is safe on the server; a missing thumbnail only means the card shows its type icon.
  Promise.resolve(job.thumbnail || makeThumbnail(job.file))
    .then(blob => blob && saveThumbnail(contentId, blob))
    .then(() => thumbnailListeners.forEach(listener => listener(contentId)))
    .catch(() => {})
    .then(() => saveText(contentId, job.file))
    .catch(() => {});
}

function settle(job, status, error = '', result = null) {
  patch(job.id, { status, error, progress: status === 'done' ? 100 : find(job.id)?.progress || 0, published: result?.status === 'approved' });
  if (job.kind === 'file') saved.remove(job.id);
  if (status === 'done') attachThumbnail(find(job.id) || job, result?.id);
  job.resolve?.({ id: job.id, key: job.key, status, error, contentStatus: result?.status, contentId: result?.id });
  notify(find(job.id));
}

async function process(job) {
  patch(job.id, { status: 'uploading', error: '' });
  try {
    if (job.kind === 'link') {
      settle(job, 'done', '', await api('/content', { method: 'POST', body: { ...job.fields, url: job.url } }));
      return;
    }
    let { uploadId, chunkSize } = find(job.id);
    let offset = 0;
    if (uploadId) {
      const state = await api(`/uploads/${encodeURIComponent(uploadId)}`);
      if (state.done) { settle(job, 'done', '', { id: uploadId }); return; }
      offset = state.received;
      patch(job.id, { progress: Math.min(99, Math.round((offset / job.size) * 100)) });
    } else {
      ({ id: uploadId, chunkSize } = await startUpload(job.file, job.fields));
      patch(job.id, { uploadId, chunkSize });
      saved.put({
        id: job.id, owner, uploadId, chunkSize, file: job.file, name: job.name, size: job.size, title: job.title, createdAt: Date.now(),
      });
    }
    controller = new AbortController();
    const result = await sendUpload({
      id: uploadId, chunkSize, file: job.file, offset, signal: controller.signal, onProgress: progress => patch(job.id, { progress }),
    });
    settle(job, 'done', '', result);
  } catch (error) {
    if (error.name === 'AbortError' || !find(job.id)) return;
    if (error.status === 0) {
      // Keep the upload: it continues from the last saved chunk once the connection is back.
      patch(job.id, { status: 'waiting', error: 'Waiting for connection…' });
      await waitForNetwork();
      if (find(job.id)?.status === 'waiting') patch(job.id, { status: 'queued', error: '' });
      return;
    }
    const { uploadId } = find(job.id);
    if (uploadId && error.status !== 404) api(`/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => {});
    settle(job, 'error', error.status === 404 ? 'This upload expired. Please upload the file again.' : error.message);
  } finally {
    controller = null;
  }
}

async function run() {
  if (running) return;
  running = true;
  holdScreen(true);
  try {
    let job;
    while ((job = jobs.find(item => item.status === 'queued'))) await process(job);
  } finally {
    running = false;
    holdScreen(false);
  }
}

let nextId = 0;
const newId = () => `${Date.now().toString(36)}-${(nextId += 1)}-${Math.random().toString(36).slice(2, 8)}`;

// Adds items ({ key, kind: 'file'|'link', file, url, title, fields, onUpdate }) and resolves once all have finished.
export function enqueue(items) {
  const added = items.map(item => new Promise(resolve => {
    jobs = [...jobs, {
      ...item,
      id: newId(),
      name: item.kind === 'file' ? item.file.name : item.url,
      size: item.kind === 'file' ? item.file.size : 0,
      status: 'queued',
      progress: 0,
      error: '',
      resolve,
    }];
  }));
  emit();
  run();
  return Promise.all(added);
}

// Called after sign-in: picks up uploads that were interrupted by closing or reloading the app.
export async function resumeSaved(userId, onSettled) {
  owner = userId;
  notify = onSettled || (() => {});
  const stored = await saved.all();
  let resumed = 0;
  for (const record of stored) {
    if (record.owner !== userId || find(record.id)) continue;
    if (Date.now() - record.createdAt > MAX_AGE_MS || !(record.file instanceof Blob)) { saved.remove(record.id); continue; }
    jobs = [...jobs, {
      id: record.id, kind: 'file', file: record.file, name: record.name, size: record.size, title: record.title,
      uploadId: record.uploadId, chunkSize: record.chunkSize, status: 'queued', progress: 0, error: '', resumed: true,
    }];
    resumed += 1;
  }
  if (resumed) { emit(); run(); }
  return resumed;
}

export function forget(ids) {
  jobs = jobs.filter(job => !ids.includes(job.id) || isActive(job));
  emit();
}
export function dismissFinished() {
  jobs = jobs.filter(isActive);
  emit();
}

// Signing out cancels everything and removes saved files from this device.
export async function cancelAll() {
  const pending = jobs.filter(job => isActive(job) && job.uploadId);
  jobs = [];
  owner = null;
  emit();
  controller?.abort();
  await Promise.all(pending.map(job => api(`/uploads/${encodeURIComponent(job.uploadId)}`, { method: 'DELETE' }).catch(() => {})));
  await saved.clear();
}

document.addEventListener('visibilitychange', () => {
  if (running && document.visibilityState === 'visible') holdScreen(true);
});
window.addEventListener('beforeunload', event => {
  if (jobs.some(isActive)) { event.preventDefault(); event.returnValue = ''; }
});
