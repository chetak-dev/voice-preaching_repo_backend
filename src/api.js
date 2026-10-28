export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, form, signal } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: form || (body ? JSON.stringify(body) : undefined),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError('Network error. Check your connection and try again.', 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status}).`, response.status);
  return data;
}

function sendChunk(url, chunk, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open('PUT', url);
    xhr.responseType = 'json';
    xhr.timeout = 120_000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => onProgress(event.loaded);
    xhr.onload = () => { signal?.removeEventListener('abort', abort); resolve({ status: xhr.status, data: xhr.response || {} }); };
    xhr.onerror = xhr.ontimeout = () => { signal?.removeEventListener('abort', abort); reject(new ApiError('Network error. Check your connection and try again.', 0)); };
    xhr.onabort = () => reject(new DOMException('Upload cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(chunk);
  });
}

export const startUpload = (file, fields) => api('/uploads', {
  method: 'POST', body: { ...fields, name: file.name, mime: file.type, size: file.size },
});

// Sends a file in small chunks so each request stays under serverless limits. The server tracks how much it has
// received, so an upload can continue later (even after the page was closed) from where it stopped.
export async function sendUpload({ id, chunkSize, file, onProgress, signal, offset: from = 0 }) {
  let offset = from;
  let attempts = 0;
  const retry = () => new Promise(resolve => setTimeout(resolve, 1000 * attempts));
  while (true) {
    if (signal?.aborted) throw new DOMException('Upload cancelled.', 'AbortError');
    const start = offset;
    let result;
    try {
      result = await sendChunk(`/api/uploads/${encodeURIComponent(id)}?offset=${offset}`, file.slice(offset, offset + chunkSize),
        loaded => onProgress(Math.min(99, Math.round(((start + loaded) / file.size) * 100))), signal);
    } catch (error) {
      if (error.name === 'AbortError' || ++attempts > 3) throw error;
      await retry();
      continue;
    }
    const { status, data } = result;
    if (status === 409 && typeof data.received === 'number') { offset = data.received; continue; }
    if (status >= 500 && ++attempts <= 3) { await retry(); continue; }
    if (status < 200 || status >= 300) throw new ApiError(data.error || `Upload failed (${status}).`, status);
    attempts = 0;
    if (data.done) { onProgress(100); return data; }
    offset = data.received;
    onProgress(Math.min(99, Math.round((offset / file.size) * 100)));
  }
}

export const fileUrl = (id, inline = false) => `/api/content/${encodeURIComponent(id)}/file${inline ? '?inline=1' : ''}`;
export const thumbnailUrl = id => `/api/content/${encodeURIComponent(id)}/thumbnail`;

export async function saveThumbnail(id, blob) {
  const response = await fetch(thumbnailUrl(id), { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob });
  if (!response.ok) throw new ApiError((await response.json().catch(() => null))?.error || 'Thumbnail could not be saved.', response.status);
}
