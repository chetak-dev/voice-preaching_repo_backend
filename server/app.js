import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { google } from 'googleapis';
import { openDatabase, audit, hashPassword, verifyPassword } from './db.js';
import { createBackup, cronAuthorized, listBackups } from './backup.js';
import { CHUNK_SIZE, DRIVE_FILE_SCOPE, createStorage, driveClient, encryptToken, ensureAppFolder, isConnected, oauthClient, refreshQuota } from './storage.js';

const TYPES = ['image', 'video', 'audio', 'doc', 'link'];
const FILE_TYPES = TYPES.filter(type => type !== 'link');
// Formats the browser may display inline. Any other file type is accepted but only ever served as a sandboxed download.
const MIME_TYPES = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/webm': 'video',
  'audio/mpeg': 'audio', 'audio/wav': 'audio', 'audio/x-wav': 'audio', 'audio/ogg': 'audio',
  'application/pdf': 'doc', 'text/plain': 'doc',
};
const normalizeMime = mime => {
  const value = String(mime || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(value) ? value : 'application/octet-stream';
};
const classify = mime => MIME_TYPES[mime] || ['image', 'video', 'audio'].find(type => mime.startsWith(`${type}/`)) || 'doc';
const UPLOAD_TTL_MS = 24 * 3600_000;
const POINTS_PER_APPROVAL = 10;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const text = (value, label, max = 160, min = 1) => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw fail(400, `${label} must be ${min}-${max} characters.`);
  }
  return value.trim();
};
const emailAddress = value => {
  const email = text(value, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a valid email address.');
  return email;
};
const publicUser = row => ({
  id: row.id, email: row.email, name: row.name, role: row.role,
  suspended: Boolean(row.suspended), google: Boolean(row.google_linked), password: Boolean(row.password_hash),
  createdAt: row.created_at,
});

export const LANGUAGES = ['English', 'Hindi', 'Odia', 'Bengali', 'Sanskrit', 'Telugu', 'Other'];
// Verses in the Bhagavad Gita per chapter, used to reject impossible references.
const GITA_VERSES = [47, 72, 43, 42, 29, 47, 30, 28, 34, 42, 55, 20, 35, 27, 20, 24, 28, 78];
// Turns "BG 2.13, 3:19-21, ch 4" into "2.13,3.19,3.20,3.21,4". A bare number is a whole chapter.
export function normalizeVerses(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 300) throw fail(400, 'Verses must be under 300 characters.');
  const out = [];
  for (const piece of value.split(/[,;]+/)) {
    const part = piece.toLowerCase().replace(/bhagavad|gita|bg|chapter|ch\.?|verse|text|\s+/g, ' ').trim();
    if (!part) continue;
    const match = part.match(/^(\d{1,2})(?:\s*[.:]\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?)?$/);
    const chapter = Number(match?.[1]);
    if (!match || chapter < 1 || chapter > 18) throw fail(400, `"${piece.trim()}" is not a Gita reference. Use chapter.verse, like 2.13 or 3.19-21.`);
    if (!match[2]) { out.push(String(chapter)); continue; }
    const from = Number(match[2]);
    const to = Number(match[3] || match[2]);
    if (from < 1 || to < from || to > GITA_VERSES[chapter - 1] || to - from > 20) throw fail(400, `Chapter ${chapter} has verses 1-${GITA_VERSES[chapter - 1]}.`);
    for (let verse = from; verse <= to; verse += 1) out.push(`${chapter}.${verse}`);
  }
  const unique = [...new Set(out)];
  if (unique.length > 40) throw fail(400, 'Add at most 40 verses.');
  return unique.length ? unique.join(',') : null;
}
const normalizeTopics = value => {
  if (value == null || value === '') return null;
  const list = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .map(topic => String(topic).trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (list.some(topic => topic.length > 40)) throw fail(400, 'Each topic must be under 40 characters.');
  const unique = list.filter((topic, index) => list.findIndex(other => other.toLowerCase() === topic.toLowerCase()) === index);
  if (unique.length > 8) throw fail(400, 'Add at most 8 topics.');
  return unique.length ? unique.join(',') : null;
};
// Reads optional tags; fields that are missing keep their current values.
function tagFields(body, current = {}) {
  const pick = (key, read) => (body[key] === undefined ? current[key] ?? null : read(body[key]));
  return {
    language: pick('language', value => {
      if (value == null || value === '') return null;
      if (!LANGUAGES.includes(value)) throw fail(400, 'Choose a listed language.');
      return value;
    }),
    speaker: pick('speaker', value => (value == null || value === '' ? null : text(value, 'Speaker', 80))),
    verses: pick('verses', normalizeVerses),
    topics: pick('topics', normalizeTopics),
  };
}
const fingerprintOf = value => (typeof value === 'string' && /^\d{1,15}:[a-f0-9]{64}$/.test(value) ? value : null);
const likeEscape = value => value.replace(/[\\%_]/g, char => `\\${char}`);
const TEXT_LIMIT = 60_000;

// Turns Google API failures into actionable messages; raw details are shown only to site admins connecting a Drive.
export function googleProblem(error, purpose) {
  const data = error?.response?.data || {};
  const details = typeof data.error === 'object' ? data.error : {};
  const reasons = [...(details.errors || []), ...(details.details || [])].map(item => item.reason).filter(Boolean);
  const text = `${details.message || ''} ${data.error_description || ''} ${error?.message || ''}`;
  if (reasons.some(r => ['accessNotConfigured', 'SERVICE_DISABLED'].includes(r)) || /has not been used in project|is disabled/i.test(text)) {
    return 'The Google Drive API is not enabled in your Google Cloud project. Enable it under APIs & Services → Library → Google Drive API, wait a few minutes, then click Connect again.';
  }
  if (data.error === 'invalid_client' || /invalid_client|unauthorized_client/i.test(text)) {
    return 'Google rejected the OAuth client. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your hosting settings.';
  }
  if (data.error === 'invalid_grant') return 'Google rejected the sign-in code (it may have expired). Please try again.';
  if (reasons.includes('insufficientPermissions') || /insufficient (permission|authentication scopes)/i.test(text)) {
    return 'Google Drive access was not granted. Click Connect again and tick the Google Drive permission.';
  }
  if (purpose === 'drive' && details.message) return `Google Drive error: ${details.message}`;
  return '';
}

function configuration(overrides) {
  const serverless = Boolean(process.env.VERCEL);
  // On Vercel, NODE_ENV=production would skip installing the build tools, so the platform itself implies production.
  const production = process.env.NODE_ENV === 'production' || serverless;
  const vercelOrigin = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
  const config = {
    production,
    serverless,
    // Serverless hosts have no permanent disk: files must go to Google Drive and the database to Turso.
    localStorage: !serverless,
    serveStatic: production && !serverless,
    trustProxy: Number(process.env.TRUST_PROXY ?? (production || serverless ? 1 : 0)),
    origin: process.env.APP_ORIGIN || vercelOrigin || 'http://localhost:5173',
    dataDir: path.resolve(process.env.DATA_DIR || 'data'),
    databaseUrl: process.env.TURSO_DATABASE_URL || '',
    databaseAuthToken: process.env.TURSO_AUTH_TOKEN || '',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    siteAdmins: (process.env.SITE_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    serviceAccount: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
    encryptionKey: process.env.STORAGE_ENCRYPTION_KEY || '',
    cronSecret: process.env.CRON_SECRET || '',
    ...overrides,
  };
  if (new URL(config.origin).origin !== config.origin) throw new Error('APP_ORIGIN must be an origin without a trailing slash.');
  if (config.production && !config.origin.startsWith('https://')) throw new Error('Production APP_ORIGIN must use HTTPS.');
  if (config.production && (!config.googleClientId || !config.googleClientSecret || !config.siteAdmins.length)) {
    throw new Error('Production requires Google OAuth credentials and SITE_ADMIN_EMAILS.');
  }
  if (config.serverless && !config.databaseUrl) throw new Error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN: serverless hosts cannot keep a local database.');
  if (!Number.isInteger(config.trustProxy) || config.trustProxy < 0 || config.trustProxy > 10) {
    throw new Error('TRUST_PROXY must be the number of proxies in front of the server (0-10).');
  }
  return config;
}

function verifySignature(chunk, mime, size) {
  const buffer = chunk.subarray(0, 512);
  const starts = hex => buffer.subarray(0, hex.length / 2).toString('hex') === hex;
  const ascii = buffer.toString('latin1');
  const matches = {
    'image/jpeg': starts('ffd8ff'),
    'image/png': starts('89504e470d0a1a0a'),
    'image/webp': ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP',
    'application/pdf': ascii.startsWith('%PDF-'),
    'video/mp4': ascii.slice(4, 8) === 'ftyp',
    'video/webm': starts('1a45dfa3'),
    'audio/mpeg': ascii.startsWith('ID3') || (buffer[0] === 255 && (buffer[1] & 224) === 224),
    'audio/wav': ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE',
    'audio/x-wav': ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE',
    'audio/ogg': ascii.startsWith('OggS'),
    'text/plain': size > 0 && !buffer.includes(0) && !starts('4d5a'),
  };
  if (mime in matches && !matches[mime]) throw fail(400, 'The file contents do not match the selected file format.');
}

export function createApp(overrides = {}) {
  const config = configuration(overrides);
  const app = express();
  const db = openDatabase({ url: config.databaseUrl, authToken: config.databaseAuthToken, directory: config.dataDir });
  const storage = createStorage(config, db);
  app.locals.db = db;
  app.locals.config = config;
  app.locals.ready = db.ready;
  db.ready.catch(error => console.error('Database initialisation failed:', error.message));
  app.disable('x-powered-by');
  // Hosting platforms terminate HTTPS at a proxy; trust it so client IPs and rate limits are correct.
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', h(async (req, res, next) => { await db.ready; next(); }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: config.apiRateLimit || 240, standardHeaders: 'draft-8', legacyHeaders: false,
    // Upload chunks are bounded by the upload size limit, so they don't count towards the request rate.
    skip: req => req.method === 'PUT' && req.path.startsWith('/uploads/'),
    message: { error: 'Too many requests. Please try again in a minute.' } }));
  // Document text for search is larger than other request bodies.
  const jsonBody = express.json({ limit: '32kb' });
  app.use((req, res, next) => (/^\/api\/content\/[^/]+\/text$/.test(req.path) ? next() : jsonBody(req, res, next)));
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== config.origin) {
      return next(fail(403, 'Request origin is not allowed. Refresh the application and try again.'));
    }
    next();
  });

  function cookie(req, name) {
    return (req.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  }
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/' };
  async function session(res, userId) {
    const token = randomBytes(32).toString('hex');
    await db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    await db.run('INSERT INTO sessions VALUES (?, ?, ?)', hash(token), userId, Date.now() + 7 * 86400000);
    res.cookie('voice_session', token, { ...cookieOptions, maxAge: 7 * 86400000 });
  }
  app.use('/api', h(async (req, res, next) => {
    const token = cookie(req, 'voice_session');
    if (token) req.user = await db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.suspended = 0`, hash(token), Date.now());
    next();
  }));
  const authenticated = (req, res, next) => req.user ? next() : next(fail(401, 'Please sign in to continue.'));
  const roles = (...allowed) => (req, res, next) =>
    allowed.includes(req.user?.role) ? next() : next(fail(403, 'You do not have permission to perform this action.'));
  const siteAdmin = roles('site_admin');
  const reviewers = roles('site_admin', 'org_admin');
  const isReviewer = user => user.role === 'site_admin' || user.role === 'org_admin';
  // Admin contributions are published immediately; everyone else's wait for review.
  const initialReview = user => isReviewer(user)
    ? { status: 'approved', reviewedBy: user.id, reviewedAt: new Date().toISOString(), action: 'Published content', message: 'Published.' }
    : { status: 'pending', reviewedBy: null, reviewedAt: null, action: 'Submitted content', message: 'Submitted for admin approval.' };
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, legacyHeaders: false, skipSuccessfulRequests: true,
    message: { error: 'Too many sign-in attempts. Please try again later.' } });

  app.get('/api/config', (req, res) => res.json({
    googleConfigured: Boolean(config.googleClientId && config.googleClientSecret),
  }));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/auth/me', authenticated, (req, res) => res.json({ user: publicUser(req.user) }));
  app.post('/api/auth/logout', authenticated, h(async (req, res) => {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', hash(cookie(req, 'voice_session')));
    res.clearCookie('voice_session', cookieOptions);
    res.json({ ok: true });
  }));
  const password = value => {
    if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw fail(400, 'Password must be 8-128 characters.');
    return value;
  };
  app.post('/api/auth/signup', authLimiter, h(async (req, res) => {
    const name = text(req.body.name, 'Name', 100, 2);
    const email = emailAddress(req.body.email);
    const secret = password(req.body.password);
    if (config.siteAdmins.includes(email)) throw fail(403, 'This address is reserved for administrators. Continue with Google instead.');
    if (await db.get('SELECT id FROM users WHERE email = ?', email)) throw fail(409, 'An account with this email already exists. Sign in instead.');
    const id = randomUUID();
    await db.run('INSERT INTO users (id, email, name, role, created_at, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
      id, email, name, 'user', new Date().toISOString(), hashPassword(secret));
    await audit(db, id, 'Signed up', email);
    await session(res, id);
    res.status(201).json({ ok: true });
  }));
  app.post('/api/auth/login', authLimiter, h(async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const secret = typeof req.body.password === 'string' ? req.body.password : '';
    const user = email ? await db.get('SELECT * FROM users WHERE email = ?', email) : null;
    const valid = verifyPassword(secret, user?.password_hash);
    if (!user || !valid) throw fail(401, 'Incorrect email or password. If you joined with Google, use Continue with Google.');
    if (user.suspended) throw fail(403, 'This account has been suspended. Contact an administrator.');
    await session(res, user.id);
    res.json({ ok: true });
  }));

  async function beginOAuth(req, res, purpose, nodeId = null) {
    if (!config.googleClientId || !config.googleClientSecret) throw fail(503, 'Google sign-in has not been configured.');
    const state = randomBytes(32).toString('hex');
    const verifier = randomBytes(48).toString('base64url');
    await db.run('DELETE FROM oauth_states WHERE expires_at < ?', Date.now());
    await db.run('INSERT INTO oauth_states VALUES (?, ?, ?, ?, ?, ?)',
      hash(state), purpose, req.user?.id || null, nodeId, verifier, Date.now() + 600000);
    res.cookie('voice_oauth', state, { ...cookieOptions, maxAge: 600000 });
    res.redirect(oauthClient(config).generateAuthUrl({
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: purpose === 'drive'
        ? ['openid', 'email', 'profile', DRIVE_FILE_SCOPE]
        : ['openid', 'email', 'profile'],
      access_type: purpose === 'drive' ? 'offline' : 'online',
      prompt: purpose === 'drive' ? 'consent' : 'select_account',
    }));
  }
  app.get('/api/auth/google', authLimiter, h((req, res) => beginOAuth(req, res, 'login')));
  app.get('/api/auth/google/callback', authLimiter, h(async (req, res) => {
    let purpose = 'login';
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const record = await db.get('SELECT * FROM oauth_states WHERE hash = ?', hash(state));
      if (!record || record.expires_at < Date.now() || cookie(req, 'voice_oauth') !== state) {
        throw fail(400, 'The sign-in request expired. Please try again.');
      }
      purpose = record.purpose;
      await db.run('DELETE FROM oauth_states WHERE hash = ?', hash(state));
      res.clearCookie('voice_oauth', cookieOptions);
      if (req.query.error) throw fail(400, 'Google authorization was cancelled or denied.');
      if (typeof req.query.code !== 'string') throw fail(400, 'Google did not return an authorization code.');
      const client = oauthClient(config);
      const { tokens } = await client.getToken({ code: req.query.code, codeVerifier: record.verifier });
      if (!tokens.id_token) throw fail(400, 'Google did not return a verified identity.');
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.googleClientId });
      const identity = ticket.getPayload();
      if (!identity?.email_verified || !identity.email) throw fail(403, 'A verified Google email address is required.');
      const email = identity.email.toLowerCase();
      if (record.purpose === 'drive') {
        if (req.user?.id !== record.user_id || req.user.role !== 'site_admin') throw fail(403, 'Site administrator access is required.');
        if (!tokens.refresh_token) throw fail(400, 'No offline access token was returned. Reconnect and grant consent.');
        if (!String(tokens.scope || '').split(' ').includes(DRIVE_FILE_SCOPE)) {
          throw fail(400, 'Google Drive access was not granted. Click Connect again and tick the Google Drive permission.');
        }
        client.setCredentials(tokens);
        const node = await db.get('SELECT * FROM drives WHERE id = ?', record.node_id);
        if (!node) throw fail(404, 'Storage destination not found.');
        const other = await db.get("SELECT name FROM drives WHERE kind = 'oauth' AND account_email = ? AND id != ?", email, node.id);
        if (other) throw fail(409, `${email} is already connected as "${other.name}". Use a different Google account for each Drive.`);
        const holdsFiles = await db.get('SELECT 1 AS found FROM content WHERE storage_node = ? LIMIT 1', node.id);
        if (holdsFiles && node.account_email && node.account_email !== email) {
          throw fail(409, `This Drive's files are stored in ${node.account_email}. Reconnect with that Google account.`);
        }
        const folderId = await ensureAppFolder(google.drive({ version: 'v3', auth: client }), node.folder_id);
        await db.run('UPDATE drives SET refresh_token = ?, account_email = ?, folder_id = ?, quota_checked_at = NULL WHERE id = ?',
          encryptToken(tokens.refresh_token, config.encryptionKey), email, folderId, record.node_id);
        await audit(db, req.user.id, 'Connected Google Drive', node.name);
        return res.redirect(`${config.origin}/?connected=1`);
      }
      let user = await db.get('SELECT * FROM users WHERE email = ?', email);
      const isSiteAdmin = config.siteAdmins.includes(email);
      if (!user) {
        const id = randomUUID();
        await db.run('INSERT INTO users (id, email, name, role, created_at, google_linked) VALUES (?, ?, ?, ?, ?, 1)',
          id, email, identity.name || email.split('@')[0], isSiteAdmin ? 'site_admin' : 'user', new Date().toISOString());
        await audit(db, id, 'Signed up with Google', email);
        user = await db.get('SELECT * FROM users WHERE id = ?', id);
      } else {
        if (user.suspended) throw fail(403, 'This account has been suspended. Contact an administrator.');
        if (!user.google_linked) {
          // Someone may have registered this address with a password before its owner signed in with Google.
          await db.run('UPDATE users SET google_linked = 1, password_hash = NULL WHERE id = ?', user.id);
          await db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
        }
        if (isSiteAdmin && user.role !== 'site_admin') await db.run("UPDATE users SET role = 'site_admin' WHERE id = ?", user.id);
      }
      await session(res, user.id);
      res.redirect(config.origin);
    } catch (error) {
      console.error('Google authorization failed:', error);
      const message = error.expose ? error.message
        : googleProblem(error, purpose) || 'Google authorization failed. Check the server configuration and try again.';
      res.redirect(`${config.origin}/?authError=${encodeURIComponent(message)}`);
    }
  }));

  // Shared links (/s/:id) give chat apps a title and thumbnail to preview, then send people into the app.
  // Only approved public uploads reveal anything; viewing the content itself still requires signing in.
  const shareLimiter = rateLimit({ windowMs: 60_000, limit: 120, legacyHeaders: false });
  const sharedItem = async id => {
    await db.ready;
    if (typeof id !== 'string' || id.length > 80) return null;
    return db.get(`SELECT c.id, c.title, c.description, c.type, EXISTS(SELECT 1 FROM thumbnails t WHERE t.content_id = c.id) AS has_thumb
      FROM content c WHERE c.id = ? AND c.status = 'approved' AND c.visibility = 'public' AND c.parent_id IS NULL`, id);
  };
  const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  app.get(['/s/:id', '/api/share/:id'], shareLimiter, h(async (req, res) => {
    const item = await sharedItem(req.params.id);
    const target = item ? `/?content=${encodeURIComponent(item.id)}#/library` : '/';
    const title = item ? item.title : 'Kalpa Taru';
    const description = (item?.description || 'Gita preaching content shared on Kalpa Taru by ISKCON Brahmapur.').slice(0, 200);
    const image = item?.has_thumb ? `${config.origin}/api/share/${encodeURIComponent(item.id)}/image` : `${config.origin}/icon-512.png`;
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(item ? `${title} · Kalpa Taru` : title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:site_name" content="Kalpa Taru">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:url" content="${escapeHtml(`${config.origin}/s/${item ? encodeURIComponent(item.id) : ''}`)}">
<meta name="twitter:card" content="${item?.has_thumb ? 'summary_large_image' : 'summary'}">
<meta http-equiv="refresh" content="0;url=${escapeHtml(target)}">
</head><body><p><a href="${escapeHtml(target)}">Open ${escapeHtml(title)} on Kalpa Taru</a></p></body></html>`);
  }));
  app.get('/api/share/:id/image', shareLimiter, h(async (req, res) => {
    const item = await sharedItem(req.params.id);
    const thumb = item?.has_thumb && await db.get('SELECT mime, data FROM thumbnails WHERE content_id = ?', item.id);
    if (!thumb) throw fail(404, 'No preview image.');
    res.set('Cache-Control', 'public, max-age=86400');
    res.type(thumb.mime).send(Buffer.from(thumb.data));
  }));

  // Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`; it runs without a user session.
  app.get('/api/cron/backup', h(async (req, res) => {
    if (!cronAuthorized(req.get('authorization'), config.cronSecret)) throw fail(401, 'Unauthorized.');
    const record = await createBackup({ db, config });
    res.status(record.ok ? 200 : 500).json(record.ok ? { ok: true } : { ok: false, error: record.error });
  }));

  app.use('/api', authenticated);
  const contentQuery = `SELECT c.*, u.name AS uploader, r.name AS reviewer, p.title AS parent_title,
    EXISTS(SELECT 1 FROM bookmarks b WHERE b.content_id = c.id AND b.user_id = ?) AS bookmarked,
    EXISTS(SELECT 1 FROM thumbnails t WHERE t.content_id = c.id) AS has_thumb,
    EXISTS(SELECT 1 FROM content_text x WHERE x.content_id = c.id) AS has_text,
    (SELECT count(*) FROM content_views v WHERE v.content_id = c.id) AS views,
    (SELECT count(*) FROM content a WHERE a.parent_id = c.id AND a.status = 'approved') AS parts
    FROM content c JOIN users u ON u.id = c.uploader_id
    LEFT JOIN users r ON r.id = c.reviewed_by
    LEFT JOIN content p ON p.id = c.parent_id`;
  function visible(item, user) {
    const privateAccess = item.visibility !== 'private' || item.uploader_id === user.id || isReviewer(user);
    return privateAccess && (item.status === 'approved' || isReviewer(user) || item.uploader_id === user.id);
  }
  async function getContent(req, id = req.params.id) {
    const item = await db.get(`${contentQuery} WHERE c.id = ?`, req.user.id, id);
    if (!item || !visible(item, req.user)) throw fail(404, 'Content not found.');
    // Additions are only reachable while the upload they belong to is reachable.
    if (item.parent_id) {
      const parent = await db.get('SELECT * FROM content WHERE id = ?', item.parent_id);
      if (!parent || (!visible(parent, req.user) && item.uploader_id !== req.user.id && !isReviewer(req.user))) throw fail(404, 'Content not found.');
    }
    return { item };
  }
  // Contributors may add to their own upload while it is pending or approved; anyone may add to approved uploads.
  async function additionTarget(req) {
    const parentId = req.body.parentId;
    if (parentId == null || parentId === '') return null;
    if (typeof parentId !== 'string') throw fail(400, 'Choose a valid upload to add to.');
    const { item: parent } = await getContent(req, parentId);
    if (parent.parent_id) throw fail(400, 'Add files to the main upload instead.');
    if (parent.status === 'rejected') throw fail(409, 'Rejected uploads cannot receive more files.');
    if (parent.status !== 'approved' && parent.uploader_id !== req.user.id) throw fail(409, 'This upload is still waiting for approval.');
    return parent;
  }
  const count = async (sql, ...args) => (await db.get(sql, ...args)).n;
  async function notify(userId, kind, title, body = '', contentId = null, link = null) {
    if (!userId) return;
    await db.run(`INSERT INTO notifications (id, user_id, kind, title, body, content_id, link, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      randomUUID(), userId, kind, title.slice(0, 200), String(body || '').slice(0, 500), contentId, link, new Date().toISOString());
  }
  async function openRequest(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || value.length > 80) throw fail(400, 'Choose a valid request.');
    const request = await db.get("SELECT id FROM content_requests WHERE id = ? AND status = 'open'", value);
    if (!request) throw fail(409, 'That request is no longer open.');
    return request.id;
  }
  // Called whenever content becomes approved: tells the contributor and closes the request it answered.
  async function published(item, reviewerId) {
    if (reviewerId && item.uploader_id !== reviewerId) {
      await notify(item.uploader_id, 'approved', `Approved: ${item.title}`, item.parent_id ? 'Your addition is now live.' : 'Your contribution is now in the library.', item.id);
    }
    if (!item.request_id || item.parent_id) return;
    const request = await db.get("SELECT * FROM content_requests WHERE id = ? AND status = 'open'", item.request_id);
    if (!request) return;
    const done = await db.run(`UPDATE content_requests SET status = 'fulfilled', content_id = ?, fulfilled_by = ?, closed_at = ?
      WHERE id = ? AND status = 'open'`, item.id, item.uploader_id, new Date().toISOString(), request.id);
    if (!done.changes) return;
    const voters = await db.all('SELECT user_id FROM request_votes WHERE request_id = ?', request.id);
    for (const userId of new Set([request.user_id, ...voters.map(row => row.user_id)])) {
      if (userId !== item.uploader_id) await notify(userId, 'request', `Request fulfilled: ${request.title}`, `"${item.title}" was added to the library.`, item.id);
    }
  }
  const strip = ({ storage_key, fingerprint, ...item }) => item;
  const snippetFrom = (body, tokens) => {
    const lower = body.toLowerCase();
    const at = tokens.map(token => lower.indexOf(token)).filter(index => index >= 0).sort((a, b) => a - b)[0];
    if (at == null) return null;
    const start = Math.max(0, at - 60);
    return `${start ? '…' : ''}${body.slice(start, at + 140).replace(/\s+/g, ' ').trim()}…`;
  };
  // Without `limit` every match is returned (used by review); with it, results are paged.
  app.get('/api/content', h(async (req, res) => {
    const scope = req.query.scope || 'library';
    if (!['library', 'mine', 'review', 'saved'].includes(scope)) throw fail(400, 'Unknown content view.');
    if (scope === 'review' && !isReviewer(req.user)) throw fail(403, 'Only administrators can review submissions.');
    const clauses = {
      library: "c.status = 'approved' AND c.visibility = 'public' AND c.parent_id IS NULL", mine: 'c.uploader_id = ?',
      review: "c.status = 'pending'", saved: "c.status = 'approved' AND c.visibility = 'public' AND c.parent_id IS NULL AND EXISTS(SELECT 1 FROM bookmarks b WHERE b.content_id = c.id AND b.user_id = ?)",
    };
    const where = [clauses[scope]];
    const params = scope === 'mine' || scope === 'saved' ? [req.user.id] : [];
    const param = name => (typeof req.query[name] === 'string' ? req.query[name].trim() : '');

    if (scope === 'mine' && ['pending', 'approved', 'rejected'].includes(param('status'))) { where.push('c.status = ?'); params.push(param('status')); }
    if (LANGUAGES.includes(param('language'))) { where.push('c.language = ?'); params.push(param('language')); }
    if (param('speaker') && param('speaker').length <= 80) { where.push('c.speaker = ? COLLATE NOCASE'); params.push(param('speaker')); }
    if (param('topic') && param('topic').length <= 40) {
      where.push("(',' || c.topics || ',') LIKE ? ESCAPE '\\'");
      params.push(`%,${likeEscape(param('topic'))},%`);
    }
    const chapter = Number(param('chapter'));
    if (Number.isInteger(chapter) && chapter >= 1 && chapter <= 18) {
      where.push("((',' || c.verses || ',') LIKE ? OR (',' || c.verses || ',') LIKE ?)");
      params.push(`%,${chapter}.%`, `%,${chapter},%`);
    }
    const q = param('q').slice(0, 100);
    const tokens = [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
    for (const token of tokens) {
      const like = `%${likeEscape(token)}%`;
      const verse = token.match(/^(\d{1,2})[.:](\d{1,2})$/);
      where.push(`(c.title LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\'
        OR c.speaker LIKE ? ESCAPE '\\' OR c.topics LIKE ? ESCAPE '\\' OR c.original_name LIKE ? ESCAPE '\\'
        OR EXISTS(SELECT 1 FROM content_text x WHERE x.content_id = c.id AND x.body LIKE ? ESCAPE '\\')
        ${verse ? "OR (',' || c.verses || ',') LIKE ? OR (',' || c.verses || ',') LIKE ?" : ''})`);
      params.push(like, like, like, like, like, like, like);
      if (verse) params.push(`%,${Number(verse[1])}.${Number(verse[2])},%`, `%,${Number(verse[1])},%`);
    }
    // Type counts ignore the type filter so the chips show how many of each kind match.
    const base = where.join(' AND ');
    const baseParams = [...params];
    if (TYPES.includes(param('type'))) { where.push('c.type = ?'); params.push(param('type')); }
    const filter = where.join(' AND ');

    const orders = {
      newest: 'c.created_at DESC', oldest: 'c.created_at ASC', title: 'c.title COLLATE NOCASE ASC', popular: 'views DESC, c.created_at DESC',
    };
    const sort = orders[param('sort')] ? param('sort') : 'newest';
    const relevance = q ? "CASE WHEN c.title LIKE ? ESCAPE '\\' THEN 0 WHEN c.title LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, " : '';
    const orderParams = q ? [`${likeEscape(q)}%`, `%${likeEscape(q)}%`] : [];
    const limit = Number(param('limit'));
    const paged = Number.isInteger(limit) && limit > 0;
    const offset = Math.max(0, Number.parseInt(param('offset'), 10) || 0);
    const page = paged ? ` LIMIT ${Math.min(limit, 100)} OFFSET ${offset}` : '';
    const rows = await db.all(`${contentQuery} WHERE ${filter} ORDER BY ${relevance}${orders[sort]}${page}`, req.user.id, ...params, ...orderParams);

    if (tokens.length) {
      const withText = rows.filter(row => row.has_text && !tokens.some(token => row.title.toLowerCase().includes(token)));
      if (withText.length) {
        const bodies = await db.all(`SELECT content_id, body FROM content_text WHERE content_id IN (${withText.map(() => '?').join(',')})`, ...withText.map(row => row.id));
        for (const { content_id: id, body } of bodies) {
          const row = rows.find(item => item.id === id);
          row.snippet = snippetFrom(String(body), tokens);
        }
      }
    }
    // Reviewers are warned when a submission matches a file or link that is already in the library or waiting.
    if (scope === 'review') {
      for (const row of rows) {
        if (!row.fingerprint && !(row.type === 'link' && row.url)) continue;
        const match = (await db.all(`SELECT id, title, status, visibility, uploader_id FROM content
          WHERE id != ? AND status != 'rejected' AND (fingerprint = ? OR (type = 'link' AND url = ?))
          ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, created_at LIMIT 5`,
        row.id, row.fingerprint || null, row.type === 'link' ? row.url : null)).find(other => visible(other, req.user));
        if (match) row.duplicateOf = { id: match.id, title: match.title, status: match.status };
      }
    }
    const from = 'FROM content c JOIN users u ON u.id = c.uploader_id';
    const total = paged ? Number(await count(`SELECT count(*) AS n ${from} WHERE ${filter}`, ...params)) : rows.length;
    const typeRows = paged && offset === 0 ? await db.all(`SELECT c.type, count(*) AS n ${from} WHERE ${base} GROUP BY c.type`, ...baseParams) : null;
    res.json({
      items: rows.map(strip), total, hasMore: paged ? offset + rows.length < total : false,
      ...(typeRows ? { counts: Object.fromEntries(typeRows.map(row => [row.type, Number(row.n)])) } : {}),
    });
  }));
  app.get('/api/content/facets', h(async (req, res) => {
    const rows = await db.all(`SELECT language, speaker, topics, verses FROM content
      WHERE status = 'approved' AND visibility = 'public' AND parent_id IS NULL
        AND (language IS NOT NULL OR speaker IS NOT NULL OR topics IS NOT NULL OR verses IS NOT NULL)`);
    const tally = values => [...values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => ({ name, count: n }));
    res.json({
      languages: tally(rows.map(row => row.language).filter(Boolean)),
      speakers: tally(rows.map(row => row.speaker).filter(Boolean)).slice(0, 50),
      topics: tally(rows.flatMap(row => (row.topics ? row.topics.split(',') : []))).slice(0, 50),
      chapters: tally(rows.flatMap(row => [...new Set((row.verses ? row.verses.split(',') : []).map(ref => ref.split('.')[0]))]))
        .sort((a, b) => Number(a.name) - Number(b.name)),
    });
  }));
  app.get('/api/content/:id', h(async (req, res) => {
    const { item } = await getContent(req);
    res.json({ item: strip(item) });
  }));
  app.get('/api/content/:id/parts', h(async (req, res) => {
    const { item } = await getContent(req);
    const rows = await db.all(`${contentQuery} WHERE c.parent_id = ?
      AND (c.status = 'approved' OR c.uploader_id = ? OR (? = 1 AND c.status = 'pending'))
      ORDER BY c.created_at`, req.user.id, item.id, req.user.id, isReviewer(req.user) ? 1 : 0);
    res.json({ items: rows.map(strip) });
  }));
  // Text is read from documents in the uploader's (or an admin's) browser and stored only for search.
  app.put('/api/content/:id/text', express.json({ limit: '256kb' }), h(async (req, res) => {
    const { item } = await getContent(req);
    if (item.uploader_id !== req.user.id && !isReviewer(req.user)) throw fail(403, 'Only the uploader or an admin can add document text.');
    if (item.type !== 'doc') throw fail(400, 'Only documents have searchable text.');
    if (typeof req.body.text !== 'string') throw fail(400, 'Send the document text.');
    const body = req.body.text.replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').slice(0, TEXT_LIMIT);
    await db.run(`INSERT INTO content_text (content_id, body, created_at) VALUES (?, ?, ?)
      ON CONFLICT(content_id) DO UPDATE SET body = excluded.body, created_at = excluded.created_at`, item.id, body, new Date().toISOString());
    res.json({ ok: true, length: body.length });
  }));
  app.get('/api/overview', h(async (req, res) => {
    const approved = await count("SELECT count(*) AS n FROM content WHERE status = 'approved' AND visibility = 'public'");
    const contributions = await count('SELECT count(*) AS n FROM content WHERE uploader_id = ?', req.user.id);
    const pending = isReviewer(req.user)
      ? await count("SELECT count(*) AS n FROM content WHERE status = 'pending'")
      : await count("SELECT count(*) AS n FROM content WHERE status = 'pending' AND uploader_id = ?", req.user.id);
    const members = await count('SELECT count(*) AS n FROM users');
    const typeRows = await db.all(`SELECT type, count(*) AS files, COALESCE(sum(size), 0) AS bytes FROM content
      WHERE status = 'approved' AND visibility = 'public' GROUP BY type`);
    const types = Object.fromEntries(typeRows.map(row => [row.type, { files: Number(row.files), bytes: Number(row.bytes) }]));
    if (!isReviewer(req.user)) {
      res.json({ approved, contributions, pending, members, types: Object.fromEntries(Object.entries(types).map(([type, info]) => [type, { files: info.files }])) });
      return;
    }
    const drives = (await db.all('SELECT * FROM drives WHERE enabled = 1')).filter(node => isConnected(node, config));
    const measured = drives.filter(node => node.quota_limit != null);
    const stored = await db.get("SELECT COALESCE(sum(size), 0) AS bytes FROM content WHERE status != 'rejected'");
    const storage = {
      drives: drives.length,
      used: measured.length ? measured.reduce((sum, node) => sum + Number(node.quota_usage || 0), 0) : null,
      total: measured.length ? measured.reduce((sum, node) => sum + Number(node.quota_limit), 0) : null,
      content: Number(stored.bytes),
      // Uploads already skip full Drives; this tells admins when one is close so they can add more storage in time.
      nearlyFull: measured.filter(node => Number(node.quota_limit) > 0 && Number(node.quota_usage || 0) / Number(node.quota_limit) >= 0.9)
        .map(node => ({ name: node.name, percent: Math.min(100, Math.round(Number(node.quota_usage || 0) / Number(node.quota_limit) * 100)) })),
    };
    const weeksAgo = new Date(Date.now() - 12 * 7 * 86400_000).toISOString();
    const recent = await db.all('SELECT created_at FROM content WHERE parent_id IS NULL AND created_at >= ?', weeksAgo);
    const weekly = Array.from({ length: 12 }, (_, index) => {
      const end = Date.now() - (11 - index) * 7 * 86400_000;
      const start = end - 7 * 86400_000;
      return { start: new Date(start).toISOString(), uploads: recent.filter(row => Date.parse(row.created_at) > start && Date.parse(row.created_at) <= end).length };
    });
    const tagged = await db.all("SELECT language, topics FROM content WHERE status = 'approved' AND visibility = 'public' AND parent_id IS NULL");
    const tally = values => [...values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, count: n }));
    const analytics = {
      topViewed: (await db.all(`SELECT c.id, c.title, c.type, count(v.user_id) AS views FROM content c JOIN content_views v ON v.content_id = c.id
        WHERE c.status = 'approved' AND c.visibility = 'public' GROUP BY c.id, c.title, c.type ORDER BY views DESC LIMIT 10`))
        .map(row => ({ ...row, views: Number(row.views) })),
      topContributors: (await db.all(`SELECT u.id, u.name, count(c.id) AS approved FROM users u JOIN content c ON c.uploader_id = u.id
        WHERE c.status = 'approved' GROUP BY u.id, u.name ORDER BY approved DESC LIMIT 10`)).map(row => ({ ...row, approved: Number(row.approved) })),
      weekly,
      viewsLast30: Number(await count('SELECT count(*) AS n FROM content_views WHERE viewed_at >= ?', new Date(Date.now() - 30 * 86400_000).toISOString())),
      languages: tally(tagged.map(row => row.language || 'Not set')),
      topics: tally(tagged.flatMap(row => (row.topics ? row.topics.split(',') : []))),
      openRequests: Number(await count("SELECT count(*) AS n FROM content_requests WHERE status = 'open'")),
    };
    res.json({ approved, contributions, pending, members, types, storage, analytics });
  }));
  app.get('/api/leaderboard', h(async (req, res) => {
    const rows = await db.all(`SELECT u.id, u.name, u.role, count(c.id) * ${POINTS_PER_APPROVAL} AS points FROM users u
      JOIN content c ON c.uploader_id = u.id AND c.status = 'approved'
      WHERE u.suspended = 0 GROUP BY u.id, u.name, u.role ORDER BY points DESC, u.name COLLATE NOCASE`);
    const ranked = rows.map(row => ({ ...row, points: Number(row.points) }))
      .map((row, index, all) => ({ ...row, rank: all.findIndex(other => other.points === row.points) + 1 }));
    const me = ranked.find(row => row.id === req.user.id) || { id: req.user.id, name: req.user.name, role: req.user.role, points: 0, rank: null };
    res.json({ top: ranked.slice(0, 10), me, pointsPerApproval: POINTS_PER_APPROVAL });
  }));
  app.get('/api/storage', h(async (req, res) => {
    const rows = await db.all(`SELECT d.*, (SELECT count(*) FROM content c WHERE c.storage_node = d.id) AS file_count
      FROM drives d ORDER BY d.created_at`);
    const nodes = rows.map(node => ({
      id: node.id, name: node.name, kind: node.kind,
      connected: isConnected(node, config), enabled: Boolean(node.enabled),
      ...(req.user.role === 'site_admin' ? {
        folderId: node.folder_id, accountEmail: node.account_email,
        quotaUsage: node.quota_usage, quotaLimit: node.quota_limit, quotaCheckedAt: node.quota_checked_at,
      } : {}),
      fileCount: node.file_count,
    }));
    res.json({
      nodes,
      local: config.localStorage ? { id: 'local', name: 'Local workspace', kind: 'local', connected: true,
        fileCount: await count("SELECT count(*) AS n FROM content WHERE storage_node = 'local'") } : null,
      oauthReady: Boolean(config.googleClientId && config.googleClientSecret && /^[a-fA-F0-9]{64}$/.test(config.encryptionKey)),
      serviceReady: Boolean(config.serviceAccount),
      setup: {
        googleClient: Boolean(config.googleClientId && config.googleClientSecret),
        encryptionKey: /^[a-fA-F0-9]{64}$/.test(config.encryptionKey),
        serviceAccount: Boolean(config.serviceAccount),
        redirectUri: `${config.origin}/api/auth/google/callback`,
      },
    });
  }));

  // Links are submitted directly; files go through the chunked /api/uploads flow below.
  app.post('/api/content', h(async (req, res) => {
    const title = text(req.body.title, 'Title');
    const description = text(req.body.description || '', 'Description', 2000, 0);
    const url = text(req.body.url, 'URL', 2048);
    let parsed;
    try { parsed = new URL(url); } catch { throw fail(400, 'Enter a valid link.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw fail(400, 'Links must start with http:// or https:// and cannot contain credentials.');
    const parent = await additionTarget(req);
    const tags = tagFields(req.body);
    const requestId = parent ? null : await openRequest(req.body.requestId);
    const id = randomUUID();
    const review = initialReview(req.user);
    await db.run(`INSERT INTO content (id,title,description,type,url,status,uploader_id,created_at,parent_id,reviewed_by,reviewed_at,language,speaker,verses,topics,request_id)
      VALUES (?,?,?,'link',?,?,?,?,?,?,?,?,?,?,?,?)`, id, title, description, url, review.status, req.user.id, new Date().toISOString(), parent?.id ?? null,
    review.reviewedBy, review.reviewedAt, tags.language, tags.speaker, tags.verses, tags.topics, requestId);
    if (review.status === 'approved') await published({ id, title, uploader_id: req.user.id, parent_id: parent?.id ?? null, request_id: requestId }, null);
    await audit(db, req.user.id, parent ? 'Added to upload' : review.action, parent ? `${title} → ${parent.title}` : title);
    res.status(201).json({ id, status: review.status, message: review.message });
  }));

  // Chunked uploads keep every request under serverless body limits and stream straight into Google Drive.
  async function discard(upload, heldToken) {
    const now = Date.now();
    const token = heldToken || randomUUID();
    const claim = await db.run(`UPDATE uploads SET chunk_lock = ?, chunk_lock_expires = ?
      WHERE id = ? AND (chunk_lock IS NULL OR chunk_lock_expires IS NULL OR chunk_lock_expires < ? OR chunk_lock = ?)`,
    token, now + 5 * 60_000, upload.id, now, heldToken || null);
    if (!claim.changes) throw fail(409, 'This upload is currently processing. Try again shortly.');
    try {
      if (upload.completed_key) await storage.remove({ node: upload.node, key: upload.completed_key });
      else await storage.cancelUpload(upload);
    } catch (error) {
      await db.run('UPDATE uploads SET chunk_lock = NULL, chunk_lock_expires = NULL WHERE id = ? AND chunk_lock = ?', upload.id, token);
      console.error('Upload cleanup failed; upload record retained for retry:', upload.id, error.message);
      throw fail(503, 'Upload storage could not be cleaned up. Please retry.');
    }
    await db.run('DELETE FROM uploads WHERE id = ? AND chunk_lock = ?', upload.id, token);
  }
  app.post('/api/uploads', h(async (req, res) => {
    const now = Date.now();
    for (const stale of await db.all('SELECT * FROM uploads WHERE created_at < ? AND (chunk_lock IS NULL OR chunk_lock_expires IS NULL OR chunk_lock_expires < ?)', Date.now() - UPLOAD_TTL_MS, now)) {
      try {
        const submitted = await db.get('SELECT id FROM content WHERE id = ? AND uploader_id = ?', stale.id, stale.user_id);
        if (submitted) await db.run('DELETE FROM uploads WHERE id = ? AND (chunk_lock IS NULL OR chunk_lock_expires < ?)', stale.id, Date.now());
        else await discard(stale);
      } catch (error) {
        console.warn('Stale upload cleanup deferred:', stale.id, error.message);
      }
    }
    const title = text(req.body.title, 'Title');
    const description = text(req.body.description || '', 'Description', 2000, 0);
    const name = text(req.body.name, 'File name', 255);
    const size = Number(req.body.size);
    const mime = normalizeMime(req.body.mime);
    const type = classify(mime);
    if (!Number.isInteger(size) || size < 1) throw fail(400, 'Empty files cannot be uploaded.');
    const parent = await additionTarget(req);
    const tags = tagFields(req.body);
    const requestId = parent ? null : await openRequest(req.body.requestId);
    const target = req.user.role === 'site_admin' ? req.body.targetDriveId || 'auto' : 'auto';
    const id = randomUUID();
    const started = await storage.startUpload({ id, target, name, mime, size, type });
    await db.run(`INSERT INTO uploads (id,user_id,title,description,type,mime,original_name,size,node,session_uri,created_at,parent_id,
      language,speaker,verses,topics,fingerprint,request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, req.user.id, title, description, type, mime, name, size,
    started.node, started.sessionUri, Date.now(), parent?.id ?? null,
    tags.language, tags.speaker, tags.verses, tags.topics, fingerprintOf(req.body.fingerprint), requestId);
    res.status(201).json({ id, chunkSize: CHUNK_SIZE });
  }));
  const ownUpload = async req => {
    const upload = await db.get('SELECT * FROM uploads WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!upload) throw fail(404, 'Upload not found. It may have expired; please start again.');
    return upload;
  };
  app.get('/api/uploads/:id', h(async (req, res) => {
    const completed = await db.get('SELECT id FROM content WHERE id = ? AND uploader_id = ? AND storage_key IS NOT NULL', req.params.id, req.user.id);
    if (completed) return res.json({ done: true, received: null });
    const upload = await ownUpload(req);
    res.json({ done: false, received: upload.completed_key ? upload.size : upload.received, size: upload.size });
  }));
  app.put('/api/uploads/:id', express.raw({ type: 'application/octet-stream', limit: CHUNK_SIZE + 1024 }), h(async (req, res) => {
    const completed = await db.get('SELECT id, status FROM content WHERE id = ? AND uploader_id = ? AND storage_key IS NOT NULL', req.params.id, req.user.id);
    if (completed) return res.status(200).json({ done: true, id: completed.id, status: completed.status, message: 'Upload was already submitted.' });

    const upload = await ownUpload(req);
    const offset = Number(req.query.offset);
    const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!upload.completed_key && offset !== upload.received) {
      return res.status(409).json({ error: 'Upload is out of sync; resuming.', received: upload.received });
    }
    if (!upload.completed_key) {
      const end = offset + chunk.length;
      if (!chunk.length || end > upload.size) throw fail(400, 'Invalid upload chunk.');
      if (end < upload.size && chunk.length % (256 * 1024) !== 0) throw fail(400, 'Upload chunks must be multiples of 256 KB.');
    }

    const token = randomUUID();
    const now = Date.now();
    const claim = await db.run(`UPDATE uploads SET chunk_lock = ?, chunk_lock_expires = ?
      WHERE id = ? AND user_id = ? AND received = ?
      AND (chunk_lock IS NULL OR chunk_lock_expires IS NULL OR chunk_lock_expires < ?)`,
    token, now + 5 * 60_000, upload.id, req.user.id, upload.received, now);
    if (!claim.changes) {
      const latest = await db.get('SELECT received FROM uploads WHERE id = ? AND user_id = ?', upload.id, req.user.id);
      if (!latest) throw fail(404, 'Upload not found. It may have expired; please start again.');
      return res.status(409).json({ error: 'This upload is already processing or out of sync; resuming.', received: latest.received });
    }

    let locked = true;
    try {
      if (!upload.completed_key && offset === 0) {
        try { verifySignature(chunk, upload.mime, upload.size); }
        catch (error) { await discard(upload, token); locked = false; throw error; }
      }

      let completedKey = upload.completed_key;
      if (!completedKey) {
        const result = await storage.sendChunk(upload, chunk, offset);
        if (!result.done) {
          if (!Number.isInteger(result.received) || result.received < 0 || result.received > upload.size) throw fail(502, 'Storage returned an invalid upload offset.');
          const saved = await db.run(`UPDATE uploads SET received = ?, chunk_lock = NULL, chunk_lock_expires = NULL
            WHERE id = ? AND chunk_lock = ?`, result.received, upload.id, token);
          locked = false;
          if (!saved.changes) throw fail(409, 'The upload lease expired; please retry from the latest offset.');
          return res.json({ done: false, received: result.received });
        }
        if (!result.key) throw fail(502, 'Storage completed the upload without returning a file key.');
        completedKey = result.key;
        const saved = await db.run('UPDATE uploads SET completed_key = ? WHERE id = ? AND chunk_lock = ?', completedKey, upload.id, token);
        if (!saved.changes) throw fail(409, 'The upload lease expired; please retry.');
      }

      const id = upload.id;
      const review = initialReview(req.user);
      let existing = await db.get('SELECT id FROM content WHERE id = ? AND uploader_id = ?', id, req.user.id);
      let created = false;
      if (!existing) {
        try {
          // The upload it belongs to may have been removed while this file was uploading.
          const parent = upload.parent_id ? await db.get("SELECT id FROM content WHERE id = ? AND status != 'rejected'", upload.parent_id) : null;
          if (upload.parent_id && !parent) {
            await discard(upload, token);
            locked = false;
            throw fail(409, 'The upload you were adding to is no longer available.');
          }
          await db.run(`INSERT INTO content
            (id,title,description,type,mime,original_name,size,storage_node,storage_key,status,uploader_id,created_at,parent_id,reviewed_by,reviewed_at,
              language,speaker,verses,topics,fingerprint,request_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, upload.title, upload.description, upload.type, upload.mime,
          upload.original_name, upload.size, upload.node, completedKey, review.status, req.user.id, new Date().toISOString(), upload.parent_id ?? null,
          review.reviewedBy, review.reviewedAt, upload.language ?? null, upload.speaker ?? null, upload.verses ?? null, upload.topics ?? null,
          upload.fingerprint ?? null, upload.request_id ?? null);
          created = true;
        } catch (error) {
          if (error.status === 409) throw error;
          existing = await db.get('SELECT id FROM content WHERE id = ? AND uploader_id = ?', id, req.user.id);
          if (!existing) throw error;
        }
      }
      await db.run('DELETE FROM uploads WHERE id = ? AND chunk_lock = ?', upload.id, token);
      locked = false;
      if (created) await audit(db, req.user.id, upload.parent_id ? 'Added to upload' : review.action, upload.title);
      if (created && review.status === 'approved') {
        await published({ id, title: upload.title, uploader_id: req.user.id, parent_id: upload.parent_id ?? null, request_id: upload.request_id ?? null }, null);
      }
      const status = created ? 201 : 200;
      const saved = await db.get('SELECT status FROM content WHERE id = ?', id);
      const finalStatus = saved?.status || review.status;
      return res.status(status).json({ done: true, id, status: finalStatus,
        message: finalStatus === 'approved' ? 'Published.' : 'Submitted for admin approval.' });
    } finally {
      if (locked) await db.run('UPDATE uploads SET chunk_lock = NULL, chunk_lock_expires = NULL WHERE id = ? AND chunk_lock = ?', upload.id, token);
    }
  }));
  app.delete('/api/uploads/:id', h(async (req, res) => {
    await discard(await ownUpload(req));
    res.json({ ok: true });
  }));

  // Warns before uploading something the library already has. Only matches the user may see are reported.
  app.post('/api/uploads/check', h(async (req, res) => {
    const fingerprints = Array.isArray(req.body.fingerprints) ? req.body.fingerprints.map(fingerprintOf).filter(Boolean).slice(0, 50) : [];
    const urls = Array.isArray(req.body.urls) ? req.body.urls.filter(url => typeof url === 'string' && url.length <= 2048).slice(0, 50) : [];
    const matches = [];
    const seen = row => visible(row, req.user) && row.status !== 'rejected';
    for (const fingerprint of new Set(fingerprints)) {
      const row = (await db.all("SELECT id, title, status, visibility, uploader_id FROM content WHERE fingerprint = ? AND status != 'rejected' ORDER BY created_at LIMIT 5", fingerprint)).find(seen);
      if (row) matches.push({ fingerprint, id: row.id, title: row.title, status: row.status });
    }
    for (const url of new Set(urls)) {
      const row = (await db.all("SELECT id, title, status, visibility, uploader_id FROM content WHERE type = 'link' AND url = ? AND status != 'rejected' ORDER BY created_at LIMIT 5", url.trim())).find(seen);
      if (row) matches.push({ url, id: row.id, title: row.title, status: row.status });
    }
    res.json({ matches });
  }));

  app.get('/api/notifications', h(async (req, res) => {
    const items = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30', req.user.id);
    const unread = Number(await count('SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', req.user.id));
    const pendingReview = isReviewer(req.user)
      ? Number(await count("SELECT count(*) AS n FROM content WHERE status = 'pending' AND (? = 'site_admin' OR uploader_id != ?)", req.user.role, req.user.id))
      : 0;
    res.json({ items: items.map(({ user_id, ...item }) => item), unread, pendingReview });
  }));
  app.post('/api/notifications/read', h(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(id => typeof id === 'string').slice(0, 100) : null;
    const now = new Date().toISOString();
    if (ids) {
      for (const id of ids) await db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', now, id, req.user.id);
    } else {
      await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now, req.user.id);
    }
    res.json({ ok: true });
  }));

  // Members ask for content that is missing; anyone can +1 and contributors can upload against a request.
  app.get('/api/requests', h(async (req, res) => {
    const status = ['open', 'fulfilled', 'closed'].includes(req.query.status) ? req.query.status : 'open';
    const rows = await db.all(`SELECT r.*, u.name AS requester, c.title AS content_title,
        (SELECT count(*) FROM request_votes v WHERE v.request_id = r.id) AS votes,
        EXISTS(SELECT 1 FROM request_votes v WHERE v.request_id = r.id AND v.user_id = ?) AS voted
      FROM content_requests r JOIN users u ON u.id = r.user_id LEFT JOIN content c ON c.id = r.content_id
      WHERE r.status = ? ORDER BY ${status === 'open' ? 'votes DESC, r.created_at DESC' : 'r.closed_at DESC'} LIMIT 100`, req.user.id, status);
    res.json({ items: rows.map(row => ({ ...row, votes: Number(row.votes), voted: Boolean(row.voted), mine: row.user_id === req.user.id })) });
  }));
  app.post('/api/requests', h(async (req, res) => {
    const title = text(req.body.title, 'Request', 160, 5);
    const details = text(req.body.details || '', 'Details', 1000, 0);
    const language = req.body.language ? tagFields({ language: req.body.language }).language : null;
    const open = Number(await count("SELECT count(*) AS n FROM content_requests WHERE user_id = ? AND status = 'open'", req.user.id));
    if (open >= 10) throw fail(429, 'You already have 10 open requests. Close one before adding another.');
    const id = randomUUID();
    await db.run('INSERT INTO content_requests (id, user_id, title, details, language, created_at) VALUES (?,?,?,?,?,?)',
      id, req.user.id, title, details, language, new Date().toISOString());
    await db.run('INSERT INTO request_votes (request_id, user_id) VALUES (?, ?)', id, req.user.id);
    await audit(db, req.user.id, 'Requested content', title);
    res.status(201).json({ id });
  }));
  const contentRequest = async id => {
    const request = await db.get('SELECT * FROM content_requests WHERE id = ?', id);
    if (!request) throw fail(404, 'Request not found.');
    return request;
  };
  app.post('/api/requests/:id/vote', h(async (req, res) => {
    const request = await contentRequest(req.params.id);
    if (request.status !== 'open') throw fail(409, 'This request is no longer open.');
    const current = await db.get('SELECT 1 AS found FROM request_votes WHERE request_id = ? AND user_id = ?', request.id, req.user.id);
    if (current) await db.run('DELETE FROM request_votes WHERE request_id = ? AND user_id = ?', request.id, req.user.id);
    else await db.run('INSERT INTO request_votes (request_id, user_id) VALUES (?, ?)', request.id, req.user.id);
    res.json({ voted: !current, votes: Number(await count('SELECT count(*) AS n FROM request_votes WHERE request_id = ?', request.id)) });
  }));
  app.post('/api/requests/:id/close', h(async (req, res) => {
    const request = await contentRequest(req.params.id);
    if (request.user_id !== req.user.id && !isReviewer(req.user)) throw fail(403, 'Only the requester or an admin can close this request.');
    if (request.status !== 'open') throw fail(409, 'This request is already closed.');
    await db.run("UPDATE content_requests SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'", new Date().toISOString(), request.id);
    if (request.user_id !== req.user.id) await notify(request.user_id, 'request', `Request closed: ${request.title}`, 'An admin closed this request.');
    await audit(db, req.user.id, 'Closed request', request.title);
    res.json({ ok: true });
  }));

  app.post('/api/content/:id/review', reviewers, h(async (req, res) => {
    const { item } = await getContent(req);
    if (req.user.role === 'org_admin' && item.uploader_id === req.user.id) throw fail(403, 'Your own submissions must be reviewed by another administrator.');
    if (!['approved', 'rejected'].includes(req.body.decision)) throw fail(400, 'Choose approve or reject.');
    if (item.status !== 'pending') throw fail(409, 'This submission has already been reviewed.');
    const note = text(req.body.note || '', 'Review note', 1000, req.body.decision === 'rejected' ? 5 : 0);
    const result = await db.run(`UPDATE content SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending'
        AND (deletion_token IS NULL OR deletion_lock_expires IS NULL OR deletion_lock_expires < ?)`,
    req.body.decision, req.user.id, note, new Date().toISOString(), item.id, Date.now());
    if (!result.changes) throw fail(409, 'Another administrator has already reviewed this submission.');
    if (req.body.decision === 'rejected' && !item.parent_id) {
      await db.run(`UPDATE content SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = ?
        WHERE parent_id = ? AND status = 'pending'`, req.user.id, note, new Date().toISOString(), item.id);
    }
    if (req.body.decision === 'approved') await published(item, req.user.id);
    else if (item.uploader_id !== req.user.id) await notify(item.uploader_id, 'rejected', `Not approved: ${item.title}`, note, item.id);
    await audit(db, req.user.id, req.body.decision === 'approved' ? 'Approved content' : 'Rejected content', item.title);
    res.json({ ok: true });
  }));
  app.post('/api/review/bulk-approve', reviewers, h(async (req, res) => {
    const ids = req.body.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 25
      || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 80)
      || new Set(ids).size !== ids.length) throw fail(400, 'Select between 1 and 25 unique submission IDs.');
    let approved = 0;
    let skipped = 0;
    for (const id of ids) {
      const item = await db.get(`${contentQuery} WHERE c.id = ?`, req.user.id, id);
      if (!item || item.status !== 'pending' || (req.user.role === 'org_admin' && item.uploader_id === req.user.id)) { skipped += 1; continue; }
      const result = await db.run(`UPDATE content SET status = 'approved', reviewed_by = ?, review_note = '', reviewed_at = ?
        WHERE id = ? AND status = 'pending'
          AND (deletion_token IS NULL OR deletion_lock_expires IS NULL OR deletion_lock_expires < ?)`,
      req.user.id, new Date().toISOString(), item.id, Date.now());
      if (!result.changes) { skipped += 1; continue; }
      await published(item, req.user.id);
      await audit(db, req.user.id, 'Approved content', item.title);
      approved += 1;
    }
    res.json({ approved, skipped });
  }));
  app.post('/api/review/bulk-reject', reviewers, h(async (req, res) => {
    const ids = req.body.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 25
      || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 80)
      || new Set(ids).size !== ids.length) throw fail(400, 'Select between 1 and 25 unique submission IDs.');
    const note = text(req.body.note, 'Rejection reason', 1000, 5);
    let rejected = 0;
    let skipped = 0;
    for (const id of ids) {
      const item = await db.get(`${contentQuery} WHERE c.id = ?`, req.user.id, id);
      if (!item || item.status !== 'pending' || (req.user.role === 'org_admin' && item.uploader_id === req.user.id)) { skipped += 1; continue; }
      const now = new Date().toISOString();
      const result = await db.run(`UPDATE content SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = ?
        WHERE id = ? AND status = 'pending'
          AND (deletion_token IS NULL OR deletion_lock_expires IS NULL OR deletion_lock_expires < ?)`,
      req.user.id, note, now, item.id, Date.now());
      if (!result.changes) { skipped += 1; continue; }
      if (!item.parent_id) {
        await db.run(`UPDATE content SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = ?
          WHERE parent_id = ? AND status = 'pending'`, req.user.id, note, now, item.id);
      }
      if (item.uploader_id !== req.user.id) await notify(item.uploader_id, 'rejected', `Not approved: ${item.title}`, note, item.id);
      await audit(db, req.user.id, 'Rejected content', item.title);
      rejected += 1;
    }
    res.json({ rejected, skipped });
  }));

  app.patch('/api/content/:id', reviewers, h(async (req, res) => {
    const { item } = await getContent(req);
    const title = req.body.title === undefined ? item.title : text(req.body.title, 'Title');
    const description = req.body.description === undefined ? item.description || '' : text(req.body.description, 'Description', 2000, 0);
    const tags = tagFields(req.body, item);
    const changed = await db.run(`UPDATE content SET title = ?, description = ?, language = ?, speaker = ?, verses = ?, topics = ? WHERE id = ?
      AND (deletion_token IS NULL OR deletion_lock_expires IS NULL OR deletion_lock_expires < ?)`,
    title, description, tags.language, tags.speaker, tags.verses, tags.topics, item.id, Date.now());
    if (!changed.changes) throw fail(409, 'This content is being changed or is no longer available.');
    await audit(db, req.user.id, 'Edited content', item.title === title ? title : `${item.title} → ${title}`);
    res.json({ ok: true, title, description, ...tags });
  }));

  app.patch('/api/content/:id/visibility', h(async (req, res) => {
    const { item } = await getContent(req);
    if (req.user.role !== 'site_admin' && item.uploader_id !== req.user.id) throw fail(403, 'Only the contributor or a site admin can change visibility.');
    if (item.status !== 'approved') throw fail(409, 'Only approved content can change visibility.');
    if (item.parent_id) throw fail(409, 'Added files follow the visibility of the upload they belong to.');
    const visibility = req.body.visibility;
    if (!['public', 'private'].includes(visibility)) throw fail(400, 'Choose public or private visibility.');
    const changed = await db.run(`UPDATE content SET visibility = ? WHERE id = ? AND status = 'approved'
      AND (deletion_token IS NULL OR deletion_lock_expires IS NULL OR deletion_lock_expires < ?)`, visibility, item.id, Date.now());
    if (!changed.changes) throw fail(409, 'This content is being changed or is no longer available.');
    await audit(db, req.user.id, visibility === 'public' ? 'Made content public' : 'Made content private', item.title);
    res.json({ ok: true, visibility });
  }));

  app.post('/api/content/:id/bookmark', h(async (req, res) => {
    const { item } = await getContent(req);
    if (item.status !== 'approved' || item.visibility !== 'public' || item.parent_id) throw fail(400, 'Only public, approved uploads can be saved.');
    const current = await db.get('SELECT 1 AS found FROM bookmarks WHERE user_id = ? AND content_id = ?', req.user.id, item.id);
    if (current) await db.run('DELETE FROM bookmarks WHERE user_id = ? AND content_id = ?', req.user.id, item.id);
    else await db.run('INSERT INTO bookmarks VALUES (?, ?)', req.user.id, item.id);
    res.json({ bookmarked: !current });
  }));
  app.post('/api/content/:id/view', h(async (req, res) => {
    const { item } = await getContent(req);
    if (item.status === 'approved') {
      await db.run('INSERT OR IGNORE INTO content_views (content_id, user_id, viewed_at) VALUES (?, ?, ?)', item.id, req.user.id, new Date().toISOString());
    }
    res.json({ views: await count('SELECT count(*) AS n FROM content_views WHERE content_id = ?', item.id) });
  }));
  app.delete('/api/content/:id', h(async (req, res) => {
    if (req.user.role !== 'site_admin') throw fail(403, 'Only site admins can remove content.');
    const { item } = await getContent(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 5) throw fail(400, 'Write a reason (at least 5 characters) before removing content.');
    if (reason.length > 500) throw fail(400, 'Keep the reason under 500 characters.');
    await removeContent(item);
    if (item.uploader_id !== req.user.id) await notify(item.uploader_id, 'removed', `Removed: ${item.title}`, reason);
    await audit(db, req.user.id, 'Deleted content', `${item.title} — Reason: ${reason}`);
    res.json({ ok: true });
  }));
  // Contributors can take back their own submission while it is still waiting for review.
  app.post('/api/content/:id/withdraw', h(async (req, res) => {
    const { item } = await getContent(req);
    if (item.uploader_id !== req.user.id) throw fail(403, 'You can only withdraw your own submissions.');
    if (item.status !== 'pending') throw fail(409, 'Only submissions that are still waiting for review can be withdrawn.');
    await removeContent(item, "AND status = 'pending'");
    await audit(db, req.user.id, 'Withdrew submission', item.title);
    res.json({ ok: true });
  }));
  async function removeContent(item, condition = '') {
    const token = randomUUID();
    const now = Date.now();
    const claim = await db.run(`UPDATE content SET deletion_token = ?, deletion_lock_expires = ?
      WHERE id = ? ${condition} AND (deletion_token IS NULL OR deletion_lock_expires IS NULL OR deletion_lock_expires < ?)`,
    token, now + 5 * 60_000, item.id, now);
    if (!claim.changes) throw fail(409, 'This content is already being removed or its status changed. Refresh and try again.');

    const removeStored = async (row, release) => {
      if (!row.storage_key) return;
      if (row.storage_node !== 'local') {
        // A disconnected Drive cannot be reached; the record is removed and the file stays in that Drive.
        const node = await db.get('SELECT * FROM drives WHERE id = ?', row.storage_node);
        if (node && !isConnected(node, config)) return;
      }
      try {
        await storage.remove({ node: row.storage_node, key: row.storage_key });
      } catch (error) {
        await release();
        console.error('Stored file could not be removed; content record retained for retry:', row.storage_node, row.storage_key, error.message);
        throw fail(503, 'The stored file could not be removed, so the content was kept. Please retry later.');
      }
    };
    const release = () => db.run('UPDATE content SET deletion_token = NULL, deletion_lock_expires = NULL WHERE id = ? AND deletion_token = ?', item.id, token);
    // Removing an upload also removes every file and link that was added to it.
    for (const part of await db.all('SELECT * FROM content WHERE parent_id = ?', item.id)) {
      await removeStored(part, release);
      await db.run('DELETE FROM bookmarks WHERE content_id = ?', part.id);
      await db.run('DELETE FROM content_views WHERE content_id = ?', part.id);
      await db.run('DELETE FROM thumbnails WHERE content_id = ?', part.id);
      await db.run('DELETE FROM content_text WHERE content_id = ?', part.id);
      await db.run('DELETE FROM content WHERE id = ?', part.id);
    }
    await removeStored(item, release);
    await db.run('DELETE FROM bookmarks WHERE content_id = ?', item.id);
    await db.run('DELETE FROM content_views WHERE content_id = ?', item.id);
    await db.run('DELETE FROM thumbnails WHERE content_id = ?', item.id);
    await db.run('DELETE FROM content_text WHERE content_id = ?', item.id);
    const deleted = await db.run('DELETE FROM content WHERE id = ? AND deletion_token = ?', item.id, token);
    if (!deleted.changes) throw fail(409, 'The content changed while it was being removed. Refresh and try again.');
  }
  // Thumbnails are generated in the uploader's browser (a frame, first page or cover) and stored as small images.
  const THUMB_TYPES = {
    'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/webp': bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  };
  const THUMB_LIMIT = 300 * 1024;
  app.get('/api/content/:id/thumbnail', h(async (req, res) => {
    const { item } = await getContent(req);
    const thumb = await db.get('SELECT mime, data FROM thumbnails WHERE content_id = ?', item.id);
    if (!thumb) throw fail(404, 'No thumbnail yet.');
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(thumb.mime).send(Buffer.from(thumb.data));
  }));
  app.put('/api/content/:id/thumbnail', express.raw({ type: Object.keys(THUMB_TYPES), limit: THUMB_LIMIT }), h(async (req, res) => {
    const { item } = await getContent(req);
    if (item.uploader_id !== req.user.id && !isReviewer(req.user)) throw fail(403, 'Only the uploader or an admin can set a thumbnail.');
    const mime = req.get('content-type')?.split(';')[0].trim();
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!THUMB_TYPES[mime] || bytes.length < 12 || !THUMB_TYPES[mime](bytes)) throw fail(400, 'Thumbnails must be JPEG, PNG or WebP images.');
    await db.run(`INSERT INTO thumbnails (content_id, mime, data, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(content_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, created_at = excluded.created_at`,
    item.id, mime, bytes, new Date().toISOString());
    res.json({ ok: true });
  }));
  app.get('/api/content/:id/file', h(async (req, res) => {
    const { item } = await getContent(req);
    if (!item.storage_key) throw fail(404, 'This contribution is a link, not a file.');
    const file = await storage.read(item, req.get('range'));
    const name = encodeURIComponent(item.original_name || item.title).replace(/'/g, '%27');
    const previewable = Boolean(MIME_TYPES[item.mime]);
    res.set('Content-Disposition', `${previewable && req.query.inline === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`);
    res.set('X-Frame-Options', 'SAMEORIGIN');
    if (!previewable) res.set('Content-Security-Policy', 'sandbox');
    res.type(item.mime || 'application/octet-stream');
    res.set('Accept-Ranges', 'bytes');
    const length = file.contentLength ?? file.headers?.get('content-length');
    const range = file.contentRange ?? file.headers?.get('content-range');
    if (length != null) res.set('Content-Length', String(length));
    if (range) res.set('Content-Range', range);
    if (file.status === 416) return res.status(416).end();
    res.status(file.status);
    await pipeline(file.stream, res);
  }));
  app.get('/api/users', siteAdmin, h(async (req, res) => {
    const users = await db.all(`SELECT u.*, (SELECT COUNT(*) FROM content c WHERE c.uploader_id = u.id) AS uploads
      FROM users u ORDER BY CASE u.role WHEN 'site_admin' THEN 0 WHEN 'org_admin' THEN 1 ELSE 2 END, u.name`);
    res.json({ users: users.map(row => ({ ...publicUser(row), uploads: row.uploads })) });
  }));
  const member = async id => {
    const user = await db.get('SELECT * FROM users WHERE id = ?', id);
    if (!user) throw fail(404, 'Member not found.');
    return user;
  };
  app.patch('/api/users/:id', siteAdmin, h(async (req, res) => {
    const user = await member(req.params.id);
    if (user.role === 'site_admin') throw fail(403, 'Site administrator accounts are managed through server configuration.');
    if (!['user', 'org_admin'].includes(req.body.role)) throw fail(400, 'Choose a valid member role.');
    await db.run('UPDATE users SET role = ? WHERE id = ?', req.body.role, user.id);
    if (user.role !== req.body.role) {
      await notify(user.id, 'role', req.body.role === 'org_admin' ? 'You are now an org admin' : 'Your org admin role was removed',
        req.body.role === 'org_admin' ? 'You can now review and approve submissions.' : '');
    }
    await audit(db, req.user.id, req.body.role === 'org_admin' ? 'Made org admin' : 'Removed org admin', user.email);
    res.json({ ok: true });
  }));
  app.post('/api/users/:id/suspend', siteAdmin, h(async (req, res) => {
    const user = await member(req.params.id);
    const suspended = Boolean(req.body.suspended);
    if (user.id === req.user.id) throw fail(400, 'You cannot suspend your own account.');
    if (user.role === 'site_admin') throw fail(403, 'Site administrators cannot be suspended.');
    await db.run('UPDATE users SET suspended = ? WHERE id = ?', suspended ? 1 : 0, user.id);
    if (suspended) await db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
    await audit(db, req.user.id, suspended ? 'Suspended member' : 'Reactivated member', user.email);
    res.json({ ok: true });
  }));
  app.get('/api/audit', siteAdmin, h(async (req, res) => res.json({
    entries: await db.all(`SELECT a.*, u.name AS actor FROM audit a JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC LIMIT 100`),
  })));
  const drive = async id => {
    const node = await db.get('SELECT * FROM drives WHERE id = ?', id);
    if (!node) throw fail(404, 'Storage destination not found.');
    return node;
  };
  app.post('/api/storage', siteAdmin, h(async (req, res) => {
    const name = text(req.body.name, 'Storage name', 100);
    if (!['oauth', 'service'].includes(req.body.kind)) throw fail(400, 'Choose a storage connection type.');
    // Personal Drives get their own "Kalpa Taru Media" folder when connected; only Shared Drives need a folder up front.
    let folderId = '';
    if (req.body.kind === 'service') {
      folderId = text(req.body.folderId, 'Folder ID', 200);
      if (!/^[A-Za-z0-9_-]+$/.test(folderId)) throw fail(400, 'Enter a Google Drive folder ID, not its full URL.');
      if (await db.get('SELECT 1 AS found FROM drives WHERE folder_id = ?', folderId)) throw fail(409, 'This folder is already registered.');
    }
    if (await db.get('SELECT 1 AS found FROM drives WHERE lower(name) = lower(?)', name)) throw fail(409, 'A Drive with this name already exists.');
    const id = randomUUID();
    await db.run('INSERT INTO drives (id,name,folder_id,kind,types,created_at) VALUES (?,?,?,?,?,?)',
      id, name, folderId, req.body.kind, JSON.stringify(FILE_TYPES), new Date().toISOString());
    await audit(db, req.user.id, 'Added storage destination', name);
    res.status(201).json({ id });
  }));
  app.get('/api/storage/:id/connect', siteAdmin, h(async (req, res) => {
    const node = await db.get('SELECT * FROM drives WHERE id = ?', req.params.id);
    if (!node || node.kind !== 'oauth') throw fail(404, 'Personal Drive destination not found.');
    if (!/^[a-fA-F0-9]{64}$/.test(config.encryptionKey)) throw fail(503, 'Set a 64-character hex STORAGE_ENCRYPTION_KEY and restart the server.');
    await beginOAuth(req, res, 'drive', node.id);
  }));
  app.post('/api/storage/:id/test', siteAdmin, h(async (req, res) => {
    const node = await drive(req.params.id);
    const { data } = await driveClient(node, config).files.get({
      fileId: node.folder_id, supportsAllDrives: true, fields: 'id,name,mimeType,driveId,capabilities(canAddChildren)',
    });
    if (data.mimeType !== 'application/vnd.google-apps.folder' || !data.capabilities?.canAddChildren) {
      throw fail(400, 'The configured account cannot upload to this folder.');
    }
    if (node.kind === 'service' && !data.driveId) throw fail(400, 'Service accounts require a folder inside a Workspace Shared Drive. Use OAuth for personal Drives.');
    const quota = await refreshQuota(db, node, config);
    res.json({ message: `Connection verified: ${data.name}`, quota });
  }));
  app.patch('/api/storage/:id', siteAdmin, h(async (req, res) => {
    const node = await drive(req.params.id);
    const name = req.body.name === undefined ? node.name : text(req.body.name, 'Storage name', 100);
    const enabled = req.body.enabled === undefined ? node.enabled : req.body.enabled ? 1 : 0;
    await db.run('UPDATE drives SET name = ?, enabled = ? WHERE id = ?', name, enabled, node.id);
    await audit(db, req.user.id, 'Updated storage destination', name);
    res.json({ ok: true });
  }));
  app.get('/api/storage/:id/items', siteAdmin, h(async (req, res) => {
    const node = await drive(req.params.id);
    const rows = await db.all(`SELECT c.id, c.title, c.status, c.visibility, c.size, c.created_at, c.parent_id, u.name AS uploader, p.title AS parent_title
      FROM content c JOIN users u ON u.id = c.uploader_id LEFT JOIN content p ON p.id = c.parent_id
      WHERE c.storage_node = ? ORDER BY c.created_at DESC LIMIT 200`, node.id);
    res.json({ items: rows.map(row => ({
      id: row.id, title: row.title, status: row.status, visibility: row.visibility, size: row.size, createdAt: row.created_at,
      uploader: row.uploader, parentTitle: row.parent_title || null,
    })) });
  }));
  app.delete('/api/storage/:id', siteAdmin, h(async (req, res) => {
    const node = await drive(req.params.id);
    if (await db.get('SELECT 1 AS found FROM content WHERE storage_node = ? LIMIT 1', node.id)) {
      throw fail(409, 'This Drive still holds files. Pause it instead so new uploads go elsewhere.');
    }
    await db.run('DELETE FROM drives WHERE id = ?', node.id);
    await audit(db, req.user.id, 'Removed storage destination', node.name);
    res.json({ ok: true });
  }));
  app.get('/api/backups', siteAdmin, h(async (req, res) => {
    const recent = await listBackups(db, 10);
    res.json({ last: recent[0] || null, recent, scheduled: Boolean(config.cronSecret) });
  }));
  app.post('/api/backups', siteAdmin, h(async (req, res) => {
    const record = await createBackup({ db, config });
    if (!record.ok) throw fail(502, `Backup failed: ${record.error}`);
    await audit(db, req.user.id, 'Backed up database', record.fileName);
    res.status(201).json(record);
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  if (config.serveStatic) {
    const dist = path.resolve('dist');
    if (!existsSync(path.join(dist, 'index.html'))) throw new Error('Production build missing. Run npm run build first.');
    app.use(express.static(dist));
    app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error(`${req.method} ${req.path}:`, error.message);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Upload chunk is too large.' });
    const status = error.status >= 400 && error.status < 600 ? error.status : 500;
    const message = error.expose ? error.message : 'The operation failed. Please check the connection or server configuration and try again.';
    res.status(error.expose || status === 400 ? status : 500).json({ error: message });
  });
  return app;
}
