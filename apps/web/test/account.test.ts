// The account-deletion client contract.
//
//   node --test apps/web/test/account.test.ts
//
// Deleting an account destroys every capture, every stored model and every
// session, so the two things that must not drift are the verb and the
// confirmation: the request is a `DELETE` to `/api/auth/account` carrying the
// password in its body (a `POST` would be a 405), and a refusal surfaces the
// server's own message rather than a generic failure.

import test from 'node:test'
import assert from 'node:assert/strict'

import { ApiError, deleteAccount } from '../src/lib/api.ts'

test('deleting an account sends the password to the account endpoint with DELETE', async () => {
  const calls: { url: string; method: string; body: unknown }[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return new Response(
      JSON.stringify({
        deleted: true,
        captures_deleted: 2,
        objects_deleted: 7,
        sessions_revoked: 1,
        cancelled: 0,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  try {
    const result = await deleteAccount('a long enough passphrase')
    assert.equal(result.deleted, true)
    assert.equal(result.captures_deleted, 2)
    assert.equal(result.objects_deleted, 7, 'the count of removed objects is reported, not assumed')
  } finally {
    globalThis.fetch = realFetch
  }

  assert.deepEqual(calls, [
    { url: '/api/auth/account', method: 'DELETE', body: { password: 'a long enough passphrase' } },
  ])
})

test('a wrong password is refused with the server message, and the client reports it as such', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'password is incorrect' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  try {
    await assert.rejects(
      () => deleteAccount('not-the-password'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError, 'a refusal is an ApiError, not a raw throw')
        assert.equal((err as ApiError).status, 401)
        assert.equal((err as ApiError).message, 'password is incorrect')
        return true
      },
    )
  } finally {
    globalThis.fetch = realFetch
  }
})
