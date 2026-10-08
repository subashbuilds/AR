// The direct-upload client contract, and the fallback that keeps it safe.
//
//   node --test apps/web/test/direct-upload.test.ts
//
// Two things must not drift:
//
//   * the request the object store receives -- the upload URL the API named,
//     POSTed with the headers the API handed out plus the checksum of the bytes
//     the client is sending (the API cannot compute it: it never sees them);
//   * the fallback. A deployment that cannot presign answers 409, and a store
//     that refuses an object answers 5xx. Neither may cost the user their
//     capture, so both must end up on the request-body path.

import test from 'node:test'
import assert from 'node:assert/strict'

import { dataUrlMediaType, dataUrlToBytes, sha1Hex, uploadToStore } from '../src/lib/api.ts'
import { directUploadsOffered, submitShots } from '../src/lib/upload.ts'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const DATA_URL = `data:image/jpeg;base64,${Buffer.from(JPEG).toString('base64')}`

type Stubbed = {
  calls: { url: string; init?: RequestInit }[]
  restore: () => void
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): Stubbed {
  const calls: { url: string; init?: RequestInit }[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = real
    },
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const CAPTURE = {
  id: '11111111-2222-4333-8444-555555555555',
  name: 'object',
  status: 'uploading',
  role: 'owner',
  owned: true,
}

const UPLOADS = [
  {
    key: `captures/${CAPTURE.id}/images/frame_001.jpg`,
    name: 'frame_001.jpg',
    contentType: 'image/jpeg',
    url: 'https://pod.example.com/upload/bucket-id',
    headers: {
      authorization: 'upload-token',
      'x-bz-file-name': `captures/${CAPTURE.id}/images/frame_001.jpg`,
      'content-type': 'image/jpeg',
    },
    max_bytes: 12_000_000,
  },
]

test('a data URL yields exactly its bytes and declared media type', () => {
  assert.deepEqual(Array.from(dataUrlToBytes(DATA_URL)), Array.from(JPEG))
  assert.equal(dataUrlMediaType(DATA_URL), 'image/jpeg')
  assert.equal(dataUrlMediaType('data:image/webp;base64,AAAA'), 'image/webp')
  assert.equal(dataUrlMediaType('not-a-data-url'), null)
  // A URL with no payload is empty, not an exception: the server is the one
  // that decides it is unusable.
  assert.equal(dataUrlToBytes('data:image/jpeg;base64,').length, 0)
})

test('the checksum is the one the store verifies', async () => {
  // The published test vector for SHA-1 of "abc".
  const digest = await sha1Hex(new TextEncoder().encode('abc'))
  assert.equal(digest, 'a9993e364706816aba3e25717850c26c9cd0d89d')
})

test('an upload goes to the store URL with the handed-out headers and the bytes', async () => {
  const stub = stubFetch(() => new Response('', { status: 200 }))
  try {
    await uploadToStore(UPLOADS[0], JPEG)
  } finally {
    stub.restore()
  }

  assert.equal(stub.calls.length, 1)
  const { url, init } = stub.calls[0]
  assert.equal(url, UPLOADS[0].url)
  assert.equal(init?.method, 'POST')
  const headers = init?.headers as Record<string, string>
  assert.equal(headers.authorization, 'upload-token')
  assert.equal(headers['x-bz-file-name'], UPLOADS[0].key)
  assert.equal(headers['content-type'], 'image/jpeg')
  assert.equal(headers['x-bz-content-sha1'], await sha1Hex(JPEG))
  assert.equal(
    'content-length' in headers,
    false,
    'a browser forbids scripts from setting it, and the HTTP client always knows it',
  )
  assert.deepEqual(Array.from(init?.body as Uint8Array), Array.from(JPEG))
})

test('a refused object is reported with the store\'s status, not swallowed', async () => {
  const stub = stubFetch(() => new Response('service_unavailable', { status: 503 }))
  try {
    await assert.rejects(
      () => uploadToStore(UPLOADS[0], JPEG),
      (err: unknown) => {
        assert.equal((err as { status?: number }).status, 503)
        assert.match((err as Error).message, /refused frame_001\.jpg \(503\)/)
        return true
      },
    )
  } finally {
    stub.restore()
  }
})

test('the preferred route prepares, uploads every object, then completes', async () => {
  const stub = stubFetch((url) => {
    if (url === '/api/captures/uploads') return json({ ...CAPTURE, direct: true, uploads: UPLOADS })
    if (url === UPLOADS[0].url) return new Response('', { status: 200 })
    if (url === `/api/captures/${CAPTURE.id}/uploads/complete`) {
      return json({ ...CAPTURE, status: 'queued' })
    }
    throw new Error(`unexpected request: ${url}`)
  })
  try {
    const result = await submitShots({
      shots: [{ dataUrl: DATA_URL }, { dataUrl: DATA_URL }],
      name: 'my object',
      calibration: null,
      direct: true,
    })
    assert.equal(result.route, 'direct')
    assert.equal(result.capture.status, 'queued')
  } finally {
    stub.restore()
  }

  assert.deepEqual(
    stub.calls.map((c) => c.url),
    ['/api/captures/uploads', UPLOADS[0].url, `/api/captures/${CAPTURE.id}/uploads/complete`],
  )
  const prepared = JSON.parse(String(stub.calls[0].init?.body))
  assert.equal(prepared.name, 'my object')
  assert.deepEqual(
    prepared.images,
    [
      { contentType: 'image/jpeg', bytes: JPEG.length },
      { contentType: 'image/jpeg', bytes: JPEG.length },
    ],
    'the manifest declares what will actually be uploaded',
  )
})

test('a deployment that cannot presign falls back to the request body', async () => {
  const stub = stubFetch((url) => {
    if (url === '/api/captures/uploads') {
      return json(
        { error: { message: 'direct uploads need a durable object store', code: 'direct_uploads_unavailable' } },
        409,
      )
    }
    if (url === '/api/captures') return json({ ...CAPTURE, status: 'queued' }, 202)
    throw new Error(`unexpected request: ${url}`)
  })
  try {
    const result = await submitShots({
      shots: [{ dataUrl: DATA_URL }, { dataUrl: DATA_URL }],
      name: 'object',
      calibration: null,
      direct: true,
    })
    assert.equal(result.route, 'body')
    assert.equal(result.capture.status, 'queued')
  } finally {
    stub.restore()
  }
  assert.deepEqual(
    stub.calls.map((c) => c.url),
    ['/api/captures/uploads', '/api/captures'],
  )
  const fallback = JSON.parse(String(stub.calls[1].init?.body))
  assert.deepEqual(fallback.images, [DATA_URL, DATA_URL], 'the same photographs, the other way')
})

test('a store that refuses an object also falls back, rather than losing the capture', async () => {
  const stub = stubFetch((url) => {
    if (url === '/api/captures/uploads') return json({ ...CAPTURE, direct: true, uploads: UPLOADS })
    if (url === UPLOADS[0].url) return new Response('blocked by CORS', { status: 403 })
    if (url === '/api/captures') return json({ ...CAPTURE, status: 'queued' }, 202)
    throw new Error(`unexpected request: ${url}`)
  })
  try {
    const result = await submitShots({
      shots: [{ dataUrl: DATA_URL }],
      name: 'object',
      calibration: null,
      direct: true,
    })
    assert.equal(result.route, 'body', 'a blocked preflight must not cost the user their capture')
  } finally {
    stub.restore()
  }
  assert.deepEqual(
    stub.calls.map((c) => c.url),
    ['/api/captures/uploads', UPLOADS[0].url, '/api/captures'],
    'completion is not attempted once the bytes were refused',
  )
})

test('a signed-out session is reported rather than retried the other way', async () => {
  const stub = stubFetch((url) => {
    if (url === '/api/captures/uploads') return json({ error: { message: 'sign in to start a capture' } }, 401)
    if (url === '/api/captures') return json({ ...CAPTURE, status: 'queued' }, 202)
    throw new Error(`unexpected request: ${url}`)
  })
  try {
    await assert.rejects(
      () => submitShots({ shots: [{ dataUrl: DATA_URL }], name: 'object', calibration: null, direct: true }),
      (err: unknown) => {
        assert.equal((err as { status?: number }).status, 401)
        return true
      },
    )
  } finally {
    stub.restore()
  }
  assert.deepEqual(
    stub.calls.map((c) => c.url),
    ['/api/captures/uploads'],
    'the second route would fail identically; the user needs the real reason',
  )
})

test('with direct uploads unavailable the request-body path is used without asking', async () => {
  const stub = stubFetch((url) => {
    if (url === '/api/captures') return json({ ...CAPTURE, status: 'queued' }, 202)
    throw new Error(`unexpected request: ${url}`)
  })
  try {
    const result = await submitShots({
      shots: [{ dataUrl: DATA_URL }],
      name: 'object',
      calibration: null,
      direct: false,
    })
    assert.equal(result.route, 'body')
  } finally {
    stub.restore()
  }
  assert.deepEqual(stub.calls.map((c) => c.url), ['/api/captures'])
})

test('the health answer decides whether direct uploads are offered at all', () => {
  assert.equal(directUploadsOffered(null), false)
  assert.equal(directUploadsOffered({ ok: true } as never), false, 'an older server has no storage block')
  assert.equal(
    directUploadsOffered({
      ok: true,
      worker: { available: true, entrypoint: '', python: '' },
      limits: { minImages: 2, maxImages: 200, maxImageBytes: 1 },
      storage: { kind: 'local', durable: false, directUploads: false, warnings: [] },
    }),
    false,
  )
  assert.equal(
    directUploadsOffered({
      ok: true,
      worker: { available: true, entrypoint: '', python: '' },
      limits: { minImages: 2, maxImages: 200, maxImageBytes: 1 },
      storage: { kind: 'b2', durable: true, directUploads: true, bucket: 'b', warnings: [] },
    }),
    true,
  )
})
