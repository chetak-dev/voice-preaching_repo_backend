// Promotes an existing account to site admin: npm run make-admin -- someone@example.com
import 'dotenv/config';
import path from 'node:path';
import { audit, openDatabase } from './db.js';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run make-admin -- <email>  (the person must have signed up first)');
  process.exit(1);
}
const db = openDatabase(path.resolve(process.env.DATA_DIR || 'data'));
const user = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No account found for ${email}. Sign up on the website first, then run this again.`);
  process.exit(1);
}
db.prepare("UPDATE users SET role = 'site_admin', suspended = 0 WHERE id = ?").run(user.id);
audit(db, user.id, 'Made site admin (command line)', email);
db.close();
console.log(`${email} is now a site admin.`);
