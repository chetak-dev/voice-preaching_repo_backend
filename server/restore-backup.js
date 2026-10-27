// Restores a Kalpa Taru database backup: npm run restore-backup -- <file.json.gz> [--yes]
// Without --yes it only lists what the backup holds. Uses TURSO_DATABASE_URL/TURSO_AUTH_TOKEN (or DATA_DIR) from .env,
// exactly like the server. Rows are upserted, so existing rows with the same id are overwritten and others are kept.
// Drive refresh tokens are never stored in backups: existing tokens are kept, new Drives must be reconnected.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { openDatabase } from './db.js';
import { TABLE_ORDER } from './backup.js';

const args = process.argv.slice(2);
const file = args.find(arg => !arg.startsWith('--'));
const confirmed = args.includes('--yes');
if (!file) {
  console.error('Usage: npm run restore-backup -- <kalpa-taru-backup-....json.gz> [--yes]');
  process.exit(1);
}

const backup = JSON.parse(gunzipSync(readFileSync(path.resolve(file))).toString('utf8'));
if (backup.app !== 'kalpa-taru' || backup.version !== 1 || !backup.tables) {
  console.error('This file is not a Kalpa Taru backup (version 1).');
  process.exit(1);
}

const rank = name => (TABLE_ORDER.includes(name) ? TABLE_ORDER.indexOf(name) : TABLE_ORDER.length);
const names = Object.keys(backup.tables).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
console.log(`Backup created ${backup.createdAt}`);
for (const name of names) console.log(`  ${name}: ${backup.tables[name].length} rows`);
if (!confirmed) {
  console.log('\nNothing was written. Run again with --yes to restore these rows into the configured database.');
  process.exit(0);
}

// Content items may reference other content (parent_id); insert parents before their children.
function parentsFirst(rows) {
  const ids = new Set(rows.map(row => row.id));
  const placed = new Set();
  const ordered = [];
  let pending = rows;
  while (pending.length) {
    const next = pending.filter(row => row.parent_id && ids.has(row.parent_id) && !placed.has(row.parent_id));
    const ready = pending.filter(row => !next.includes(row));
    if (!ready.length) { ordered.push(...next); break; }
    for (const row of ready) { ordered.push(row); placed.add(row.id); }
    pending = next;
  }
  return ordered;
}

const value = item => (item && typeof item === 'object' && typeof item.$base64 === 'string' ? Buffer.from(item.$base64, 'base64') : item);
const quote = name => `"${String(name).replace(/"/g, '""')}"`;

const db = openDatabase({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  directory: path.resolve(process.env.DATA_DIR || 'data'),
});
await db.ready;
const existing = new Set((await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map(row => row.name));
for (const name of names) {
  if (!existing.has(name)) { console.warn(`Skipping ${name}: this database has no such table.`); continue; }
  const info = await db.all(`PRAGMA table_info(${quote(name)})`);
  const known = new Set(info.map(column => column.name));
  const keys = info.filter(column => column.pk).map(column => column.name);
  const rows = name === 'content' ? parentsFirst(backup.tables[name]) : backup.tables[name];
  let restored = 0;
  for (const row of rows) {
    // Tokens are blanked in backups; never overwrite a working connection with null.
    const columns = Object.keys(row).filter(column => known.has(column) && !(name === 'drives' && column === 'refresh_token'));
    const updates = columns.filter(column => !keys.includes(column));
    const insert = `INSERT INTO ${quote(name)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
    const sql = keys.length
      ? `${insert} ON CONFLICT(${keys.map(quote).join(',')}) DO ${updates.length ? `UPDATE SET ${updates.map(column => `${quote(column)} = excluded.${quote(column)}`).join(', ')}` : 'NOTHING'}`
      : insert.replace('INSERT INTO', 'INSERT OR REPLACE INTO');
    await db.run(sql, ...columns.map(column => value(row[column])));
    restored += 1;
  }
  console.log(`Restored ${restored} rows into ${name}.`);
}
db.close();
console.log('Restore complete. Reconnect any Google Drive that shows "Needs connection" under Storage.');
