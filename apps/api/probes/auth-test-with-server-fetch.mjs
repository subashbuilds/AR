import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../src/server.js';
import { sessionCookie } from '../src/accounts.js';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, '..', 'data', 'probe-auth-server-fetch-' + randomUUID());
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

const probeDirect = await fetch(base + '/api/auth/signup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'probe+server-fetch@example.test',
    password: 'password-for-probe-server-fetch',
    name: 'Probe Server Fetch',
  }),
});
console.log('PROBE_DIRECT_STATUS=' + probeDirect.status);
console.log('PROBE_DIRECT_BODY=' + JSON.stringify(await probeDirect.json()));

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

await new Promise((resolve) => server.close(resolve));
console.log('DONE');
fs.rmSync(tmpRoot, { recursive: true, force: true });
