import { createServer } from '../src/server.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, '..', 'data', 'probe-auth-' + randomUUID());
fs.mkdirSync(tmpRoot, { recursive: true });

const server = createServer({ dataDir: tmpRoot });
const port = 8799;
await new Promise((resolve) =>
  server.listen({ port, host: '127.0.0.1' }, resolve),
);
console.log('BASE=http://127.0.0.1:' + port);

const res = await fetch('http://127.0.0.1:' + port + '/api/auth/signup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'probe+auth@example.test',
    password: 'password-for-probe-auth',
    name: 'Probe Auth',
  }),
});
console.log('SIGNUP_STATUS=' + res.status);
console.log('SIGNUP_BODY=' + JSON.stringify(await res.json()));

await new Promise((resolve) => server.close(resolve));
console.log('DONE');
