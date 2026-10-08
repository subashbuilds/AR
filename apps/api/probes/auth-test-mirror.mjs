import { createServer } from '../src/server.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sessionCookie } from '../src/accounts.js';
import { test } from 'node:test';
import assert from 'node:assert';

const here = path.dirname(new URL(import.meta.url).pathname);
const tmpRoot = path.join(here, '..', 'data', 'probe-auth-mirror-' + randomUUID());
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

async function accountA() {
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
  return (await res.json()).user;
}

await test('signup works in the mirrored harness', async () => {
  const a = await accountA();
  console.log('ACCOUNT_ID=' + a.id);
  assert.ok(a.id, 'has an id');
});

await new Promise((resolve) => server.close(resolve));
console.log('DONE');
fs.rmSync(tmpRoot, { recursive: true, force: true });
