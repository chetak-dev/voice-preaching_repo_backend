import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, googleProblem } from './app.js';
import { hashPassword } from './db.js';
import { APP_FOLDER, TYPE_FOLDERS, boundedRange, ensureAppFolder, ensureTypeFolder } from './storage.js';

const ORIGIN = 'http://localhost:5173';
const TEST_PASSWORD = 'test-password';
let server;
let app;
let base;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'voice-test-'));
  app = createApp({ production: false, dataDir, databaseUrl: 'file::memory:', origin: ORIGIN, googleClientId: '', googleClientSecret: '', siteAdmins: ['owner@example.test'], apiRateLimit: 2000 });
  await app.locals.ready;
  const insert = (...values) => app.locals.db.run('INSERT INTO users (id, email, name, role, created_at, password_hash) VALUES (?, ?, ?, ?, ?, ?)', ...values);
  const hashed = hashPassword(TEST_PASSWORD);
  await insert('test-admin', 'admin@example.test', 'Test Admin', 'site_admin', new Date().toISOString(), hashed);
  await insert('test-org-admin', 'orgadmin@example.test', 'Test Org Admin', 'org_admin', new Date().toISOString(), hashed);
  await insert('test-user', 'member@example.test', 'Test Member', 'user', new Date().toISOString(), hashed);
  await insert('test-viewer', 'viewer@example.test', 'Test Viewer', 'user', new Date().toISOString(), hashed);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  app.locals.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const REASON = { reason: 'Test cleanup' };
const ACCOUNTS = { site_admin: 'admin@example.test', org_admin: 'orgadmin@example.test', user: 'member@example.test' };

function post(url, body, origin = ORIGIN) {
  return fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
}

async function signIn(role, password = TEST_PASSWORD) {
  const res = await post('/api/auth/login', { email: ACCOUNTS[role] || role, password });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (url, { method = 'GET', body, raw, type } = {}) => {
    const headers = { Cookie: cookie, Origin: ORIGIN };
    if (body) headers['Content-Type'] = 'application/json';
    if (raw) headers['Content-Type'] = type || 'application/octet-stream';
    const response = await fetch(`${base}${url}`, { method, headers, body: raw || (body && JSON.stringify(body)) });
    const contentType = response.headers.get('content-type') || '';
    if (contentType.startsWith('image/')) return { status: response.status, type: contentType, bytes: Buffer.from(await response.arrayBuffer()) };
    return { status: response.status, json: await response.json().catch(() => null) };
  };
}


test('media byte ranges are single, valid, and capped at 4 MiB', () => {
  const oversized = boundedRange('bytes=0-99999999', 10 * 1024 * 1024);
  assert.equal(oversized.header, 'bytes=0-4194303');
  const suffix = boundedRange('bytes=-99999999', 10 * 1024 * 1024);
  assert.equal(suffix.header, 'bytes=6291456-10485759');
  assert.equal(boundedRange('bytes=0-1,3-4', 32).invalid, true);
  assert.equal(boundedRange('bytes=32-', 32).invalid, true);
});

test('unauthenticated requests are rejected', async () => {
  const res = await fetch(`${base}/api/content`);
  assert.equal(res.status, 401);
});

test('state-changing requests from other origins are rejected', async () => {
  const res = await post('/api/auth/login', { email: ACCOUNTS.user, password: TEST_PASSWORD }, 'https://evil.example');
  assert.equal(res.status, 403);
});

test('member submissions require admin approval; admin submissions are published', async () => {
  const user = await signIn('user');
  const orgAdmin = await signIn('org_admin');
  const admin = await signIn('site_admin');

  const created = await user('/api/content', { method: 'POST', body: { title: 'Weekly class notes', url: 'https://example.org/notes' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, 'pending');
  assert.equal((await user('/api/content', { method: 'POST', body: { title: 'Plain http link', url: 'http://example.org/http' } })).status, 201);
  for (const url of ['javascript:alert(1)', 'ftp://example.org/x', 'https://u:p@example.org/']) {
    assert.equal((await user('/api/content', { method: 'POST', body: { title: 'Bad link', url } })).status, 400, url);
  }
  const library = await user('/api/content?scope=library');
  assert.ok(!library.json.items.some(item => item.id === created.json.id), 'pending content must not appear in the library');
  const mine = await user('/api/content?scope=mine');
  assert.ok(mine.json.items.some(item => item.id === created.json.id && item.status === 'pending'));

  assert.equal((await user('/api/content?scope=review')).status, 403);
  assert.equal((await user(`/api/content/${created.json.id}/review`, { method: 'POST', body: { decision: 'approved' } })).status, 403);

  const queue = await admin('/api/content?scope=review');
  assert.ok(queue.json.items.some(item => item.id === created.json.id));
  const approved = await admin(`/api/content/${created.json.id}/review`, { method: 'POST', body: { decision: 'approved' } });
  assert.equal(approved.status, 200);
  const again = await admin(`/api/content/${created.json.id}/review`, { method: 'POST', body: { decision: 'rejected', note: 'Too late now' } });
  assert.equal(again.status, 409);

  const after = await orgAdmin('/api/content?scope=library');
  assert.ok(after.json.items.some(item => item.id === created.json.id));

  const orgAdminPost = await orgAdmin('/api/content', { method: 'POST', body: { title: 'Org admin link', url: 'https://example.org/a' } });
  assert.equal(orgAdminPost.json.status, 'approved', 'admin submissions are published without review');
  assert.equal(orgAdminPost.json.message, 'Published.');
  const adminPost = await admin('/api/content', { method: 'POST', body: { title: 'Admin link', url: 'https://example.org/b' } });
  assert.equal(adminPost.json.status, 'approved');
  const published = await user('/api/content?scope=library');
  assert.ok([orgAdminPost.json.id, adminPost.json.id].every(id => published.json.items.some(item => item.id === id && item.status === 'approved')));
  assert.ok(!(await admin('/api/content?scope=review')).json.items.some(item => [orgAdminPost.json.id, adminPost.json.id].includes(item.id)));
});

test('rejections require a note and are visible to the uploader', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  const { json } = await user('/api/content', { method: 'POST', body: { title: 'Rejected link', url: 'https://example.org/r' } });
  assert.equal((await admin(`/api/content/${json.id}/review`, { method: 'POST', body: { decision: 'rejected' } })).status, 400);
  assert.equal((await admin(`/api/content/${json.id}/review`, { method: 'POST', body: { decision: 'rejected', note: 'Please add a description.' } })).status, 200);
  const mine = await user('/api/content?scope=mine');
  const item = mine.json.items.find(entry => entry.id === json.id);
  assert.equal(item.status, 'rejected');
  assert.equal(item.review_note, 'Please add a description.');
  assert.equal((await user(`/api/content/${json.id}`, { method: 'DELETE', body: REASON })).status, 403, 'members cannot remove content');
  assert.equal((await admin(`/api/content/${json.id}`, { method: 'DELETE' })).status, 400, 'a reason is required');
  assert.equal((await admin(`/api/content/${json.id}`, { method: 'DELETE', body: { reason: 'no' } })).status, 400);
  assert.equal((await admin(`/api/content/${json.id}`, { method: 'DELETE', body: REASON })).status, 200);
  assert.ok(JSON.stringify((await admin('/api/audit')).json).includes('Reason: Test cleanup'));
});

test('uploads are verified and stored pending approval', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const started = await user('/api/uploads', { method: 'POST', body: { title: 'Logo', name: 'logo.png', mime: 'image/png', size: png.length } });
  assert.equal(started.status, 201);
  const ok = await user(`/api/uploads/${started.json.id}?offset=0`, { method: 'PUT', raw: png });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.done, true);
  assert.equal(ok.json.status, 'pending');
  const queue = await admin('/api/content?scope=review');
  assert.ok(queue.json.items.some(item => item.id === ok.json.id && item.size === png.length));
  const repeat = await user(`/api/uploads/${started.json.id}?offset=0`, { method: 'PUT', raw: png });
  assert.equal(repeat.status, 200, 'a retried final chunk returns the finished upload');
  assert.equal(repeat.json.id, ok.json.id);
  const mine = (await user('/api/content?scope=mine')).json.items.filter(item => item.id === ok.json.id);
  assert.equal(mine.length, 1, 'retries do not duplicate content');

  const fake = await user('/api/uploads', { method: 'POST', body: { title: 'Not really a PNG', name: 'fake.png', mime: 'image/png', size: 5 } });
  assert.equal((await user(`/api/uploads/${fake.json.id}?offset=0`, { method: 'PUT', raw: Buffer.from('hello') })).status, 400);
  assert.equal((await user(`/api/uploads/${fake.json.id}?offset=0`, { method: 'PUT', raw: Buffer.from('hello') })).status, 404, 'rejected uploads are discarded');

  const html = Buffer.from('<script>alert(1)</script>');
  const page = await user('/api/uploads', { method: 'POST', body: { title: 'Web page', name: 'page.html', mime: 'text/html', size: html.length } });
  assert.equal(page.status, 201, 'any file type is accepted');
  const saved = await user(`/api/uploads/${page.json.id}?offset=0`, { method: 'PUT', raw: html });
  assert.equal(saved.status, 201);
  const pageItem = (await user('/api/content?scope=mine')).json.items.find(item => item.id === saved.json.id);
  assert.equal(pageItem.type, 'doc');
  const login = await post('/api/auth/login', { email: ACCOUNTS.user, password: TEST_PASSWORD });
  const served = await fetch(`${base}/api/content/${saved.json.id}/file?inline=1`, { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } });
  assert.match(served.headers.get('content-disposition'), /^attachment/, 'non-previewable files are always downloads');
  assert.equal(served.headers.get('content-security-policy'), 'sandbox');
  await served.arrayBuffer();
  const unknown = await user('/api/uploads', { method: 'POST', body: { title: 'Program', name: 'a.bin', mime: '', size: 10 } });
  assert.equal(unknown.status, 201, 'files without a reported type are accepted');
  const huge = await user('/api/uploads', { method: 'POST', body: { title: 'Huge', name: 'a.mp4', mime: 'video/mp4', size: 20 * 1024 * 1024 * 1024 } });
  assert.equal(huge.status, 201, 'there is no file size limit');
});

test('large uploads arrive in ordered chunks and can be cancelled', async () => {
  const user = await signIn('user');
  const other = await signIn('org_admin');
  const size = 256 * 1024 + 100;
  const file = Buffer.alloc(size, 0x61);
  file.write('%PDF-1.7', 0, 'latin1');
  const { json: { id } } = await user('/api/uploads', { method: 'POST', body: { title: 'Big doc', name: 'big.pdf', mime: 'application/pdf', size } });
  assert.equal((await other(`/api/uploads/${id}?offset=0`, { method: 'PUT', raw: file.subarray(0, 256 * 1024) })).status, 404, 'only the uploader can send chunks');
  assert.equal((await user(`/api/uploads/${id}?offset=0`, { method: 'PUT', raw: file.subarray(0, 1000) })).status, 400, 'middle chunks must be 256 KB multiples');
  const first = await user(`/api/uploads/${id}?offset=0`, { method: 'PUT', raw: file.subarray(0, 256 * 1024) });
  assert.deepEqual(first.json, { done: false, received: 256 * 1024 });
  assert.deepEqual((await user(`/api/uploads/${id}`)).json, { done: false, received: 256 * 1024, size }, 'a reopened app learns where to resume');
  assert.equal((await other(`/api/uploads/${id}`)).status, 404, 'only the uploader can see upload progress');
  const outOfOrder = await user(`/api/uploads/${id}?offset=0`, { method: 'PUT', raw: file.subarray(0, 256 * 1024) });
  assert.equal(outOfOrder.status, 409);
  assert.equal(outOfOrder.json.received, 256 * 1024);
  const last = await user(`/api/uploads/${id}?offset=${256 * 1024}`, { method: 'PUT', raw: file.subarray(256 * 1024) });
  assert.equal(last.status, 201);
  const replay = await user(`/api/uploads/${id}?offset=${256 * 1024}`, { method: 'PUT', raw: file.subarray(256 * 1024) });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, last.json.id);
  assert.equal((await user(`/api/uploads/${id}`)).json.done, true);
  assert.deepEqual(readFileSync(path.join(dataDir, 'files', id)), file);
  const mine = await user('/api/content?scope=mine');
  assert.equal(mine.json.items.find(item => item.id === last.json.id).size, size);

  const cancelled = await user('/api/uploads', { method: 'POST', body: { title: 'Cancel me', name: 'c.pdf', mime: 'application/pdf', size } });
  assert.equal((await user(`/api/uploads/${cancelled.json.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await user(`/api/uploads/${cancelled.json.id}?offset=0`, { method: 'PUT', raw: file.subarray(0, 256 * 1024) })).status, 404);
});


test('concurrent chunks cannot advance or duplicate an upload, and finalization is idempotent', async () => {
  const user = await signIn('user');
  const size = 256 * 1024 + 10;
  const file = Buffer.alloc(size, 0x61);
  file.write('%PDF-1.7', 0, 'latin1');
  const started = await user('/api/uploads', { method: 'POST', body: { title: 'Concurrent upload', name: 'concurrent.pdf', mime: 'application/pdf', size } });
  const id = started.json.id;
  const first = file.subarray(0, 256 * 1024);
  const attempts = await Promise.all([
    user(`/api/uploads/${id}?offset=0`, { method: 'PUT', raw: first }),
    user(`/api/uploads/${id}?offset=0`, { method: 'PUT', raw: first }),
  ]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
  const final = await user(`/api/uploads/${id}?offset=${256 * 1024}`, { method: 'PUT', raw: file.subarray(256 * 1024) });
  assert.equal(final.status, 201);
  const replay = await user(`/api/uploads/${id}?offset=${256 * 1024}`, { method: 'PUT', raw: file.subarray(256 * 1024) });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, final.json.id);
  assert.deepEqual(readFileSync(path.join(dataDir, 'files', id)), file);
});

test('an active deletion claim blocks approval and duplicate deletion', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  const { json: item } = await user('/api/content', { method: 'POST', body: { title: 'Deletion race', url: 'https://example.org/deletion-race' } });
  await app.locals.db.run('UPDATE content SET deletion_token = ?, deletion_lock_expires = ? WHERE id = ?', 'test-lock', Date.now() + 60_000, item.id);
  assert.equal((await admin(`/api/content/${item.id}/review`, { method: 'POST', body: { decision: 'approved' } })).status, 409);
  assert.equal((await admin(`/api/content/${item.id}`, { method: 'DELETE', body: REASON })).status, 409);
  await app.locals.db.run('UPDATE content SET deletion_lock_expires = ? WHERE id = ?', Date.now() - 1, item.id);
  assert.equal((await admin(`/api/content/${item.id}`, { method: 'DELETE', body: REASON })).status, 200);
});

test('people can sign up, sign in and are rejected with bad credentials', async () => {
  const short = await post('/api/auth/signup', { name: 'New Person', email: 'new@example.test', password: 'short' });
  assert.equal(short.status, 400);
  const created = await post('/api/auth/signup', { name: 'New Person', email: 'New@Example.test', password: 'a-strong-pass' });
  assert.equal(created.status, 201);
  assert.ok(created.headers.get('set-cookie'));
  assert.equal((await post('/api/auth/signup', { name: 'Again', email: 'new@example.test', password: 'a-strong-pass' })).status, 409);
  assert.equal((await post('/api/auth/signup', { name: 'Owner', email: 'owner@example.test', password: 'a-strong-pass' })).status, 403);

  const session = await signIn('new@example.test', 'a-strong-pass');
  const me = await session('/api/auth/me');
  assert.equal(me.json.user.role, 'user');
  assert.equal(me.json.user.email, 'new@example.test');

  assert.equal((await post('/api/auth/login', { email: 'new@example.test', password: 'wrong-password' })).status, 401);
  assert.equal((await post('/api/auth/login', { email: 'nobody@example.test', password: 'whatever1' })).status, 401);
});

test('only site admins can promote org admins', async () => {
  const orgAdmin = await signIn('org_admin');
  const admin = await signIn('site_admin');
  assert.equal((await orgAdmin('/api/users/test-user', { method: 'PATCH', body: { role: 'org_admin' } })).status, 403);
  assert.equal((await admin('/api/users/test-user', { method: 'PATCH', body: { role: 'site_admin' } })).status, 400);
  assert.equal((await admin('/api/users/test-user', { method: 'PATCH', body: { role: 'org_admin' } })).status, 200);
  const users = await admin('/api/users');
  assert.equal(users.status, 200);
  assert.equal(users.json.users.find(entry => entry.id === 'test-user').role, 'org_admin');
  assert.ok(users.json.users.every(entry => !('password_hash' in entry)));
  assert.equal((await admin('/api/users/test-admin', { method: 'PATCH', body: { role: 'user' } })).status, 403);
  assert.equal((await admin('/api/users/test-user', { method: 'PATCH', body: { role: 'user' } })).status, 200);
  assert.equal((await (await signIn('user'))('/api/users')).status, 403);
});

test('suspension rules and suspended accounts are blocked', async () => {
  const orgAdmin = await signIn('org_admin');
  const admin = await signIn('site_admin');
  const user = await signIn('user');
  assert.equal((await orgAdmin('/api/users/test-admin/suspend', { method: 'POST', body: { suspended: true } })).status, 403);
  assert.equal((await admin('/api/users/test-admin/suspend', { method: 'POST', body: { suspended: true } })).status, 400);
  assert.equal((await orgAdmin('/api/users/test-user/suspend', { method: 'POST', body: { suspended: true } })).status, 403);
  assert.equal((await admin('/api/users/test-user/suspend', { method: 'POST', body: { suspended: true } })).status, 200);
  assert.equal((await user('/api/auth/me')).status, 401, 'existing sessions end on suspension');
  assert.equal((await post('/api/auth/login', { email: ACCOUNTS.user, password: TEST_PASSWORD })).status, 403);
  assert.equal((await admin('/api/users/test-user/suspend', { method: 'POST', body: { suspended: false } })).status, 200);
  assert.equal((await (await signIn('user'))('/api/auth/me')).status, 200);
  assert.equal((await admin('/api/users/test-org-admin/suspend', { method: 'POST', body: { suspended: true } })).status, 200);
  assert.equal((await orgAdmin('/api/auth/me')).status, 401);
  assert.equal((await admin('/api/users/test-org-admin/suspend', { method: 'POST', body: { suspended: false } })).status, 200);
});

test('org admins can approve or reject content, and nothing else', async () => {
  const user = await signIn('user');
  const orgAdmin = await signIn('org_admin');
  const admin = await signIn('site_admin');

  const { json } = await user('/api/content', { method: 'POST', body: { title: 'For the org admin', url: 'https://example.org/o' } });
  const queue = await orgAdmin('/api/content?scope=review');
  assert.equal(queue.status, 200);
  assert.ok(queue.json.items.some(item => item.id === json.id));
  assert.equal((await orgAdmin('/api/overview')).json.pending, queue.json.items.length);
  assert.equal((await orgAdmin(`/api/content/${json.id}/review`, { method: 'POST', body: { decision: 'approved' } })).status, 200);
  assert.ok((await user('/api/content?scope=library')).json.items.some(item => item.id === json.id));

  const second = (await user('/api/content', { method: 'POST', body: { title: 'Needs work', url: 'https://example.org/n' } })).json;
  assert.equal((await orgAdmin(`/api/content/${second.id}/review`, { method: 'POST', body: { decision: 'rejected', note: 'Please add details.' } })).status, 200);

  const own = (await orgAdmin('/api/content', { method: 'POST', body: { title: 'My own link', url: 'https://example.org/own' } })).json;
  assert.equal(own.status, 'approved');
  assert.equal((await orgAdmin(`/api/content/${own.id}/review`, { method: 'POST', body: { decision: 'rejected', note: 'Changed my mind' } })).status, 403,
    'org admins cannot review their own submissions');

  assert.equal((await orgAdmin(`/api/content/${json.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await user(`/api/content/${json.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await orgAdmin('/api/users')).status, 403);
  assert.equal((await orgAdmin('/api/audit')).status, 403);
  assert.equal((await orgAdmin('/api/users/test-user', { method: 'PATCH', body: { role: 'org_admin' } })).status, 403);
  assert.equal((await admin(`/api/content/${json.id}`, { method: 'DELETE', body: REASON })).status, 200);
});

test('approved content visibility defaults to public and private items stay out of community lists and file routes', async () => {
  const owner = await signIn('user');
  const viewer = await signIn('viewer@example.test');
  const orgAdmin = await signIn('org_admin');
  const admin = await signIn('site_admin');
  const item = (await owner('/api/content', { method: 'POST', body: { title: 'Visibility test', url: 'https://example.org/visibility-test' } })).json;
  assert.equal((await admin(`/api/content/${item.id}/review`, { method: 'POST', body: { decision: 'approved' } })).status, 200);
  assert.ok((await viewer('/api/content?scope=library')).json.items.some(row => row.id === item.id));
  assert.equal((await owner(`/api/content/${item.id}/visibility`, { method: 'PATCH', body: { visibility: 'private' } })).json.visibility, 'private');
  assert.ok((await owner('/api/content?scope=mine')).json.items.some(row => row.id === item.id && row.visibility === 'private'));
  assert.ok(!(await viewer('/api/content?scope=library')).json.items.some(row => row.id === item.id));
  assert.equal((await viewer(`/api/content/${item.id}/file`)).status, 404);
  assert.equal((await orgAdmin(`/api/content/${item.id}/visibility`, { method: 'PATCH', body: { visibility: 'public' } })).status, 403);
  assert.equal((await viewer(`/api/content/${item.id}/visibility`, { method: 'PATCH', body: { visibility: 'public' } })).status, 404);
  assert.equal((await owner(`/api/content/${item.id}/visibility`, { method: 'PATCH', body: { visibility: 'unlisted' } })).status, 400);
  assert.equal((await admin(`/api/content/${item.id}/visibility`, { method: 'PATCH', body: { visibility: 'public' } })).status, 200);
  assert.ok((await viewer('/api/content?scope=library')).json.items.some(row => row.id === item.id));
});

test('bulk review is bounded, skips ineligible items, and keeps org admins from approving their own submissions', async () => {
  const user = await signIn('user');
  const orgAdmin = await signIn('org_admin');
  const siteAdmin = await signIn('site_admin');
  const first = (await user('/api/content', { method: 'POST', body: { title: 'Bulk one', url: 'https://example.org/bulk-one' } })).json;
  const second = (await user('/api/content', { method: 'POST', body: { title: 'Bulk two', url: 'https://example.org/bulk-two' } })).json;
  assert.equal((await user('/api/review/bulk-approve', { method: 'POST', body: { ids: [first.id] } })).status, 403);
  const approved = await orgAdmin('/api/review/bulk-approve', { method: 'POST', body: { ids: [first.id, second.id] } });
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.json, { approved: 2, skipped: 0 });
  assert.equal((await user('/api/content?scope=library')).json.items.filter(row => [first.id, second.id].includes(row.id)).length, 2);
  const own = (await orgAdmin('/api/content', { method: 'POST', body: { title: 'Org admin own item', url: 'https://example.org/org-own' } })).json;
  assert.equal(own.status, 'approved', 'admin submissions skip the review queue');
  const skipped = await orgAdmin('/api/review/bulk-approve', { method: 'POST', body: { ids: [own.id] } });
  assert.equal(skipped.status, 200);
  assert.deepEqual(skipped.json, { approved: 0, skipped: 1 });
  assert.ok(!(await orgAdmin('/api/content?scope=review')).json.items.some(row => row.id === own.id));
  assert.equal((await siteAdmin('/api/review/bulk-approve', { method: 'POST', body: { ids: Array.from({ length: 26 }, (_, index) => `bad-${index}`) } })).status, 400);
  assert.equal((await siteAdmin('/api/review/bulk-approve', { method: 'POST', body: { ids: [first.id, first.id] } })).status, 400);
});

test('storage management is restricted to site admins', async () => {
  const orgAdmin = await signIn('org_admin');
  const admin = await signIn('site_admin');
  assert.equal((await orgAdmin('/api/storage', { method: 'POST', body: { name: 'X', folderId: 'abc', kind: 'oauth' } })).status, 403);
  const storage = await admin('/api/storage');
  assert.equal(storage.status, 200);
  assert.ok(Array.isArray(storage.json.nodes));
  assert.equal(storage.json.setup.redirectUri.endsWith('/api/auth/google/callback'), true);
  assert.equal((await admin('/api/audit')).status, 200);
});

test('drives can be registered before Google is configured and accept every file type', async () => {
  const admin = await signIn('site_admin');
  const created = await admin('/api/storage', { method: 'POST', body: { name: 'Media Drive 1', kind: 'oauth' } });
  assert.equal(created.status, 201);
  assert.equal((await admin('/api/storage', { method: 'POST', body: { name: 'media drive 1', kind: 'oauth' } })).status, 409);
  const node = (await admin('/api/storage')).json.nodes.find(n => n.id === created.json.id);
  assert.equal(node.connected, false);
  assert.equal(node.folderId, '');
  assert.equal('types' in node, false);
  assert.equal((await admin(`/api/storage/${node.id}`, { method: 'DELETE' })).status, 200);

  assert.equal((await admin('/api/storage', { method: 'POST', body: { name: 'Shared', kind: 'service' } })).status, 400);
  const shared = { name: 'Shared', kind: 'service', folderId: '1_bvFEEuo__VMC85oVlk49a3f6XUTjIH3' };
  const sharedNode = await admin('/api/storage', { method: 'POST', body: shared });
  assert.equal(sharedNode.status, 201);
  assert.equal((await admin('/api/storage', { method: 'POST', body: { ...shared, name: 'Shared 2' } })).status, 409);
  assert.equal((await admin(`/api/storage/${sharedNode.json.id}`, { method: 'DELETE' })).status, 200);
});

test('site admins can list and remove what a disconnected Drive holds, then remove the Drive', async () => {
  const admin = await signIn('site_admin');
  const orgAdmin = await signIn('org_admin');
  const user = await signIn('user');
  const node = (await admin('/api/storage', { method: 'POST', body: { name: 'Old test Drive', kind: 'oauth' } })).json;
  const hidden = (await user('/api/content', { method: 'POST', body: { title: 'Hidden pending file', url: 'https://example.org/hidden' } })).json;
  await app.locals.db.run('UPDATE content SET storage_node = ?, storage_key = ? WHERE id = ?', node.id, 'unreachable-file', hidden.id);

  assert.equal((await orgAdmin(`/api/storage/${node.id}/items`)).status, 403);
  const listed = await admin(`/api/storage/${node.id}/items`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.items.map(item => [item.title, item.status]), [['Hidden pending file', 'pending']]);
  assert.equal((await admin(`/api/storage/${node.id}`, { method: 'DELETE' })).status, 409);

  assert.equal((await admin(`/api/content/${hidden.id}`, { method: 'DELETE', body: REASON })).status, 200);
  assert.deepEqual((await admin(`/api/storage/${node.id}/items`)).json.items, []);
  assert.equal((await admin(`/api/storage/${node.id}`, { method: 'DELETE' })).status, 200);
});

test('Google failures become actionable messages', () => {
  const disabled = { response: { data: { error: { code: 403, message: 'Google Drive API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } } } };
  assert.match(googleProblem(disabled, 'drive'), /Drive API is not enabled/);
  assert.match(googleProblem({ response: { data: { error: 'invalid_client' } } }, 'login'), /GOOGLE_CLIENT_ID/);
  assert.match(googleProblem({ response: { data: { error: 'invalid_grant' } } }, 'login'), /try again/);
  const other = { response: { data: { error: { code: 500, message: 'Backend Error' } } } };
  assert.equal(googleProblem(other, 'drive'), 'Google Drive error: Backend Error');
  assert.equal(googleProblem(other, 'login'), '');
  assert.equal(googleProblem(new Error('boom'), 'login'), '');
});

test('personal Drives use their own app folder, reusing it when possible', async () => {
  const calls = [];
  const fake = ({ getOk = false, listed = [] } = {}) => ({
    files: {
      get: async ({ fileId }) => {
        calls.push(['get', fileId]);
        if (!getOk) throw new Error('not found');
        return { data: { id: fileId, mimeType: 'application/vnd.google-apps.folder', trashed: false, capabilities: { canAddChildren: true } } };
      },
      list: async ({ q }) => { calls.push(['list', q]); return { data: { files: listed } }; },
      create: async ({ requestBody }) => { calls.push(['create', requestBody.name]); return { data: { id: 'new-folder' } }; },
    },
  });
  assert.equal(await ensureAppFolder(fake({ getOk: true }), 'kept'), 'kept');
  assert.equal(await ensureAppFolder(fake({ listed: [{ id: 'found' }] }), 'gone'), 'found');
  assert.equal(await ensureAppFolder(fake(), ''), 'new-folder');
  assert.deepEqual(calls.at(-1), ['create', APP_FOLDER]);
  assert.ok(calls.some(([kind, q]) => kind === 'list' && q.includes(`name = '${APP_FOLDER}'`)));
  // Drives connected before the rename keep their "VOICE Media" folder; the current name wins when both exist.
  assert.ok(calls.some(([kind, q]) => kind === 'list' && q.includes("name = 'VOICE Media'")));
  assert.equal(await ensureAppFolder(fake({ listed: [{ id: 'old', name: 'VOICE Media' }, { id: 'current', name: APP_FOLDER }] }), ''), 'current');
  assert.equal(await ensureAppFolder(fake({ listed: [{ id: 'old', name: 'VOICE Media' }] }), ''), 'old');
});

test('uploads go into per-type subfolders that are created once and then reused', async () => {
  const calls = [];
  const fake = listed => ({
    files: {
      list: async ({ q }) => { calls.push(['list', q]); return { data: { files: listed } }; },
      create: async ({ requestBody }) => { calls.push(['create', requestBody]); return { data: { id: 'videos-new' } }; },
    },
  });
  assert.equal(await ensureTypeFolder(fake([{ id: 'videos-existing' }]), 'app-folder', TYPE_FOLDERS.video), 'videos-existing');
  assert.ok(calls[0][1].includes("name = 'Videos'") && calls[0][1].includes("'app-folder' in parents"));
  assert.equal(await ensureTypeFolder(fake([]), 'app-folder', TYPE_FOLDERS.video), 'videos-new');
  assert.deepEqual(calls.at(-1)[1], { name: 'Videos', mimeType: 'application/vnd.google-apps.folder', parents: ['app-folder'] });
  assert.deepEqual(Object.values(TYPE_FOLDERS), ['Images', 'Videos', 'Audios', 'Documents']);
});

test('serverless hosts refuse file uploads until a Google Drive is connected', async () => {
  const serverless = createApp({ production: false, localStorage: false, dataDir, databaseUrl: 'file::memory:', origin: ORIGIN, googleClientId: '', googleClientSecret: '', siteAdmins: [] });
  await serverless.locals.ready;
  await serverless.locals.db.run('INSERT INTO users (id, email, name, role, created_at, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
    'sl-admin', 'admin@example.test', 'Admin', 'site_admin', new Date().toISOString(), hashPassword(TEST_PASSWORD));
  const listener = await new Promise(resolve => { const s = serverless.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${listener.address().port}`;
  try {
    const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email: 'admin@example.test', password: TEST_PASSWORD }) });
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: ORIGIN, 'Content-Type': 'application/json' };
    const storage = await (await fetch(`${url}/api/storage`, { headers })).json();
    assert.equal(storage.local, null);
    const upload = await fetch(`${url}/api/uploads`, { method: 'POST', headers,
      body: JSON.stringify({ title: 'Logo', name: 'logo.png', mime: 'image/png', size: 16 }) });
    assert.equal(upload.status, 503);
    const forced = await fetch(`${url}/api/uploads`, { method: 'POST', headers,
      body: JSON.stringify({ title: 'Logo', name: 'logo.png', mime: 'image/png', size: 16, targetDriveId: 'local' }) });
    assert.equal(forced.status, 400);
  } finally {
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
    serverless.locals.db.close();
  }
});
test('overview shows type counts to everyone and storage figures only to admins', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  const mine = (await user('/api/overview')).json;
  assert.equal(mine.storage, undefined, 'members do not see storage');
  assert.ok(Object.values(mine.types).every(info => info.bytes === undefined), 'members do not see sizes');
  const before = (await admin('/api/overview')).json;
  assert.ok(before.storage && typeof before.storage.content === 'number');
  const linksBefore = before.types.link?.files || 0;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const started = await user('/api/uploads', { method: 'POST', body: { title: 'Stats image', name: 'stats.png', mime: 'image/png', size: png.length } });
  const done = await user(`/api/uploads/${started.json.id}?offset=0`, { method: 'PUT', raw: png });
  const link = await user('/api/content', { method: 'POST', body: { title: 'Stats link', url: 'https://example.org/stats' } });
  const imagesBefore = before.types.image || { files: 0, bytes: 0 };
  assert.equal((await admin('/api/overview')).json.types.image?.files || 0, imagesBefore.files, 'pending items are not counted');
  for (const id of [done.json.id, link.json.id]) {
    assert.equal((await admin(`/api/content/${id}/review`, { method: 'POST', body: { decision: 'approved' } })).status, 200);
  }
  const after = (await admin('/api/overview')).json;
  assert.deepEqual(after.types.image, { files: imagesBefore.files + 1, bytes: imagesBefore.bytes + png.length });
  assert.equal(after.types.link.files, linksBefore + 1);
  assert.equal(after.storage.drives, 0);
  assert.equal(after.storage.total, null);
});

test('views count each member once and only for approved content', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  const viewer = await signIn('viewer@example.test');
  const link = await user('/api/content', { method: 'POST', body: { title: 'Views link', url: 'https://example.org/views' } });
  assert.equal((await user(`/api/content/${link.json.id}/view`, { method: 'POST' })).json.views, 0, 'pending content is not counted');
  await admin(`/api/content/${link.json.id}/review`, { method: 'POST', body: { decision: 'approved' } });
  assert.equal((await viewer(`/api/content/${link.json.id}/view`, { method: 'POST' })).json.views, 1);
  assert.equal((await viewer(`/api/content/${link.json.id}/view`, { method: 'POST' })).json.views, 1);
  assert.equal((await admin(`/api/content/${link.json.id}/view`, { method: 'POST' })).json.views, 2);
  const listed = (await user('/api/content?scope=library')).json.items.find(item => item.id === link.json.id);
  assert.equal(listed.views, 2);
  assert.equal((await admin(`/api/content/${link.json.id}`, { method: 'DELETE', body: REASON })).status, 200);
});

test('only site admins can remove content', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  const pending = (await user('/api/content', { method: 'POST', body: { title: 'Withdraw me', url: 'https://example.org/w' } })).json;
  assert.equal((await user(`/api/content/${pending.id}`, { method: 'DELETE', body: REASON })).status, 403, 'only site admins remove content');
  assert.equal((await admin(`/api/content/${pending.id}`, { method: 'DELETE', body: REASON })).status, 200);
  const approved = (await user('/api/content', { method: 'POST', body: { title: 'Keep me', url: 'https://example.org/k' } })).json;
  await admin(`/api/content/${approved.id}/review`, { method: 'POST', body: { decision: 'approved' } });
  assert.equal((await user(`/api/content/${approved.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await admin(`/api/content/${approved.id}`, { method: 'DELETE', body: REASON })).status, 200);
});

test('leaderboard awards points per approved submission and shows the top 10 to everyone', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  const pointsOf = board => board.top.find(entry => entry.id === board.me.id)?.points || 0;
  const before = (await user('/api/leaderboard')).json;
  assert.ok(before.top.length <= 10);
  const ids = [];
  for (const n of [1, 2]) {
    const { json } = await user('/api/content', { method: 'POST', body: { title: `Points ${n}`, url: `https://example.org/p${n}` } });
    ids.push(json.id);
  }
  assert.equal(pointsOf((await user('/api/leaderboard')).json), pointsOf(before), 'pending items earn nothing');
  for (const id of ids) await admin(`/api/content/${id}/review`, { method: 'POST', body: { decision: 'approved' } });
  const after = (await user('/api/leaderboard')).json;
  assert.equal(after.me.points, before.me.points + 20);
  assert.ok(after.top.some(entry => entry.id === after.me.id && entry.rank >= 1));
  assert.ok(after.top.every((entry, i, all) => i === 0 || all[i - 1].points >= entry.points));
  assert.equal((await (await signIn('org_admin'))('/api/leaderboard')).status, 200);
  for (const id of ids) await admin(`/api/content/${id}`, { method: 'DELETE', body: REASON });
});

test('files and links can be added to uploads, by the owner and by others, and each addition needs approval', async () => {
  const user = await signIn('user');
  const viewer = await signIn('viewer@example.test');
  const admin = await signIn('site_admin');
  const parent = (await user('/api/content', { method: 'POST', body: { title: 'Gita series', url: 'https://example.org/series' } })).json;

  assert.equal((await viewer('/api/content', { method: 'POST', body: { title: 'Too early', url: 'https://example.org/x', parentId: parent.id } })).status, 404,
    'others cannot add to an upload that is not yet approved');
  const ownEarly = await user('/api/content', { method: 'POST', body: { title: 'Part 1', url: 'https://example.org/1', parentId: parent.id } });
  assert.equal(ownEarly.status, 201, 'owners can add to their pending upload');

  await admin(`/api/content/${parent.id}/review`, { method: 'POST', body: { decision: 'approved' } });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const started = await viewer('/api/uploads', { method: 'POST', body: { title: 'Slide', name: 'slide.png', mime: 'image/png', size: png.length, parentId: parent.id } });
  assert.equal(started.status, 201);
  const added = await viewer(`/api/uploads/${started.json.id}?offset=0`, { method: 'PUT', raw: png });
  assert.equal(added.json.status, 'pending');

  const library = (await viewer('/api/content?scope=library')).json.items;
  assert.ok(library.some(item => item.id === parent.id));
  assert.ok(!library.some(item => item.id === ownEarly.json.id || item.id === added.json.id), 'additions are not separate library items');
  assert.deepEqual((await viewer(`/api/content/${parent.id}/parts`)).json.items.map(item => item.id), [added.json.id], 'others see only approved parts and their own');
  const queue = (await admin('/api/content?scope=review')).json.items.find(item => item.id === added.json.id);
  assert.equal(queue.parent_title, 'Gita series');

  await admin(`/api/content/${added.json.id}/review`, { method: 'POST', body: { decision: 'approved' } });
  await admin(`/api/content/${ownEarly.json.id}/review`, { method: 'POST', body: { decision: 'approved' } });
  assert.equal((await viewer('/api/content?scope=library')).json.items.find(item => item.id === parent.id).parts, 2);
  assert.equal((await viewer(`/api/content/${added.json.id}/file`)).status, 200);
  assert.equal((await viewer('/api/content', { method: 'POST', body: { title: 'Nested', url: 'https://example.org/n', parentId: added.json.id } })).status, 400);
  assert.equal((await viewer(`/api/content/${added.json.id}/bookmark`, { method: 'POST' })).status, 400);

  assert.equal((await admin(`/api/content/${parent.id}`, { method: 'DELETE', body: REASON })).status, 200);
  assert.equal((await viewer(`/api/content/${added.json.id}/file`)).status, 404, 'deleting an upload removes its additions');
  assert.equal((await user('/api/content?scope=mine')).json.items.filter(item => item.parent_id === parent.id).length, 0);
});

test('rejecting an upload also rejects its pending additions', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  const parent = (await user('/api/content', { method: 'POST', body: { title: 'Rejected series', url: 'https://example.org/rs' } })).json;
  const part = (await user('/api/content', { method: 'POST', body: { title: 'Rejected part', url: 'https://example.org/rp', parentId: parent.id } })).json;
  await admin(`/api/content/${parent.id}/review`, { method: 'POST', body: { decision: 'rejected', note: 'Not suitable' } });
  const mine = (await user('/api/content?scope=mine')).json.items.find(item => item.id === part.id);
  assert.equal(mine.status, 'rejected');
  assert.equal((await user('/api/content', { method: 'POST', body: { title: 'Late', url: 'https://example.org/l', parentId: parent.id } })).status, 409);
  await admin(`/api/content/${parent.id}`, { method: 'DELETE', body: REASON });
});

test('thumbnails are validated images that only the uploader or an admin can set, and are removed with the content', async () => {
  const user = await signIn('user');
  const viewer = await signIn('viewer@example.test');
  const admin = await signIn('site_admin');
  const item = (await user('/api/content', { method: 'POST', body: { title: 'Thumb link', url: 'https://example.org/thumb' } })).json;
  const jpeg = Buffer.concat([Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'), Buffer.alloc(32)]);
  assert.equal((await user(`/api/content/${item.id}/thumbnail`)).status, 404);
  assert.equal((await user(`/api/content/${item.id}/thumbnail`, { method: 'PUT', raw: Buffer.from('not an image at all'), type: 'image/jpeg' })).status, 400);
  assert.equal((await user(`/api/content/${item.id}/thumbnail`, { method: 'PUT', raw: jpeg, type: 'image/gif' })).status, 400);
  assert.equal((await user(`/api/content/${item.id}/thumbnail`, { method: 'PUT', raw: jpeg, type: 'image/jpeg' })).status, 200);
  assert.equal((await viewer(`/api/content/${item.id}/thumbnail`)).status, 404, 'pending thumbnails are hidden from others');
  const own = await user(`/api/content/${item.id}/thumbnail`);
  assert.equal(own.type, 'image/jpeg');
  assert.ok(own.bytes.equals(jpeg));
  assert.equal((await user('/api/content?scope=mine')).json.items.find(row => row.id === item.id).has_thumb, 1);

  await admin(`/api/content/${item.id}/review`, { method: 'POST', body: { decision: 'approved' } });
  assert.equal((await viewer(`/api/content/${item.id}/thumbnail`)).status, 200);
  assert.equal((await viewer(`/api/content/${item.id}/thumbnail`, { method: 'PUT', raw: jpeg, type: 'image/jpeg' })).status, 403);
  assert.equal((await admin(`/api/content/${item.id}/thumbnail`, { method: 'PUT', raw: jpeg, type: 'image/jpeg' })).status, 200);
  assert.equal((await admin(`/api/content/${item.id}`, { method: 'DELETE', body: REASON })).status, 200);
  assert.equal((await app.locals.db.get('SELECT count(*) AS n FROM thumbnails WHERE content_id = ?', item.id)).n, 0);
});

test('bulk reject needs a reason, rejects pending items and skips the rest', async () => {
  const user = await signIn('user');
  const orgAdmin = await signIn('org_admin');
  const first = (await user('/api/content', { method: 'POST', body: { title: 'Reject one', url: 'https://example.org/rj-one' } })).json;
  const second = (await user('/api/content', { method: 'POST', body: { title: 'Reject two', url: 'https://example.org/rj-two' } })).json;
  const own = (await orgAdmin('/api/content', { method: 'POST', body: { title: 'Already live', url: 'https://example.org/rj-own' } })).json;
  assert.equal((await user('/api/review/bulk-reject', { method: 'POST', body: { ids: [first.id], note: 'Not suitable' } })).status, 403);
  assert.equal((await orgAdmin('/api/review/bulk-reject', { method: 'POST', body: { ids: [first.id] } })).status, 400, 'a reason is required');
  const result = await orgAdmin('/api/review/bulk-reject', { method: 'POST', body: { ids: [first.id, second.id, own.id], note: 'Duplicate content' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { rejected: 2, skipped: 1 });
  const mine = (await user('/api/content?scope=mine')).json.items;
  for (const id of [first.id, second.id]) {
    const row = mine.find(item => item.id === id);
    assert.equal(row.status, 'rejected');
    assert.equal(row.review_note, 'Duplicate content');
  }
});

test('admins can edit titles and descriptions; members cannot', async () => {
  const user = await signIn('user');
  const orgAdmin = await signIn('org_admin');
  const { json } = await user('/api/content', { method: 'POST', body: { title: 'IMG 2024 typo', url: 'https://example.org/edit' } });
  assert.equal((await user(`/api/content/${json.id}`, { method: 'PATCH', body: { title: 'Mine now' } })).status, 403);
  assert.equal((await orgAdmin(`/api/content/${json.id}`, { method: 'PATCH', body: { title: '' } })).status, 400);
  const edited = await orgAdmin(`/api/content/${json.id}`, { method: 'PATCH', body: { title: 'Bhagavad Gita 2.13', description: 'Class notes' } });
  assert.equal(edited.status, 200);
  const row = (await user('/api/content?scope=mine')).json.items.find(item => item.id === json.id);
  assert.equal(row.title, 'Bhagavad Gita 2.13');
  assert.equal(row.description, 'Class notes');
  assert.ok(JSON.stringify((await (await signIn('site_admin'))('/api/audit')).json).includes('Edited content'));
});

test('contributors can withdraw only their own pending submissions', async () => {
  const user = await signIn('user');
  const viewer = await signIn('viewer@example.test');
  const admin = await signIn('site_admin');
  const pending = (await user('/api/content', { method: 'POST', body: { title: 'Change of mind', url: 'https://example.org/wd' } })).json;
  assert.equal((await viewer(`/api/content/${pending.id}/withdraw`, { method: 'POST' })).status, 404, 'others cannot even see it');
  assert.equal((await admin(`/api/content/${pending.id}/withdraw`, { method: 'POST' })).status, 403, 'admins remove with a reason instead');
  assert.equal((await user(`/api/content/${pending.id}/withdraw`, { method: 'POST' })).status, 200);
  assert.ok(!(await user('/api/content?scope=mine')).json.items.some(item => item.id === pending.id));
  assert.ok(!(await admin('/api/content?scope=review')).json.items.some(item => item.id === pending.id));

  const live = (await user('/api/content', { method: 'POST', body: { title: 'Approved stays', url: 'https://example.org/wd2' } })).json;
  await admin(`/api/content/${live.id}/review`, { method: 'POST', body: { decision: 'approved' } });
  assert.equal((await user(`/api/content/${live.id}/withdraw`, { method: 'POST' })).status, 409);
});

test('shared links preview only approved public uploads and need no sign-in', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  const item = (await admin('/api/content', { method: 'POST', body: { title: 'Gita <Class> & "Q&A"', description: 'Chapter 2 summary', url: 'https://example.org/share' } })).json;
  const page = await fetch(`${base}/s/${item.id}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('<meta property="og:title" content="Gita &lt;Class&gt; &amp; &quot;Q&amp;A&quot;">'), 'titles are escaped');
  assert.ok(html.includes('og:description" content="Chapter 2 summary"'));
  assert.ok(html.includes(`url=/?content=${item.id}#/library`));
  assert.equal((await fetch(`${base}/api/share/${item.id}`)).status, 200);
  assert.equal((await fetch(`${base}/api/share/${item.id}/image`)).status, 404, 'no thumbnail yet');

  const pending = (await user('/api/content', { method: 'POST', body: { title: 'Secret pending title', url: 'https://example.org/share2' } })).json;
  const hidden = await (await fetch(`${base}/s/${pending.id}`)).text();
  assert.ok(!hidden.includes('Secret pending title'), 'pending titles never leak');
  assert.ok(hidden.includes('url=/"'));
});

test('admins are warned when a Drive is nearly full', async () => {
  const admin = await signIn('site_admin');
  const db = app.locals.db;
  await db.run(`INSERT INTO drives (id,name,folder_id,kind,types,created_at,enabled,quota_usage,quota_limit,quota_checked_at,refresh_token)
    VALUES ('full-drive','Full Drive','folder-full','oauth','[]',?,1,95,100,?,'token')`, new Date().toISOString(), Date.now());
  await db.run(`INSERT INTO drives (id,name,folder_id,kind,types,created_at,enabled,quota_usage,quota_limit,quota_checked_at,refresh_token)
    VALUES ('roomy-drive','Roomy Drive','folder-roomy','oauth','[]',?,1,10,100,?,'token')`, new Date().toISOString(), Date.now());
  const overview = (await admin('/api/overview')).json;
  assert.deepEqual(overview.storage.nearlyFull, [{ name: 'Full Drive', percent: 95 }]);
  assert.equal((await (await signIn('user'))('/api/overview')).json.storage, undefined, 'members never see storage details');  await db.run("DELETE FROM drives WHERE id IN ('full-drive', 'roomy-drive')");
});

test('site admins can back up the database; the nightly cron needs the secret', async () => {
  const { gunzipSync } = await import('node:zlib');
  const { readdirSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'kt-backup-test-'));
  const secret = 'cron-secret-for-tests';
  const backupApp = createApp({ production: false, dataDir: dir, databaseUrl: ':memory:', origin: ORIGIN, googleClientId: '', googleClientSecret: '',
    siteAdmins: [], apiRateLimit: 2000, cronSecret: secret });
  await backupApp.locals.ready;
  const backupDb = backupApp.locals.db;
  const hashed = hashPassword(TEST_PASSWORD);
  for (const [id, email, role] of [['b-admin', 'badmin@example.test', 'site_admin'], ['b-user', 'buser@example.test', 'user']]) {
    await backupDb.run('INSERT INTO users (id, email, name, role, created_at, password_hash) VALUES (?, ?, ?, ?, ?, ?)', id, email, id, role, new Date().toISOString(), hashed);
  }
  await backupDb.run(`INSERT INTO drives (id,name,folder_id,kind,types,created_at,enabled,refresh_token)
    VALUES ('paused-drive','Paused Drive','folder-paused','oauth','[]',?,0,'secret-refresh-token')`, new Date().toISOString());
  const backupServer = await new Promise(resolve => { const s = backupApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${backupServer.address().port}`;
  const login = async email => {
    const res = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email, password: TEST_PASSWORD }) });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return (route, method = 'GET', body) => fetch(`${url}${route}`, { method,
      headers: { Cookie: cookie, Origin: ORIGIN, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  };
  try {
    const admin = await login('badmin@example.test');
    const member = await login('buser@example.test');
    assert.equal((await admin('/api/content', 'POST', { title: 'Backed up talk', url: 'https://example.org/talk' })).status, 201);

    assert.equal((await member('/api/backups', 'POST')).status, 403);
    assert.equal((await member('/api/backups')).status, 403);
    const empty = await (await admin('/api/backups')).json();
    assert.equal(empty.last, null);
    assert.equal(empty.scheduled, true);

    const created = await admin('/api/backups', 'POST');
    assert.equal(created.status, 201);
    const record = await created.json();
    assert.equal(record.ok, true);
    assert.match(record.fileName, /^kalpa-taru-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json\.gz$/);
    const files = readdirSync(path.join(dir, 'backups'));
    assert.ok(files.includes(record.fileName));
    const raw = readFileSync(path.join(dir, 'backups', record.fileName));
    const backup = JSON.parse(gunzipSync(raw).toString('utf8'));
    assert.equal(backup.app, 'kalpa-taru');
    assert.equal(backup.version, 1);
    assert.ok(backup.tables.users.some(user => user.email === 'badmin@example.test'));
    assert.ok(backup.tables.content.some(item => item.title === 'Backed up talk'));
    assert.ok(backup.tables.drives.length === 1 && backup.tables.drives.every(drive => drive.refresh_token === null));
    for (const excluded of ['sessions', 'oauth_states', 'uploads', 'thumbnails', 'backups']) assert.equal(backup.tables[excluded], undefined, excluded);
    assert.ok(!raw.toString('latin1').includes('secret-refresh-token') && !gunzipSync(raw).toString('utf8').includes('secret-refresh-token'));

    const listed = await (await admin('/api/backups')).json();
    assert.equal(listed.last.fileName, record.fileName);
    assert.equal(listed.last.ok, true);
    const audited = await (await admin('/api/audit')).json();
    assert.ok(JSON.stringify(audited).includes('Backed up database'));

    assert.equal((await fetch(`${url}/api/cron/backup`)).status, 401);
    assert.equal((await fetch(`${url}/api/cron/backup`, { headers: { Authorization: 'Bearer wrong-secret' } })).status, 401);
    const cron = await fetch(`${url}/api/cron/backup`, { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(cron.status, 200);
    assert.deepEqual(await cron.json(), { ok: true });
    assert.equal((await fetch(`${base}/api/cron/backup`, { headers: { Authorization: 'Bearer ' } })).status, 401, 'no secret configured means no cron access');
  } finally {
    backupServer.closeAllConnections();
    await new Promise(resolve => backupServer.close(resolve));
    backupDb.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('tags are validated, editable, and drive library filters, paging and search', async () => {
  const admin = await signIn('site_admin');
  const user = await signIn('user');
  assert.equal((await admin('/api/content', { method: 'POST', body: { title: 'Bad verse', url: 'https://example.org/tag-bad', verses: '19.1' } })).status, 400);
  assert.equal((await admin('/api/content', { method: 'POST', body: { title: 'Bad language', url: 'https://example.org/tag-bad2', language: 'Klingon' } })).status, 400);
  const tagged = await admin('/api/content', { method: 'POST', body: {
    title: 'Zeta tagging talk', url: 'https://example.org/tag-1', language: 'Odia', speaker: 'HG Tag Prabhu', verses: 'BG 2.13, 3:19-20', topics: 'Karma, Soul,karma' } });
  assert.equal(tagged.status, 201);
  const row = (await user(`/api/content/${tagged.json.id}`)).json.item;
  assert.equal(row.verses, '2.13,3.19,3.20');
  assert.equal(row.topics, 'Karma,Soul');
  assert.equal(row.fingerprint, undefined);
  for (const query of ['language=Odia', 'speaker=hg%20tag%20prabhu', 'topic=soul', 'chapter=3', 'q=2:13', 'q=zeta%20tag']) {
    assert.ok((await user(`/api/content?scope=library&${query}`)).json.items.some(item => item.id === tagged.json.id), query);
  }
  assert.ok(!(await user('/api/content?scope=library&chapter=4')).json.items.some(item => item.id === tagged.json.id));
  assert.ok(!(await user('/api/content?scope=library&q=zeta%20nothing')).json.items.some(item => item.id === tagged.json.id), 'all words must match');
  assert.equal((await user('/api/content?scope=library&q=100%25')).status, 200);

  const facets = (await user('/api/content/facets')).json;
  assert.ok(facets.languages.some(entry => entry.name === 'Odia'));
  assert.ok(facets.topics.some(entry => entry.name === 'Karma'));
  assert.ok(facets.chapters.some(entry => entry.name === '2'));

  const page = (await user('/api/content?scope=library&limit=2&offset=0&sort=title')).json;
  assert.equal(page.items.length, 2);
  assert.ok(page.total >= 3 && page.hasMore);
  assert.ok(page.counts.link >= 1);
  const next = (await user('/api/content?scope=library&limit=2&offset=2&sort=title')).json;
  assert.ok(!next.items.some(item => page.items.some(other => other.id === item.id)), 'pages do not overlap');

  assert.equal((await user(`/api/content/${tagged.json.id}`, { method: 'PATCH', body: { language: 'Hindi' } })).status, 403);
  const edited = await admin(`/api/content/${tagged.json.id}`, { method: 'PATCH', body: { language: 'Hindi', topics: '' } });
  assert.equal(edited.json.language, 'Hindi');
  assert.equal(edited.json.topics, null);
  assert.equal(edited.json.speaker, 'HG Tag Prabhu', 'fields that are not sent are kept');
});

test('document text is searchable with a snippet and only the uploader or an admin can set it', async () => {
  const user = await signIn('user');
  const viewer = await signIn('viewer@example.test');
  const admin = await signIn('site_admin');
  const body = Buffer.from('plain notes');
  const started = await user('/api/uploads', { method: 'POST', body: { title: 'Text notes', name: 'notes.txt', mime: 'text/plain', size: body.length } });
  const done = await user(`/api/uploads/${started.json.id}?offset=0`, { method: 'PUT', raw: body });
  const id = done.json.id;
  const long = `${'intro '.repeat(5000)}the eternal soul is never born and never dies`;
  assert.equal((await user(`/api/content/${id}/text`, { method: 'PUT', body: { text: long } })).status, 200, 'large text bodies are accepted');
  await admin(`/api/content/${id}/review`, { method: 'POST', body: { decision: 'approved' } });
  assert.equal((await viewer(`/api/content/${id}/text`, { method: 'PUT', body: { text: 'spam' } })).status, 403);
  assert.ok(!(await viewer('/api/content?scope=library&q=never%20dies&limit=10')).json.items.some(item => item.id === id),
    'the default search only looks at titles and descriptions');
  const found = (await viewer('/api/content?scope=library&q=never%20dies&in=all&limit=10')).json.items.find(item => item.id === id);
  assert.ok(found, 'text inside documents is searched when asked');
  assert.match(found.snippet, /never born/);
  assert.equal(found.has_text, 1);
  const link = (await admin('/api/content', { method: 'POST', body: { title: 'Not a doc', url: 'https://example.org/text-link' } })).json;
  assert.equal((await admin(`/api/content/${link.id}/text`, { method: 'PUT', body: { text: 'x' } })).status, 400);
  assert.equal((await admin(`/api/content/${id}`, { method: 'DELETE', body: REASON })).status, 200, 'content with text can be removed');
});

test('members are notified about reviews, removals and role changes, and can mark them read', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  const orgAdmin = await signIn('org_admin');
  await user('/api/notifications/read', { method: 'POST', body: {} });
  const a = (await user('/api/content', { method: 'POST', body: { title: 'Notify approve', url: 'https://example.org/n-1' } })).json;
  const b = (await user('/api/content', { method: 'POST', body: { title: 'Notify reject', url: 'https://example.org/n-2' } })).json;
  assert.ok((await orgAdmin('/api/notifications')).json.pendingReview >= 2, 'reviewers see the pending count');
  assert.equal((await user('/api/notifications')).json.pendingReview, 0);
  await orgAdmin(`/api/content/${a.id}/review`, { method: 'POST', body: { decision: 'approved' } });
  await orgAdmin(`/api/content/${b.id}/review`, { method: 'POST', body: { decision: 'rejected', note: 'Audio too quiet' } });
  await admin(`/api/content/${a.id}`, { method: 'DELETE', body: { reason: 'Duplicate of another talk' } });
  let inbox = (await user('/api/notifications')).json;
  assert.equal(inbox.unread, 3);
  assert.deepEqual(inbox.items.slice(0, 3).map(item => item.kind), ['removed', 'rejected', 'approved']);
  assert.equal(inbox.items[1].body, 'Audio too quiet');
  await user('/api/notifications/read', { method: 'POST', body: { ids: [inbox.items[0].id] } });
  assert.equal((await user('/api/notifications')).json.unread, 2);
  await user('/api/notifications/read', { method: 'POST', body: {} });
  inbox = (await user('/api/notifications')).json;
  assert.equal(inbox.unread, 0);
  assert.ok(!(await admin('/api/notifications')).json.items.some(item => item.title.includes('Notify')), 'notifications are private');
});

test('content requests can be voted on, fulfilled by an approved upload, and closed', async () => {
  const user = await signIn('user');
  const viewer = await signIn('viewer@example.test');
  const admin = await signIn('site_admin');
  assert.equal((await user('/api/requests', { method: 'POST', body: { title: 'Hi' } })).status, 400);
  const request = (await user('/api/requests', { method: 'POST', body: { title: 'Lecture on BG 2.47', language: 'Odia' } })).json;
  const vote = await viewer(`/api/requests/${request.id}/vote`, { method: 'POST' });
  assert.deepEqual(vote.json, { voted: true, votes: 2 });
  assert.equal((await viewer(`/api/requests/${request.id}/close`, { method: 'POST' })).status, 403);
  const open = (await viewer('/api/requests')).json.items.find(item => item.id === request.id);
  assert.equal(open.voted, true);
  assert.equal(open.requester, 'Test Member');

  const answer = (await viewer('/api/content', { method: 'POST', body: { title: 'BG 2.47 class', url: 'https://example.org/req-1', requestId: request.id } })).json;
  assert.equal((await viewer('/api/requests')).json.items.find(item => item.id === request.id).status, 'open', 'pending content does not fulfil a request');
  await admin(`/api/content/${answer.id}/review`, { method: 'POST', body: { decision: 'approved' } });
  const fulfilled = (await user('/api/requests?status=fulfilled')).json.items.find(item => item.id === request.id);
  assert.equal(fulfilled.content_title, 'BG 2.47 class');
  assert.ok((await user('/api/notifications')).json.items.some(item => item.kind === 'request' && item.content_id === answer.id));
  assert.equal((await viewer('/api/content', { method: 'POST', body: { title: 'Late', url: 'https://example.org/req-2', requestId: request.id } })).status, 409);

  const other = (await viewer('/api/requests', { method: 'POST', body: { title: 'Kirtan recordings please' } })).json;
  assert.equal((await admin(`/api/requests/${other.id}/close`, { method: 'POST' })).status, 200);
  assert.ok((await viewer('/api/requests?status=closed')).json.items.some(item => item.id === other.id));
});

test('duplicate checks find matching files and links the member can see', async () => {
  const user = await signIn('user');
  const viewer = await signIn('viewer@example.test');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const fingerprint = `${png.length}:${'ab'.repeat(32)}`;
  const started = await user('/api/uploads', { method: 'POST', body: { title: 'Dupe logo', name: 'dupe.png', mime: 'image/png', size: png.length, fingerprint } });
  const done = (await user(`/api/uploads/${started.json.id}?offset=0`, { method: 'PUT', raw: png })).json;
  await user('/api/content', { method: 'POST', body: { title: 'Dupe link', url: 'https://example.org/dupe' } });
  const own = (await user('/api/uploads/check', { method: 'POST', body: { fingerprints: [fingerprint, 'junk'], urls: ['https://example.org/dupe'] } })).json;
  assert.equal(own.matches.length, 2);
  assert.equal(own.matches[0].id, done.id);
  assert.equal((await viewer('/api/uploads/check', { method: 'POST', body: { fingerprints: [fingerprint] } })).json.matches.length, 0, 'pending uploads of others are not revealed');
});

test('the review queue flags submissions that duplicate existing content', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  const original = (await user('/api/content', { method: 'POST', body: { title: 'Original talk', url: 'https://example.org/same-talk' } })).json;
  await admin(`/api/content/${original.id}/review`, { method: 'POST', body: { decision: 'approved' } });
  const copy = (await user('/api/content', { method: 'POST', body: { title: 'Same talk again', url: 'https://example.org/same-talk' } })).json;
  const fresh = (await user('/api/content', { method: 'POST', body: { title: 'Brand new talk', url: 'https://example.org/new-talk' } })).json;
  const queue = (await admin('/api/content?scope=review')).json.items;
  assert.deepEqual(queue.find(item => item.id === copy.id).duplicateOf, { id: original.id, title: 'Original talk', status: 'approved' });
  assert.equal(queue.find(item => item.id === fresh.id).duplicateOf, undefined);
  for (const id of [original.id, copy.id, fresh.id]) await admin(`/api/content/${id}`, { method: 'DELETE', body: REASON });
});

test('only site admins see the list of duplicate uploads', async () => {
  const user = await signIn('user');
  const org = await signIn('org_admin');
  const admin = await signIn('site_admin');
  const first = (await user('/api/content', { method: 'POST', body: { title: 'Dup A', url: 'https://example.org/dup-list' } })).json;
  const second = (await user('/api/content', { method: 'POST', body: { title: 'Dup B', url: 'https://example.org/dup-list' } })).json;
  const single = (await user('/api/content', { method: 'POST', body: { title: 'Only one', url: 'https://example.org/dup-single' } })).json;
  assert.equal((await user('/api/duplicates')).status, 403);
  assert.equal((await org('/api/duplicates')).status, 403);
  const { groups } = (await admin('/api/duplicates')).json;
  const group = groups.find(entry => entry.items.some(item => item.id === first.id));
  assert.deepEqual(group.items.map(item => item.id), [first.id, second.id]);
  assert.equal(group.isLink, true);
  assert.equal(group.items[0].fingerprint, undefined);
  assert.ok(!groups.some(entry => entry.items.some(item => item.id === single.id)));
  for (const id of [first.id, second.id, single.id]) await admin(`/api/content/${id}`, { method: 'DELETE', body: REASON });
});

test('admins can merge separate uploads into one card, moving their parts and bookmarks', async () => {
  const user = await signIn('user');
  const viewer = await signIn('viewer@example.test');
  const org = await signIn('org_admin');
  const admin = await signIn('site_admin');
  const make = async (title, extra = {}) => (await admin('/api/content', { method: 'POST', body: { title, url: `https://example.org/${encodeURIComponent(title)}`, ...extra } })).json;
  const main = await make('Merge main');
  const other = await make('Merge other');
  const otherPart = await make('Merge other part', { parentId: other.id });
  const mine = (await user('/api/content', { method: 'POST', body: { title: 'Merge member', url: 'https://example.org/merge-member' } })).json;
  await viewer(`/api/content/${other.id}/bookmark`, { method: 'POST' });

  assert.equal((await user(`/api/content/${main.id}/merge`, { method: 'POST', body: { ids: [other.id] } })).status, 403);
  assert.equal((await admin(`/api/content/${main.id}/merge`, { method: 'POST', body: { ids: [main.id] } })).status, 400);
  assert.equal((await admin(`/api/content/${otherPart.id}/merge`, { method: 'POST', body: { ids: [main.id] } })).status, 400);
  assert.equal((await admin(`/api/content/${main.id}/merge`, { method: 'POST', body: { ids: [otherPart.id] } })).status, 409);

  const merged = await org(`/api/content/${main.id}/merge`, { method: 'POST', body: { ids: [other.id, mine.id] } });
  assert.equal(merged.status, 200);
  assert.equal(merged.json.merged, 2);
  const parts = (await admin(`/api/content/${main.id}/parts`)).json.items.map(item => item.id).sort();
  assert.deepEqual(parts, [other.id, otherPart.id, mine.id].sort());
  const library = (await viewer('/api/content?scope=library')).json.items;
  assert.ok(library.some(item => item.id === main.id));
  assert.ok(!library.some(item => item.id === other.id), 'merged cards leave the library list');
  const saved = (await viewer('/api/content?scope=saved')).json.items.map(item => item.id);
  assert.ok(saved.includes(main.id) && !saved.includes(other.id), 'bookmarks move to the main card');
  assert.ok((await user('/api/notifications')).json.items.some(item => item.kind === 'merged' && item.content_id === main.id));
  assert.equal((await admin(`/api/content/${main.id}`, { method: 'DELETE', body: REASON })).status, 200);
  assert.equal((await admin(`/api/content/${mine.id}`)).status, 404, 'removing the card removes merged parts');
});

test('site admins can remove several duplicates at once with one reason', async () => {
  const user = await signIn('user');
  const org = await signIn('org_admin');
  const admin = await signIn('site_admin');
  const make = async (who, title) => (await who('/api/content', { method: 'POST', body: { title, url: 'https://example.org/bulk-dup' } })).json;
  const first = await make(admin, 'Bulk dup first');
  const second = await make(user, 'Bulk dup second');
  const third = await make(admin, 'Bulk dup third');
  const ids = [second.id, third.id];
  assert.equal((await org('/api/content/bulk-remove', { method: 'POST', body: { ids, ...REASON } })).status, 403);
  assert.equal((await admin('/api/content/bulk-remove', { method: 'POST', body: { ids } })).status, 400, 'a reason is required');
  assert.equal((await admin('/api/content/bulk-remove', { method: 'POST', body: { ids: [], ...REASON } })).status, 400);
  const done = await admin('/api/content/bulk-remove', { method: 'POST', body: { ids: [...ids, 'missing-id'], ...REASON } });
  assert.equal(done.status, 200);
  assert.deepEqual(done.json, { removed: 2, failed: [] });
  assert.equal((await admin(`/api/content/${second.id}`)).status, 404);
  assert.equal((await admin(`/api/content/${first.id}`)).status, 200, 'unselected copies stay');
  assert.ok((await user('/api/notifications')).json.items.some(item => item.kind === 'removed' && item.title.includes('Bulk dup second')));
  await admin(`/api/content/${first.id}`, { method: 'DELETE', body: REASON });
});

test('members can change their display name, which updates their cards', async () => {
  const viewer = await signIn('viewer@example.test');
  const item = (await viewer('/api/content', { method: 'POST', body: { title: 'Rename check', url: 'https://example.org/rename' } })).json;
  assert.equal((await viewer('/api/auth/me', { method: 'PATCH', body: { name: 'x' } })).status, 400);
  const changed = await viewer('/api/auth/me', { method: 'PATCH', body: { name: '  Bhakta   Viewer ' } });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.user.name, 'Bhakta Viewer');
  assert.equal((await viewer(`/api/content/${item.id}`)).json.item.uploader, 'Bhakta Viewer');
  assert.equal((await fetch(`${base}/api/auth/me`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{"name":"Anon"}' })).status, 401);
  await viewer('/api/auth/me', { method: 'PATCH', body: { name: 'Test Viewer' } });
});

test('guests can view and download shared public uploads and their files, but nothing else', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const upload = async (who, title, parentId) => {
    const started = await who('/api/uploads', { method: 'POST', body: { title, name: 'guest.png', mime: 'image/png', size: png.length, parentId } });
    return (await who(`/api/uploads/${started.json.id}?offset=0`, { method: 'PUT', raw: png })).json.id;
  };
  const main = await upload(admin, 'Guest main');
  const part = await upload(admin, 'Guest part', main);
  const pendingPart = await upload(user, 'Guest pending part', main);
  const pending = await upload(user, 'Guest pending');

  const view = await fetch(`${base}/api/public/content/${main}`);
  assert.equal(view.status, 200);
  const data = await view.json();
  assert.equal(data.item.title, 'Guest main');
  assert.equal(data.item.uploader, 'Test Admin');
  assert.equal(data.item.uploader_id, undefined, 'guests see no account details');
  assert.equal(data.item.storage_key, undefined);
  assert.deepEqual(data.parts.map(row => row.id), [part], 'only approved parts are listed');

  const inline = await fetch(`${base}/api/content/${main}/file?inline=1`);
  assert.equal(inline.status, 200);
  assert.match(inline.headers.get('content-disposition'), /^inline/);
  assert.deepEqual(Buffer.from(await inline.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/api/content/${part}/file?inline=1`)).status, 200);
  const download = await fetch(`${base}/api/content/${main}/file`);
  assert.equal(download.status, 200, 'guests can download shared files');
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  for (const id of [pending, pendingPart]) assert.equal((await fetch(`${base}/api/content/${id}/file`)).status, 404, 'unshared files cannot be downloaded');
  for (const id of [pending, pendingPart]) {
    assert.equal((await fetch(`${base}/api/public/content/${id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/content/${id}/file?inline=1`)).status, 404);
  }
  assert.equal((await fetch(`${base}/api/public/content/${part}`)).status, 404, 'parts are viewed through their card');
  assert.equal((await fetch(`${base}/api/content/${main}`)).status, 401, 'other routes still need sign-in');
  await admin(`/api/content/${main}/visibility`, { method: 'PATCH', body: { visibility: 'private' } });
  assert.equal((await fetch(`${base}/api/public/content/${main}`)).status, 404, 'private uploads are hidden');
  assert.equal((await fetch(`${base}/api/content/${part}/file?inline=1`)).status, 404, 'parts of private uploads are hidden');
  const signedIn = await admin(`/api/content/${main}/thumbnail`);
  assert.equal(signedIn.status, 404, 'signed-in requests use the normal routes');
  for (const id of [main, pending]) await admin(`/api/content/${id}`, { method: 'DELETE', body: REASON });
});

test('admins get analytics in the overview; members do not', async () => {
  const user = await signIn('user');
  const admin = await signIn('site_admin');
  assert.equal((await user('/api/overview')).json.analytics, undefined);
  const { analytics } = (await admin('/api/overview')).json;
  assert.equal(analytics.weekly.length, 12);
  assert.ok(analytics.weekly.at(-1).uploads > 0);
  assert.ok(Array.isArray(analytics.topViewed) && Array.isArray(analytics.topContributors));
  assert.ok(analytics.languages.length > 0);
  assert.equal(typeof analytics.openRequests, 'number');
});