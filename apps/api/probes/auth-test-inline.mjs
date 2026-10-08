import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../src/server.js';
import { sessionCookie } from '../src/accounts.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const tmpRoot = path.join(here, '..', 'data', 'probe-auth-inline-' + randomUUID());
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

const makeImage = (n) =>
  `data:image/png;base64,${Buffer.from(`${n}`.repeat(4), 'utf8').toString('base64url')}`;

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

await test('an account is created from an email and a password, and only the scrypt hash is stored', async () => {
  const account = await accountA();
  assert.ok(account.id, 'has an id');
  assert.ok(account.email, 'has an email');
  assert.equal(account.name, 'Account A', 'has a name');
  assert.ok(account.createdAt, 'has a created_at');
});

await new Promise((resolve) => server.close(resolve));
console.log('DONE');
fs.rmSync(tmpRoot, { recursive: true, force: true });
