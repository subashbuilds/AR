import { test } from 'node:test';
import { createServer } from '../src/server.js';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = join(here, 'data', 'probe-node-test-http-v3-' + randomUUID().slice(2));
fs.mkdirSync(tmpRoot, { recursive: true });

const server = createServer({ dataDir: tmpRoot });
await new Promise((r) => server.listen({ port: 0, host: '127.0.0.1' }, r));
const { address, port } = server.address();
const base = `http://${address}:${port}`;
console.log('TEST_BASE=' + base);

const subtests = [
  test('health via node:http', async () => {
    const health = await new Promise((resolve, reject) => {
      const req = request(base + '/api/health', { method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
    console.log('HEALTH_STATUS=' + health.status);
    if (health.status !== 200) throw new Error('health returned ' + health.status);
  }),

  test('signup via node:http', async () => {
    const body = JSON.stringify({
      email: 'probe+node-test@example.test',
      password: 'password-for-probe-node-test',
      name: 'Probe Node Test',
    });
    const signup = await new Promise((resolve, reject) => {
      const req = request(base + '/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, (res) => {
        let payload = '';
        res.on('data', (c) => (payload += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: payload && JSON.parse(payload) }),
        );
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    console.log('SIGNUP_STATUS=' + signup.status);
    if (signup.status !== 201) throw new Error('signup returned ' + signup.status);
  }),
];

for (const t of subtests) await t;

await new Promise((r) => server.close(r));
console.log('DONE');
fs.rmSync(tmpRoot, { recursive: true, force: true });
