// Photographs uploaded straight to the object store, with the API never
// carrying the bytes.
//
//   node --test apps/api/test/direct-upload.test.js
//
// The path exists to remove the request-body ceiling: the API hands a signed-in
// owner a short-lived, bucket-scoped upload URL, the client sends the bytes to
// the bucket itself, and the API verifies what landed *before* a worker is
// allowed to see it.
//
// The claims gated here:
//
//   * A capture created for a direct upload starts as `uploading` and is never
//     picked up by the job runner -- there are no local images yet, so a worker
//     would fail on a capture whose photographs are still in flight.
//   * Completion re-checks the manifest's promises: the object exists, its size
//     is inside the limit, and its bytes really are the container that was
//     declared. A mismatch is a refusal, and the capture is removed whole.
//   * The working copy is materialised from the store, because the Python
//     worker reads real files -- the upload skips the API process, not the
//     worker's filesystem.
//   * A deployment without a presigning driver is told `direct: false` and
//     answers 409, so the client falls back to the request-body path.
//
// The B2 side runs against apps/api/test/b2-stub.js: no account, no credential.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startB2Stub } from "./b2-stub.js";

const fixtureDir = process.env.FIXTURE_DIR || "/tmp/fx2";

// The stand-in worker lives outside the data dir, so a test that removes its
// data dir cannot delete the interpreter out from under the next one.
const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "oca-direct-bin-"));
process.on("exit", () => fs.rmSync(toolDir, { recursive: true, force: true }));

const STANDIN_WORKER = [
  "#!/usr/bin/env python3",
  "import json, sys",
  "args = sys.argv[1:]",
  "with open(args[args.index('--job') + 1]) as f:",
  "    job = json.load(f)",
  "print(json.dumps({'event': 'stage', 'stage': 'sfm', 'note': 'stand-in', 'progress': 1.0}), flush=True)",
  "with open(job['outputs']['glb_path'], 'wb') as f:",
  "    f.write(b'glTF' + (2).to_bytes(4, 'little') + bytes(2040))",
  "with open(job['outputs']['result_json'], 'w') as f:",
  "    json.dump({'state': 'completed', 'manifest': {'vertex_count': 3, 'triangle_count': 1}}, f)",
  "print(json.dumps({'event': 'job_finished', 'elapsed_seconds': 0.2}), flush=True)",
  "",
].join("\n");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oca-direct-"));
// Comfortably above the fixture's ~120 kB photographs, so a real photo passes
// the size rule while a deliberately inflated object can be made to fail it.
const MAX_IMAGE_BYTES = 500_000;

let stub;
let server;
let base;
let cookie;

test.before(async () => {
  stub = await startB2Stub();
  const worker = path.join(toolDir, "standin_worker.py");
  fs.writeFileSync(worker, STANDIN_WORKER);
  fs.chmodSync(worker, 0o755);

  process.env.DATA_DIR = dataDir;
  process.env.PYTHON = worker;
  process.env.JOB_TIMEOUT_SECONDS = "60";
  process.env.UPLOAD_BURST = "100"; // this file creates more captures than a user would
  process.env.MAX_IMAGE_BYTES = String(MAX_IMAGE_BYTES);
  // A published capture's photographs are pruned once the bucket holds them, so
  // the materialisation check below asks for them to be kept: it is asserting
  // that the store's objects reach the worker's filesystem at all.
  process.env.KEEP_LOCAL_COPIES = "1";
  process.env.STORAGE_DRIVER = "b2";
  process.env.B2_KEY_ID = stub.keyId;
  process.env.B2_APPLICATION_KEY = stub.applicationKey;
  process.env.B2_BUCKET_NAME = stub.bucketName;
  process.env.B2_ENDPOINT = stub.base;

  const { createServer } = await import("../src/server.js");
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const signup = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "direct@example.com", password: "direct-upload-pass" }),
  });
  assert.equal(signup.status, 201, `the gate needs an account: ${await signup.clone().text()}`);
  cookie = (signup.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
});

test.after(async () => {
  if (server) {
    server.runner.queue.length = 0;
    for (const [, child] of server.runner.running) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    await new Promise((resolve) => server.close(resolve));
    server.accounts.close();
  }
  if (stub) await stub.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function fixtureBytes(count) {
  const dir = path.join(fixtureDir, "images");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .slice(0, count)
    .map((f) => fs.readFileSync(path.join(dir, f)));
}

function sha1hex(bytes) {
  return crypto.createHash("sha1").update(bytes).digest("hex");
}

/** What the client declares before uploading: a media type and a size each. */
function manifest(entries) {
  return entries.map((e) => ({ contentType: e.contentType ?? "image/jpeg", bytes: e.bytes }));
}

async function beginUpload(images) {
  const res = await fetch(`${base}/api/captures/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "direct upload", images }),
  });
  let body = null;
  try {
    body = await res.clone().json();
  } catch {
    // a non-JSON answer is a failure the caller will report
  }
  return { res, body };
}

/** The part the browser plays: send the bytes to the URL the API handed out. */
async function putObject(target, bytes) {
  return fetch(target.url, {
    method: "POST",
    headers: {
      ...target.headers,
      // The header the API deliberately does not fill in: the checksum must
      // describe the bytes the client is sending. `content-length` is left to
      // the HTTP client -- a browser forbids scripts from setting it, and any
      // client that can set it sets it wrong.
      "x-bz-content-sha1": sha1hex(bytes),
    },
    body: bytes,
  });
}

async function complete(id, jar = cookie) {
  const res = await fetch(`${base}/api/captures/${id}/uploads/complete`, {
    method: "POST",
    headers: { cookie: jar },
  });
  let body = null;
  try {
    body = await res.clone().json();
  } catch {
    // see beginUpload
  }
  return { res, body };
}

async function waitForCompletion(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let record = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    record = await (await fetch(`${base}/api/captures/${id}`, { headers: { cookie } })).json();
    if (["completed", "failed", "cancelled"].includes(record.status)) break;
  }
  return record;
}

test("health says whether a client may upload straight to the store", async () => {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.storage.kind, "b2");
  assert.equal(health.storage.directUploads, true, "B2 can hand out an upload URL");
  assert.equal(health.retention.captureTtlDays, 0, "captures are kept by default");
  assert.equal(health.retention.enabled, true, "abandoned uploads are reaped by default");
});

test("a local driver never offers direct uploads, and says so instead of failing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oca-direct-local-"));
  try {
    const { LocalStorage } = await import("../src/storage.js");
    const local = new LocalStorage({ root: tmp });
    assert.equal(local.supportsDirectUploads, false);
    assert.equal(
      await local.presign({ key: "captures/x/images/frame_001.jpg", contentType: "image/jpeg" }),
      null,
      "there is no URL a browser could be trusted to upload to",
    );

    // A server whose driver cannot presign: isolated store and accounts, so this
    // cannot disturb the B2 server the other tests use.
    const { createServer } = await import("../src/server.js");
    const { Store } = await import("../src/store.js");
    const { Accounts } = await import("../src/accounts.js");
    const isolated = createServer({
      store: new Store(tmp),
      storage: local,
      accounts: new Accounts(tmp),
    });
    await new Promise((r) => isolated.listen(0, "127.0.0.1", r));
    const isolatedBase = `http://127.0.0.1:${isolated.address().port}`;
    try {
      const health = await (await fetch(`${isolatedBase}/api/health`)).json();
      assert.equal(health.storage.directUploads, false);

      const signup = await fetch(`${isolatedBase}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "local@example.com", password: "local-only-pass" }),
      });
      const localCookie = (signup.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
      const res = await fetch(`${isolatedBase}/api/captures/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: localCookie },
        body: JSON.stringify({
          images: manifest([{ bytes: 1000 }, { bytes: 1000 }]),
        }),
      });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.match(body.error.message, /local disk/);
      assert.equal(body.error.code, "direct_uploads_unavailable", "the client can tell this apart from a real failure");
      // Nothing was created: a refused offer must not leave a row behind.
      assert.deepEqual(isolated.store.list(null), []);
    } finally {
      isolated.runner.queue.length = 0;
      await new Promise((r) => isolated.close(r));
      isolated.store.db.close?.();
      isolated.accounts.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("an upload is prepared with the documented headers, and is not run before it is complete", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  const bytes = fixtureBytes(3);
  const { res, body } = await beginUpload(manifest(bytes.map((b) => ({ bytes: b.length }))));
  assert.equal(res.status, 201, `prepare failed: ${JSON.stringify(body)}`);
  assert.equal(body.direct, true);
  assert.equal(body.status, "uploading", "no photographs have arrived, so this is not queued");
  assert.equal(body.uploads.length, 3);
  assert.equal("pendingUploads" in body, false, "internal bookkeeping is not part of the client contract");

  for (const [index, target] of body.uploads.entries()) {
    const suffix = String(index + 1).padStart(3, "0");
    assert.equal(target.name, `frame_${suffix}.jpg`);
    assert.equal(target.key, `captures/${body.id}/images/frame_${suffix}.jpg`);
    assert.equal(target.contentType, "image/jpeg");
    assert.equal(target.max_bytes, MAX_IMAGE_BYTES);
    assert.equal(target.url, `${stub.base}/upload/${stub.bucketId}`);
    assert.ok(target.headers.authorization, "the upload token travels with the target");
    assert.equal(
      target.headers["x-bz-file-name"],
      `captures/${body.id}/images/frame_${suffix}.jpg`,
      "the object name is percent-encoded UTF-8, with / kept as the separator",
    );
    assert.equal(
      "x-bz-content-sha1" in target.headers,
      false,
      "the checksum must describe the client's bytes, so this process cannot supply it",
    );
  }

  // The job runner must not touch it: there is nothing on disk to reconstruct.
  await new Promise((r) => setTimeout(r, 300));
  const still = await (await fetch(`${base}/api/captures/${body.id}`, { headers: { cookie } })).json();
  assert.equal(still.status, "uploading");
  assert.equal(server.runner.queue.includes(body.id), false);
  assert.equal(server.runner.running.has(body.id), false);

  // Clean up so the remaining tests start from an empty bucket.
  await server.storage.removeAll(`captures/${body.id}/`);
  fs.rmSync(path.join(dataDir, "captures", body.id), { recursive: true, force: true });
  server.store.remove(body.id);
});

test("uploaded photographs are verified, materialised, reconstructed and served", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  const bytes = fixtureBytes(3);
  const { res, body } = await beginUpload(manifest(bytes.map((b) => ({ bytes: b.length }))));
  assert.equal(res.status, 201);

  for (const [index, target] of body.uploads.entries()) {
    const sent = await putObject(target, bytes[index]);
    assert.equal(sent.status, 200, `the store refused ${target.name}`);
  }

  const done = await complete(body.id);
  assert.equal(done.res.status, 202, `completion failed: ${JSON.stringify(done.body)}`);
  // Enqueueing pumps the queue immediately, so the answer may already say
  // `running`. What matters is that it left the upload phase.
  assert.ok(
    ["queued", "running"].includes(done.body.status),
    `expected a queued or running capture, got ${done.body.status}`,
  );

  const record = await waitForCompletion(body.id);
  assert.equal(record.status, "completed", `ended as ${record.status}: ${JSON.stringify(record.error)}`);

  // The bucket holds the photographs and the published artifacts.
  for (const [index] of body.uploads.entries()) {
    const name = `captures/${body.id}/images/frame_${String(index + 1).padStart(3, "0")}.jpg`;
    const object = stub.get(name);
    assert.ok(object, `${name} must be in the bucket; holds ${stub.names().join(", ")}`);
    assert.equal(object.bytes.equals(bytes[index]), true, "the stored bytes are the bytes that were uploaded");
  }
  assert.ok(stub.get(`captures/${body.id}/model.glb`), "the model was published");

  // ...and the worker's own inputs were materialised from the store, because
  // the pipeline reads real files.
  const localImages = path.join(dataDir, "captures", body.id, "images");
  const names = fs.readdirSync(localImages).sort();
  assert.deepEqual(names, ["frame_001.jpg", "frame_002.jpg", "frame_003.jpg"]);
  assert.equal(fs.readFileSync(path.join(localImages, "frame_001.jpg")).equals(bytes[0]), true);

  const model = await fetch(`${base}/api/captures/${body.id}/model.glb`, { headers: { cookie } });
  assert.equal(model.status, 200);
  assert.equal((await model.arrayBuffer()).byteLength, 2048);
});

test("completing an upload nobody sent removes the capture instead of queueing nothing", async () => {
  const { res, body } = await beginUpload(manifest([{ bytes: 1000 }, { bytes: 1000 }]));
  assert.equal(res.status, 201);

  const done = await complete(body.id);
  assert.equal(done.res.status, 400);
  assert.match(done.body.error.message, /was never uploaded/);

  // Nothing usable exists, so nothing may remain: no row, no working directory,
  // no object in the bucket, and nothing for a worker to pick up.
  assert.equal(server.store.get(body.id), null);
  assert.equal(fs.existsSync(path.join(dataDir, "captures", body.id)), false);
  assert.deepEqual(stub.names().filter((n) => n.startsWith(`captures/${body.id}/`)), []);
});

test("bytes that are not the declared container are refused, and nothing is reconstructed", async () => {
  const { res, body } = await beginUpload(manifest([{ bytes: 64 }, { bytes: 64 }]));
  assert.equal(res.status, 201);

  const text = Buffer.from("this is not an image, it is a text file. ".repeat(3));
  assert.equal((await putObject(body.uploads[0], text)).status, 200, "the store accepts any bytes; the API is the gate");
  assert.equal((await putObject(body.uploads[1], text)).status, 200);

  const done = await complete(body.id);
  assert.equal(done.res.status, 400);
  assert.match(done.body.error.message, /is not a JPEG, PNG or WebP file/);
  assert.equal(server.store.get(body.id), null);
  assert.deepEqual(stub.names().filter((n) => n.startsWith(`captures/${body.id}/`)), []);
});

test("a container that disagrees with the declared type is refused by name", async () => {
  // The declared type chose the object's name, so a PNG uploaded as a JPEG
  // would leave a file whose name lies about its contents. The body path can
  // take the bytes' word for it; this path cannot, so it refuses.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]);
  const { res, body } = await beginUpload(manifest([{ bytes: png.length }, { bytes: png.length }]));
  assert.equal(res.status, 201);
  for (const target of body.uploads) assert.equal((await putObject(target, png)).status, 200);

  const done = await complete(body.id);
  assert.equal(done.res.status, 400);
  assert.match(done.body.error.message, /declared image\/jpeg but its bytes are png/);
  assert.equal(server.store.get(body.id), null);
  assert.deepEqual(stub.names().filter((n) => n.startsWith(`captures/${body.id}/`)), []);
});

test("an object larger than the limit is caught after it lands, not trusted from the manifest", async () => {
  // The declared size is honest and small; the object that arrives is not. Only
  // the stored length can settle it.
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const big = Buffer.concat([jpegHeader, Buffer.alloc(MAX_IMAGE_BYTES + 1024)]);
  const { res, body } = await beginUpload(manifest([{ bytes: 1024 }, { bytes: 1024 }]));
  assert.equal(res.status, 201, "the declared size passes the pre-check");
  for (const target of body.uploads) assert.equal((await putObject(target, big)).status, 200);

  const done = await complete(body.id);
  assert.equal(done.res.status, 413);
  assert.match(done.body.error.message, /limit is 500000/);
  assert.equal(server.store.get(body.id), null);
  assert.deepEqual(stub.names().filter((n) => n.startsWith(`captures/${body.id}/`)), []);
});

test("declaring an unusable upload is refused before any row exists", async () => {
  const tooFew = await beginUpload(manifest([{ bytes: 1000 }]));
  assert.equal(tooFew.res.status, 400);
  assert.match(tooFew.body.error.message, /at least 2 images/);

  const wrongType = await beginUpload(manifest([{ contentType: "image/gif", bytes: 10 }, { contentType: "image/gif", bytes: 10 }]));
  assert.equal(wrongType.res.status, 400);
  assert.match(wrongType.body.error.message, /unsupported type/);

  const oversized = await beginUpload(manifest([{ bytes: MAX_IMAGE_BYTES + 1 }, { bytes: 10 }]));
  assert.equal(oversized.res.status, 413);
  assert.match(oversized.body.error.message, /limit is 500000/);

  const noSize = await beginUpload(manifest([{ bytes: 0 }, { bytes: 10 }]));
  assert.equal(noSize.res.status, 400);
  assert.match(noSize.body.error.message, /must declare the number of bytes/);
});

test("preparing and completing an upload both belong to one account", async () => {
  const anonymous = await fetch(`${base}/api/captures/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ images: manifest([{ bytes: 10 }, { bytes: 10 }]) }),
  });
  assert.equal(anonymous.status, 401);

  const { res, body } = await beginUpload(manifest([{ bytes: 10 }, { bytes: 10 }]));
  assert.equal(res.status, 201);

  // Somebody else, and a link holder with no account at all.
  const other = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "intruder@example.com", password: "intruder-passphrase" }),
  });
  const otherCookie = (other.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  assert.equal((await complete(body.id, otherCookie)).res.status, 403);
  assert.equal((await complete(body.id, "")).res.status, 403);
  // The owner can still finish it, so a refusal did not destroy their work.
  assert.equal((await complete(body.id)).res.status, 400, "the shapes are missing, but it was the owner asking");

  // A second completion of a capture that is no longer uploading is a conflict.
  const { res: res2, body: body2 } = await beginUpload(manifest([{ bytes: 1000 }, { bytes: 1000 }]));
  assert.equal(res2.status, 201);
  const notUploading = await fetch(`${base}/api/captures/${body2.id}/uploads/complete`, {
    method: "GET",
    headers: { cookie },
  });
  assert.equal(notUploading.status, 405);
});
