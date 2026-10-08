// The job runner: what a restart does to work in flight, and what a finished
// run leaves behind.
//
//   node --test apps/api/test/worker.test.js
//
// The claims gated here, the first of which used to be false:
//
//   * The queue lives in memory. A capture that was `queued` (or `running`) when
//     the process stopped is stranded by a restart: nothing re-enqueues it, so
//     it reads as "in progress" for ever and the user can neither get it nor
//     clear it. This file reproduces that first.
//   * `recover()` -- called from `start()` on boot, never from `createServer` --
//     re-queues exactly the unfinished captures and runs them again from the
//     start, because their inputs are still on disk. Terminal captures are left
//     alone.
//   * A finished run prunes its scratch directory always, and its raw
//     photographs too once a durable store holds them; it keeps the published
//     model and result locally as a warm cache. With no durable store the
//     photographs are never touched -- there they are the only copy.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The stand-in worker lives outside every dataDir, so a test that removes its
// dataDir cannot delete the interpreter out from under the next one.
const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "oca-worker-bin-"));
process.on("exit", () => fs.rmSync(toolDir, { recursive: true, force: true }));

const STANDIN_WORKER = [
  "#!/usr/bin/env python3",
  "import json, sys",
  "args = sys.argv[1:]",
  "with open(args[args.index('--job') + 1]) as f:",
  "    job = json.load(f)",
  "print(json.dumps({'event': 'stage', 'stage': 'feature', 'note': 'stand-in', 'progress': 1.0}), flush=True)",
  "print(json.dumps({'event': 'stage', 'stage': 'sfm', 'note': 'stand-in', 'progress': 1.0}), flush=True)",
  "with open(job['outputs']['glb_path'], 'wb') as f:",
  "    f.write(b'glTF' + (2).to_bytes(4, 'little') + bytes(100))",
  "with open(job['outputs']['result_json'], 'w') as f:",
  "    json.dump({'state': 'completed', 'manifest': {'vertex_count': 3, 'triangle_count': 1}}, f)",
  "print(json.dumps({'event': 'job_finished', 'elapsed_seconds': 0.2}), flush=True)",
  "",
].join("\n");

const worker = path.join(toolDir, "standin_worker.py");
fs.writeFileSync(worker, STANDIN_WORKER);
fs.chmodSync(worker, 0o755);

// Config is read at import time, so the environment must be set first.
process.env.PYTHON = worker;
process.env.JOB_TIMEOUT_SECONDS = "30";

const { Store } = await import("../src/store.js");
const { WorkerRunner } = await import("../src/worker.js");

const quiet = { log() {}, warn() {}, error() {} };

/**
 * A store on its own data directory, plus the runners built over it. close()
 * stops every runner before the database goes: a child's close handler writes
 * to the store, and closing underneath it is what makes a passing test emit an
 * unhandled rejection.
 */
function withStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oca-worker-"));
  const store = new Store(dataDir);
  const runners = [];
  return {
    dataDir,
    store,
    runner(options = {}) {
      const runner = new WorkerRunner(store, { logger: quiet, ...options });
      runners.push(runner);
      return runner;
    },
    async close() {
      for (const runner of runners) {
        runner.queue.length = 0;
        for (const [, child] of runner.running) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      await new Promise((r) => setTimeout(r, 200));
      try {
        store.db.close?.();
      } catch {
        // already closed
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A capture row, without going through the API; the runner reads the row. */
function createCapture(store, name) {
  const id = crypto.randomUUID();
  store.create({
    id,
    name,
    imageCount: 2,
    calibration: null,
    dir: store.captureDir(id),
    userId: "user-1",
  });
  return store.get(id);
}

async function waitFor(predicate, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for the runner");
}

const TERMINAL = (record) => Boolean(record) && ["completed", "failed", "cancelled"].includes(record.status);

test("a capture left unfinished by a restart stays stuck on its own", async () => {
  const env = withStore();
  try {
    const capture = createCapture(env.store, "orphan");
    // A new runner over the existing data directory: the queue is empty even
    // though the store still says this capture is waiting.
    const runner = env.runner();
    assert.equal(runner.queue.length, 0);

    await new Promise((r) => setTimeout(r, 300));
    const after = env.store.get(capture.id);
    assert.equal(
      after.status,
      "queued",
      "nothing re-enqueues it: the queue died with the process, which is the defect recover() fixes",
    );
    assert.equal(after.stage, "queued");
  } finally {
    await env.close();
  }
});

test("recovery re-queues unfinished captures and leaves terminal ones alone", async () => {
  const env = withStore();
  try {
    const queued = createCapture(env.store, "was queued");
    const running = createCapture(env.store, "was running");
    env.store.update(running.id, {
      status: "running",
      stage: "sfm",
      note: "worker: sfm",
      progress: 0.4,
      elapsed_seconds: 12,
    });
    const finished = createCapture(env.store, "already finished");
    env.store.update(finished.id, { status: "completed", stage: "done", progress: 1 });
    const failed = createCapture(env.store, "already failed");
    env.store.update(failed.id, { status: "failed", stage: "worker" });

    const runner = env.runner();
    // Hold the single worker slot so the re-queued rows can be inspected before
    // a worker overwrites them: recover() respects the concurrency limit, which
    // is also what stops it from spawning every stranded capture at once.
    runner.running.set("blocker", { kill() {} });
    assert.equal(runner.recover(), 2, "exactly the queued and running captures are re-queued");

    // The interrupted row is reset, not left mid-stage: a restarted run has no
    // progress to report until its worker says so again.
    for (const [id, expected] of [
      [queued.id, { status: "queued", stage: "queued", progress: null, elapsedSeconds: null }],
      [running.id, { status: "queued", stage: "queued", progress: null, elapsedSeconds: null }],
    ]) {
      const record = env.store.get(id);
      for (const [field, value] of Object.entries(expected)) {
        assert.equal(record[field], value, `${id}.${field} after recovery`);
      }
      assert.match(record.note, /re-queued after the API restarted/);
      assert.equal(record.workerCode, null);
      assert.equal(record.error, null);
    }

    // Release the slot: they really do run again, and reach a terminal state.
    runner.running.delete("blocker");
    runner.pump();
    await waitFor(() => TERMINAL(env.store.get(queued.id)) && TERMINAL(env.store.get(running.id)));
    for (const id of [queued.id, running.id]) {
      const record = env.store.get(id);
      assert.equal(record.status, "completed", `${id} ended as ${record.status}`);
      assert.equal(record.workerCode, 0);
      assert.ok(fs.existsSync(path.join(record.dir, "model.glb")), "the rerun wrote a model");
    }

    // A second recovery on the same data directory finds nothing left to do.
    assert.equal(runner.recover(), 0, "recovery is not sticky");

    // Terminal captures were never touched.
    assert.equal(env.store.get(finished.id).status, "completed");
    assert.equal(env.store.get(finished.id).stage, "done");
    assert.equal(env.store.get(failed.id).status, "failed");
    assert.equal(env.store.get(failed.id).stage, "worker");
  } finally {
    await env.close();
  }
});

test("a finished run drops its scratch directory but keeps the only copy of its photographs", async () => {
  const env = withStore();
  try {
    const capture = createCapture(env.store, "local cleanup");
    env.runner().enqueue(capture.id);
    await waitFor(() => TERMINAL(env.store.get(capture.id)));
    assert.equal(env.store.get(capture.id).status, "completed");

    const dir = env.store.get(capture.id).dir;
    assert.equal(fs.existsSync(path.join(dir, "work")), false, "the worker's scratch directory is disposable");
    assert.equal(
      fs.existsSync(path.join(dir, "images")),
      true,
      "with no durable store these photographs are the only copy there is",
    );
    assert.equal(fs.existsSync(path.join(dir, "model.glb")), true);
    assert.equal(fs.existsSync(path.join(dir, "result.json")), true);
  } finally {
    await env.close();
  }
});

test("with a durable store the published photographs are pruned, and the model is kept as a cache", async () => {
  const env = withStore();
  try {
    const uploaded = [];
    const storage = {
      describe: () => ({ kind: "stand-in", durable: true }),
      localFile: () => null,
      open: async () => null,
      putFile: async (key) => {
        uploaded.push(key);
        return { key, bytes: 1 };
      },
    };
    const capture = createCapture(env.store, "durable cleanup");
    env.runner({ storage }).enqueue(capture.id);
    await waitFor(() => TERMINAL(env.store.get(capture.id)));
    assert.equal(env.store.get(capture.id).status, "completed");

    // Both artifacts were published before the capture was called complete.
    assert.deepEqual(uploaded.sort(), [
      `captures/${capture.id}/model.glb`,
      `captures/${capture.id}/result.json`,
    ]);

    const dir = env.store.get(capture.id).dir;
    assert.equal(fs.existsSync(path.join(dir, "work")), false);
    assert.equal(
      fs.existsSync(path.join(dir, "images")),
      false,
      "the photographs are in the durable store now and nothing reads them after the run",
    );
    assert.equal(fs.existsSync(path.join(dir, "model.glb")), true, "the model stays local as a warm cache");
    assert.equal(fs.existsSync(path.join(dir, "result.json")), true);
  } finally {
    await env.close();
  }
});

test("KEEP_LOCAL_COPIES leaves the photographs on disk even with a durable store", async () => {
  const env = withStore();
  try {
    const storage = {
      describe: () => ({ kind: "stand-in", durable: true }),
      localFile: () => null,
      open: async () => null,
      putFile: async () => ({}),
    };
    const capture = createCapture(env.store, "kept copies");
    env.runner({ storage, keepLocalCopies: true }).enqueue(capture.id);
    await waitFor(() => TERMINAL(env.store.get(capture.id)));
    assert.equal(env.store.get(capture.id).status, "completed");

    const dir = env.store.get(capture.id).dir;
    assert.equal(fs.existsSync(path.join(dir, "images")), true);
    assert.equal(fs.existsSync(path.join(dir, "work")), false, "the scratch directory goes regardless");
  } finally {
    await env.close();
  }
});
