import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../src/server.js';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, '..', 'data', 'probe-auth-v13-' + randomUUID());
fs.mkdirSync(tmpRoot, { recursive: true });

const server = createServer({ dataDir: tmpRoot });
const listen = new Promise((resolve) =>
  server.listen({ port: 0, host: '127.0.0.1' }, resolve),
);
await listen;
const addr = server.address();
assert.ok(addr && typeof addr !== 'string');
const host = '127.0.0.1';
const port = addr.port;

const base = `http://${host}:${port}`;
console.log('BASE=' + base);

// One top-level fetch to the same server, before any test() is defined.
const topHealth = await fetch(base + '/api/health');
console.log('TOP_HEALTH=' + topHealth.status);

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

test('subtest one: health', async () => {
  const h = await fetch(base + '/api/health');
  assert.equal(h.status, 200, 'health still works inside subtest');
});

test('subtest two: signup inside node:test', async () => {
  const a = await accountA();
  assert.ok(a.id, 'accountA returned an id');
});

test('subtest three: second signup in same process', async () => {
  const b = await accountA();
  assert.ok(b.id, 'accountA reused or created an id inside subtest three');
});

await new Promise((resolve) => server.close(resolve));
console.log('DONE');
fs.rmSync(tmpRoot, { recursive: true, force: true });
