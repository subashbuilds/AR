import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../src/server.js';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const server = createServer({ dataDir: join(here, 'data', 'probe-reused-account-' + Date.now()) });
await new Promise((r) => server.listen({ port: 0, host: '127.0.0.1' }, r));
const { address, port } = server.address();
const base = `http://${address}:${port}`;
console.log('TEST_BASE=' + base);

function requestJson(method, url, payload = null) {
  const body = payload ? JSON.stringify(payload) : null;
  return new Promise((resolve, reject) => {
    const req = request(base + url, { method, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null, text: data });
        } catch (err) {
          reject(new Error('bad json: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function makeEmail(suffix) {
  return `probe+reused-${suffix}@example.test`;
}

const t1 = test('first subtest creates an account', async () => {
  const res = await requestJson('POST', '/api/auth/signup', {
    email: makeEmail('first'),
    password: 'password-for-probe-reused',
    name: 'Probe Reused',
  });
  console.log('T1_STATUS=' + res.status);
  if (res.status !== 201) throw new Error('signup failed: ' + res.status + ' ' + res.text);
  assert.equal(res.status, 201);
});

await t1;

const t2 = test('second subtest creates a different account with a different email', async () => {
  const res = await requestJson('POST', '/api/auth/signup', {
    email: makeEmail('second'),
    password: 'password-for-probe-reused',
    name: 'Probe Reused',
  });
  console.log('T2_STATUS=' + res.status, 'body=' + res.text.slice(0, 120));
  if (res.status !== 201) throw new Error('signup failed: ' + res.status + ' ' + res.text);
  assert.equal(res.status, 201);
});

await t2;
await new Promise((r) => server.close(r));
console.log('DONE');
fs.rmSync(server.dataDir, { recursive: true, force: true });
