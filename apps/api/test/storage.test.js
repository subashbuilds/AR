// The storage layer: local disk, and Backblaze B2 over its native API v4.
//
//   node --test apps/api/test/storage.test.js
//
// Two halves, both against a stand-in B2 server that implements the other side
// of Backblaze's documented protocol (apps/api/test/b2-stub.js):
//
//   1. the drivers, asserted request by request -- the Basic auth on
//      b2_authorize_account, the bucket id resolved from the key, the
//      percent-encoded X-Bz-File-Name, the X-Bz-Content-Sha1 B2 verifies, the
//      401-then-reauthorise path, deletion by (fileName, fileId);
//   2. the API with B2 configured -- photographs stored as they are uploaded,
//      the model and result stored before the capture is called completed, and
//      the model still servable after the local copy is gone.
//
// No Backblaze account is contacted and no credential is needed. Running it
// against the real service is a separate step: set B2_KEY_ID,
// B2_APPLICATION_KEY and B2_BUCKET_NAME (see docs/storage/README.md).

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startB2Stub } from "./b2-stub.js";

const fixtureDir = process.env.FIXTURE_DIR || "/tmp/fx2";

const { B2Storage, LocalStorage, createStorage, captureKey } = await import("../src/storage.js");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Drain a stream. Async iteration rather than an "end" listener: a small body
 * can finish before a listener is attached, and a promise waiting for an event
 * that already fired would hang the whole gate.
 */
async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function driver(stub, options = {}) {
  return new B2Storage({
    keyId: stub.keyId,
    applicationKey: stub.applicationKey,
    bucket: stub.bucketName,
    endpoint: stub.base,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

test("with no B2 settings the local disk driver is used, and no bucket is claimed", () => {
  const root = tempDir("oca-store-none-");
  try {
    const storage = createStorage({ dataDir: root });
    assert.equal(storage.kind, "local");
    assert.equal(storage.describe().durable, false);
    assert.deepEqual(storage.warnings || [], [], "an unconfigured store is not a warning");

    // The shape config.js actually hands over: the credential fields are
    // undefined but the optional ones carry their defaults. That is still an
    // unconfigured deployment, and it must not warn -- the running preview did,
    // which is how this case was found.
    const asConfigDeliversIt = createStorage({
      dataDir: root,
      storageDriver: "auto",
      b2: { keyId: undefined, applicationKey: undefined, bucket: undefined, prefix: "", endpoint: "https://api.backblazeb2.com" },
    });
    assert.equal(asConfigDeliversIt.kind, "local");
    assert.deepEqual(
      asConfigDeliversIt.warnings,
      [],
      "defaults for prefix/endpoint must never read as a half-finished configuration",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a half-finished B2 configuration warns by name instead of pretending a bucket is in use", () => {
  const root = tempDir("oca-store-partial-");
  try {
    const storage = createStorage({
      dataDir: root,
      b2: { keyId: "k", applicationKey: null, bucket: null, endpoint: "https://api.backblazeb2.com" },
    });
    assert.equal(storage.kind, "local", "it must still work without credentials");
    assert.equal(storage.warnings.length, 1);
    assert.match(storage.warnings[0], /applicationKey/);
    assert.match(storage.warnings[0], /bucket/);
    assert.doesNotMatch(storage.warnings[0], /keyId/, "the key id was supplied, so it is not missing");

    // Asking for b2 explicitly with nothing configured is a misconfiguration
    // worth shouting about, never a silent fallback.
    const optedIn = createStorage({ dataDir: root, storageDriver: "b2", b2: {} });
    assert.equal(optedIn.kind, "local");
    assert.match(optedIn.warnings[0], /STORAGE_DRIVER=b2/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the local driver's key for a capture is the store's own capture directory", async () => {
  const root = tempDir("oca-store-map-");
  try {
    const { Store } = await import("../src/store.js");
    const store = new Store(root);
    const storage = new LocalStorage({ root });
    const id = "11111111-2222-4333-8444-555555555555";
    assert.equal(
      storage.localFile(captureKey(id, "model.glb")),
      path.join(store.captureDir(id), "model.glb"),
      "the storage key and the worker's output path must be the same file, or the publish step would copy forever",
    );
    assert.equal(storage.localFile(captureKey(id, "images/frame_001.jpg")), path.join(store.captureDir(id), "images", "frame_001.jpg"));
    store.db.close?.();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The local driver
// ---------------------------------------------------------------------------

test("local: put, head, open, list and remove round-trip", async () => {
  const root = tempDir("oca-store-local-");
  try {
    const storage = new LocalStorage({ root });
    const key = captureKey("abc", "result.json");
    await storage.put(key, Buffer.from('{"state":"completed"}'), { contentType: "application/json" });

    assert.equal((await storage.head(key)).length, Buffer.byteLength('{"state":"completed"}'));
    assert.equal(await storage.head(captureKey("abc", "missing.json")), null);

    const found = await storage.open(key);
    assert.equal((await readAll(found.stream)).toString(), '{"state":"completed"}');
    assert.equal(found.contentType, "application/json");

    const listed = await storage.list();
    assert.deepEqual(listed.map((o) => o.key), ["captures/abc/result.json"]);

    assert.equal(await storage.remove(key), true);
    assert.equal(await storage.remove(key), true, "removing something already gone is not an error");
    assert.deepEqual(await storage.list(), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local: putFile of a file already at its own key is a no-op, not a duplicate", async () => {
  const root = tempDir("oca-store-nop-");
  try {
    const storage = new LocalStorage({ root });
    const key = captureKey("abc", "model.glb");
    const file = storage.localFile(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "glTF");
    const before = fs.statSync(file).mtimeMs;
    const info = await storage.putFile(key, file);
    assert.equal(info.bytes, 4);
    assert.equal(fs.readFileSync(file, "utf8"), "glTF");
    assert.equal(fs.statSync(file).mtimeMs, before, "the file must not be rewritten");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local: a key cannot escape the storage root", async () => {
  const root = tempDir("oca-store-escape-");
  try {
    const storage = new LocalStorage({ root });
    for (const bad of ["../outside.txt", "/etc/passwd", "captures/..%2f..", "a\\b"]) {
      await assert.rejects(() => storage.put(bad, Buffer.from("x")), /not allowed/);
    }
    assert.equal(fs.existsSync(path.join(path.dirname(root), "outside.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The Backblaze B2 driver, request by request
// ---------------------------------------------------------------------------

test("b2: authorises once, takes the bucket from the key, and uploads with the documented headers", async () => {
  const stub = await startB2Stub();
  try {
    const storage = driver(stub);
    const key = captureKey("cap-1", "images/frame_001.jpg");
    const bytes = Buffer.from("a photograph, honest");

    const info = await storage.put(key, bytes, { contentType: "image/jpeg" });
    assert.equal(info.bytes, bytes.length);
    assert.ok(info.fileId, "the upload response carries the file id");

    // b2_authorize_account: Basic auth, base64(keyId:applicationKey).
    const auth = stub.seen("/b2api/v4/b2_authorize_account");
    assert.equal(auth.length, 1);
    assert.equal(
      auth[0].headers.authorization,
      `Basic ${Buffer.from(`${stub.keyId}:${stub.applicationKey}`).toString("base64")}`,
    );

    // b2_get_upload_url: authenticated with the account token, bucketId in the query.
    const uploadUrl = stub.seen("/b2api/v4/b2_get_upload_url");
    assert.equal(uploadUrl.length, 1);
    assert.equal(uploadUrl[0].query.bucketId, stub.bucketId);
    assert.match(uploadUrl[0].headers.authorization, /^acct-/);
    assert.equal(stub.state.listBucketsCount, 0, "a bucket-restricted key already names its bucket");

    // b2_upload_file: the file name percent-encoded, the SHA1 B2 verifies,
    // the content type, and a Content-Length that matches the body.
    const upload = stub.seen(`/upload/${stub.bucketId}`);
    assert.equal(upload.length, 1);
    assert.equal(upload[0].method, "POST");
    assert.equal(decodeURIComponent(upload[0].headers["x-bz-file-name"]), `captures/cap-1/images/frame_001.jpg`);
    assert.equal(upload[0].headers["x-bz-content-sha1"], crypto.createHash("sha1").update(bytes).digest("hex"));
    assert.equal(upload[0].headers["content-type"], "image/jpeg");
    assert.equal(Number(upload[0].headers["content-length"]), bytes.length);
    assert.equal(stub.get("captures/cap-1/images/frame_001.jpg").bytes.toString(), bytes.toString());

    // A second object reuses the same token and upload URL: one exchange, two files.
    await storage.put(captureKey("cap-1", "images/frame_002.jpg"), Buffer.from("another"));
    assert.equal(stub.state.authorizeCount, 1, "the account token is cached, not re-fetched per file");
    assert.equal(stub.state.uploadUrlCount, 1, "the upload URL is valid for 24 hours and is reused");
    assert.deepEqual(stub.names(), [
      "captures/cap-1/images/frame_001.jpg",
      "captures/cap-1/images/frame_002.jpg",
    ]);
  } finally {
    await stub.close();
  }
});

test("b2: a file name with spaces and non-ASCII characters survives the round trip", async () => {
  const stub = await startB2Stub();
  try {
    const storage = driver(stub);
    const key = captureKey("cap-2", "images/a photo — ünïcode.jpg");
    const bytes = Buffer.from("bytes");
    await storage.put(key, bytes, { contentType: "image/jpeg" });

    const upload = stub.seen(`/upload/${stub.bucketId}`)[0];
    assert.match(upload.headers["x-bz-file-name"], /%20/, "a space must be percent-encoded on the wire");
    assert.doesNotMatch(upload.headers["x-bz-file-name"], / /, "no raw space may be sent as a header value");
    assert.deepEqual(stub.names(), ["captures/cap-2/images/a photo — ünïcode.jpg"]);

    const found = await storage.open(key);
    assert.equal((await readAll(found.stream)).toString(), "bytes");
  } finally {
    await stub.close();
  }
});

test("b2: reads, range reads, and a missing object is null rather than an exception", async () => {
  const stub = await startB2Stub();
  try {
    const storage = driver(stub);
    const key = captureKey("cap-3", "model.glb");
    await storage.put(key, Buffer.from("glTF-and-more"), { contentType: "model/gltf-binary" });

    const head = await storage.head(key);
    assert.equal(head.length, 13);
    assert.equal(head.contentType, "model/gltf-binary");

    const whole = await storage.open(key);
    assert.equal(whole.status, 200);
    assert.equal((await readAll(whole.stream)).toString(), "glTF-and-more");

    const ranged = await storage.open(key, { range: "bytes=0-3" });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.length, 4);
    assert.equal((await readAll(ranged.stream)).toString(), "glTF");

    assert.equal(await storage.open(captureKey("cap-3", "absent.glb")), null);
    assert.equal(await storage.head(captureKey("cap-3", "absent.glb")), null);
  } finally {
    await stub.close();
  }
});

test("b2: lists by prefix and deletes by (fileName, fileId)", async () => {
  const stub = await startB2Stub();
  try {
    const storage = driver(stub);
    await storage.put(captureKey("cap-4", "model.glb"), Buffer.from("m"));
    await storage.put(captureKey("cap-4", "result.json"), Buffer.from("{}"));
    await storage.put(captureKey("cap-5", "model.glb"), Buffer.from("m"));
    assert.equal(stub.names().length, 3);

    const listed = await storage.list("captures/cap-4/");
    assert.deepEqual(listed.map((o) => o.key), ["captures/cap-4/model.glb", "captures/cap-4/result.json"]);
    const model = listed.find((o) => o.key.endsWith("model.glb"));
    assert.ok(model.fileId, "a listing carries the file id a delete needs");

    const listRequest = stub.seen("/b2api/v4/b2_list_file_names").at(-1);
    assert.equal(listRequest.query.prefix, "captures/cap-4/", "the prefix is what restricts the listing");

    // No file id in hand: the driver looks it up itself before deleting.
    assert.equal(await storage.remove("captures/cap-4/result.json"), true);
    const del = stub.seen("/b2api/v4/b2_delete_file_version").at(-1);
    const asked = JSON.parse(del.body.toString("utf8"));
    assert.equal(asked.fileName, "captures/cap-4/result.json");
    assert.ok(asked.fileId, "b2_delete_file_version requires the file id, so it must be looked up");

    // Removing something that is not there reports false, never throws.
    assert.equal(await storage.remove("captures/cap-4/nothing-here.json"), false);
    assert.deepEqual(stub.names(), ["captures/cap-4/model.glb", "captures/cap-5/model.glb"]);
  } finally {
    await stub.close();
  }
});

test("b2: an expired token is answered by re-authorising once, not by failing", async () => {
  const stub = await startB2Stub();
  try {
    const storage = driver(stub);
    await storage.put(captureKey("cap-6", "a.txt"), Buffer.from("first"));
    assert.equal(stub.state.authorizeCount, 1);

    // Everything issued so far is now stale -- what a 24-hour expiry looks like.
    stub.state.epoch += 1;

    await storage.put(captureKey("cap-6", "b.txt"), Buffer.from("second"));
    assert.equal(stub.state.authorizeCount, 2, "it must ask for a new token, once");
    assert.equal(stub.state.uploadUrlCount, 2, "and for a new upload URL with it");
    assert.equal(stub.get("captures/cap-6/b.txt").bytes.toString(), "second");

    // A read after the same expiry also recovers.
    const found = await storage.open(captureKey("cap-6", "a.txt"));
    assert.ok(found, "the object is still readable through a fresh token");
    assert.equal((await readAll(found.stream)).toString(), "first");
  } finally {
    await stub.close();
  }
});

test("b2: a rejected checksum is surfaced with B2's own error, never swallowed", async () => {
  const stub = await startB2Stub();
  try {
    const storage = driver(stub);
    stub.state.rejectSha1 = true;
    await assert.rejects(
      () => storage.put(captureKey("cap-7", "model.glb"), Buffer.from("corrupt")),
      (err) => {
        assert.match(err.message, /Sha1 did not match/);
        assert.equal(err.b2.code, "bad_request");
        return true;
      },
    );
    assert.deepEqual(stub.names(), [], "nothing may be stored when the store refused it");

    // The same request succeeds once the store accepts the checksum.
    stub.state.rejectSha1 = false;
    await storage.put(captureKey("cap-7", "model.glb"), Buffer.from("corrupt"));
    assert.deepEqual(stub.names(), ["captures/cap-7/model.glb"]);
  } finally {
    await stub.close();
  }
});

test("b2: an unrestricted key resolves its bucket through b2_list_buckets", async () => {
  const stub = await startB2Stub({ unrestrictedKey: true });
  try {
    const storage = driver(stub);
    assert.equal((await storage.authorise()).buckets.length, 0, "this key names no bucket");
    await storage.put(captureKey("cap-8", "model.glb"), Buffer.from("m"));

    const listed = stub.seen("/b2api/v4/b2_list_buckets");
    assert.equal(listed.length, 1);
    assert.equal(JSON.parse(listed[0].body.toString("utf8")).bucketName, stub.bucketName);
    assert.equal(stub.state.listBucketsCount, 1, "and it is asked once, then cached");
    await storage.put(captureKey("cap-8", "result.json"), Buffer.from("{}"));
    assert.equal(stub.state.listBucketsCount, 1);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// The API with B2 configured
//
// The stand-in worker writes a real GLB and a real result.json and exits 0, so
// the publish step runs for real: nothing here is a mock of the code under
// test, only of the two things that need an account or a deletion (Backblaze
// itself, and the reconstruction).
// ---------------------------------------------------------------------------

let stub;
let server;
let base;
let dataDir;
let toolDir;
let cookie;

const STANDIN_WORKER = [
  "#!/usr/bin/env python3",
  "import json, sys",
  "args = sys.argv[1:]",
  "with open(args[args.index('--job') + 1]) as f:",
  "    job = json.load(f)",
  "print(json.dumps({'event': 'stage', 'stage': 'feature', 'note': 'stand-in', 'progress': 1.0}), flush=True)",
  "print(json.dumps({'event': 'stage', 'stage': 'sfm', 'note': 'stand-in', 'progress': 1.0}), flush=True)",
  "with open(job['outputs']['glb_path'], 'wb') as f:",
  "    f.write(b'glTF' + (2).to_bytes(4, 'little') + bytes(2040))",
  "with open(job['outputs']['result_json'], 'w') as f:",
  "    json.dump({'state': 'completed', 'manifest': {'vertex_count': 3, 'triangle_count': 1,",
  "               'stage_seconds': {'sfm': 0.2}}, 'error': None}, f)",
  "print(json.dumps({'event': 'job_finished', 'elapsed_seconds': 0.2}), flush=True)",
  "",
].join("\n");

function dataUrls(count) {
  const dir = path.join(fixtureDir, "images");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort().slice(0, count);
  return files.map((f) => ({
    name: f,
    bytes: fs.readFileSync(path.join(dir, f)),
    dataUrl: `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, f)).toString("base64")}`,
  }));
}

test.before(async () => {
  stub = await startB2Stub();
  dataDir = tempDir("oca-store-api-");
  toolDir = tempDir("oca-store-bin-");
  const worker = path.join(toolDir, "standin_worker.py");
  fs.writeFileSync(worker, STANDIN_WORKER);
  fs.chmodSync(worker, 0o755);

  // Config is read at import time, so the environment comes first.
  process.env.DATA_DIR = dataDir;
  process.env.PYTHON = worker;
  process.env.JOB_TIMEOUT_SECONDS = "60";
  // This file creates more captures than a real client would be allowed in one
  // window; the upload budget has its own gate in api.test.js.
  process.env.UPLOAD_BURST = "100";
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
    body: JSON.stringify({ email: "storage@example.com", password: "storage-test-pass" }),
  });
  assert.equal(signup.status, 201, `the storage gate needs an account: ${await signup.clone().text()}`);
  cookie = (signup.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
});

test.after(async () => {
  if (server) {
    server.runner.queue.length = 0; // nothing may be pumped after the kill
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
  for (const dir of [dataDir, toolDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function createCapture(name) {
  const images = dataUrls(3);
  const res = await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name, images: images.map((i) => i.dataUrl) }),
  });
  return { res, images };
}

async function waitForCompletion(id, timeoutMs = 30_000, jar = cookie) {
  const deadline = Date.now() + timeoutMs;
  let record = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    record = await (await fetch(`${base}/api/captures/${id}`, { headers: { cookie: jar } })).json();
    if (["completed", "failed", "cancelled"].includes(record.status)) break;
  }
  return record;
}

test("health reports the storage driver actually in use, without the key", async () => {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.storage.kind, "b2");
  assert.equal(health.storage.durable, true);
  assert.equal(health.storage.bucket, stub.bucketName);
  assert.deepEqual(health.storage.warnings, []);
  assert.equal(
    JSON.stringify(health).includes(stub.applicationKey),
    false,
    "the application key must never appear in a response",
  );
});

test("the photographs are stored in the bucket as they are uploaded", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  const { res, images } = await createCapture("stored photographs");
  assert.equal(res.status, 202, await res.clone().text());
  const { id } = await res.json();

  const names = images.map((_, i) => `captures/${id}/images/frame_${String(i + 1).padStart(3, "0")}.jpg`);
  for (const [index, name] of names.entries()) {
    const object = stub.get(name);
    assert.ok(object, `${name} must be in the bucket; bucket holds ${stub.names().join(", ")}`);
    assert.equal(object.contentType, "image/jpeg", "the stored content type follows the file extension");
    assert.equal(
      object.bytes.equals(images[index].bytes),
      true,
      "the stored bytes must be the photograph that was uploaded, not a re-encode",
    );
  }
});

test("the model and the result are stored before the capture is called completed", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  const { res } = await createCapture("published artifacts");
  const { id } = await res.json();
  const record = await waitForCompletion(id);
  assert.equal(record.status, "completed", `capture ended as ${record.status}: ${JSON.stringify(record.error)}`);
  assert.match(record.note, /2 artifacts stored/, "the note says what was stored, not just that it finished");

  const model = stub.get(`captures/${id}/model.glb`);
  const result = stub.get(`captures/${id}/result.json`);
  assert.ok(model, `the model must be in the bucket; holds ${stub.names().join(", ")}`);
  assert.ok(result, "result.json must be in the bucket");
  assert.equal(model.bytes.subarray(0, 4).toString("latin1"), "glTF");
  assert.equal(model.contentType, "model/gltf-binary");
  assert.equal(JSON.parse(result.bytes.toString("utf8")).state, "completed");

  // A body that ends in a completed capture must have its bytes already there;
  // that is the whole point of storing before publishing.
  assert.equal(
    server.store.get(id).status,
    "completed",
    "the store agrees the artifacts are durable",
  );
});

test("the model is still served after the host's own copy is gone", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  const { res } = await createCapture("survives its host");
  const { id } = await res.json();
  assert.equal((await waitForCompletion(id)).status, "completed");

  // Prove the read really comes from the bucket: there is no remote local file
  // for this driver, and the working copy is about to disappear.
  assert.equal(server.storage.localFile(), null, "a remote driver has no local file for an object");
  const local = path.join(dataDir, "captures", id, "model.glb");
  fs.rmSync(local, { force: true });
  assert.equal(fs.existsSync(local), false);

  const fetched = await fetch(`${base}/api/captures/${id}/model.glb`, { headers: { cookie } });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get("content-type"), "model/gltf-binary");
  const bytes = Buffer.from(await fetched.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "glTF");
  assert.equal(bytes.length, 2048, "the whole object, not a prefix");

  // And the second-phone path works from the bucket too: a cookie-less reader
  // holding the share token gets the model, with the local copy still gone.
  const share = await (
    await fetch(`${base}/api/captures/${id}/share`, { method: "POST", headers: { cookie } })
  ).json();
  const viaToken = await fetch(`${base}/api/captures/${id}/model.glb?t=${share.share_token}`);
  assert.equal(viaToken.status, 200, "a shared link must be served from the stored object");
  assert.equal((await viaToken.arrayBuffer()).byteLength, 2048);
});

test("a capture whose photographs cannot be stored is refused, not accepted and lost", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  const capturesDir = path.join(dataDir, "captures");
  const before = stub.names().length;
  const dirsBefore = fs.readdirSync(capturesDir).sort();
  stub.state.failUploads = true;
  try {
    const { res } = await createCapture("never stored");
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error.message, /could not be stored in the object store/);
    assert.match(body.error.message, /storage unavailable/);
  } finally {
    stub.state.failUploads = false;
  }
  assert.equal(stub.names().length, before, "no object may be left in the bucket by a refused capture");
  assert.deepEqual(
    fs.readdirSync(capturesDir).sort(),
    dirsBefore,
    "and no working directory may be left behind by a refused capture",
  );
});

test("a reconstruction whose model cannot be stored is failed, never completed", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  // The photographs store fine; only the model is refused. The capture must end
  // failed with the storage stage named, because "completed" would promise a
  // model that is not in the bucket.
  stub.state.failUploadFor = (name) => name.endsWith("model.glb");
  try {
    const { res } = await createCapture("model cannot be stored");
    assert.equal(res.status, 202, "the upload itself is fine");
    const { id } = await res.json();
    const record = await waitForCompletion(id);
    assert.equal(record.status, "failed");
    assert.equal(record.error.stage, "storage");
    assert.match(record.error.message, /could not be stored/);
    assert.equal(stub.get(`captures/${id}/model.glb`), null);

    const glb = await fetch(`${base}/api/captures/${id}/model.glb`, { headers: { cookie } });
    assert.equal(glb.status, 409, "no model may be served for a capture whose model was not stored");
  } finally {
    stub.state.failUploadFor = null;
  }
});

test("once published, the raw photographs leave the working copy but the model stays cached", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  const { res, images } = await createCapture("pruned working copy");
  assert.equal(res.status, 202);
  const { id } = await res.json();
  assert.equal((await waitForCompletion(id)).status, "completed");

  // The photographs really were stored first -- pruning is only ever allowed to
  // drop a local copy of bytes the bucket already holds.
  for (const [index] of images.entries()) {
    const name = `captures/${id}/images/frame_${String(index + 1).padStart(3, "0")}.jpg`;
    assert.ok(stub.get(name), `${name} must be in the bucket`);
  }

  const dir = path.join(dataDir, "captures", id);
  assert.equal(fs.existsSync(path.join(dir, "work")), false, "the worker's scratch directory is disposable");
  assert.equal(
    fs.existsSync(path.join(dir, "images")),
    false,
    "the photographs live in the bucket now and nothing reads them after the run",
  );
  assert.equal(fs.existsSync(path.join(dir, "model.glb")), true, "the model stays local as a warm cache");
  assert.equal(fs.existsSync(path.join(dir, "result.json")), true);

  // And the capture is still completely usable from the local cache.
  const glb = await fetch(`${base}/api/captures/${id}/model.glb`, { headers: { cookie } });
  assert.equal(glb.status, 200);
  assert.equal((await glb.arrayBuffer()).byteLength, 2048);
});

test("deleting an account removes the objects it owned, and only those", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  // A second account, so the one every other test uses is left intact.
  const password = "delete-me-please";
  const signup = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "delete-me@example.com", password }),
  });
  assert.equal(signup.status, 201, `the deletion test needs an account: ${await signup.clone().text()}`);
  const doomedCookie = (signup.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  const created = await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: doomedCookie },
    body: JSON.stringify({ name: "to be deleted", images: dataUrls(3).map((i) => i.dataUrl) }),
  });
  assert.equal(created.status, 202, await created.clone().text());
  const { id } = await created.json();
  assert.equal((await waitForCompletion(id, 30_000, doomedCookie)).status, "completed");

  const mine = stub.names().filter((name) => name.startsWith(`captures/${id}/`));
  assert.ok(mine.length >= 3, `the bucket should hold the photographs and artifacts: ${mine.join(", ")}`);
  const othersBefore = stub.names().filter((name) => !name.startsWith(`captures/${id}/`));
  assert.ok(othersBefore.length > 0, "another capture's objects exist and must be left alone");

  const deleted = await fetch(`${base}/api/auth/account`, {
    method: "DELETE",
    headers: { "content-type": "application/json", cookie: doomedCookie },
    body: JSON.stringify({ password }),
  });
  assert.equal(deleted.status, 200, `deletion was refused: ${await deleted.clone().text()}`);
  const body = await deleted.json();
  assert.ok(
    body.objects_deleted >= mine.length,
    `reported ${body.objects_deleted} objects removed of the ${mine.length} the capture owned`,
  );

  assert.deepEqual(
    stub.names().filter((name) => name.startsWith(`captures/${id}/`)),
    [],
    "every object of the deleted account is gone from the bucket",
  );
  assert.deepEqual(
    stub.names().filter((name) => !name.startsWith(`captures/${id}/`)),
    othersBefore,
    "another account's objects are untouched",
  );
  assert.equal(server.store.get(id), null, "and the capture row is gone");
  assert.equal(fs.existsSync(path.join(dataDir, "captures", id)), false, "and so is its working directory");
});
