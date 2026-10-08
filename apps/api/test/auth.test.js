// Account, session and share-link integration tests against the live server.
//
//   node --test apps/api/test/auth.test.js
//
// Requests go through node:http directly: this runtime's node:test + global
// fetch interaction after top-level awaits dropped requests on the floor, and
// node:http is unaffected. The runner is a stub whose only behaviour is
// cancelling a queued capture — everything the real runner does is covered by
// worker.test.js, cancel.test.js and timeout.test.js; what is under test here
// is the account/session/share surface around it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { request } from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = join(here, 'data', 'test-auth-' + randomUUID());
fs.mkdirSync(tmpRoot, { recursive: true });

// Config is read at import time, so the environment must be set first. The
// local driver is forced because what is under test here is accounts, sessions
// and share links, not storage: with B2 credentials in the environment the
// default `auto` selection would make every capture write to the network.
process.env.DATA_DIR = tmpRoot;
process.env.STORAGE_DRIVER = 'local';
process.env.AUTH_BURST = '100';
process.env.UPLOAD_BURST = '100';

const { createServer } = await import('../src/server.js');
const { Store } = await import('../src/store.js');

const store = new Store(tmpRoot);

/** A stand-in runner: captures stay queued, and a queued capture can be cancelled. */
const stubRunner = {
  queue: [],
  get runningIds() {
    return [];
  },
  enqueue(id) {
    this.queue.push(id);
  },
  recover() {
    return 0;
  },
  cancel(id) {
    const capture = store.get(id);
    if (!capture || capture.status !== 'queued') return { ok: false, was: null };
    store.update(id, {
      status: 'cancelled',
      stage: 'cancelled',
      note: 'cancelled before a worker slot was assigned',
      error: JSON.stringify({
        stage: 'cancelled',
        message: "cancelled at the user's request while queued",
      }),
    });
    return { ok: true, was: 'queued' };
  },
};

const server = createServer({ store, runner: stubRunner });
await new Promise((r) => server.listen({ port: 0, host: '127.0.0.1' }, r));
const { address, port } = server.address();
const base = `http://${address}:${port}`;

// ---------------------------------------------------------------- fixtures

/** CRC-32 (PNG chunk checksum), table form. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.from(type, 'latin1');
  const body = Buffer.concat([head, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A real (if tiny) 8x8 grayscale PNG as a data URL. The API sniffs container
 * bytes, so the payload must be a genuine PNG — no label-only fixtures.
 */
function makeImage(n) {
  const width = 8;
  const height = 8;
  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width)] = 0; // filter: none
    for (let x = 0; x < width; x += 1) raw[y * (1 + width) + 1 + x] = (n * 17 + x * 29 + y * 11) % 256;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// ------------------------------------------------------------- http helper

async function requestJson(method, url, payload = null, cookie = null) {
  const body = payload ? JSON.stringify(payload) : null;
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    // Content-length is required: a chunked DELETE body is dropped on this
    // runtime, and the server then answers 400 to an empty body.
    if (body) headers['content-length'] = String(Buffer.byteLength(body));
    if (cookie) headers.cookie = cookie;
    const req = request(base + url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : null;
          resolve({
            status: res.statusCode,
            json,
            text: data,
            /** `oca_session=...` from the first Set-Cookie, or null. */
            session: (res.headers['set-cookie'] || [])
              .map((c) => c.split(';')[0])
              .find((c) => c.startsWith('oca_session=')) || null,
          });
        } catch (err) {
          reject(new Error(`invalid json from ${method} ${url}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ------------------------------------------------------------- accounts

const accounts = new Map();

async function account(key, name) {
  if (accounts.has(key)) return accounts.get(key);
  const password = `password-for-test-${key}`;
  const res = await requestJson('POST', '/api/auth/signup', {
    email: `${key}-${randomUUID()}@test.example`,
    password,
    name,
  });
  assert.equal(res.status, 201, `account ${key} signs up`);
  assert.ok(res.session, 'signing up opens a session');
  const record = { user: res.json.user, password, cookie: res.session };
  accounts.set(key, record);
  return record;
}

const accountA = () => account('a', 'Account A');
const accountB = () => account('b', 'Account B');

async function share(owner, captureId, action) {
  const res = await requestJson(
    action === 'create' ? 'POST' : 'DELETE',
    `/api/captures/${captureId}/share`,
    null,
    owner.cookie,
  );
  assert.ok(res.status < 400, `share ${action} accepted: ${res.status}`);
  return action === 'create' ? res.json.share_token : null;
}

async function createCapture(owner, captureName) {
  const res = await requestJson(
    'POST',
    '/api/captures',
    { name: captureName, images: [makeImage(1), makeImage(2)] },
    owner.cookie,
  );
  assert.equal(res.status, 202, `capture "${captureName}" is accepted: ${res.text.slice(0, 200)}`);
  return res.json;
}

// ----------------------------------------------------------------- tests

await test('an account is created from an email and a password, and only the scrypt hash is stored', async () => {
  const a = await accountA();
  assert.ok(a.user.id, 'has an id');
  assert.ok(a.user.email, 'has an email');
  assert.equal(a.user.name, 'Account A', 'has a name');
  assert.ok(a.user.createdAt, 'has a created_at');
  const row = server.accounts.db.prepare('SELECT * FROM users WHERE id = ?').get(a.user.id);
  assert.match(row.password_hash, /^scrypt\$/, 'only the hash is stored');
  assert.ok(!JSON.stringify(a.user).includes(a.password), 'the password never comes back');
});

await test('sign-in failures are indistinguishable, and a successful one opens a fresh session', async () => {
  const a = await accountA();
  const bad = await requestJson('POST', '/api/auth/signin', {
    email: a.user.email,
    password: 'not-the-password',
  });
  assert.equal(bad.status, 401, 'wrong password is refused');
  assert.match(bad.json.error.message, /email or password is incorrect/);
  assert.equal(bad.session, null, 'a refused sign-in opens no session');

  const unknown = await requestJson('POST', '/api/auth/signin', {
    email: 'nobody-there@test.example',
    password: 'not-the-password',
  });
  assert.equal(unknown.status, 401, 'an unknown address is refused the same way');
  assert.equal(unknown.json.error.message, bad.json.error.message, 'the message is identical');

  const good = await requestJson('POST', '/api/auth/signin', {
    email: a.user.email,
    password: a.password,
  });
  assert.equal(good.status, 200, 'good password accepts');
  assert.equal(good.json.user.id, a.user.id, 'returns the same account');
  assert.ok(good.session, 'a good sign-in opens a session');

  const me = await requestJson('GET', '/api/auth/me', null, good.session);
  assert.equal(me.json.user.id, a.user.id, 'the fresh session identifies the account');
});

await test('a session can be signed out, and the token stops working at once', async () => {
  const a = await accountA();
  const res = await requestJson('POST', '/api/auth/signout', null, a.cookie);
  assert.equal(res.status, 200, 'sign out accepted');

  const after = await requestJson('GET', '/api/auth/me', null, a.cookie);
  assert.equal(after.json.user, null, 'the token is dead');

  // Sign in again for the tests that follow: the old cookie no longer works.
  const again = await requestJson('POST', '/api/auth/signin', {
    email: a.user.email,
    password: a.password,
  });
  assert.equal(again.status, 200);
  a.cookie = again.session;
});

await test('an expired session is refused and its row is dropped', async () => {
  const a = await accountA();
  const raw = decodeURIComponent(a.cookie.split('=')[1]);
  const tokenHash = createHash('sha256').update(raw).digest('hex');
  const expired = server.accounts.db
    .prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run(Date.now() - 1, tokenHash);
  assert.equal(expired.changes, 1, 'the session row exists');

  const me = await requestJson('GET', '/api/auth/me', null, a.cookie);
  assert.equal(me.json.user, null, 'an expired session is refused');

  const left = server.accounts.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(tokenHash);
  assert.equal(left.n, 0, 'the expired row is dropped');

  // The tests that follow still need a live session for this account.
  const again = await requestJson('POST', '/api/auth/signin', {
    email: a.user.email,
    password: a.password,
  });
  assert.equal(again.status, 200);
  a.cookie = again.session;
});

await test('a capture belongs to its owner and is invisible to everyone else', async () => {
  const owner = await accountA();
  const other = await accountB();
  const created = await createCapture(owner, 'owner start');
  assert.ok(created.id, 'created an id');
  assert.equal(created.owned, true, 'the creator is the owner');

  const stranger = await requestJson('GET', `/api/captures/${created.id}`, null, other.cookie);
  assert.equal(stranger.status, 403, 'another signed-in account is refused');
  assert.match(stranger.json.error.message, /belongs to another account/);

  const listed = await requestJson('GET', '/api/captures', null, owner.cookie);
  assert.ok(
    listed.json.captures.some((c) => c.id === created.id),
    'the owner can list their own captures',
  );
  const otherList = await requestJson('GET', '/api/captures', null, other.cookie);
  assert.ok(
    !otherList.json.captures.some((c) => c.id === created.id),
    'no cross-account listing',
  );
});

await test('an anonymous browser cannot open the capture from the id', async () => {
  const owner = await accountA();
  const created = await createCapture(owner, 'private capture');
  const anonymous = await requestJson('GET', `/api/captures/${created.id}`);
  assert.equal(anonymous.status, 401, 'no session is refused');
  assert.match(anonymous.json.error.message, /sign in to view this capture/);
});

await test('the unguessable URL is not an access grant; the share token is', async () => {
  const owner = await accountA();
  const created = await createCapture(owner, 'shared capture');
  const id = created.id;

  await test('the id alone is not enough', async () => {
    const anonymous = await requestJson('GET', `/api/captures/${id}`);
    assert.equal(anonymous.status, 401, 'an unshared capture is not public');
  });

  await test('the owner can publish a share link', async () => {
    const token = await share(owner, id, 'create');
    assert.ok(token, 'published a token');

    const shared = await requestJson('GET', `/api/captures/${id}?t=${token}`);
    assert.equal(shared.status, 200, 'a bearer of the token can read the capture');
    assert.equal(shared.json.role, 'shared', 'the reader is a link holder, not an owner');
    assert.equal(shared.json.owned, false, 'a link holder is not the owner');
  });

  await test('a stranger’s account cannot publish someone else’s link', async () => {
    const impostor = await requestJson('POST', `/api/captures/${id}/share`, null, (await accountB()).cookie);
    assert.equal(impostor.status, 404, 'a non-owner gets the same 404 as an unknown id');
  });

  await test('revoking the link takes effect on the next request', async () => {
    const token = await share(owner, id, 'create');
    const first = await requestJson('GET', `/api/captures/${id}?t=${token}`);
    assert.equal(first.status, 200, 'the live link still works');

    await share(owner, id, 'revoke');
    const after = await requestJson('GET', `/api/captures/${id}?t=${token}`);
    assert.equal(after.status, 403, 'the revoked link is refused immediately');
    assert.match(after.json.error.message, /no longer active/);
  });
});

await test('only the owner can cancel a capture, and a shared link cannot', async () => {
  const owner = await accountA();
  const created = await createCapture(owner, 'cancellable');
  const id = created.id;

  await test('a shared link cannot cancel the capture', async () => {
    const token = await share(owner, id, 'create');
    const impostor = await requestJson('DELETE', `/api/captures/${id}?t=${token}`);
    assert.equal(impostor.status, 403, 'the shared link gives no right to cancel');
    assert.match(impostor.json.error.message, /only the account that owns a capture can cancel it/);
  });

  await test('only the owner can cancel', async () => {
    const cancel = await requestJson('DELETE', `/api/captures/${id}`, null, owner.cookie);
    assert.equal(cancel.status, 202, 'the owner can cancel');
    assert.equal(cancel.json.cancelled, true, 'the reply says cancelled');
    assert.equal(cancel.json.was, 'queued', 'it was cancelled before it ever ran');

    const afterwards = await requestJson('GET', `/api/captures/${id}`, null, owner.cookie);
    assert.equal(afterwards.json.status, 'cancelled', 'the capture ends as cancelled');
  });
});

await test("deleting an account needs the password and takes that account's data with it", async () => {
  // A fresh account, so the deletion counts describe exactly what this test created.
  const a = await account('delete-me', 'Doomed Account');
  const created = await createCapture(a, 'to be destroyed');
  const id = created.id;

  await test('a wrong password does nothing', async () => {
    const wrong = await requestJson('DELETE', '/api/auth/account', { password: 'not-the-password' }, a.cookie);
    assert.equal(wrong.status, 401, 'wrong password is refused');
    assert.match(wrong.json.error.message, /password is incorrect/);

    const stillThere = await requestJson('GET', `/api/captures/${id}`, null, a.cookie);
    assert.equal(stillThere.status, 200, 'the capture survives a refused deletion');
  });

  await test('the right password destroys the account, its captures and its sessions', async () => {
    const destroyed = await requestJson('DELETE', '/api/auth/account', { password: a.password }, a.cookie);
    assert.equal(destroyed.status, 200, 'the right password accepts deletion');
    assert.equal(destroyed.json.deleted, true, 'the reply confirms deletion');
    assert.equal(destroyed.json.captures_deleted, 1, 'the capture was deleted');
    assert.equal(destroyed.json.objects_deleted, 2, 'the images were deleted');
    assert.ok(destroyed.json.sessions_revoked >= 1, 'its sessions were revoked');
    assert.equal(destroyed.json.cancelled, 1, 'the queued capture was stopped');

    // The row is gone, so even the former owner's (now dead) session is told
    // the capture does not exist — the access check never comes first.
    const gone = await requestJson('GET', `/api/captures/${id}`, null, a.cookie);
    assert.equal(gone.status, 404, 'the deleted capture is simply gone');

    const me = await requestJson('GET', '/api/auth/me', null, a.cookie);
    assert.equal(me.json.user, null, 'the account itself is gone');

    const resurrected = await requestJson('POST', '/api/auth/signin', {
      email: a.user.email,
      password: a.password,
    });
    assert.equal(resurrected.status, 401, 'the account cannot be signed back into');
  });
});

await new Promise((r) => server.close(r));
server.accounts.close();
store.close?.();
fs.rmSync(tmpRoot, { recursive: true, force: true });
