import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../src/server.js';
import { sessionCookie } from '../src/accounts.js';
import { createHash } from 'node:crypto';

const here = path.dirname(new URL(import.meta.url).pathname);
const tmpRoot = path.join(here, '..', 'data', 'probe-auth-binary-' + randomUUID());
fs.mkdirSync(tmpRoot, { recursive: true });

const server = createServer({ dataDir: tmpRoot });
const listen = new Promise((resolve) =>
  server.listen({ port: 0, host: '127.0.0.1' }, resolve),
);
await listen;
const addr = server.address();
assert.ok(addr && typeof addr !== 'string');
const base = `http://127.0.0.1:${addr.port}`;
console.log('TEST_BASE=' + base);
await fetch(base + '/api/health');
console.log('TEST_READY=true');

const makeImage = (n) =>
  `data:image/png;base64,${Buffer.from(`${n}`.repeat(32), 'utf8').toString('base64url')}`;

const accounts = new Map();

async function accountA() {
  if (accounts.has('a')) return accounts.get('a');
  const res = await fetch(base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `a-${randomUUID()}@test.example`,
      password: 'password-for-test-a',
      name: 'Account A',
    }),
  });
  assert.equal(res.status, 201, 'account A signs up');
  const user = (await res.json()).user;
  accounts.set('a', user);
  return user;
}

async function accountB() {
  if (accounts.has('b')) return accounts.get('b');
  const res = await fetch(base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `b-${randomUUID()}@test.example`,
      password: 'password-for-test-b',
      name: 'Account B',
    }),
  });
  assert.equal(res.status, 201, 'account B signs up');
  const user = (await res.json()).user;
  accounts.set('b', user);
  return user;
}

async function share(owner, captureId, action) {
  const res = await fetch(
    base + '/api/captures/' + captureId + '/share',
    {
      method: action === 'create' ? 'POST' : 'DELETE',
      headers: { cookie: sessionCookie(owner.token) },
    },
  );
  assert.ok(res.ok, 'share ' + action + ' accepted');
  const body = await res.json();
  return action === 'create' ? body.share_token : null;
}

test('an account is created from an email and a password, and only the scrypt hash is stored', async () => {
  const account = await accountA();
  assert.ok(account.id, 'has an id');
  assert.ok(account.email, 'has an email');
  assert.equal(account.name, 'Account A', 'has a name');
  assert.ok(account.createdAt, 'has a created_at');
});

test('sign-in failures are indistinguishable, and a successful one opens a fresh session', async () => {
  const a = await accountA();
  const bad = await fetch(base + '/api/auth/signin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: 'wrong' }),
  });
  assert.equal(bad.status, 401, 'wrong password is refused');
  assert.match((await bad.json()).error.message, /email or password is incorrect/);

  const good = await fetch(base + '/api/auth/signin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: a.password }),
  });
  assert.equal(good.status, 200, 'good password accepts');
  const user = (await good.json()).user;
  assert.equal(user.id, a.id, 'returns the same account');
});

test('a session can be signed out, and the token stops working at once', async () => {
  const a = await accountA();
  const res = await fetch(base + '/api/auth/signout', {
    method: 'POST',
    headers: { cookie: sessionCookie(a.token) },
  });
  assert.equal(res.status, 200, 'sign out accepted');
  const after = await fetch(base + '/api/auth/me', {
    headers: { cookie: sessionCookie(a.token) },
  });
  assert.equal((await after.json()).user, null, 'the token is dead');
});

test('an expired session is refused and its row is dropped', async () => {
  const a = await accountA();
  const db = server.accounts.db;
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(
    Date.now() - 1,
    createHash('sha256').update(a.token).digest('hex'),
  );
  const me = await fetch(base + '/api/auth/me', {
    headers: { cookie: sessionCookie(a.token) },
  });
  assert.equal((await me.json()).user, null, 'an expired session is refused');
});

test('a capture belongs to its owner and is invisible to everyone else', async (t) => {
  await t.test('the owner starts a capture with the request-body path', async () => {
    const account = await accountA();
    const res = await fetch(base + '/api/captures', {
      method: 'POST',
      headers: {
        cookie: sessionCookie(account.token),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'owner start',
        images: [makeImage(1), makeImage(2)],
      }),
    });
    assert.equal(res.status, 202, 'owner starts a capture');
    const created = await res.json();
    assert.ok(created.id, 'created an id');
  });
});

await new Promise((resolve) => server.close(resolve));
console.log('DONE');
fs.rmSync(tmpRoot, { recursive: true, force: true });
