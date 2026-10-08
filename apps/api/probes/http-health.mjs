import { createServer } from '../src/server.js';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = join(here, 'data', 'probe-http-' + randomUUID().slice(2));
fs.mkdirSync(tmpRoot, { recursive: true });

const server = createServer({ dataDir: tmpRoot });
await new Promise((r) => server.listen({ port: 0, host: '127.0.0.1' }, r));
const { address, port } = server.address();
const base = `http://${address}:${port}`;
console.log('BASE=' + base);

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
console.log('HEALTH=' + health.body.slice(0, 220));

await new Promise((r) => server.close(r));
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('DONE');
