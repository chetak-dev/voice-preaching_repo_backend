import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';
import { DEMO_PASSWORD } from './db.js';

const ORIGIN = 'http://localhost:5173';
let server;
let app;
let base;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'voice-test-'));
  app = createApp({ demo: true, production: false, dataDir, origin: ORIGIN, googleClientId: '', googleClientSecret: '', siteAdmins: ['owner@example.test'] });
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  app.locals.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const ACCOUNTS = { site_admin: 'admin@example.test', org_admin: 'orgadmin@example.test', user: 'member@example.test' };

function post(url, body, origin = ORIGIN) {
  return fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
}

async function signIn(role, password = DEMO_PASSWORD) {
  const res = await post('/api/auth/login', { email: ACCOUNTS[role] || role, password });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (url, { method = 'GET', body, form } = {}) => {
    const headers = { Cookie: cookie, Origin: ORIGIN };
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${url}`, { method, headers, body: form || (body && JSON.stringify(body)) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
}

test('unauthenticated requests are rejected', async () => {
  const res = await fetch(`${base}/api/content`);
  assert.equal(res.status, 401);
});

test('state-changing requests from other origins are rejected', async () => {
  const res = await post('/api/auth/login', { email: ACCOUNTS.user, password: DEMO_PASSWORD }, 'https://evil.example');
  assert.equal(res.status, 403);
});

test('submissions from any role require admin approval', async () => {
  const user = await signIn('user');
  const orgAdmin = await signIn('org_admin');
  const admin = await signIn('site_admin');

  const created = await user('/api/content', { method: 'POST', body: { title: 'Weekly class notes', url: 'https://example.org/notes' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, 'pending');

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
  assert.equal(orgAdminPost.json.status, 'pending');
  const adminPost = await admin('/api/content', { method: 'POST', body: { title: 'Admin link', url: 'https://example.org/b' } });
  assert.equal(adminPost.json.status, 'pending');
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
  assert.equal((await user(`/api/content/${json.id}`, { method: 'DELETE' })).status, 200);
});

test('uploads are verified and stored pending approval', async () => {
  const user = await signIn('user');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const form = new FormData();
  form.append('title', 'Logo');
  form.append('file', new Blob([png], { type: 'image/png' }), 'logo.png');
  const ok = await user('/api/content', { method: 'POST', form });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.status, 'pending');

  const fake = new FormData();
  fake.append('title', 'Not really a PNG');
  fake.append('file', new Blob(['hello'], { type: 'image/png' }), 'fake.png');
  assert.equal((await user('/api/content', { method: 'POST', form: fake })).status, 400);
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
  assert.equal((await orgAdmin('/api/users/demo-user', { method: 'PATCH', body: { role: 'org_admin' } })).status, 403);
  assert.equal((await admin('/api/users/demo-user', { method: 'PATCH', body: { role: 'site_admin' } })).status, 400);
  assert.equal((await admin('/api/users/demo-user', { method: 'PATCH', body: { role: 'org_admin' } })).status, 200);
  const users = await admin('/api/users');
  assert.equal(users.status, 200);
  assert.equal(users.json.users.find(entry => entry.id === 'demo-user').role, 'org_admin');
  assert.ok(users.json.users.every(entry => !('password_hash' in entry)));
  assert.equal((await admin('/api/users/demo-admin', { method: 'PATCH', body: { role: 'user' } })).status, 403);
  assert.equal((await admin('/api/users/demo-user', { method: 'PATCH', body: { role: 'user' } })).status, 200);
  assert.equal((await (await signIn('user'))('/api/users')).status, 403);
});

test('suspension rules and suspended accounts are blocked', async () => {
  const orgAdmin = await signIn('org_admin');
  const admin = await signIn('site_admin');
  const user = await signIn('user');
  assert.equal((await orgAdmin('/api/users/demo-admin/suspend', { method: 'POST', body: { suspended: true } })).status, 403);
  assert.equal((await admin('/api/users/demo-admin/suspend', { method: 'POST', body: { suspended: true } })).status, 400);
  assert.equal((await orgAdmin('/api/users/demo-user/suspend', { method: 'POST', body: { suspended: true } })).status, 403);
  assert.equal((await admin('/api/users/demo-user/suspend', { method: 'POST', body: { suspended: true } })).status, 200);
  assert.equal((await user('/api/auth/me')).status, 401, 'existing sessions end on suspension');
  assert.equal((await post('/api/auth/login', { email: ACCOUNTS.user, password: DEMO_PASSWORD })).status, 403);
  assert.equal((await admin('/api/users/demo-user/suspend', { method: 'POST', body: { suspended: false } })).status, 200);
  assert.equal((await (await signIn('user'))('/api/auth/me')).status, 200);
  assert.equal((await admin('/api/users/demo-org-admin/suspend', { method: 'POST', body: { suspended: true } })).status, 200);
  assert.equal((await orgAdmin('/api/auth/me')).status, 401);
  assert.equal((await admin('/api/users/demo-org-admin/suspend', { method: 'POST', body: { suspended: false } })).status, 200);
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
  assert.equal((await orgAdmin(`/api/content/${own.id}/review`, { method: 'POST', body: { decision: 'approved' } })).status, 403);
  assert.equal((await admin(`/api/content/${own.id}/review`, { method: 'POST', body: { decision: 'approved' } })).status, 200);

  assert.equal((await orgAdmin(`/api/content/${json.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await user(`/api/content/${json.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await orgAdmin('/api/users')).status, 403);
  assert.equal((await orgAdmin('/api/audit')).status, 403);
  assert.equal((await orgAdmin('/api/users/demo-user', { method: 'PATCH', body: { role: 'org_admin' } })).status, 403);
  assert.equal((await admin(`/api/content/${json.id}`, { method: 'DELETE' })).status, 200);
});

test('storage management is restricted to site admins', async () => {
  const orgAdmin = await signIn('org_admin');
  const admin = await signIn('site_admin');
  assert.equal((await orgAdmin('/api/storage', { method: 'POST', body: { name: 'X', folderId: 'abc', kind: 'oauth', types: ['image'] } })).status, 403);
  const storage = await admin('/api/storage');
  assert.equal(storage.status, 200);
  assert.ok(Array.isArray(storage.json.nodes));
  assert.equal((await admin('/api/audit')).status, 200);
});
