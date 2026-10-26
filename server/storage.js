import { google } from 'googleapis';
import { createReadStream, mkdirSync } from 'node:fs';
import { open, unlink, writeFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';

// Each upload chunk stays below Vercel's 4.5 MB request limit and is a multiple of 256 KB, as Drive requires.
export const CHUNK_SIZE = 4 * 1024 * 1024;
// Media range responses are capped so every response stays small; browsers request the next range automatically.
const MAX_RANGE = 4 * 1024 * 1024;
const QUOTA_TTL_MS = 5 * 60_000;
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id';
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

export function oauthClient(config) {
  return new google.auth.OAuth2(config.googleClientId, config.googleClientSecret,
    `${config.origin}/api/auth/google/callback`);
}

export function encryptToken(token, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64')).join('.');
}

function decryptToken(token, key) {
  const [iv, tag, body] = token.split('.').map(value => Buffer.from(value, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function isConnected(node, config) {
  return node.kind === 'service' ? Boolean(config.serviceAccount) : Boolean(node.refresh_token);
}

function authFor(node, config) {
  if (node.kind === 'oauth') {
    if (!node.refresh_token) throw fail(400, 'Connect this Google Drive account first.');
    const auth = oauthClient(config);
    auth.setCredentials({ refresh_token: decryptToken(node.refresh_token, config.encryptionKey) });
    return auth;
  }
  if (!config.serviceAccount) throw fail(400, 'Configure service account credentials first.');
  // GOOGLE_SERVICE_ACCOUNT_JSON holds the key itself (for serverless hosts); otherwise it is a key file path.
  const value = config.serviceAccount.trim();
  return new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive'],
    ...(value.startsWith('{') ? { credentials: JSON.parse(value) } : { keyFile: value }),
  });
}

export function driveClient(node, config) {
  return google.drive({ version: 'v3', auth: authFor(node, config) });
}

// Personal Drives only grant `drive.file` (files this app creates), which needs no Google verification.
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const APP_FOLDER = 'VOICE Media';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Returns the id of the app's own upload folder: the current one if still usable, else an existing or new "VOICE Media" folder. */
export async function ensureAppFolder(drive, currentId) {
  if (currentId) {
    try {
      const { data } = await drive.files.get({ fileId: currentId, fields: 'id,mimeType,trashed,capabilities(canAddChildren)' });
      if (data.mimeType === FOLDER_MIME && !data.trashed && data.capabilities?.canAddChildren) return data.id;
    } catch {
      // Not visible to this app or account any more; fall through and use a fresh folder.
    }
  }
  const { data: found } = await drive.files.list({
    q: `name = '${APP_FOLDER}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`,
    fields: 'files(id)', pageSize: 1, spaces: 'drive',
  });
  if (found.files?.length) return found.files[0].id;
  const { data } = await drive.files.create({ requestBody: { name: APP_FOLDER, mimeType: FOLDER_MIME }, fields: 'id' });
  return data.id;
}

async function accessToken(node, config) {
  const result = await authFor(node, config).getAccessToken();
  const token = typeof result === 'string' ? result : result?.token;
  if (!token) throw fail(502, 'Google did not issue an access token for this Drive. Reconnect it from Storage.');
  return token;
}

async function googleError(response, fallback) {
  const body = await response.json().catch(() => null);
  console.error(fallback, response.status, body?.error?.message || '');
  return fail(502, `${fallback} (Google responded ${response.status}).`);
}

// Shared Drives draw from the Workspace pool, so they report no per-account limit.
export async function refreshQuota(db, node, config) {
  if (node.kind === 'service') {
    await db.run('UPDATE drives SET quota_usage = NULL, quota_limit = NULL, quota_checked_at = ? WHERE id = ?', Date.now(), node.id);
    return { usage: null, limit: null };
  }
  const { data } = await driveClient(node, config).about.get({ fields: 'storageQuota(limit,usage)' });
  const usage = data.storageQuota?.usage ? Number(data.storageQuota.usage) : null;
  const limit = data.storageQuota?.limit ? Number(data.storageQuota.limit) : null;
  await db.run('UPDATE drives SET quota_usage = ?, quota_limit = ?, quota_checked_at = ? WHERE id = ?', usage, limit, Date.now(), node.id);
  return { usage, limit };
}

export function boundedRange(range, size) {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(range).trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    const length = Math.min(size, suffixLength, MAX_RANGE);
    start = size - length;
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return { invalid: true };
    end = Math.min(end, start + MAX_RANGE - 1, size - 1);
  }
  return {
    start,
    end,
    header: `bytes=${start}-${end}`,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

export function createStorage(config, db) {
  const filesDir = path.join(config.dataDir, 'files');
  if (config.localStorage) mkdirSync(filesDir, { recursive: true });
  const localPath = key => path.join(filesDir, path.basename(key));

  async function freeSpace(node) {
    let { quota_usage: usage, quota_limit: limit } = node;
    if (!node.quota_checked_at || Date.now() - node.quota_checked_at > QUOTA_TTL_MS) {
      ({ usage, limit } = await refreshQuota(db, node, config));
    }
    return limit == null ? Number.MAX_SAFE_INTEGER : limit - (usage || 0);
  }

  async function route(size) {
    const candidates = (await db.all('SELECT * FROM drives WHERE enabled = 1 ORDER BY created_at'))
      .filter(node => isConnected(node, config));
    if (!candidates.length) return null;
    let best = null;
    for (const node of candidates) {
      try {
        const free = await freeSpace(node);
        if (free > size && (!best || free > best.free)) best = { node, free };
      } catch (error) {
        console.warn(`Skipping storage "${node.name}" during routing:`, error.message);
      }
    }
    if (!best) throw fail(507, 'Every connected Google Drive is full or unreachable. Ask a site admin to add storage.');
    return best.node;
  }

  async function destination(target, size) {
    if (target === 'local') {
      if (!config.localStorage) throw fail(400, 'This host has no permanent disk. Choose a Google Drive.');
      return null;
    }
    if (target && target !== 'auto') {
      const node = await db.get('SELECT * FROM drives WHERE id = ?', target);
      if (!node) throw fail(400, 'Storage destination not found.');
      if (!isConnected(node, config)) throw fail(400, 'This storage destination is not connected yet.');
      return node;
    }
    const node = await route(size);
    if (!node && !config.localStorage) {
      throw fail(503, 'File uploads need a connected Google Drive. Ask a site admin to connect one under Storage.');
    }
    return node;
  }

  return {
    async startUpload({ id, target, name, mime, size }) {
      const node = await destination(target, size);
      if (!node) {
        await writeFile(localPath(id), '');
        return { node: 'local', sessionUri: null };
      }
      const response = await fetch(DRIVE_UPLOAD, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken(node, config)}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mime,
          'X-Upload-Content-Length': String(size),
        },
        body: JSON.stringify({ name, parents: [node.folder_id] }),
      });
      const sessionUri = response.headers.get('location');
      if (!response.ok || !sessionUri) throw await googleError(response, 'Google Drive refused to start the upload');
      return { node: node.id, sessionUri };
    },
    // Returns { done, received, key }. Drive may persist fewer bytes than sent; `received` tells the client where to resume.
    async sendChunk(upload, chunk, offset) {
      const end = offset + chunk.length;
      if (upload.node === 'local') {
        const handle = await open(localPath(upload.id), 'r+');
        try {
          let written = 0;
          while (written < chunk.length) {
            const result = await handle.write(chunk, written, chunk.length - written, offset + written);
            if (!result.bytesWritten) throw new Error('Local upload write made no progress.');
            written += result.bytesWritten;
          }
        } finally {
          await handle.close();
        }
        return { done: end === upload.size, received: end, key: upload.id };
      }
      const response = await fetch(upload.session_uri, {
        method: 'PUT',
        redirect: 'manual',
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${upload.size}` },
        body: chunk,
      });
      if (response.status === 308) {
        const range = /bytes=0-(\d+)/.exec(response.headers.get('range') || '');
        return { done: false, received: range ? Number(range[1]) + 1 : 0 };
      }
      if (response.status === 404 || response.status === 410) throw fail(410, 'The upload session expired. Please upload the file again.');
      if (!response.ok) throw await googleError(response, 'Google Drive rejected part of the upload');
      const { id } = await response.json();
      await db.run('UPDATE drives SET quota_usage = quota_usage + ? WHERE id = ? AND quota_usage IS NOT NULL', upload.size, upload.node);
      return { done: true, received: upload.size, key: id };
    },
    async cancelUpload(upload) {
      if (upload.node === 'local') {
        try { await unlink(localPath(upload.id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      } else if (upload.session_uri) {
        const response = await fetch(upload.session_uri, { method: 'DELETE' });
        if (!response.ok && response.status !== 404 && response.status !== 410) {
          throw await googleError(response, 'The upload session could not be cancelled');
        }
      }
    },
    async remove(stored) {
      if (stored.node === 'local') {
        try { await unlink(localPath(stored.key)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return;
      }
      const node = await db.get('SELECT * FROM drives WHERE id = ?', stored.node);
      if (!node) throw fail(503, 'The storage connection for this file is unavailable.');
      try {
        await driveClient(node, config).files.delete({ fileId: stored.key, supportsAllDrives: true });
      } catch (error) {
        if (Number(error.code || error.status) !== 404) throw error;
      }
    },
    async read(item, range) {
      const bounded = boundedRange(range, item.size);
      if (bounded?.invalid) return { status: 416, contentRange: `bytes */${item.size}` };
      if (item.storage_node === 'local') {
        const stream = bounded
          ? createReadStream(localPath(item.storage_key), { start: bounded.start, end: bounded.end })
          : createReadStream(localPath(item.storage_key));
        return {
          stream,
          status: bounded ? 206 : 200,
          contentLength: bounded ? bounded.end - bounded.start + 1 : item.size,
          contentRange: bounded?.contentRange,
        };
      }
      const node = await db.get('SELECT * FROM drives WHERE id = ?', item.storage_node);
      if (!node) throw fail(503, 'The storage connection for this file is unavailable.');
      const headers = { Authorization: `Bearer ${await accessToken(node, config)}` };
      if (bounded) headers.Range = bounded.header;
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.storage_key)}?alt=media&supportsAllDrives=true`, { headers });
      if (response.status === 416) return { status: 416, contentRange: `bytes */${item.size}` };
      if (!response.ok) throw await googleError(response, 'The file could not be read from Google Drive');
      return { stream: Readable.fromWeb(response.body), headers: response.headers, status: response.status };
    },
  };
}
