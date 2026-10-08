import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../src/server.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, '..', 'data', 'probe-no-server-' + randomUUID());
fs.mkdirSync(tmpRoot, { recursive: true });

const server = createServer({ dataDir: tmpRoot });
const port = 8801;
await new Promise((resolve) =>
  server.listen({ port, host: '127.0.0.1' }, resolve),
);
console.log('BASE=http://127.0.0.1:' + port);

const res = await fetch('http://127.0.0.1:' + port + '/api/auth/signup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'probe+no-server@example.test',
    password: 'password-for-probe-no-server',
    name: 'Probe No Server',
  }),
});
console.log('DIRECT_STATUS=' + res.status);
console.log('DIRECT_BODY=' + JSON.stringify(await res.json()));

await new Promise((resolve) => server.close(resolve));
console.log('DONE');
fs.rmSync(tmpRoot, { recursive: true, force: true });
