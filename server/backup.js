import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { APP_FOLDER, driveClient, ensureAppFolder, ensureTypeFolder, isConnected } from './storage.js';

export const BACKUP_FOLDER = 'Backups';
export const KEEP_BACKUPS = 14;
const FILE_PREFIX = 'kalpa-taru-backup-';
const FILE_PATTERN = /^kalpa-taru-backup-[\dT-]+Z\.json\.gz$/;
// Session, upload and thumbnail data is transient or regenerable; `backups` only describes the backups themselves.
const EXCLUDED = new Set(['sessions', 'oauth_states', 'uploads', 'thumbnails', 'backups']);
// Parents first so a restore never inserts a row before the row it references.
export const TABLE_ORDER = ['users', 'drives', 'content'];

const prepared = new WeakMap();
function ensureTable(db) {
  if (!prepared.has(db)) {
    prepared.set(db, (async () => {
      await db.ready;
      await db.run(`CREATE TABLE IF NOT EXISTS backups (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, ok INTEGER NOT NULL,
        file_name TEXT, size INTEGER, location TEXT, error TEXT
      )`);
    })().catch(error => { prepared.delete(db); throw error; }));
  }
  return prepared.get(db);
}

const jsonValue = value => {
  if (value instanceof ArrayBuffer) return { $base64: Buffer.from(value).toString('base64') };
  if (ArrayBuffer.isView(value)) return { $base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  return value;
};

export const backupFileName = (date = new Date()) => `${FILE_PREFIX}${date.toISOString().slice(0, 19).replace(/:/g, '-')}Z.json.gz`;

/** Returns every app table (minus transient ones) as { name: rows[] }, parents first, with Drive tokens removed. */
export async function exportTables(db) {
  const names = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'"))
    .map(row => row.name)
    .filter(name => !EXCLUDED.has(name) && !name.startsWith('sqlite_') && !name.startsWith('_') && !name.startsWith('libsql_'))
    .sort((a, b) => {
      const rank = name => (TABLE_ORDER.includes(name) ? TABLE_ORDER.indexOf(name) : TABLE_ORDER.length);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  const tables = {};
  for (const name of names) {
    const rows = await db.all(`SELECT * FROM "${name.replace(/"/g, '""')}"`);
    tables[name] = rows.map(row => {
      const copy = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonValue(value)]));
      if (name === 'drives' && 'refresh_token' in copy) copy.refresh_token = null;
      return copy;
    });
  }
  return tables;
}

async function saveToDrive(node, config, fileName, body) {
  const drive = driveClient(node, config);
  const parent = node.folder_id || await ensureAppFolder(drive, node.folder_id);
  const folder = await ensureTypeFolder(drive, parent, BACKUP_FOLDER);
  await drive.files.create({
    requestBody: { name: fileName, parents: [folder], mimeType: 'application/gzip' },
    media: { mimeType: 'application/gzip', body: Readable.from(body) },
    fields: 'id', supportsAllDrives: true,
  });
  const { data } = await drive.files.list({
    q: `'${folder}' in parents and name contains '${FILE_PREFIX}' and trashed = false`,
    fields: 'files(id,name)', orderBy: 'name desc', pageSize: 100,
    corpora: 'allDrives', includeItemsFromAllDrives: true, supportsAllDrives: true,
  });
  const old = (data.files || []).filter(file => FILE_PATTERN.test(file.name))
    .sort((a, b) => b.name.localeCompare(a.name)).slice(KEEP_BACKUPS);
  for (const file of old) {
    try {
      await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
    } catch (error) {
      console.warn(`Could not delete old backup ${file.name}:`, error.message);
    }
  }
  return `${node.name} (Google Drive: ${APP_FOLDER}/${BACKUP_FOLDER})`;
}

async function saveLocally(config, fileName, body) {
  const directory = path.join(config.dataDir, 'backups');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, fileName), body);
  const old = (await readdir(directory)).filter(name => FILE_PATTERN.test(name)).sort().reverse().slice(KEEP_BACKUPS);
  for (const name of old) await unlink(path.join(directory, name)).catch(() => {});
  return 'Local disk (data/backups)';
}

/**
 * Exports the database as gzipped JSON to the first enabled, connected Google Drive (in "Backups" inside the
 * app folder), or to `<dataDir>/backups` when no Drive is connected and the host has a disk. Keeps the newest
 * 14 backups. Never throws for backup failures: the outcome is recorded in `backups` and returned.
 */
export async function createBackup({ db, config }) {
  await ensureTable(db);
  const now = new Date();
  const record = { id: randomUUID(), createdAt: now.toISOString(), ok: false, fileName: backupFileName(now), size: null, location: null, error: null };
  try {
    const tables = await exportTables(db);
    const body = gzipSync(Buffer.from(JSON.stringify({ app: 'kalpa-taru', version: 1, createdAt: record.createdAt, tables })));
    record.size = body.length;
    const node = (await db.all('SELECT * FROM drives WHERE enabled = 1 ORDER BY created_at')).find(item => isConnected(item, config));
    if (node) record.location = await saveToDrive(node, config, record.fileName, body);
    else if (config.localStorage) record.location = await saveLocally(config, record.fileName, body);
    else throw new Error('No Google Drive is connected. Connect one under Storage so backups have somewhere to go.');
    record.ok = true;
  } catch (error) {
    console.error('Database backup failed:', error.message);
    record.error = String(error.message || error).slice(0, 500);
  }
  await db.run('INSERT INTO backups (id, created_at, ok, file_name, size, location, error) VALUES (?,?,?,?,?,?,?)',
    record.id, record.createdAt, record.ok ? 1 : 0, record.fileName, record.size, record.location, record.error);
  return record;
}

export async function listBackups(db, limit = 10) {
  await ensureTable(db);
  const rows = await db.all('SELECT * FROM backups ORDER BY created_at DESC LIMIT ?', limit);
  return rows.map(row => ({
    id: row.id, createdAt: row.created_at, ok: Boolean(row.ok), fileName: row.file_name,
    size: row.size, location: row.location, error: row.error,
  }));
}

/** Timing-safe check of an `Authorization: Bearer <secret>` header. */
export function cronAuthorized(header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
