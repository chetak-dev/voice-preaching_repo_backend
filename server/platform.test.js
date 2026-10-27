import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, googleProblem } from './app.js';
import { hashPassword } from './db.js';
import { APP_FOLDER, boundedRange, ensureAppFolder } from './storage.js';

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
