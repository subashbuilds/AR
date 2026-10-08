import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../src/server.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const server = createServer({ dataDir: join(here, 'data', 'probe-socket-lifecycle-' + Date.now()) });
await new Promise((r) => server.listen({ port: 0, host: '127.0.0.1' }, r));
const { address, port } = server.address();
console.log('OUTER_PORT=' + port);
console.log('OUTER_ADDR=' + address);
let capturedPort = null;
let capturedAddr = null;

const t1 = test('capture server identity inside subtest', async () => {
  capturedPort = server.address().port;
  capturedAddr = server.address().address;
  console.log('INNER_PORT=' + capturedPort);
  console.log('INNER_ADDR=' + capturedAddr);
  assert.notStrictEqual(capturedPort, null, 'server still has a port inside subtest');
});

await t1;
console.log('AFTER_T1_PORT=' + capturedPort);
await new Promise((r) => setTimeout(r, 100));
console.log('AFTER_SLEEP_PORT=' + (server.address() ? server.address().port : 'closed'));
await new Promise((r) => server.close(r));
console.log('DONE');
