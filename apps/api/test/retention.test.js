// Retention: the two cases where a capture is removed without its owner asking.
//
//   node --test apps/api/test/retention.test.js
//
//   * an upload that never finished (a direct-to-store row with no bytes) is
//     reaped on a short clock, because it is unusable by definition;
//   * a capture older than the configured TTL is removed -- and the TTL is off
//     by default, because expiring somebody's reconstruction on a timer is a
//     product decision, not housekeeping.
//
// Removal has to mean the same thing here as everywhere else: the row, the
// stored objects and the local working directory go together, and a capture
// that is still queued or running is cancelled before its directory disappears.
// Nothing in this file contacts a network service.
//
// Rows are aged with a direct UPDATE rather than by waiting: the rules are
// about elapsed time, so `now` is passed in and the timestamps are set to match.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { Store } = await import("../src/store.js");
const { LocalStorage, captureKey } = await import("../src/storage.js");
const { Retention } = await import("../src/retention.js");

const quiet = { log() {}, warn() {}, error() {} };

/** A fixed clock, so an "old" row means the same thing on every run. */
const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oca-retention-"));
}

/**
 * A store and a retention rule over the same directory, with a storage and a
 * runner that record what they are asked to do.
 */
function makeEnv({ ttlDays = 0, abandonedMinutes = 60 } = {}, { storage } = {}) {
  const root = tempDir();
  const store = new Store(root);
  const removedPrefixes = [];
  const cancelled = [];
  const activeStorage =
    storage ??
    {
      kind: "recording",
      durable: true,
      supportsDirectUploads: false,
      describe: () => ({ kind: "recording", durable: true }),
      localFile: (key) => path.join(root, key),
      async removeAll(prefix) {
        removedPrefixes.push(prefix);
        return 2;
      },
    };
  const runner = {
    cancel(id) {
      cancelled.push(id);
      return { ok: true, was: "running" };
    },
  };
  const retention = new Retention(store, {
    storage: activeStorage,
    runner,
    logger: quiet,
    ttlDays,
    abandonedMinutes,
  });
  return {
    root,
    store,
    storage: activeStorage,
    retention,
    removedPrefixes,
    cancelled,
    close() {
      try {
        store.db.close?.();
      } catch {
        // already closed
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function createCapture(env, name, { status = "queued", ageMs = 0, withFiles = false } = {}) {
  const id = crypto.randomUUID();
  const dir = env.store.captureDir(id);
  env.store.create({
    id,
    name,
    imageCount: 2,
    calibration: null,
    dir,
    userId: "user-1",
    status,
    pendingUploads: status === "uploading" ? [{ name: "frame_001.jpg", contentType: "image/jpeg", bytes: 10 }] : null,
  });
  if (withFiles) {
    fs.mkdirSync(path.join(dir, "images"), { recursive: true });
    fs.writeFileSync(path.join(dir, "images", "frame_001.jpg"), "jpeg-bytes");
    fs.writeFileSync(path.join(dir, "model.glb"), "glTF");
  }
  age(env.store, id, NOW - ageMs);
  return env.store.get(id);
}

/** Set both timestamps directly: `update()` would stamp `updated_at` as now. */
function age(store, id, atMs) {
  store.db
    .prepare("UPDATE captures SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(atMs, atMs, id);
}

test("the policy is stated, and is off for captures by default", async () => {
  const defaults = makeEnv();
  try {
    // The shipped defaults: keep a capture until its owner deletes it, but
    // always reap an upload nobody finished.
    assert.deepEqual(defaults.retention.describe(), {
      captureTtlDays: 0,
      uploadAbandonedMinutes: 60,
      enabled: true,
    });
    const off = makeEnv({ ttlDays: 0, abandonedMinutes: 0 });
    try {
      assert.equal(off.retention.describe().enabled, false, "both rules can be off");
    } finally {
      off.close();
    }
  } finally {
    defaults.close();
  }
});

test("an upload nobody finished is reaped; a recent one is left alone", async () => {
  const env = makeEnv({ ttlDays: 0, abandonedMinutes: 60 });
  try {
    const stale = createCapture(env, "abandoned", { status: "uploading", ageMs: 2 * HOUR });
    const recent = createCapture(env, "still uploading", { status: "uploading", ageMs: 5 * 60 * 1000 });

    const result = await env.retention.sweep({ now: NOW });
    assert.deepEqual(result, { abandoned: 1, expired: 0, removed: 1, objects: 2 });
    assert.equal(env.store.get(stale.id), null);
    assert.ok(env.store.get(recent.id), "five minutes is not abandoned");
    assert.deepEqual(env.removedPrefixes, [captureKey(stale.id, "")]);
  } finally {
    env.close();
  }
});

test("with no TTL configured, an old capture survives the sweep", async () => {
  const env = makeEnv({ ttlDays: 0, abandonedMinutes: 60 });
  try {
    const ancient = createCapture(env, "kept", { status: "completed", ageMs: 400 * DAY });
    const result = await env.retention.sweep({ now: NOW });
    assert.deepEqual(result, { abandoned: 0, expired: 0, removed: 0, objects: 0 });
    assert.ok(env.store.get(ancient.id), "the default is to keep it until the owner deletes it");
  } finally {
    env.close();
  }
});

test("a configured TTL removes what is older than it and keeps what is newer", async () => {
  const env = makeEnv({ ttlDays: 30, abandonedMinutes: 0 });
  try {
    const old = createCapture(env, "expired", { status: "completed", ageMs: 31 * DAY });
    const boundary = createCapture(env, "just inside", { status: "failed", ageMs: 30 * DAY - HOUR });
    const fresh = createCapture(env, "fresh", { status: "completed", ageMs: 2 * DAY });

    const result = await env.retention.sweep({ now: NOW });
    assert.deepEqual(result, { abandoned: 0, expired: 1, removed: 1, objects: 2 });
    assert.equal(env.store.get(old.id), null);
    assert.ok(env.store.get(boundary.id), "a second under the TTL is still inside it");
    assert.ok(env.store.get(fresh.id));
  } finally {
    env.close();
  }
});

test("a capture that is still running is cancelled before it is removed", async () => {
  const env = makeEnv({ ttlDays: 1, abandonedMinutes: 0 });
  try {
    const running = createCapture(env, "mid reconstruction", { status: "running", ageMs: 2 * DAY });
    const queued = createCapture(env, "waiting", { status: "queued", ageMs: 2 * DAY });
    const done = createCapture(env, "already done", { status: "completed", ageMs: 2 * DAY });

    const result = await env.retention.sweep({ now: NOW });
    assert.equal(result.removed, 3);
    // Exactly the two that a worker could still be holding.
    assert.deepEqual(env.cancelled.sort(), [queued.id, running.id].sort());
    for (const capture of [running, queued, done]) {
      assert.equal(env.store.get(capture.id), null);
    }
  } finally {
    env.close();
  }
});

test("the real local driver loses the objects and the working directory together", async () => {
  const root = tempDir();
  const store = new Store(root);
  try {
    const storage = new LocalStorage({ root });
    const retention = new Retention(store, {
      storage,
      runner: null,
      logger: quiet,
      ttlDays: 1,
      abandonedMinutes: 60,
    });

    const id = crypto.randomUUID();
    const dir = store.captureDir(id);
    store.create({ id, name: "stored", imageCount: 1, calibration: null, dir, userId: "u" });
    await storage.put(captureKey(id, "images/frame_001.jpg"), Buffer.from("jpeg-bytes"));
    await storage.put(captureKey(id, "model.glb"), Buffer.from("glTF"));
    fs.writeFileSync(path.join(dir, "job.json"), "{}");
    age(store, id, NOW - 3 * DAY);

    assert.equal((await storage.list(captureKey(id, ""))).length, 3, "the stored objects plus job.json");
    const result = await retention.sweep({ now: NOW });
    // With the local driver the store IS the working directory, so its listing
    // covers every file in it -- job.json included. The count is a fact about
    // what was removed, not a promise about which layer owns it.
    assert.deepEqual(result, { abandoned: 0, expired: 1, removed: 1, objects: 3 });
    assert.equal(store.get(id), null, "the row is gone");
    assert.deepEqual(await storage.list(captureKey(id, "")), [], "and so are the objects");
    assert.equal(fs.existsSync(dir), false, "and the working directory, job.json included");
  } finally {
    store.db.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the server reports the policy and can be swept through it", async () => {
  const root = tempDir();
  try {
    const { createServer } = await import("../src/server.js");
    const { Accounts } = await import("../src/accounts.js");
    const storage = new LocalStorage({ root });
    const store = new Store(root);
    const retention = new Retention(store, {
      storage,
      runner: null,
      logger: quiet,
      ttlDays: 7,
      abandonedMinutes: 30,
    });
    const server = createServer({ store, storage, retention, accounts: new Accounts(root) });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      // A deployment can be checked from outside without reading its config.
      const health = await (await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).json();
      assert.deepEqual(health.retention, {
        captureTtlDays: 7,
        uploadAbandonedMinutes: 30,
        enabled: true,
      });

      const id = crypto.randomUUID();
      store.create({
        id,
        name: "abandoned",
        imageCount: 1,
        calibration: null,
        dir: store.captureDir(id),
        userId: "u",
        status: "uploading",
        pendingUploads: [{ name: "frame_001.jpg", contentType: "image/jpeg", bytes: 4 }],
      });
      age(store, id, NOW - 90 * 60 * 1000);
      const result = await server.retention.sweep({ now: NOW });
      assert.equal(result.removed, 1);
      assert.equal(store.get(id), null);
    } finally {
      server.runner.queue.length = 0;
      await new Promise((r) => server.close(r));
      server.accounts.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
