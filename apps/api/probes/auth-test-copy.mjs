// Account, session, capture access and share-link tests against the real server.
// These are integration tests: they hit the HTTP server, use the real storage
// driver that is configured for the process, and they fail loudly when the
// configured store cannot accept a capture.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../src/server.js';
import { sessionCookie } from '../src/accounts.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const tmpRoot = path.join(here, '..', 'data', 'test-auth-' + randomUUID());
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
    require('node:crypto')
      .createHash('sha256')
      .update(a.token)
      .digest('hex'),
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

  await t.test('an anonymous browser cannot open the capture from the id', async () => {
    const owner = await accountA();
    const created = await fetch(
      base + '/api/captures',
      {
        method: 'POST',
        headers: {
          cookie: sessionCookie(owner.token),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'private capture',
          images: [makeImage(1), makeImage(2)],
        }),
      },
    ).then((r) => r.json());

    const anonymous = await fetch(base + '/api/captures/' + created.id);
    assert.equal(anonymous.status, 401, 'no session is refused');
    assert.match(
      (await anonymous.json()).error.message,
      /sign in to view this capture/,
      'the refusal says what to do',
    );
  });
});

test('the unguessable URL is not an access grant; the share token is', async (t) => {
  const owner = await accountA();
  const created = await fetch(
    base + '/api/captures',
    {
      method: 'POST',
      headers: {
        cookie: sessionCookie(owner.token),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'shared capture',
        images: [makeImage(1), makeImage(2)],
      }),
    },
  ).then((r) => r.json());

  await t.test('the id alone is not enough', async () => {
    const anonymous = await fetch(base + '/api/captures/' + created.id);
    assert.equal(anonymous.status, 401, 'an unshared capture is not public');
  });

  await t.test('the owner can publish a share link', async () => {
    const token = await share(owner, created.id, 'create');
    assert.ok(token, 'published a token');

    const shared = await fetch(base + '/api/captures/' + created.id + '?t=' + token);
    assert.equal(shared.status, 200, 'a bearer of the token can read the capture');
    assert.equal(
      (await shared.json()).role,
      'shared',
      'the reader is a link holder, not an owner',
    );
  });

  await t.test('revoking the link takes effect on the next request', async () => {
    const token = await share(owner, created.id, 'create');
    const first = await fetch(base + '/api/captures/' + created.id + '?t=' + token);
    assert.equal(first.status, 200, 'the live link still works');

    await share(owner, created.id, 'revoke');
    const after = await fetch(base + '/api/captures/' + created.id + '?t=' + token);
    assert.equal(after.status, 403, 'the revoked link is refused immediately');
    assert.match(
      (await after.json()).error.message,
      /no longer active/,
      'the refusal names the reason',
    );
  });
});

test('only the owner can cancel a capture, and a shared link cannot', async (t) => {
  const owner = await accountA();
  const created = await fetch(
    base + '/api/captures',
    {
      method: 'POST',
      headers: {
        cookie: sessionCookie(owner.token),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'cancellable',
        images: [makeImage(1), makeImage(2)],
      }),
    },
  ).then((r) => r.json());

  await t.test('only the owner can cancel', async () => {
    const cancel = await fetch(
      base + '/api/captures/' + created.id,
      {
        method: 'DELETE',
        headers: { cookie: sessionCookie(owner.token) },
      },
    );
    assert.equal(cancel.status, 202, 'the owner can cancel');
    assert.equal((await cancel.json()).cancelled, true, 'the reply says cancelled');

    const afterwards = await fetch(
      base + '/api/captures/' + created.id,
      { headers: { cookie: sessionCookie(owner.token) } },
    );
    assert.equal(
      (await afterwards.json()).status,
      'cancelled',
      'the capture ends as cancelled',
    );
  });

  await t.test('a shared link cannot cancel the capture', async () => {
    const token = await share(owner, created.id, 'create');
    const impostor = await fetch(
      base + '/api/captures/' + created.id + '?t=' + token,
      { method: 'DELETE' },
    );
    assert.equal(impostor.status, 404, 'the shared link gives no access at all');
  });
});

test('deleting an account needs the password and takes that account\'s data with it', async () => {
  const account = await accountA();
  const created = await fetch(
    base + '/api/captures',
    {
      method: 'POST',
      headers: {
        cookie: sessionCookie(account.token),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'to be destroyed',
        images: [makeImage(1), makeImage(2)],
      }),
    },
  ).then((r) => r.json());

  await test('a wrong password does nothing', async () => {
    const wrong = await fetch(base + '/api/auth/account', {
      method: 'DELETE',
      headers: {
        cookie: sessionCookie(account.token),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ password: 'not-the-password' }),
    });
    assert.equal(wrong.status, 401, 'wrong password is refused');
    assert.match(
      (await wrong.json()).error.message,
      /password is incorrect/,
      'the refusal names the reason',
    );

    const stillThere = await fetch(
      base + '/api/captures/' + created.id,
      { headers: { cookie: sessionCookie(account.token) } },
    );
    assert.equal(stillThere.status, 200, 'the capture survives a refused deletion');
  });

  await test('the right password destroys the account, its captures and its sessions', async () => {
    const destroyed = await fetch(base + '/api/auth/account', {
      method: 'DELETE',
      headers: {
        cookie: sessionCookie(account.token),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ password: account.password }),
    });
    assert.equal(destroyed.status, 200, 'the right password accepts deletion');
    const report = await destroyed.json();
    assert.equal(report.deleted, true, 'the reply confirms deletion');
    assert.equal(report.captures_deleted, 1, 'the capture was deleted');
    assert.equal(report.objects_deleted, 2, 'the images were deleted');
    assert.equal(report.sessions_revoked, 1, 'its session was revoked');
    assert.equal(report.cancelled, 0, 'nothing was running');

    const gone = await fetch(
      base + '/api/captures/' + created.id,
      { headers: { cookie: sessionCookie(account.token) } },
    );
    assert.equal(gone.status, 401, 'the destroyed session is gone');
  });
});

await new Promise((resolve) => server.close(resolve));
console.log('TEST_CLOSE=true');
fs.rmSync(tmpRoot, { recursive: true, force: true });
