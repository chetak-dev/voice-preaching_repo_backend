import { google } from 'googleapis';
import { createReadStream, mkdirSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';

const QUOTA_TTL_MS = 5 * 60_000;
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

export function driveClient(node, config) {
  let auth;
  if (node.kind === 'oauth') {
    if (!node.refresh_token) throw fail(400, 'Connect this Google Drive account first.');
    auth = oauthClient(config);
    auth.setCredentials({ refresh_token: decryptToken(node.refresh_token, config.encryptionKey) });
  } else {
    if (!config.serviceAccount) throw fail(400, 'Configure service account credentials first.');
    auth = new google.auth.GoogleAuth({
      keyFile: config.serviceAccount,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
  }
  return google.drive({ version: 'v3', auth });
}

// Shared Drives draw from the Workspace pool, so they report no per-account limit.
export async function refreshQuota(db, node, config) {
  if (node.kind === 'service') {
    db.prepare('UPDATE drives SET quota_usage = NULL, quota_limit = NULL, quota_checked_at = ? WHERE id = ?').run(Date.now(), node.id);
    return { usage: null, limit: null };
  }
  const { data } = await driveClient(node, config).about.get({ fields: 'storageQuota(limit,usage)' });
  const usage = data.storageQuota?.usage ? Number(data.storageQuota.usage) : null;
  const limit = data.storageQuota?.limit ? Number(data.storageQuota.limit) : null;
  db.prepare('UPDATE drives SET quota_usage = ?, quota_limit = ?, quota_checked_at = ? WHERE id = ?')
    .run(usage, limit, Date.now(), node.id);
  return { usage, limit };
}

export function createStorage(config, db) {
  const filesDir = path.join(config.dataDir, 'files');
  mkdirSync(filesDir, { recursive: true });

  async function freeSpace(node) {
    let { quota_usage: usage, quota_limit: limit } = node;
    if (!node.quota_checked_at || Date.now() - node.quota_checked_at > QUOTA_TTL_MS) {
      ({ usage, limit } = await refreshQuota(db, node, config));
    }
    return limit == null ? Number.MAX_SAFE_INTEGER : limit - (usage || 0);
  }

  async function route(type, size) {
    const candidates = db.prepare('SELECT * FROM drives WHERE enabled = 1 ORDER BY created_at').all()
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

  return {
    async save(file, type, nodeId) {
      const node = nodeId && nodeId !== 'auto'
        ? (nodeId === 'local' ? null : db.prepare('SELECT * FROM drives WHERE id = ?').get(nodeId))
        : await route(type, file.size);
      if (nodeId && nodeId !== 'auto' && nodeId !== 'local' && !node) throw fail(400, 'Storage destination not found.');
      if (!node) {
        const key = path.basename(file.path);
        await rename(file.path, path.join(filesDir, key));
        return { node: 'local', key };
      }
      const result = await driveClient(node, config).files.create({
        supportsAllDrives: true,
        requestBody: { name: file.originalname, parents: [node.folder_id] },
        media: { mimeType: file.mimetype, body: createReadStream(file.path) },
        fields: 'id',
      });
      if (node.quota_usage != null) {
        db.prepare('UPDATE drives SET quota_usage = quota_usage + ? WHERE id = ?').run(file.size, node.id);
      }
      return { node: node.id, key: result.data.id };
    },
    async remove(stored) {
      if (stored.node === 'local') return unlink(path.join(filesDir, path.basename(stored.key)));
      const node = db.prepare('SELECT * FROM drives WHERE id = ?').get(stored.node);
      if (!node) throw fail(503, 'The storage connection for this file is unavailable.');
      await driveClient(node, config).files.delete({ fileId: stored.key, supportsAllDrives: true });
    },
    async read(item, range) {
      if (item.storage_node === 'local') return { local: path.join(filesDir, path.basename(item.storage_key)) };
      const node = db.prepare('SELECT * FROM drives WHERE id = ?').get(item.storage_node);
      if (!node) throw fail(503, 'The storage connection for this file is unavailable.');
      const response = await driveClient(node, config).files.get({
        fileId: item.storage_key, alt: 'media', supportsAllDrives: true,
      }, { responseType: 'stream', headers: range ? { Range: range } : {} });
      return { stream: response.data, headers: response.headers, status: response.status };
    },
  };
}
