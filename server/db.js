import { createClient } from '@libsql/client';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// A fixed dummy hash keeps response timing similar when the account does not exist.
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = (stored || DUMMY_HASH).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected) && Boolean(stored);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('site_admin','org_admin','user')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_states (
    hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id TEXT, node_id TEXT,
    verifier TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drives (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('oauth','service')),
    types TEXT NOT NULL, refresh_token TEXT, account_email TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS content (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
    type TEXT NOT NULL, mime TEXT, original_name TEXT, size INTEGER NOT NULL DEFAULT 0,
    storage_node TEXT, storage_key TEXT, url TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','private')),
    uploader_id TEXT NOT NULL REFERENCES users(id),
    reviewed_by TEXT REFERENCES users(id), review_note TEXT, reviewed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS content_status ON content(status, created_at);
  CREATE TABLE IF NOT EXISTS bookmarks (
    user_id TEXT NOT NULL REFERENCES users(id), content_id TEXT NOT NULL REFERENCES content(id),
    PRIMARY KEY(user_id, content_id)
  );
  CREATE TABLE IF NOT EXISTS content_views (
    content_id TEXT NOT NULL REFERENCES content(id), user_id TEXT NOT NULL REFERENCES users(id),
    viewed_at TEXT NOT NULL, PRIMARY KEY(content_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS audit (
    id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL, description TEXT NOT NULL, type TEXT NOT NULL, mime TEXT NOT NULL,
    original_name TEXT NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0,
    node TEXT NOT NULL, session_uri TEXT, created_at INTEGER NOT NULL
  );
`;

/**
 * Opens the database. Uses Turso/libSQL when `url` is a libsql:// or https:// URL
 * (needed on serverless hosts such as Vercel), otherwise a local SQLite file.
 * Every query helper is async: get() -> row | undefined, all() -> rows, run() -> { changes }.
 */
export function openDatabase({ url, authToken, directory }) {
  if (!url) {
    mkdirSync(directory, { recursive: true });
    url = pathToFileURL(path.join(directory, 'platform.sqlite')).href;
  }
  const client = createClient({ url, authToken: authToken || undefined });
  const local = url.startsWith('file:') || url === ':memory:';
  const toObject = (result, row) => Object.fromEntries(result.columns.map((column, i) => [column, row[i]]));
  const execute = (sql, args) => client.execute({ sql, args: args.map(value => value === undefined ? null : value) });
  const db = {
    async get(sql, ...args) {
      const result = await execute(sql, args);
      return result.rows[0] ? toObject(result, result.rows[0]) : undefined;
    },
    async all(sql, ...args) {
      const result = await execute(sql, args);
      return result.rows.map(row => toObject(result, row));
    },
    async run(sql, ...args) {
      const result = await execute(sql, args);
      return { changes: result.rowsAffected };
    },
    close: () => client.close(),
  };
  db.ready = (async () => {
    if (local) await client.executeMultiple('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    await client.executeMultiple(SCHEMA);
    const addColumns = async (table, columns) => {
      const existing = (await db.all(`PRAGMA table_info(${table})`)).map(column => column.name);
      for (const [name, definition] of columns) {
        if (!existing.includes(name)) await client.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    await addColumns('users', [
      ['password_hash', 'TEXT'],
      ['google_linked', 'INTEGER NOT NULL DEFAULT 0'],
      ['suspended', 'INTEGER NOT NULL DEFAULT 0'],
    ]);
    await addColumns('drives', [
      ['enabled', 'INTEGER NOT NULL DEFAULT 1'],
      ['quota_usage', 'INTEGER'],
      ['quota_limit', 'INTEGER'],
      ['quota_checked_at', 'INTEGER'],
    ]);
    await addColumns('content', [
      ['deletion_token', 'TEXT'],
      ['deletion_lock_expires', 'INTEGER'],
      ['visibility', "TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','private'))"],
      // Set when this file or link was added to an existing upload.
      ['parent_id', 'TEXT REFERENCES content(id)'],
    ]);
    await client.execute('CREATE INDEX IF NOT EXISTS content_parent ON content(parent_id, created_at)');
    await addColumns('uploads', [
      ['chunk_lock', 'TEXT'],
      ['chunk_lock_expires', 'INTEGER'],
      ['completed_key', 'TEXT'],
      ['parent_id', 'TEXT'],
    ]);
  })();
  return db;
}

export function audit(db, actorId, action, subject) {
  return db.run('INSERT INTO audit VALUES (?, ?, ?, ?, ?)', randomUUID(), actorId, action, subject, new Date().toISOString());
}
