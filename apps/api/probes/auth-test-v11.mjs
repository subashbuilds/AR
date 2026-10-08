import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../src/server.js';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, '..', 'data', 'probe-auth-v11-' + randomUUID());
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
console.log('TEST_HOST=' + host);
console.log('TEST_PORT=' + port);

const probeDirect = await fetch(`http://${host}:${port}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'probe+v11@example.test',
    password: 'password-for-probe-v11',
    name: 'Probe V11',
  }),
});
console.log('PROBE_DIRECT_STATUS=' + probeDirect.status);

const health = await fetch(`http://${host}:${port}/api/health`);
console.log('HEALTH_STATUS=' + health.status);
console.log('HEALTH=' + JSON.stringify(await health.json()).slice(0, 220));

await new Promise((r) => setTimeout(r, 25));
console.log('AWAITED_25MS');

const makeImage = (n) =>
  `data:image/png;base64,${Buffer.from(`${n}`.repeat(32), 'utf8').toString('base64url')}`;

const accounts = new Map();

async function accountA() {
  if (accounts.has('a')) return accounts.get('a');
  const res = await fetch(`http://${host}:${port}/api/auth/signup`, {
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

test('first subtest does not touch the server', async () => {
  assert.equal(1 + 1, 2, 'trivial assertion');
});

test('second subtest hits the real server with explicit host:port', async () => {
  const a = await accountA();
  console.log('ACCOUNT_ID=' + a.id);
  assert.ok(a.id, 'has an id');
});

await new Promise((resolve) => server.close(resolve));
console.log('DONE');
fs.rmSync(tmpRoot, { recursive: true, force: true });
