// Promotes an existing account to site admin: npm run make-admin -- someone@example.com
// Uses TURSO_DATABASE_URL/TURSO_AUTH_TOKEN from .env when set, so it also works for the hosted database.
import 'dotenv/config';
import path from 'node:path';
import { audit, openDatabase } from './db.js';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run make-admin -- <email>  (the person must have signed up first)');
  process.exit(1);
}
const db = openDatabase({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  directory: path.resolve(process.env.DATA_DIR || 'data'),
});
await db.ready;
const user = await db.get('SELECT id FROM users WHERE email = ?', email);
if (!user) {
  console.error(`No account found for ${email}. Sign up on the website first, then run this again.`);
  process.exit(1);
}
await db.run("UPDATE users SET role = 'site_admin', suspended = 0 WHERE id = ?", user.id);
await audit(db, user.id, 'Made site admin (command line)', email);
db.close();
console.log(`${email} is now a site admin.`);
