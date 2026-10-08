import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../src/server.js';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = join(here, 'data', 'probe-sleep-subtest-' + randomUUID().slice(2));
fs.mkdirSync(tmpRoot, { recursive: true });

const server = createServer({ dataDir: tmpRoot });
await new Promise((r) => server.listen({ port: 0, host: '127.0.0.1' }, r));
const { address, port } = server.address();
const base = `http://${address}:${port}`;
console.log('TEST_BASE=' + base);

const t1 = test('first subtest sleeps for 200ms', async () => {
  console.log('T1_START');
  await new Promise((r) => setTimeout(r, 200));
  console.log('T1_END');
});

await t1;

const t2 = test('second subtest hits signup immediately after sleep', async () => {
  const res = await new Promise((resolve, reject) => {
    const req = request(base + '/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    const body = JSON.stringify({
      email: 'probe+sleep-subtest@example.test',
      password: 'password-for-probe-sleep-subtest',
      name: 'Probe Sleep Subtest',
    });
    req.write(body);
    req.end();
  });
  console.log('T2_STATUS=' + res.status, 'body=' + res.text.slice(0, 120));
  assert.equal(res.status, 201, 'signup responds after the sleep');
});

await t2;
await new Promise((r) => server.close(r));
console.log('DONE');
fs.rmSync(tmpRoot, { recursive: true, force: true });
