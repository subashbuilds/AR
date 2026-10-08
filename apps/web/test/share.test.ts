// The share-token client contract.
//
//   node --test apps/web/test/share.test.ts
//
// A model is authorised by the session cookie (the owner) or by the token in
// the URL (every other device). The failure this file exists to prevent is
// quiet: a page that loads with the token in the address bar but asks the API
// without it, so the model appears missing on the second phone while the owner
// sees nothing wrong. Every URL builder is therefore asserted directly.

import test from 'node:test'
import assert from 'node:assert/strict'

// The token reader looks at window.location, and this suite runs in Node. Only
// the called functions touch it, so a stub here is enough.
const search = { value: '' }
;(globalThis as unknown as { window: unknown }).window = {
  location: {
    origin: 'https://example.test',
    get search() {
      return search.value
    },
  },
}

import {
  arPath,
  arShareUrl,
  authPath,
  createShareLink,
  getCapture,
  getResult,
  modelShareUrl,
  modelUrl,
  revokeShareLink,
  shareTokenFromLocation,
  signUp,
} from '../src/lib/api.ts'

const TOKEN = 'AbC-123_xyz'
const ID = '11111111-2222-4333-8444-555555555555'

test('the share token is read out of the address bar, and absent means absent', () => {
  search.value = ''
  assert.equal(shareTokenFromLocation(), null)
  search.value = `?t=${TOKEN}`
  assert.equal(shareTokenFromLocation(), TOKEN)
  // An unrelated query string is not a token; a guess must not become one.
  search.value = '?utm_source=qr'
  assert.equal(shareTokenFromLocation(), null)
  search.value = '?t='
  assert.equal(shareTokenFromLocation(), null)
})

test('every URL that carries a model carries its token', () => {
  assert.equal(modelUrl(ID), `/api/captures/${ID}/model.glb`)
  assert.equal(modelUrl(ID, TOKEN), `/api/captures/${ID}/model.glb?t=${TOKEN}`)

  assert.equal(arPath(ID), `/ar/${ID}`)
  assert.equal(arPath(ID, TOKEN), `/ar/${ID}?t=${TOKEN}`)

  assert.equal(modelShareUrl(ID, TOKEN), `https://example.test/model/${ID}?t=${TOKEN}`)
  assert.equal(arShareUrl(ID, TOKEN), `https://example.test/ar/${ID}?t=${TOKEN}`)

  // A token is attacker-supplied input on a shared link: it may not break out of
  // the query string it is placed in.
  assert.equal(modelUrl(ID, 'a b&c=d'), `/api/captures/${ID}/model.glb?t=a%20b%26c%3Dd`)
  assert.equal(arPath(ID, '#frag'), `/ar/${ID}?t=%23frag`)
})

test('the reads a shared page makes all carry the token, and the owner sends none', async () => {
  const asked: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url))
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    await getCapture(ID, TOKEN)
    await getResult(ID, TOKEN)
    await getCapture(ID)
    await getResult(ID)
  } finally {
    globalThis.fetch = realFetch
  }

  assert.deepEqual(asked, [
    `/api/captures/${ID}?t=${TOKEN}`,
    `/api/captures/${ID}/result?t=${TOKEN}`,
    `/api/captures/${ID}`,
    `/api/captures/${ID}/result`,
  ])
})

test('sharing is asked for explicitly, and revoked with DELETE', async () => {
  const calls: { url: string; method: string }[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' })
    return new Response(JSON.stringify({ shared: true, share_token: TOKEN }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const link = await createShareLink(ID)
    assert.equal(link.share_token, TOKEN)
    await revokeShareLink(ID)
    await signUp({ email: 'a@b.test', password: 'long-enough-pass' })
  } finally {
    globalThis.fetch = realFetch
  }

  assert.deepEqual(calls, [
    { url: `/api/captures/${ID}/share`, method: 'POST' },
    { url: `/api/captures/${ID}/share`, method: 'DELETE' },
    { url: '/api/auth/signup', method: 'POST' },
  ])
})

test('the sign-in redirect carries the destination as an encoded returnTo', () => {
  assert.equal(authPath('/capture'), '/auth?returnTo=%2Fcapture')
  assert.equal(authPath('/model/abc?t=x'), '/auth?returnTo=%2Fmodel%2Fabc%3Ft%3Dx')
})
