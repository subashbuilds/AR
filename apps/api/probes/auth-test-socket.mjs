import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../src/server.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const s = createServer({ dataDir: here + '/_probe-socket-' + Date.now() });
await new Promise((r) => s.listen({ port: 0, host: '127.0.0.1' }, r));
const a = s.address();
const base = 'http://127.0.0.1:' + a.port;
console.log('BASE=' + base);
const closeAtEnd = new Promise((r) => s.close(r));

test('fetch inside subtest', async () => {
  console.log('ADDR=' + JSON.stringify(a));
  console.log('TYPE=' + typeof s.address);
  console.log('ADDR_TYPE=' + (typeof a));
  console.log('SOCK=' + JSON.stringify(s?.listener?.address?.()));
  try {
    const h = await fetch(base + '/api/health');
    console.log('HEALTH=' + h.status);
  } catch (e) {
    console.log('FETCH_ERR=' + String(e).slice(0, 400));
    throw e;
  }
});

await closeAtEnd;
console.log('DONE');
