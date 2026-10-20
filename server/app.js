import express from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { google } from 'googleapis';
import { openDatabase, audit, hashPassword, verifyPassword } from './db.js';
import { createStorage, driveClient, encryptToken, isConnected, oauthClient, refreshQuota } from './storage.js';

const TYPES = ['image', 'video', 'audio', 'doc', 'link'];
const MIME_TYPES = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/webm': 'video',
  'audio/mpeg': 'audio', 'audio/wav': 'audio', 'audio/x-wav': 'audio', 'audio/ogg': 'audio',
  'application/pdf': 'doc', 'text/plain': 'doc',
};
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
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
  const production = process.env.NODE_ENV === 'production';
  const config = {
    production,
    demo: process.env.DEMO_MODE === 'true',
    origin: process.env.APP_ORIGIN || 'http://localhost:5173',
    dataDir: path.resolve(process.env.DATA_DIR || 'data'),
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    siteAdmins: (process.env.SITE_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    serviceAccount: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
    encryptionKey: process.env.STORAGE_ENCRYPTION_KEY || '',
    maxUploadMB: Number(process.env.MAX_UPLOAD_MB || 100),
    ...overrides,
  };
  if (config.production && config.demo) throw new Error('Demo mode is forbidden in production.');
  if (new URL(config.origin).origin !== config.origin) throw new Error('APP_ORIGIN must be an origin without a trailing slash.');
  if (config.production && !config.origin.startsWith('https://')) throw new Error('Production APP_ORIGIN must use HTTPS.');
  if (config.production && (!config.googleClientId || !config.googleClientSecret || !config.siteAdmins.length)) {
    throw new Error('Production requires Google OAuth credentials and SITE_ADMIN_EMAILS.');
  }
  if (!Number.isInteger(config.maxUploadMB) || config.maxUploadMB < 1 || config.maxUploadMB > 1024) {
    throw new Error('MAX_UPLOAD_MB must be an integer between 1 and 1024.');
  }
  return config;
}

async function verifyFile(file) {
  const handle = await open(file.path, 'r');
  const buffer = Buffer.alloc(Math.min(file.size, 512));
  try { await handle.read(buffer, 0, buffer.length, 0); } finally { await handle.close(); }
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
    'text/plain': file.size > 0 && !buffer.includes(0) && !starts('4d5a'),
  };
  if (!matches[file.mimetype]) throw fail(400, 'The file contents do not match the selected file format.');
}

export function createApp(overrides = {}) {
  const config = configuration(overrides);
  const app = express();
  const db = openDatabase(config.dataDir, config.demo);
  const storage = createStorage(config, db);
  const tempDir = path.join(config.dataDir, config.demo ? 'demo-tmp' : 'tmp');
  mkdirSync(tempDir, { recursive: true });
  app.locals.db = db;
  app.locals.config = config;
  app.disable('x-powered-by');
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
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false,
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
  function session(res, userId) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), userId, Date.now() + 7 * 86400000);
    res.cookie('voice_session', token, { ...cookieOptions, maxAge: 7 * 86400000 });
  }
  app.use('/api', (req, res, next) => {
    const token = cookie(req, 'voice_session');
    if (token) req.user = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.suspended = 0`).get(hash(token), Date.now());
    next();
  });
  const authenticated = (req, res, next) => req.user ? next() : next(fail(401, 'Please sign in to continue.'));
  const roles = (...allowed) => (req, res, next) =>
    allowed.includes(req.user?.role) ? next() : next(fail(403, 'You do not have permission to perform this action.'));
  const siteAdmin = roles('site_admin');
  const reviewers = roles('site_admin', 'org_admin');
  const isReviewer = user => user.role === 'site_admin' || user.role === 'org_admin';
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, legacyHeaders: false, skipSuccessfulRequests: true,
    message: { error: 'Too many sign-in attempts. Please try again later.' } });

  app.get('/api/config', (req, res) => res.json({
    demo: config.demo, googleConfigured: Boolean(config.googleClientId && config.googleClientSecret),
    maxUploadMB: config.maxUploadMB,
  }));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/auth/me', authenticated, (req, res) => res.json({ user: publicUser(req.user) }));
  app.post('/api/auth/logout', authenticated, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(cookie(req, 'voice_session')));
    res.clearCookie('voice_session', cookieOptions);
    res.json({ ok: true });
  });
  const password = value => {
    if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw fail(400, 'Password must be 8-128 characters.');
    return value;
  };
  app.post('/api/auth/signup', authLimiter, (req, res) => {
    const name = text(req.body.name, 'Name', 100, 2);
    const email = emailAddress(req.body.email);
    const secret = password(req.body.password);
    if (config.siteAdmins.includes(email)) throw fail(403, 'This address is reserved for administrators. Continue with Google instead.');
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw fail(409, 'An account with this email already exists. Sign in instead.');
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, email, name, role, created_at, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, email, name, 'user', new Date().toISOString(), hashPassword(secret));
    audit(db, id, 'Signed up', email);
    session(res, id);
    res.status(201).json({ ok: true });
  });
  app.post('/api/auth/login', authLimiter, (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const secret = typeof req.body.password === 'string' ? req.body.password : '';
    const user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
    const valid = verifyPassword(secret, user?.password_hash);
    if (!user || !valid) throw fail(401, 'Incorrect email or password. If you joined with Google, use Continue with Google.');
    if (user.suspended) throw fail(403, 'This account has been suspended. Contact an administrator.');
    session(res, user.id);
    res.json({ ok: true });
  });

  function beginOAuth(req, res, purpose, nodeId = null) {
    if (!config.googleClientId || !config.googleClientSecret) throw fail(503, 'Google sign-in has not been configured.');
    const state = randomBytes(32).toString('hex');
    const verifier = randomBytes(48).toString('base64url');
    db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO oauth_states VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash(state), purpose, req.user?.id || null, nodeId, verifier, Date.now() + 600000);
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
  app.get('/api/auth/google', authLimiter, (req, res) => beginOAuth(req, res, 'login'));
  app.get('/api/auth/google/callback', authLimiter, asyncRoute(async (req, res) => {
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const record = db.prepare('SELECT * FROM oauth_states WHERE hash = ?').get(hash(state));
      if (!record || record.expires_at < Date.now() || cookie(req, 'voice_oauth') !== state) {
        throw fail(400, 'The sign-in request expired. Please try again.');
      }
      db.prepare('DELETE FROM oauth_states WHERE hash = ?').run(hash(state));
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
        const node = db.prepare('SELECT * FROM drives WHERE id = ?').get(record.node_id);
        if (!node) throw fail(404, 'Storage destination not found.');
        const { data: folder } = await google.drive({ version: 'v3', auth: client })
          .files.get({ fileId: node.folder_id, fields: 'id,mimeType,capabilities(canAddChildren)', supportsAllDrives: true });
        if (folder.mimeType !== 'application/vnd.google-apps.folder' || !folder.capabilities?.canAddChildren) {
          throw fail(400, 'The account cannot upload to this folder. Check its folder ID and access.');
        }
        db.prepare('UPDATE drives SET refresh_token = ?, account_email = ? WHERE id = ?')
          .run(encryptToken(tokens.refresh_token, config.encryptionKey), email, record.node_id);
        audit(db, req.user.id, 'Connected Google Drive', node.name);
        return res.redirect(`${config.origin}/?connected=1`);
      }
      let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      const isSiteAdmin = config.siteAdmins.includes(email);
      if (!user) {
        const id = randomUUID();
        db.prepare('INSERT INTO users (id, email, name, role, created_at, google_linked) VALUES (?, ?, ?, ?, ?, 1)')
          .run(id, email, identity.name || email.split('@')[0], isSiteAdmin ? 'site_admin' : 'user', new Date().toISOString());
        audit(db, id, 'Signed up with Google', email);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      } else {
        if (user.suspended) throw fail(403, 'This account has been suspended. Contact an administrator.');
        if (!user.google_linked) {
          // Someone may have registered this address with a password before its owner signed in with Google.
          db.prepare('UPDATE users SET google_linked = 1, password_hash = NULL WHERE id = ?').run(user.id);
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
        }
        if (isSiteAdmin && user.role !== 'site_admin') db.prepare("UPDATE users SET role = 'site_admin' WHERE id = ?").run(user.id);
      }
      session(res, user.id);
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
    return item.status === 'approved' || isReviewer(user) || item.uploader_id === user.id;
  }
  function getContent(req) {
    const item = db.prepare(`${contentQuery} WHERE c.id = ?`).get(req.user.id, req.params.id);
    if (!item || !visible(item, req.user)) throw fail(404, 'Content not found.');
    return { item };
  }
  app.get('/api/content', (req, res) => {
    const scope = req.query.scope || 'library';
    if (!['library', 'mine', 'review', 'saved'].includes(scope)) throw fail(400, 'Unknown content view.');
    if (scope === 'review' && !isReviewer(req.user)) throw fail(403, 'Only administrators can review submissions.');
    const clauses = {
      library: "c.status = 'approved'", mine: 'c.uploader_id = ?',
      review: "c.status = 'pending'", saved: "c.status = 'approved' AND EXISTS(SELECT 1 FROM bookmarks b WHERE b.content_id = c.id AND b.user_id = ?)",
    };
    const params = [req.user.id];
    if (scope === 'mine' || scope === 'saved') params.push(req.user.id);
    const rows = db.prepare(`${contentQuery} WHERE ${clauses[scope]} ORDER BY c.created_at DESC`).all(...params);
    res.json({ items: rows.map(({ storage_key, ...item }) => item) });
  });
  app.get('/api/overview', (req, res) => {
    const approved = db.prepare("SELECT count(*) AS count FROM content WHERE status = 'approved'").get().count;
    const contributions = db.prepare('SELECT count(*) AS count FROM content WHERE uploader_id = ?').get(req.user.id).count;
    const pending = db.prepare(`SELECT count(*) AS count FROM content WHERE status = 'pending'${isReviewer(req.user) ? '' : ' AND uploader_id = ?'}`)
      .get(...(isReviewer(req.user) ? [] : [req.user.id])).count;
    const members = db.prepare('SELECT count(*) AS count FROM users').get().count;
    res.json({ approved, contributions, pending, members });
  });
  app.get('/api/storage', (req, res) => {
    const rows = db.prepare('SELECT * FROM drives ORDER BY created_at').all();
    const nodes = rows.map(node => ({
      id: node.id, name: node.name, kind: node.kind, types: JSON.parse(node.types),
      connected: isConnected(node, config), enabled: Boolean(node.enabled),
      ...(req.user.role === 'site_admin' ? {
        folderId: node.folder_id, accountEmail: node.account_email,
        quotaUsage: node.quota_usage, quotaLimit: node.quota_limit, quotaCheckedAt: node.quota_checked_at,
      } : {}),
      fileCount: db.prepare('SELECT count(*) AS n FROM content WHERE storage_node = ?').get(node.id).n,
    }));
    res.json({
      nodes, local: { id: 'local', name: 'Local workspace', kind: 'local', types: TYPES.filter(type => type !== 'link'), connected: true,
        fileCount: db.prepare("SELECT count(*) AS n FROM content WHERE storage_node = 'local'").get().n },
      oauthReady: Boolean(config.googleClientId && config.googleClientSecret && /^[a-fA-F0-9]{64}$/.test(config.encryptionKey)),
      serviceReady: Boolean(config.serviceAccount),
    });
  });
  const upload = multer({
    dest: tempDir,
    limits: { fileSize: config.maxUploadMB * 1024 * 1024, files: 1, fields: 8, fieldSize: 5000 },
    fileFilter: (req, file, cb) => MIME_TYPES[file.mimetype] ? cb(null, true) : cb(fail(400, 'Unsupported file type. Use JPG, PNG, WebP, MP4, WebM, MP3, WAV, OGG, PDF, or TXT.')),
  });
  app.post('/api/content', upload.single('file'), asyncRoute(async (req, res) => {
    let stored;
    let committed = false;
    try {
      const title = text(req.body.title, 'Title');
      const description = text(req.body.description || '', 'Description', 2000, 0);
      let type;
      let url = null;
      if (req.file && req.body.url) throw fail(400, 'Submit either a file or a link, not both.');
      if (req.file) {
        if (!req.file.size) throw fail(400, 'Empty files cannot be uploaded.');
        await verifyFile(req.file);
        type = MIME_TYPES[req.file.mimetype];
        const target = req.user.role === 'site_admin' ? req.body.targetDriveId || 'auto' : 'auto';
        if (!['auto', 'local'].includes(target)) {
          const node = db.prepare('SELECT * FROM drives WHERE id = ?').get(target);
          if (!node || !JSON.parse(node.types).includes(type)) throw fail(400, 'This storage destination does not accept that file type.');
          if (!isConnected(node, config)) throw fail(400, 'This storage destination is not connected yet.');
        }
        stored = await storage.save(req.file, type, target);
      } else {
        type = 'link';
        url = text(req.body.url, 'URL', 2048);
        let parsed;
        try { parsed = new URL(url); } catch { throw fail(400, 'Enter a valid HTTPS link.'); }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw fail(400, 'Links must use HTTPS and cannot contain credentials.');
      }
      const id = randomUUID();
      db.prepare(`INSERT INTO content
        (id,title,description,type,mime,original_name,size,storage_node,storage_key,url,status,uploader_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
        .run(id, title, description, type, req.file?.mimetype || null, req.file?.originalname || null,
          req.file?.size || 0, stored?.node || null, stored?.key || null, url, req.user.id, new Date().toISOString());
      committed = true;
      audit(db, req.user.id, 'Submitted content', title);
      res.status(201).json({ id, status: 'pending', message: 'Submitted for admin approval.' });
    } catch (error) {
      if (stored && !committed) {
        try { await storage.remove(stored); } catch (cleanupError) { console.error('Storage rollback failed; manual cleanup required:', stored, cleanupError); }
      }
      throw error;
    } finally {
      if (req.file && existsSync(req.file.path)) await unlink(req.file.path);
    }
  }));
  app.post('/api/content/:id/review', reviewers, (req, res) => {
    const { item } = getContent(req);
    if (req.user.role === 'org_admin' && item.uploader_id === req.user.id) throw fail(403, 'Your own submissions must be reviewed by another administrator.');
    if (!['approved', 'rejected'].includes(req.body.decision)) throw fail(400, 'Choose approve or reject.');
    if (item.status !== 'pending') throw fail(409, 'This submission has already been reviewed.');
    const note = text(req.body.note || '', 'Review note', 1000, req.body.decision === 'rejected' ? 5 : 0);
    const result = db.prepare(`UPDATE content SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending'`).run(req.body.decision, req.user.id, note, new Date().toISOString(), item.id);
    if (!result.changes) throw fail(409, 'Another administrator has already reviewed this submission.');
    audit(db, req.user.id, req.body.decision === 'approved' ? 'Approved content' : 'Rejected content', item.title);
    res.json({ ok: true });
  });
  app.post('/api/content/:id/bookmark', (req, res) => {
    const { item } = getContent(req);
    if (item.status !== 'approved') throw fail(400, 'Only approved content can be saved.');
    const current = db.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND content_id = ?').get(req.user.id, item.id);
    if (current) db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND content_id = ?').run(req.user.id, item.id);
    else db.prepare('INSERT INTO bookmarks VALUES (?, ?)').run(req.user.id, item.id);
    res.json({ bookmarked: !current });
  });
  app.delete('/api/content/:id', asyncRoute(async (req, res) => {
    const { item } = getContent(req);
    const owner = item.uploader_id === req.user.id && item.status !== 'approved';
    if (req.user.role !== 'site_admin' && !owner) throw fail(403, 'Only site admins can remove published content.');
    if (item.storage_key) {
      try { await storage.remove({ node: item.storage_node, key: item.storage_key }); } catch (error) {
        console.error('Stored file could not be removed; manual cleanup required:', item.storage_node, item.storage_key, error.message);
      }
    }
    db.prepare('DELETE FROM bookmarks WHERE content_id = ?').run(item.id);
    db.prepare('DELETE FROM content WHERE id = ?').run(item.id);
    audit(db, req.user.id, 'Deleted content', item.title);
    res.json({ ok: true });
  }));
  app.get('/api/content/:id/file', asyncRoute(async (req, res) => {
    const { item } = getContent(req);
    if (!item.storage_key) throw fail(404, 'This contribution is a link, not a file.');
    const file = await storage.read(item, req.get('range'));
    const name = encodeURIComponent(item.original_name || item.title).replace(/'/g, '%27');
    res.set('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`);
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.type(item.mime);
    if (file.local) return res.sendFile(file.local);
    const length = file.headers.get('content-length');
    const range = file.headers.get('content-range');
    if (length) res.set('Content-Length', length);
    if (range) res.set('Content-Range', range);
    res.set('Accept-Ranges', 'bytes');
    res.status(file.status);
    await pipeline(file.stream, res);
  }));
  app.get('/api/users', siteAdmin, (req, res) => {
    const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM content c WHERE c.uploader_id = u.id) AS uploads
      FROM users u ORDER BY CASE u.role WHEN 'site_admin' THEN 0 WHEN 'org_admin' THEN 1 ELSE 2 END, u.name`).all();
    res.json({ users: users.map(row => ({ ...publicUser(row), uploads: row.uploads })) });
  });
  const member = id => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw fail(404, 'Member not found.');
    return user;
  };
  app.patch('/api/users/:id', siteAdmin, (req, res) => {
    const user = member(req.params.id);
    if (user.role === 'site_admin') throw fail(403, 'Site administrator accounts are managed through server configuration.');
    if (!['user', 'org_admin'].includes(req.body.role)) throw fail(400, 'Choose a valid member role.');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, user.id);
    audit(db, req.user.id, req.body.role === 'org_admin' ? 'Made org admin' : 'Removed org admin', user.email);
    res.json({ ok: true });
  });
  app.post('/api/users/:id/suspend', siteAdmin, (req, res) => {
    const user = member(req.params.id);
    const suspended = Boolean(req.body.suspended);
    if (user.id === req.user.id) throw fail(400, 'You cannot suspend your own account.');
    if (user.role === 'site_admin') throw fail(403, 'Site administrators cannot be suspended.');
    db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(suspended ? 1 : 0, user.id);
    if (suspended) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    audit(db, req.user.id, suspended ? 'Suspended member' : 'Reactivated member', user.email);
    res.json({ ok: true });
  });
  app.get('/api/audit', siteAdmin, (req, res) => res.json({
    entries: db.prepare(`SELECT a.*, u.name AS actor FROM audit a JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC LIMIT 100`).all(),
  }));
  app.post('/api/storage', siteAdmin, (req, res) => {
    const name = text(req.body.name, 'Storage name', 100);
    const folderId = text(req.body.folderId, 'Folder ID', 200);
    if (!/^[A-Za-z0-9_-]+$/.test(folderId)) throw fail(400, 'Enter a Google Drive folder ID, not its full URL.');
    if (!['oauth', 'service'].includes(req.body.kind)) throw fail(400, 'Choose a storage connection type.');
    if (!Array.isArray(req.body.types) || !req.body.types.length ||
      req.body.types.some(type => !TYPES.includes(type) || type === 'link')) throw fail(400, 'Choose at least one supported file type.');
    if (req.body.kind === 'oauth' && !/^[a-fA-F0-9]{64}$/.test(config.encryptionKey)) {
      throw fail(503, 'Configure a 64-character hex STORAGE_ENCRYPTION_KEY before connecting personal Drives.');
    }
    if (req.body.kind === 'service' && !config.serviceAccount) throw fail(503, 'Configure GOOGLE_APPLICATION_CREDENTIALS before adding a Shared Drive.');
    const id = randomUUID();
    db.prepare(`INSERT INTO drives (id,name,folder_id,kind,types,created_at) VALUES (?,?,?,?,?,?)`)
      .run(id, name, folderId, req.body.kind, JSON.stringify([...new Set(req.body.types)]), new Date().toISOString());
    audit(db, req.user.id, 'Added storage destination', name);
    res.status(201).json({ id });
  });
  app.get('/api/storage/:id/connect', siteAdmin, (req, res) => {
    const node = db.prepare('SELECT * FROM drives WHERE id = ?').get(req.params.id);
    if (!node || node.kind !== 'oauth') throw fail(404, 'Personal Drive destination not found.');
    if (!/^[a-fA-F0-9]{64}$/.test(config.encryptionKey)) throw fail(503, 'Configure STORAGE_ENCRYPTION_KEY first.');
    beginOAuth(req, res, 'drive', node.id);
  });
  app.post('/api/storage/:id/test', siteAdmin, asyncRoute(async (req, res) => {
    const node = db.prepare('SELECT * FROM drives WHERE id = ?').get(req.params.id);
    if (!node) throw fail(404, 'Storage destination not found.');
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
  app.patch('/api/storage/:id', siteAdmin, (req, res) => {
    const node = db.prepare('SELECT * FROM drives WHERE id = ?').get(req.params.id);
    if (!node) throw fail(404, 'Storage destination not found.');
    const name = req.body.name === undefined ? node.name : text(req.body.name, 'Storage name', 100);
    let types = JSON.parse(node.types);
    if (req.body.types !== undefined) {
      if (!Array.isArray(req.body.types) || !req.body.types.length ||
        req.body.types.some(type => !TYPES.includes(type) || type === 'link')) throw fail(400, 'Choose at least one supported file type.');
      types = [...new Set(req.body.types)];
    }
    const enabled = req.body.enabled === undefined ? node.enabled : req.body.enabled ? 1 : 0;
    db.prepare('UPDATE drives SET name = ?, types = ?, enabled = ? WHERE id = ?').run(name, JSON.stringify(types), enabled, node.id);
    audit(db, req.user.id, 'Updated storage destination', name);
    res.json({ ok: true });
  });
  app.delete('/api/storage/:id', siteAdmin, (req, res) => {
    const node = db.prepare('SELECT * FROM drives WHERE id = ?').get(req.params.id);
    if (!node) throw fail(404, 'Storage destination not found.');
    if (db.prepare('SELECT 1 FROM content WHERE storage_node = ? LIMIT 1').get(node.id)) {
      throw fail(409, 'This Drive still holds files. Pause it instead so new uploads go elsewhere.');
    }
    db.prepare('DELETE FROM drives WHERE id = ?').run(node.id);
    audit(db, req.user.id, 'Removed storage destination', node.name);
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  if (config.production) {
    const dist = path.resolve('dist');
    if (!existsSync(path.join(dist, 'index.html'))) throw new Error('Production build missing. Run npm run build first.');
    app.use(express.static(dist));
    app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error(`${req.method} ${req.path}:`, error.message);
    const status = error instanceof multer.MulterError ? 400 : error.status >= 400 && error.status < 600 ? error.status : 500;
    const message = error.code === 'LIMIT_FILE_SIZE' ? `File exceeds the ${config.maxUploadMB} MB upload limit.`
      : error instanceof multer.MulterError ? `Upload rejected: ${error.message}`
        : error.expose ? error.message : 'The operation failed. Please check the connection or server configuration and try again.';
    res.status(error.expose || status === 400 ? status : 500).json({ error: message });
  });
  return app;
}
