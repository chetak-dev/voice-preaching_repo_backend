export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status}).`, response.status);
  return data;
}

function sendChunk(url, chunk, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => onProgress(event.loaded);
    xhr.onload = () => resolve({ status: xhr.status, data: xhr.response || {} });
    xhr.onerror = () => reject(new ApiError('Network error. Check your connection and try again.', 0));
    xhr.send(chunk);
  });
}

// Uploads a file in small chunks so each request stays under serverless limits; failed chunks are retried and resumed.
export async function uploadFile(file, fields, onProgress) {
  const { id, chunkSize } = await api('/uploads', {
    method: 'POST', body: { ...fields, name: file.name, mime: file.type, size: file.size },
  });
  let offset = 0;
  let attempts = 0;
  try {
    while (true) {
      const chunk = file.slice(offset, offset + chunkSize);
      const start = offset;
      let result;
      try {
        result = await sendChunk(`/api/uploads/${encodeURIComponent(id)}?offset=${offset}`, chunk,
          loaded => onProgress(Math.min(99, Math.round(((start + loaded) / file.size) * 100))));
      } catch (error) {
        if (++attempts > 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        continue;
      }
      const { status, data } = result;
      if (status === 409 && typeof data.received === 'number') { offset = data.received; continue; }
      if (status >= 500 && ++attempts <= 3) { await new Promise(resolve => setTimeout(resolve, 1000 * attempts)); continue; }
      if (status < 200 || status >= 300) throw new ApiError(data.error || `Upload failed (${status}).`, status);
      attempts = 0;
      if (data.done) { onProgress(100); return data; }
      offset = data.received;
    }
  } catch (error) {
    api(`/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  }
}

export const fileUrl = (id, inline = false) => `/api/content/${encodeURIComponent(id)}/file${inline ? '?inline=1' : ''}`;
