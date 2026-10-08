// End-to-end test of the capture API against the REAL reconstruction worker.
//
// It uploads real JPEG photographs from a fixture capture, lets the real Python
// pipeline reconstruct them, and then fetches the GLB the worker produced and
// validates it with the pipeline's own independent GLB validator.
//
//   node --test apps/api/test/api.test.js
//
// Fixture: generate with
//   python3 tests/make_fixture.py --out /tmp/fx2 --views 24 --radius 7.0 \
//           --width 1024 --height 768

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..", "..");

const fixtureDir = process.env.FIXTURE_DIR || "/tmp/fx2";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oca-api-test-"));
process.env.DATA_DIR = dataDir;
process.env.WEB_DIST = path.join(projectRoot, "apps", "web", "dist");

const { createServer } = await import("../src/server.js");
const { RateLimiter } = await import("../src/ratelimit.js");

let server;
let base;
/** The session cookie of the account that owns every capture made below. */
let cookie;

/**
 * Every capture route needs an account now, so the suite signs one up once and
 * carries its cookie. Access control itself is not this file's subject; see
 * auth.test.js for the ownership and share-link gate.
 */
test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "api-test@example.com", password: "api-test-password" }),
  });
  assert.equal(res.status, 201, `the suite needs an account: ${await res.clone().text()}`);
  cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.match(cookie, /^oca_session=/);
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function getJson(url, { auth = true } = {}) {
  const res = await fetch(url, auth ? { headers: { cookie } } : undefined);
  return { status: res.status, body: await res.json() };
}

function dataUrls(count) {
  const dir = path.join(fixtureDir, "images");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort().slice(0, count);
  assert.ok(files.length >= count, `fixture needs ${count} images, has ${files.length} in ${dir}`);
  return files.map((f) => `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, f)).toString("base64")}`);
}

test("health reports the real worker entrypoint", async () => {
  const { status, body } = await getJson(`${base}/api/health`, { auth: false });
  assert.equal(status, 200);
  assert.equal(body.worker.available, true);
  assert.match(body.worker.entrypoint, /reconstruction-worker\/run_job\.py$/);
  assert.equal(body.limits.minImages, 2);
});

test("rejects payloads the pipeline could never reconstruct", async () => {
  const noImages = await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ images: [dataUrls(1)[0]] }),
  });
  assert.equal(noImages.status, 400);
  assert.match((await noImages.json()).error.message, /at least 2 images/);

  const badImage = await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ images: [dataUrls(1)[0], "data:image/jpeg;base64,bm90YW5pbWFnZQ=="] }),
  });
  assert.equal(badImage.status, 400);
  assert.match((await badImage.json()).error.message, /not a JPEG, PNG or WebP/);
});

test("the upload token bucket refills at the configured rate", () => {
  let now = 1_000_000;
  const limiter = new RateLimiter({ capacity: 2, refillSeconds: 60, now: () => now });
  assert.equal(limiter.take("a").allowed, true);
  assert.equal(limiter.take("a").allowed, true);
  const denied = limiter.take("a");
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds > 0 && denied.retryAfterSeconds <= 60);
  // Another client is unaffected: the bucket is per key.
  assert.equal(limiter.take("b").allowed, true);
  now += 60_000;
  assert.equal(limiter.take("a").allowed, true);
  // Sweeping drops buckets idle for a full refill window (capacity x refill).
  assert.equal(limiter.size, 2, "live buckets must survive a sweep");
  now += 180_000;
  limiter.sweep();
  assert.equal(limiter.size, 0);
});

test("an upload burst over the limit is refused with 429 and the server message", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  // A one-token limiter makes the refusal observable without running six real
  // reconstructions. The first request is still rejected for its own reason,
  // which proves the limiter counts attempts, not successes.
  const strict = createServer({ limiter: new RateLimiter({ capacity: 1, refillSeconds: 600 }) });
  await new Promise((r) => strict.listen(0, "127.0.0.1", r));
  const strictBase = `http://127.0.0.1:${strict.address().port}`;
  try {
    const post = () =>
      fetch(`${strictBase}/api/captures`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ images: [dataUrls(1)[0]] }),
      });

    // The budget is spent before validation, so the cheap first attempt is
    // still counted and the second is refused on the budget alone.
    assert.equal((await post()).status, 400, "first attempt fails on its own validation");
    const limited = await post();
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.match(body.error.message, /Too many captures/);
    assert.ok(body.error.retry_after_seconds > 0);
    // GET must stay available; only the expensive endpoint is limited.
    assert.equal((await fetch(`${strictBase}/api/health`)).status, 200);
  } finally {
    await new Promise((r) => strict.close(r));
  }
});

test("reconstructs a real capture and serves a GLB the pipeline validator accepts", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip(`fixture ${fixtureDir} is missing; regenerate it with tests/make_fixture.py`);
    return;
  }

  const created = await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: "api test object",
      images: dataUrls(12),
      scale_calibration: { value: 2, unit: "m", source: "api_test" },
    }),
  });
  assert.equal(created.status, 202);
  const capture = await created.json();
  // enqueue() starts the worker synchronously when a slot is free, so the
  // capture may already be "running" by the time the response is written.
  assert.ok(["queued", "running"].includes(capture.status), `unexpected status ${capture.status}`);
  assert.equal(capture.imageCount, 12);

  const deadline = Date.now() + 240_000;
  let status = capture;
  const seenStages = new Set();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await getJson(`${base}/api/captures/${capture.id}`);
    status = poll.body;
    if (status.stage) seenStages.add(status.stage);
    if (status.status === "completed" || status.status === "failed") break;
  }

  assert.equal(status.status, "completed", `job did not complete: ${JSON.stringify(status.error)}`);
  assert.equal(status.progress, 1);
  assert.ok(seenStages.has("sfm"), `expected an sfm stage, saw ${[...seenStages].join(",")}`);

  const result = await getJson(`${base}/api/captures/${capture.id}/result`);
  assert.equal(result.status, 200);
  assert.equal(result.body.state, "completed");
  assert.equal(result.body.calibration.calibrated, true);
  assert.ok(result.body.manifest.vertex_count > 0);
  assert.ok(result.body.dimensions.height_m > 0, "dimensions must be in metres");

  const glbRes = await fetch(`${base}/api/captures/${capture.id}/model.glb`, { headers: { cookie } });
  assert.equal(glbRes.status, 200);
  assert.equal(glbRes.headers.get("content-type"), "model/gltf-binary");
  const bytes = Buffer.from(await glbRes.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "glTF");
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.ok(bytes.length > 1000, `GLB is only ${bytes.length} bytes`);

  // Independent check with the pipeline's own re-parsing validator.
  // require_texture=True: the worker ships a baked atlas, so this must follow
  // material -> texture -> image -> bufferView and decode the embedded PNG.
  // A model that only declared a texture, or lost it in transit, fails here.
  const saved = path.join(dataDir, "fetched.glb");
  fs.writeFileSync(saved, bytes);
  const script =
    "import sys; sys.path.insert(0, sys.argv[1]);" +
    "from pipeline import glb; r = glb.validate_glb(sys.argv[2], require_texture=True);" +
    "print(r.ok, r.errors, r.details.get('texture_size')); " +
    "sys.exit(0 if (r.ok and r.details.get('has_texture')) else 1)";
  const out = execFileSync("python3", ["-c", script, path.join(projectRoot, "services", "reconstruction-worker"), saved], {
    encoding: "utf8",
  });
  assert.match(out, /True/);

  const list = await getJson(`${base}/api/captures`);
  assert.ok(list.body.captures.some((c) => c.id === capture.id));
});

test("failed captures report the worker's own error", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  // Two nearly identical frames have almost no parallax, so the real pipeline
  // must reject them. This asserts failure is surfaced honestly, never faked.
  const dir = path.join(fixtureDir, "images");
  const one = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort()[0];
  const buf = fs.readFileSync(path.join(dir, one));
  const url = `data:image/jpeg;base64,${buf.toString("base64")}`;

  const created = await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "degenerate pair", images: [url, url] }),
  });
  assert.equal(created.status, 202);
  const { id } = await created.json();

  const deadline = Date.now() + 120_000;
  let status;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    status = (await getJson(`${base}/api/captures/${id}`)).body;
    if (status.status === "completed" || status.status === "failed") break;
  }
  assert.equal(status.status, "failed");
  assert.ok(status.error && status.error.message, "failure must carry the worker's message");

  const glb = await fetch(`${base}/api/captures/${id}/model.glb`, { headers: { cookie } });
  assert.equal(glb.status, 409, "no model may be served for a failed capture");
});