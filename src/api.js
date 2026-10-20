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

export function uploadWithProgress(form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/content');
    xhr.responseType = 'json';
    xhr.upload.onprogress = event => event.lengthComputable && onProgress(Math.round((event.loaded / event.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve(xhr.response)
      : reject(new ApiError(xhr.response?.error || `Upload failed (${xhr.status}).`, xhr.status)));
    xhr.onerror = () => reject(new ApiError('Network error. Check your connection and try again.', 0));
    xhr.send(form);
  });
}

export const fileUrl = (id, inline = false) => `/api/content/${encodeURIComponent(id)}/file${inline ? '?inline=1' : ''}`;
