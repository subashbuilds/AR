import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../src/server.js';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = join(here, 'data', 'probe-two-subtests-v2-' + randomUUID().slice(2));
fs.mkdirSync(tmpRoot, { recursive: true });

const server = createServer({ dataDir: tmpRoot });
await new Promise((r) => server.listen({ port: 0, host: '127.0.0.1' }, r));
const { address, port } = server.address();
const base = `http://${address}:${port}`;
console.log('TEST_BASE=' + base);

const t1 = test('first subtest hits health', async () => {
  const health = await new Promise((resolve, reject) => {
    const req = request(base + '/api/health', { method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  console.log('T1_STATUS=' + health.status);
  assert.equal(health.status, 200, 'health endpoint responds inside first subtest');
});

await t1;

const t2 = test('second subtest hits signup', async () => {
  const email = 'probe+two-subtests-v2-' + randomUUID().slice(2) + '@example.test';
  const payload = JSON.stringify({
    email,
    password: 'password-for-probe-two-subtests-v2',
    name: 'Probe Two Subtests V2',
  });
  const signup = await new Promise((resolve, reject) => {
    let capturedBody = null;
    const req = request(base + '/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        capturedBody = data;
        resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
      });
    });
    req.on('error', reject);
    req.write(payload);
    console.log('T2_REQ_WRITTEN');
    req.end();
    console.log('T2_REQ_ENDED');
  });
  console.log('T2_STATUS=' + signup.status);
  assert.equal(signup.status, 201, 'signup responds inside second subtest');
});

await t2;
await new Promise((r) => server.close(r));
console.log('DONE');
fs.rmSync(tmpRoot, { recursive: true, force: true });
