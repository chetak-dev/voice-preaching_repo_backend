import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { google } from 'googleapis';
import { openDatabase, audit, hashPassword, verifyPassword } from './db.js';
import { CHUNK_SIZE, createStorage, driveClient, encryptToken, isConnected, oauthClient, refreshQuota } from './storage.js';

const TYPES = ['image', 'video', 'audio', 'doc', 'link'];
const FILE_TYPES = TYPES.filter(type => type !== 'link');
const MIME_TYPES = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/webm': 'video',
  'audio/mpeg': 'audio', 'audio/wav': 'audio', 'audio/x-wav': 'audio', 'audio/ogg': 'audio',
  'application/pdf': 'doc', 'text/plain': 'doc',
};
const UPLOAD_TTL_MS = 24 * 3600_000;
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
    maxUploadMB: Number(process.env.MAX_UPLOAD_MB || 100),
    ...overrides,
  };
  if (new URL(config.origin).origin !== config.origin) throw new Error('APP_ORIGIN must be an origin without a trailing slash.');
  if (config.production && !config.origin.startsWith('https://')) throw new Error('Production APP_ORIGIN must use HTTPS.');
  if (config.production && (!config.googleClientId || !config.googleClientSecret || !config.siteAdmins.length)) {
    throw new Error('Production requires Google OAuth credentials and SITE_ADMIN_EMAILS.');
  }
  if (config.serverless && !config.databaseUrl) throw new Error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN: serverless hosts cannot keep a local database.');
  if (!Number.isInteger(config.maxUploadMB) || config.maxUploadMB < 1 || config.maxUploadMB > 5120) {
    throw new Error('MAX_UPLOAD_MB must be an integer between 1 and 5120.');
  }
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
  if (!matches[mime]) throw fail(400, 'The file contents do not match the selected file format.');
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
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false,
    // Upload chunks are bounded by the upload size limit, so they don't count towards the request rate.
    skip: req => req.method === 'PUT' && req.path.startsWith('/uploads/'),
    message: { error: 'Too many requests. Please try again in a minute.' } }));
  app.use(express.json({ limit: '32kb' }));
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
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, legacyHeaders: false, skipSuccessfulRequests: true,
    message: { error: 'Too many sign-in attempts. Please try again later.' } });

  app.get('/api/config', (req, res) => res.json({
    googleConfigured: Boolean(config.googleClientId && config.googleClientSecret),
    maxUploadMB: config.maxUploadMB,
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
        ? ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive']
        : ['openid', 'email', 'profile'],
      access_type: purpose === 'drive' ? 'offline' : 'online',
      prompt: purpose === 'drive' ? 'consent' : 'select_account',
    }));
  }
  app.get('/api/auth/google', authLimiter, h((req, res) => beginOAuth(req, res, 'login')));
  app.get('/api/auth/google/callback', authLimiter, h(async (req, res) => {
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const record = await db.get('SELECT * FROM oauth_states WHERE hash = ?', hash(state));
      if (!record || record.expires_at < Date.now() || cookie(req, 'voice_oauth') !== state) {
        throw fail(400, 'The sign-in request expired. Please try again.');
      }
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
        client.setCredentials(tokens);
        const node = await db.get('SELECT * FROM drives WHERE id = ?', record.node_id);
        if (!node) throw fail(404, 'Storage destination not found.');
        const { data: folder } = await google.drive({ version: 'v3', auth: client })
          .files.get({ fileId: node.folder_id, fields: 'id,mimeType,capabilities(canAddChildren)', supportsAllDrives: true });
        if (folder.mimeType !== 'application/vnd.google-apps.folder' || !folder.capabilities?.canAddChildren) {
          throw fail(400, 'The account cannot upload to this folder. Check its folder ID and access.');
        }
        await db.run('UPDATE drives SET refresh_token = ?, account_email = ? WHERE id = ?',
          encryptToken(tokens.refresh_token, config.encryptionKey), email, record.node_id);
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
      const message = error.expose ? error.message : 'Google authorization failed. Check the server configuration and try again.';
      res.redirect(`${config.origin}/?authError=${encodeURIComponent(message)}`);
    }
  }));

  app.use('/api', authenticated);
  const contentQuery = `SELECT c.*, u.name AS uploader, r.name AS reviewer,
    EXISTS(SELECT 1 FROM bookmarks b WHERE b.content_id = c.id AND b.user_id = ?) AS bookmarked
    FROM content c JOIN users u ON u.id = c.uploader_id
    LEFT JOIN users r ON r.id = c.reviewed_by`;
  function visible(item, user) {
    const privateAccess = item.visibility !== 'private' || item.uploader_id === user.id || isReviewer(user);
    return privateAccess && (item.status === 'approved' || isReviewer(user) || item.uploader_id === user.id);
  }
  async function getContent(req) {
    const item = await db.get(`${contentQuery} WHERE c.id = ?`, req.user.id, req.params.id);
    if (!item || !visible(item, req.user)) throw fail(404, 'Content not found.');
    return { item };
  }
  const count = async (sql, ...args) => (await db.get(sql, ...args)).n;
  app.get('/api/content', h(async (req, res) => {
    const scope = req.query.scope || 'library';
    if (!['library', 'mine', 'review', 'saved'].includes(scope)) throw fail(400, 'Unknown content view.');
    if (scope === 'review' && !isReviewer(req.user)) throw fail(403, 'Only administrators can review submissions.');
    const clauses = {
      library: "c.status = 'approved' AND c.visibility = 'public'", mine: 'c.uploader_id = ?',
      review: "c.status = 'pending'", saved: "c.status = 'approved' AND c.visibility = 'public' AND EXISTS(SELECT 1 FROM bookmarks b WHERE b.content_id = c.id AND b.user_id = ?)",
    };
    const params = [req.user.id];
    if (scope === 'mine' || scope === 'saved') params.push(req.user.id);
    const rows = await db.all(`${contentQuery} WHERE ${clauses[scope]} ORDER BY c.created_at DESC`, ...params);
    res.json({ items: rows.map(({ storage_key, ...item }) => item) });
  }));
  app.get('/api/overview', h(async (req, res) => {
    const approved = await count("SELECT count(*) AS n FROM content WHERE status = 'approved' AND visibility = 'public'");
    const contributions = await count('SELECT count(*) AS n FROM content WHERE uploader_id = ?', req.user.id);
    const pending = isReviewer(req.user)
      ? await count("SELECT count(*) AS n FROM content WHERE status = 'pending'")
      : await count("SELECT count(*) AS n FROM content WHERE status = 'pending' AND uploader_id = ?", req.user.id);
    const members = await count('SELECT count(*) AS n FROM users');
    res.json({ approved, contributions, pending, members });
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
    try { parsed = new URL(url); } catch { throw fail(400, 'Enter a valid HTTPS link.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw fail(400, 'Links must use HTTPS and cannot contain credentials.');
    const id = randomUUID();
    await db.run(`INSERT INTO content (id,title,description,type,url,status,uploader_id,created_at)
      VALUES (?,?,?,'link',?,'pending',?,?)`, id, title, description, url, req.user.id, new Date().toISOString());
    await audit(db, req.user.id, 'Submitted content', title);
    res.status(201).json({ id, status: 'pending', message: 'Submitted for admin approval.' });
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
    const type = MIME_TYPES[req.body.mime];
    if (!type) throw fail(400, 'Unsupported file type. Use JPG, PNG, WebP, MP4, WebM, MP3, WAV, OGG, PDF, or TXT.');
    if (!Number.isInteger(size) || size < 1) throw fail(400, 'Empty files cannot be uploaded.');
    if (size > config.maxUploadMB * 1024 * 1024) throw fail(400, `File exceeds the ${config.maxUploadMB} MB upload limit.`);
    const target = req.user.role === 'site_admin' ? req.body.targetDriveId || 'auto' : 'auto';
    const id = randomUUID();
    const started = await storage.startUpload({ id, target, name, mime: req.body.mime, size });
    await db.run(`INSERT INTO uploads (id,user_id,title,description,type,mime,original_name,size,node,session_uri,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, req.user.id, title, description, type, req.body.mime, name, size,
    started.node, started.sessionUri, Date.now());
    res.status(201).json({ id, chunkSize: CHUNK_SIZE });
  }));
  const ownUpload = async req => {
    const upload = await db.get('SELECT * FROM uploads WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!upload) throw fail(404, 'Upload not found. It may have expired; please start again.');
    return upload;
  };
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
      let existing = await db.get('SELECT id FROM content WHERE id = ? AND uploader_id = ?', id, req.user.id);
      let created = false;
      if (!existing) {
        try {
          await db.run(`INSERT INTO content
            (id,title,description,type,mime,original_name,size,storage_node,storage_key,status,uploader_id,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`, id, upload.title, upload.description, upload.type, upload.mime,
          upload.original_name, upload.size, upload.node, completedKey, req.user.id, new Date().toISOString());
          created = true;
        } catch (error) {
          existing = await db.get('SELECT id FROM content WHERE id = ? AND uploader_id = ?', id, req.user.id);
          if (!existing) throw error;
        }
      }
      await db.run('DELETE FROM uploads WHERE id = ? AND chunk_lock = ?', upload.id, token);
      locked = false;
      if (created) await audit(db, req.user.id, 'Submitted content', upload.title);
      const status = created ? 201 : 200;
      return res.status(status).json({ done: true, id, status: 'pending', message: 'Submitted for admin approval.' });
    } finally {
      if (locked) await db.run('UPDATE uploads SET chunk_lock = NULL, chunk_lock_expires = NULL WHERE id = ? AND chunk_lock = ?', upload.id, token);
    }
  }));
  app.delete('/api/uploads/:id', h(async (req, res) => {
    await discard(await ownUpload(req));
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
      await audit(db, req.user.id, 'Approved content', item.title);
      approved += 1;
    }
    res.json({ approved, skipped });
  }));

  app.patch('/api/content/:id/visibility', h(async (req, res) => {
    const { item } = await getContent(req);
    if (req.user.role !== 'site_admin' && item.uploader_id !== req.user.id) throw fail(403, 'Only the contributor or a site admin can change visibility.');
    if (item.status !== 'approved') throw fail(409, 'Only approved content can change visibility.');
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
    if (item.status !== 'approved' || item.visibility !== 'public') throw fail(400, 'Only public, approved content can be saved.');
    const current = await db.get('SELECT 1 AS found FROM bookmarks WHERE user_id = ? AND content_id = ?', req.user.id, item.id);
    if (current) await db.run('DELETE FROM bookmarks WHERE user_id = ? AND content_id = ?', req.user.id, item.id);
    else await db.run('INSERT INTO bookmarks VALUES (?, ?)', req.user.id, item.id);
    res.json({ bookmarked: !current });
  }));
  app.delete('/api/content/:id', h(async (req, res) => {
    const { item } = await getContent(req);
    const isAdmin = req.user.role === 'site_admin';
    const owner = item.uploader_id === req.user.id && item.status !== 'approved';
    if (!isAdmin && !owner) throw fail(403, 'Only site admins can remove published content.');

    const token = randomUUID();
    const now = Date.now();
    const claim = await db.run(`UPDATE content SET deletion_token = ?, deletion_lock_expires = ?
      WHERE id = ? AND (deletion_token IS NULL OR deletion_lock_expires IS NULL OR deletion_lock_expires < ?)
      AND (? = 1 OR (uploader_id = ? AND status != 'approved'))`,
    token, now + 5 * 60_000, item.id, now, isAdmin ? 1 : 0, req.user.id);
    if (!claim.changes) throw fail(409, 'This content is already being removed or its status changed. Refresh and try again.');

    if (item.storage_key) {
      try {
        await storage.remove({ node: item.storage_node, key: item.storage_key });
      } catch (error) {
        await db.run('UPDATE content SET deletion_token = NULL, deletion_lock_expires = NULL WHERE id = ? AND deletion_token = ?', item.id, token);
        console.error('Stored file could not be removed; content record retained for retry:', item.storage_node, item.storage_key, error.message);
        throw fail(503, 'The stored file could not be removed, so the content was kept. Please retry later.');
      }
    }
    await db.run('DELETE FROM bookmarks WHERE content_id = ?', item.id);
    const deleted = await db.run('DELETE FROM content WHERE id = ? AND deletion_token = ?', item.id, token);
    if (!deleted.changes) throw fail(409, 'The content changed while it was being removed. Refresh and try again.');
    await audit(db, req.user.id, 'Deleted content', item.title);
    res.json({ ok: true });
  }));
  app.get('/api/content/:id/file', h(async (req, res) => {
    const { item } = await getContent(req);
    if (!item.storage_key) throw fail(404, 'This contribution is a link, not a file.');
    const file = await storage.read(item, req.get('range'));
    const name = encodeURIComponent(item.original_name || item.title).replace(/'/g, '%27');
    res.set('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`);
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.type(item.mime);
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
    const folderId = text(req.body.folderId, 'Folder ID', 200);
    if (!/^[A-Za-z0-9_-]+$/.test(folderId)) throw fail(400, 'Enter a Google Drive folder ID, not its full URL.');
    if (!['oauth', 'service'].includes(req.body.kind)) throw fail(400, 'Choose a storage connection type.');
    if (await db.get('SELECT 1 AS found FROM drives WHERE folder_id = ?', folderId)) throw fail(409, 'This folder is already registered.');
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
  app.delete('/api/storage/:id', siteAdmin, h(async (req, res) => {
    const node = await drive(req.params.id);
    if (await db.get('SELECT 1 AS found FROM content WHERE storage_node = ? LIMIT 1', node.id)) {
      throw fail(409, 'This Drive still holds files. Pause it instead so new uploads go elsewhere.');
    }
    await db.run('DELETE FROM drives WHERE id = ?', node.id);
    await audit(db, req.user.id, 'Removed storage destination', node.name);
    res.json({ ok: true });
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
