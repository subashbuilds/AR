// End-to-end browser verification of the shipped web app.
//
//   node apps/web/e2e/run.mjs
//
// It starts the REAL API (which runs the REAL Python worker), serves the built
// app from apps/web/dist, and drives the UI in Chromium. Screenshots are written
// to apps/web/e2e/screenshots/.
//
// The reconstruction step uploads real photographs from the ground-truth
// fixture, because Chromium's fake camera produces a synthetic pattern that the
// SfM pipeline is right to reject; faking that result would prove nothing.
// The fake camera IS used to prove the live-preview and shutter path works.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, '..')
const projectRoot = path.resolve(webRoot, '..', '..')
const shotsDir = path.join(here, 'screenshots')
const fixtureDir = process.env.FIXTURE_DIR || '/tmp/fx2'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-e2e-'))
process.env.DATA_DIR = dataDir
process.env.WEB_DIST = path.join(webRoot, 'dist')

if (!fs.existsSync(process.env.WEB_DIST)) {
  console.error(`dist/ is missing. Run "bun run build" in ${webRoot} first.`)
  process.exit(2)
}

const { start } = await import('../../api/src/server.js')
const { chromium } = await import('playwright')

const server = await start({ port: 0, host: '127.0.0.1' })
const base = `http://127.0.0.1:${server.address().port}`
fs.mkdirSync(shotsDir, { recursive: true })

// Captures belong to an account now. The account is created here (so this
// script's own direct fetches can carry its cookie) and then signed into
// through the UI, which is what the browser uses. Two sessions, one account.
const ACCOUNT = { email: 'e2e@example.com', password: 'e2e-browser-passphrase' }
const signup = await fetch(`${base}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(ACCOUNT),
})
if (signup.status !== 201) {
  console.error(`could not create the e2e account: ${signup.status} ${await signup.text()}`)
  process.exit(2)
}
const nodeCookie = (signup.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(';')[0])
  .join('; ')

/** A direct API read as the owning account, for checking the UI against facts. */
function api(path) {
  return fetch(`${base}/api${path}`, { headers: { cookie: nodeCookie } })
}

const browser = await chromium.launch({
  // SwiftShader gives the headless shell a real (software) WebGL 2 context, so
  // the viewer is exercised for what it is rather than skipped.
  args: [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
})
const context = await browser.newContext({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 2,
  permissions: ['camera'],
})
const page = await context.newPage()

const consoleErrors = []
const missingResources = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('response', (res) => {
  if (res.status() >= 400) missingResources.push(`${res.status()} ${res.url()}`)
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

let failures = 0
async function step(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (err) {
    failures += 1
    console.log(`FAIL  ${name}: ${err.message}`)
  }
}

await step('landing page renders with the product promise and a capture CTA', async () => {
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  const heading = await page.textContent('h2')
  assert.match(heading, /real-scale 3D model/i)
  assert.equal(await page.isVisible('text=Start a capture'), true)
  const styled = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  assert.notEqual(styled, 'rgba(0, 0, 0, 0)')
  await page.screenshot({ path: path.join(shotsDir, '01-landing.png'), fullPage: true })
})

await step('the capture screen is gated: a signed-out visitor is sent to sign in', async () => {
  await page.goto(`${base}/capture`, { waitUntil: 'networkidle' })
  // The intended destination is preserved, not thrown away.
  assert.match(page.url(), /\/auth\?returnTo=%2Fcapture/, `landed on ${page.url()}`)
  assert.equal(await page.isVisible('#auth-email'), true)
  assert.equal(
    await page.isVisible('input[type=file]'),
    false,
    'the capture screen must not render behind the gate',
  )
  await page.screenshot({ path: path.join(shotsDir, '01b-sign-in.png'), fullPage: true })

  // Sign in through the UI with the account this script created. The form's
  // first mode is sign-in; the account already exists.
  await page.fill('#auth-email', ACCOUNT.email)
  await page.fill('#auth-password', ACCOUNT.password)
  await page.click('button[type=submit]')
  await page.waitForURL((url) => url.pathname === '/capture', { timeout: 15000 })
  // The URL changes before React paints, so wait for the screen itself rather
  // than asking immediately whether it is there.
  await page.waitForSelector('text=Start Capture', { timeout: 15000 })
})

await step('a wrong password is refused with the server message, not a crash', async () => {
  const fresh = await browser.newContext({ viewport: { width: 430, height: 932 } })
  const stranger = await fresh.newPage()
  try {
    await stranger.goto(`${base}/auth`, { waitUntil: 'networkidle' })
    await stranger.fill('#auth-email', ACCOUNT.email)
    await stranger.fill('#auth-password', 'not-the-right-password')
    await stranger.click('button[type=submit]')
    await stranger.waitForSelector('.note.error', { timeout: 15000 })
    const message = await stranger.textContent('.note.error')
    assert.match(message, /email or password is incorrect/i)
    // The message must not reveal whether the address has an account.
    assert.doesNotMatch(message, /no such|unknown|not found|does not exist/i)
    assert.match(stranger.url(), /\/auth/, 'a failed sign-in must not navigate away')
  } finally {
    await fresh.close()
  }
})

await step('capture setup shows the live camera and the wireframe capture box', async () => {
  await page.goto(`${base}/capture`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.capture video')
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video')
      return v && v.videoWidth > 0 && v.readyState >= 2
    },
    null,
    { timeout: 20000 },
  )
  const size = await page.evaluate(() => {
    const v = document.querySelector('video')
    return { w: v.videoWidth, h: v.videoHeight }
  })
  assert.ok(size.w > 0 && size.h > 0, 'camera produced no frame')
  // The wireframe box is an SVG polygon overlay on top of the preview.
  const polygons = await page.locator('.capture svg polygon').count()
  assert.ok(polygons >= 2, `expected a wireframe box, found ${polygons} polygons`)
  await page.screenshot({ path: path.join(shotsDir, '02-capture-setup.png') })
  console.log(`      camera delivered ${size.w}x${size.h}`)
})

await step('shutter captures frames and the ring counter tracks them', async () => {
  await page.click('button:has-text("Start Capture")')
  await page.waitForSelector('.shutter')
  for (let i = 0; i < 4; i += 1) {
    await page.click('.shutter')
    await page.waitForTimeout(250)
  }
  const badge = await page.textContent('.badge')
  assert.match(badge, /^4\/24$/, `badge shows "${badge}"`)
  const thumbs = await page.locator('.thumbstrip img').count()
  assert.equal(thumbs, 4, 'each capture must produce a thumbnail')
  await page.screenshot({ path: path.join(shotsDir, '03-capture-shoot.png') })
})

await step('the orbit ring measures which directions have been photographed', async () => {
  // Synthetic orientation events stand in for a phone's compass. The point is
  // not that the readings are real -- they are not -- but that the ring turns
  // a set of headings into the same gap verdict the reconstruction worker will
  // later report, and that it admits when it has no heading at all.
  const shoot = async (azimuth) => {
    await page.evaluate((deg) => {
      window.dispatchEvent(
        new DeviceOrientationEvent('deviceorientation', {
          alpha: deg,
          beta: 0,
          gamma: 0,
          absolute: false,
        }),
      )
    }, azimuth)
    await page.click('.shutter')
    await page.waitForTimeout(120)
  }

  // Prime the sensor before the first shutter press. The tracker latches its
  // reference from the first orientation event it ever sees, so a shot taken
  // before that has no direction and is honestly counted as unknown. Priming
  // keeps this test about the geometry rather than about warm-up.
  await page.evaluate(() => {
    window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 0, gamma: 0, absolute: false }),
    )
  })
  await page.waitForTimeout(120)

  // A quarter of the orbit only: 0 through 45 degrees.
  for (const deg of [0, 15, 30, 45]) await shoot(deg)

  const partial = await page.getAttribute('[data-orbit-ring]', 'data-measured')
  assert.equal(partial, 'true', 'the ring must report that it has compass data')

  const partialGap = Number(await page.getAttribute('[data-orbit-ring]', 'data-max-gap'))
  // Four headings spanning 0 to 45 degrees sweep a 45-degree arc, so the arc
  // left unswept -- the one running from 45 back round to 0 -- measures 315.
  assert.ok(
    Math.abs(partialGap - 315) < 1.5,
    `a 0-45 degree sweep should leave a ~315 degree gap, ring reported ${partialGap}`,
  )
  assert.equal(await page.getAttribute('[data-orbit-ring]', 'data-full-orbit'), 'false')
  const partialNote = await page.textContent('.orbit-note')
  assert.match(partialNote, /315/, 'the caption must name the unswept arc')

  // Carry on round the rest of the circle. Together with the four above these
  // are every 30 degrees from 90 to 330, which leaves a largest gap of 45 --
  // comfortably inside the 60-degree threshold rather than exactly on it, so
  // this asserts the rule rather than a floating-point boundary.
  for (const deg of [90, 120, 150, 180, 210, 240, 270, 300, 330]) await shoot(deg)
  const fullGap = Number(await page.getAttribute('[data-orbit-ring]', 'data-max-gap'))
  // The documented number, asserted exactly rather than bounded: the headings
  // are 0/15/30/45 then every 30 degrees to 330, so the widest arc is the
  // 45-to-90 one. docs/status.md and the README both quote this figure.
  assert.ok(
    Math.abs(fullGap - 45) < 1e-6,
    `expected a 45 degree largest gap after a complete sweep, ring reported ${fullGap}`,
  )
  assert.equal(await page.getAttribute('[data-orbit-ring]', 'data-full-orbit'), 'true')
  assert.equal(await page.getAttribute('[data-orbit-ring]', 'data-measured-shots'), '13')
  const fullNote = await page.textContent('.orbit-note')
  assert.doesNotMatch(fullNote, /keep circling/i, 'a complete sweep must not still ask for more')
  await page.screenshot({ path: path.join(shotsDir, '03b-orbit-ring.png') })
})

await step('the ring says coverage is unmeasured when the compass is silent', async () => {
  // A fresh session in which no orientation event ever fires. The ring must NOT
  // draw an empty circle that reads as "0% covered" -- it has to say it does
  // not know, which is a different and truthful statement.
  await page.goto(`${base}/capture`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('button:has-text("Start Capture")', { timeout: 20000 })
  await page.click('button:has-text("Start Capture")')
  await page.waitForSelector('.shutter')
  await page.click('.shutter')
  await page.waitForTimeout(250)
  assert.equal(await page.getAttribute('[data-orbit-ring]', 'data-measured'), 'false')
  const note = await page.textContent('.orbit-note')
  assert.match(note, /not being measured/i, `ring said "${note}" with no compass data`)
})

await step('the next step stays disabled until enough photos are chosen', async () => {
  const disabled = await page.locator('button:has-text("Continue")').isDisabled()
  assert.equal(disabled, true, 'must not allow a 4-photo reconstruction')
})

let captureId = null

await step('a real photo set reconstructs and opens the model page', async () => {
  await page.goto(`${base}/capture`, { waitUntil: 'domcontentloaded' })
  const files = fs
    .readdirSync(path.join(fixtureDir, 'images'))
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .slice(0, 12)
    .map((f) => path.join(fixtureDir, 'images', f))
  assert.equal(files.length, 12, 'fixture must contain 12 usable photographs')
  await page.setInputFiles('input[type=file]', files)
  await page.waitForSelector('.shutter')
  await page.waitForFunction(
    () => (document.querySelector('.badge')?.textContent ?? '').startsWith('12/'),
    null,
    { timeout: 30000 },
  )
  await page.screenshot({ path: path.join(shotsDir, '04-capture-photos-added.png') })
  await page.click('button:has-text("Continue")')
  await page.waitForSelector('#measure-height', { timeout: 15000 })
  // The fixture's ground-truth height is 1.87 m; declaring it must calibrate the
  // model, and the other axes must then be checked against the reconstruction.
  await page.fill('#measure-height', '1.87')
  await page.fill('#measure-width', '2.176')
  await page.screenshot({ path: path.join(shotsDir, '04b-measure.png') })
  await page.click('button:has-text("Reconstruct with scale")')
  await page.waitForSelector('.processing', { timeout: 30000 })
  await page.waitForFunction(
    () => {
      const bar = document.querySelector('.bar > span')
      return bar && parseFloat(bar.style.width) > 0
    },
    null,
    { timeout: 60000 },
  )
  await page.screenshot({ path: path.join(shotsDir, '05-processing.png') })

  await page.waitForURL(/\/model\/[0-9a-f-]{36}/, { timeout: 300000 })
  captureId = new URL(page.url()).pathname.split('/').pop()
  await page.waitForSelector('text=What was reconstructed', { timeout: 30000 })
  const stats = await page.locator('.stat').allTextContents()
  const joined = stats.join(' ')
  assert.match(joined, /Reprojection error\d+\.\d+ px/, 'manifest numbers must be shown')
  assert.doesNotMatch(joined, /Reprojection errorNaN/, 'no NaN may reach the UI')
  await page.screenshot({ path: path.join(shotsDir, '06-model.png'), fullPage: true })
  console.log(`      capture ${captureId}`)
})

await step('the supplied measurement calibrates the model and the rest is checked', async () => {
  await page.waitForSelector('text=Your measurements vs. the reconstruction', { timeout: 15000 })
  const stats = await page.locator('.stat').allTextContents().then((s) => s.join(' '))
  assert.match(stats, /Scale sourceuser_measurement/, 'the UI must report a measured scale')
  assert.match(stats, /Measured dimension1\.87 m/, 'the declared dimension must be echoed back')

  // Calibration sets the largest axis to the declared value, by construction.
  const result = await api(`/captures/${captureId}/result`).then((r) => r.json())
  assert.equal(result.calibration.calibrated, true)
  assert.equal(result.calibration.units, 'metre')
  const dims = result.dimensions
  const largest = Math.max(dims.width_m, dims.height_m, dims.depth_m)
  assert.ok(
    Math.abs(largest - 1.87) < 1e-6,
    `calibrated axis should be 1.87 m, largest axis is ${largest}`,
  )
  assert.ok(dims.height_m > 0 && dims.width_m > 0 && dims.depth_m > 0)

  // The secondary measurement must be compared, not silently ignored.
  const rows = await page.locator('.agreement').allTextContents()
  assert.ok(rows.length >= 1, 'the second measurement must be shown as a check')
  assert.match(rows.join(' '), /you: .*model: /, 'the check must show both numbers')
  await page.screenshot({ path: path.join(shotsDir, '06b-model-calibrated.png'), fullPage: true })
})

await step('the model page reports capture coverage honestly', async () => {
  // The worker measures how completely the capture orbited the object. A
  // partial sweep makes width and depth read low, and the page must say so
  // rather than presenting a partial scan as a complete object.
  const result = await api(`/captures/${captureId}/result`).then((r) => r.json())
  const cov = result.manifest.capture_coverage
  assert.ok(cov, 'the worker must report capture coverage')
  assert.equal(typeof cov.max_gap_deg, 'number')
  assert.equal(typeof cov.note, 'string')
  assert.ok(Array.isArray(cov.warnings), 'coverage warnings must be a list')

  const stats = await page.locator('.stat').allTextContents().then((s) => s.join(' '))
  assert.match(stats, /Orbit gap/, 'the page must show the orbit gap')

  // The UI's claim must match the measurement: a gap means a warning, no gap
  // means none. Either way the two must not contradict each other.
  const shown = await page.locator('.note.warn').allTextContents()
  const warnsAboutGap = shown.some((t) => /orbit|gap|photographed/i.test(t))
  if (cov.full_orbit) {
    assert.ok(
      !warnsAboutGap,
      'a complete orbit must not produce an unswept-direction warning',
    )
  } else {
    assert.ok(
      warnsAboutGap,
      `a ${Math.round(cov.max_gap_deg)} deg orbit gap must be surfaced to the user`,
    )
    assert.match(shown.join(' '), /Partial capture/i)
  }
})

await step('the Three.js viewer rendered real geometry from the GLB', async () => {
  const info = await page.evaluate(() => {
    const canvas = document.querySelector('.viewer canvas')
    if (!canvas) return null
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    return { width: canvas.width, height: canvas.height, renderer: gl ? gl.getParameter(gl.VERSION) : null }
  })
  assert.ok(info, 'no canvas in the viewer')
  assert.ok(info.width > 100 && info.height > 100, 'canvas was never sized')
  assert.match(String(info.renderer), /WebGL/, 'no WebGL context was available')
  const hud = await page.textContent('.viewer .hud')
  assert.match(hud, /vertices/, 'viewer HUD must report the loaded mesh')
  // The baked atlas has to survive the whole path -- worker, API, disk, GLTF
  // loader -- and actually BIND to the material. A GLB that merely declares a
  // texture still renders flat, and "has_texture" in a manifest would not show
  // that; the HUD reports what the renderer bound.
  const bound = await page.textContent('.viewer .hud')
  assert.match(bound, /baked texture \d+×\d+/,
    'the viewer did not bind a baked texture to the loaded material')
  console.log(`      webgl: ${info.renderer}`)
  console.log(`      viewer bound: ${bound.replace(/\s+/g, ' ').trim()}`)
})

await step('the model page names the photos that were not used, and why', async () => {
  const review = await page.$('[data-view-review]')
  assert.ok(review, 'the model page must show the per-photo review')
  const text = (await review.textContent()).replace(/\s+/g, ' ').trim()
  console.log(`      review: ${text.slice(0, 200)}`)
  assert.match(text, /photos? (were not used|contributed)/,
    'the review must summarise what happened to the photos')
  // Every flagged photo must be named with a reason. A bare count is what
  // this replaced, and it is what a user cannot act on.
  const items = await page.$$eval('[data-view-review] li',
    (nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()))
  for (const item of items) {
    assert.match(item, /photo_\d+\.jpg|\.jpe?g|\.png/i,
      `a flagged photo is not named: ${item}`)
    assert.ok(item.length > 40,
      `a flagged photo has no stated reason: ${item}`)
  }
  console.log(`      ${items.length} photo(s) flagged with a reason`)
})

let shareToken = null

await step('a model is private until its owner creates a share link', async () => {
  // The URL alone is not an access grant any more: an account that is not the
  // owner, and a browser with no session at all, are both refused.
  const stranger = await browser.newContext({ viewport: { width: 430, height: 932 } })
  const anonymous = await stranger.newPage()
  try {
    await anonymous.goto(`${base}/model/${captureId}`, { waitUntil: 'networkidle' })
    await anonymous.waitForSelector('text=This model is not public', { timeout: 15000 })
    await anonymous.screenshot({ path: path.join(shotsDir, '06c-private.png'), fullPage: true })
  } finally {
    await stranger.close()
  }

  // The owner, on the same page, is offered the share controls and nothing is
  // shared yet.
  assert.equal(await page.isVisible('button:has-text("Create a share link")'), true)
  assert.equal(
    await page.isVisible('.qr-wrap canvas'),
    false,
    'no link may exist before the owner asks for one',
  )
})

await step('creating a share link produces a QR code for the shared AR route', async () => {
  await page.click('button:has-text("Create a share link")')
  await page.waitForSelector('.qr-wrap canvas', { timeout: 15000 })
  const encoded = await page.textContent('.qr-wrap .faint')
  assert.match(encoded, /\/ar\/[0-9a-f-]{36}\?t=/, 'the QR must carry the share token, not just the id')
  shareToken = new URL(encoded.trim()).searchParams.get('t')
  assert.ok(shareToken && shareToken.length >= 24, `token looks wrong: ${shareToken}`)

  const painted = await page.evaluate(() => {
    const canvas = document.querySelector('.qr-wrap canvas')
    const ctx = canvas.getContext('2d')
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let dark = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark += 1
    return dark
  })
  assert.ok(painted > 500, `QR canvas looks blank (${painted} dark pixels)`)
  await page.screenshot({ path: path.join(shotsDir, '07-qr.png'), fullPage: true })
})

await step('a second device with no account can read the shared model', async () => {
  // This is the real cross-device flow: a phone that scanned the code has no
  // session, and the token in the URL is the only thing that authorises it.
  const second = await browser.newContext({ viewport: { width: 430, height: 932 } })
  const phone = await second.newPage()
  const refused = []
  phone.on('response', (res) => {
    if (res.status() >= 400) refused.push(`${res.status()} ${res.url()}`)
  })
  try {
    await phone.goto(`${base}/model/${captureId}?t=${shareToken}`, { waitUntil: 'networkidle' })
    await phone.waitForSelector('text=What was reconstructed', { timeout: 30000 })
    assert.equal(
      await phone.isVisible('text=You are viewing a shared model'),
      true,
      'a link holder must be told they are looking at a shared capture',
    )
    assert.equal(
      await phone.isVisible('button:has-text("Create a share link")'),
      false,
      'a link holder must not be offered the owner controls',
    )
    await phone.screenshot({ path: path.join(shotsDir, '07b-shared-viewer.png'), fullPage: true })
    // A link holder must be able to load the whole page: one refused request
    // here means the shared flow is only half authorised.
    assert.deepEqual(refused, [], `the shared page made failed requests:\n${refused.join('\n')}`)

    // And the token is what carries the model bytes to that device.
    const glb = await fetch(`${base}/api/captures/${captureId}/model.glb?t=${shareToken}`)
    assert.equal(glb.status, 200, 'the shared token must serve the model')
  } finally {
    await second.close()
  }
})

await step('revoking the link stops the second device reading the model', async () => {
  const before = await fetch(`${base}/api/captures/${captureId}/model.glb?t=${shareToken}`)
  assert.equal(before.status, 200)

  await page.click('button:has-text("Stop sharing")')
  await page.waitForSelector('button:has-text("Create a share link")', { timeout: 15000 })
  assert.equal(
    await page.isVisible('.qr-wrap canvas'),
    false,
    'a revoked link must not still be on screen as if it worked',
  )

  const after = await fetch(`${base}/api/captures/${captureId}/model.glb?t=${shareToken}`)
  assert.equal(after.status, 403, 'a revoked token must be refused, immediately')
  assert.match((await after.json()).error.message, /no longer active/)

  // The owner is unaffected: revocation takes the link away, not the model.
  const owner = await api(`/captures/${captureId}/model.glb`)
  assert.equal(owner.status, 200)
})

await step('AR route reports capability honestly on a device without WebXR', async () => {
  await page.goto(`${base}/ar/${captureId}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=AR is not available on this device')
  const reason = await page.textContent('.note.warn')
  assert.match(reason, /WebXR|immersive-AR/, 'the reason must name the missing capability')
  assert.doesNotMatch(reason, /^$/, 'an empty reason would be a lie')
  await page.screenshot({ path: path.join(shotsDir, '08-ar.png'), fullPage: true })
})

await step('a running reconstruction can be cancelled from the processing screen', async () => {
  // The server side is gated by apps/api/test/cancel.test.js (queued and
  // running, stand-in worker). This drives the UI affordance against the real
  // API and real worker: the cancel button appears while the capture is
  // queued or running, DELETE is accepted, the capture lands in the named
  // `cancelled` state -- never `failed`, never `completed` -- no model exists
  // afterwards, and the retry affordance returns to a fresh capture.
  await page.goto(`${base}/capture`, { waitUntil: 'domcontentloaded' })
  const files = fs
    .readdirSync(path.join(fixtureDir, 'images'))
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .slice(0, 12)
    .map((f) => path.join(fixtureDir, 'images', f))
  await page.setInputFiles('input[type=file]', files)
  await page.waitForFunction(
    () => (document.querySelector('.badge')?.textContent ?? '').startsWith('12/'),
    null,
    { timeout: 30000 },
  )
  await page.click('button:has-text("Continue")')
  await page.waitForSelector('#measure-height', { timeout: 15000 })
  await page.fill('#measure-height', '1.87')

  // Arm the DELETE listener before the capture exists so the verdict (and the
  // id it carries) cannot be missed whichever state the cancel lands in.
  const deleted = page.waitForResponse(
    (r) => r.request().method() === 'DELETE' && r.url().includes('/api/captures/'),
  )
  await page.click('button:has-text("Reconstruct with scale")')
  await page.waitForSelector('.processing', { timeout: 30000 })
  await page.waitForSelector('button:has-text("Cancel reconstruction")', {
    timeout: 20000,
  })
  await page.screenshot({ path: path.join(shotsDir, '08b-cancel-offered.png') })
  await page.click('button:has-text("Cancel reconstruction")')

  const del = await deleted
  assert.equal(del.status(), 202, `DELETE must be accepted, got ${del.status()}`)
  const verdict = await del.json()
  assert.equal(verdict.cancelled, true)
  const id = new URL(del.url()).pathname.split('/').pop()

  await page.waitForSelector('text=Reconstruction cancelled', { timeout: 30000 })
  // The server agrees -- the UI is reporting a fact, not a local opinion.
  const record = await api(`/captures/${id}`).then((r) => r.json())
  assert.equal(record.status, 'cancelled', `capture ended as ${record.status}`)
  assert.equal(
    await page.isVisible('text=Reconstruction failed'),
    false,
    'a cancel must not be rendered as a failure',
  )
  // No model was published: the model endpoint must refuse it, by status.
  const modelResp = await api(`/captures/${id}/model.glb`)
  assert.equal(modelResp.status, 409, 'a cancelled capture may serve no model')
  const modelBody = await modelResp.json()
  assert.match(modelBody.error.message, /cancelled/)
  await page.screenshot({ path: path.join(shotsDir, '08c-cancelled.png') })

  // The retry affordance returns to a fresh capture, not a dead end.
  await page.click('button:has-text("Start a new capture")')
  await page.waitForSelector('button:has-text("Start Capture")', { timeout: 15000 })
})

await step('an unknown model id fails with the server message, not a blank screen', async () => {
  await page.goto(`${base}/model/00000000-0000-4000-8000-000000000000`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=This model is not available')
})

await step('deleting the account removes it, its captures and its sessions', async () => {
  // Start from a page that renders the header, then reach the account page the
  // way a user reaches it: the account chip.
  await page.goto(`${base}/capture`, { waitUntil: 'networkidle' })
  await page.waitForSelector(`a:has-text("${ACCOUNT.email}")`, { timeout: 15000 })
  await page.click(`a:has-text("${ACCOUNT.email}")`)
  await page.waitForSelector('text=Delete this account')
  await page.screenshot({ path: path.join(shotsDir, '09-account.png') })

  const submit = page.locator('button:has-text("Delete my account")')
  assert.equal(
    await submit.isDisabled(),
    true,
    'the delete button must be inert until the password is typed',
  )

  // A wrong password is refused with the server's own message, and destroys
  // nothing. This is the second deliberate failure in the run (a 401); it is
  // excluded by URL in the console check below.
  await page.fill('#account-password', 'not-the-password')
  await submit.click()
  await page.waitForSelector('text=password is incorrect')
  assert.equal(
    (await api('/captures')).status,
    200,
    'a refused deletion must leave the account and its captures intact',
  )

  // The right one removes the account, its captures and its sessions, and
  // lands back on the public page signed out.
  await page.fill('#account-password', ACCOUNT.password)
  await submit.click()
  await page.waitForURL(`${base}/`, { timeout: 15000 })
  await page.waitForSelector('a:has-text("Sign in")')
  assert.equal((await api('/captures')).status, 401, "deletion revokes the account's sessions")
  await page.screenshot({ path: path.join(shotsDir, '09b-account-deleted.png') })
})

await step('no uncaught console errors were produced along the way', async () => {
  // Two failures are provoked on purpose: the "unknown model id" step above
  // asks for a model that does not exist (404), and the account-deletion step
  // submits a wrong password (401). The browser logs both as failed resource
  // loads, so they are excluded by URL.
  const MISSING_ID = '00000000-0000-4000-8000-000000000000'
  const ignorable =
    /favicon|Download the React DevTools|Failed to load resource/i
  // Network failures are asserted precisely by URL via `missingResources`
  // above, so the generic console mirror of them is not double counted.
  const real = consoleErrors.filter((e) => !ignorable.test(e))
  const unexpected = missingResources.filter(
    (u) => !u.includes(MISSING_ID) && !u.includes('/api/auth/account'),
  )
  assert.deepEqual(unexpected, [], `failed requests:\n${unexpected.join('\n')}`)
  assert.deepEqual(real, [], `console errors:\n${real.join('\n')}`)
})

await browser.close()
await new Promise((resolve) => server.close(resolve))
fs.rmSync(dataDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures} step(s))`)
process.exit(failures === 0 ? 0 : 1)