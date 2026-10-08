// Unit tests for the cancellation client.
//
//   node --test apps/web/test/cancel.test.ts
//
// Pure Node tests like orbit.test.ts: no server, no browser, `fetch` is
// stubbed. They pin the contract the cancel affordance in Capture.tsx relies
// on: DELETE to the capture (not a subresource), the server's 202 verdict
// parsed as-is, and a 409 (terminal state, lost race) surfaced as an ApiError
// carrying the SERVER's message rather than a generic status string — that
// message is what the UI shows the user.

import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiError, cancelCapture } from '../src/lib/api.ts'

interface Stub {
  calls: { url: string; method: string }[]
  restore: () => void
}

function stubFetch(status: number, body: unknown): Stub {
  const calls: { url: string; method: string }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const captureLike = {
  id: '6eff2b16-6193-4987-9e2b-3f8bffe5f00d',
  name: 'demo',
  status: 'cancelled',
  stage: 'cancelled',
  progress: null,
  imageCount: 12,
  elapsedSeconds: 1.5,
}

test('cancelCapture sends DELETE to the capture itself', async () => {
  const stub = stubFetch(202, { cancelled: true, was: 'queued', capture: captureLike })
  try {
    const res = await cancelCapture(captureLike.id)
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].url, `/api/captures/${captureLike.id}`)
    assert.equal(stub.calls[0].method, 'DELETE')
    assert.equal(res.cancelled, true)
    assert.equal(res.was, 'queued')
    assert.equal(res.capture.status, 'cancelled')
  } finally {
    stub.restore()
  }
})

test('a running cancellation reports the capture was running', async () => {
  const stub = stubFetch(202, { cancelled: true, was: 'running', capture: captureLike })
  try {
    const res = await cancelCapture(captureLike.id)
    assert.equal(res.was, 'running')
  } finally {
    stub.restore()
  }
})

test('a 409 for a terminal state surfaces the server message as ApiError', async () => {
  const message = 'capture is already completed and cannot be cancelled'
  const stub = stubFetch(409, { error: { message } })
  try {
    await assert.rejects(
      () => cancelCapture(captureLike.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError, 'must be an ApiError the UI can render')
        assert.equal(err.status, 409)
        assert.equal(err.message, message)
        return true
      },
    )
    assert.equal(stub.calls[0].method, 'DELETE')
  } finally {
    stub.restore()
  }
})

test('an unreachable service fails with the connection message, not a crash', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  try {
    await assert.rejects(
      () => cancelCapture(captureLike.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError)
        assert.equal(err.status, 0)
        assert.match(err.message, /Cannot reach the capture service/)
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})
