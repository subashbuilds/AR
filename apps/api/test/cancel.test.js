// Verifies job cancellation end to end through the HTTP API.
//
//   node --test apps/api/test/cancel.test.js
//
// A capture can be cancelled while queued (dequeued, never started) and while
// running (worker stopped). Either way it must end in a named "cancelled"
// state — never "failed", never "completed", and the worker slot must be
// freed. The "worker" here is a Python script that traps SIGTERM and exits 3
// on request, which is exactly what run_job.py does not need to do today: the
// default of SIGTERM on a Python process is a non-zero exit.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = process.env.FIXTURE_DIR || "/tmp/fx2";

// The stand-in worker must live OUTSIDE the per-test dataDir: both tests share
// the module-level config, and a test that removes its dataDir would otherwise
// delete the interpreter out from under the next test.
const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "oca-cancel-bin-"));
process.on("exit", () => fs.rmSync(toolDir, { recursive: true, force: true }));
const sleeper = path.join(toolDir, "cancellable_worker.py");
fs.writeFileSync(
  sleeper,
  [
    "#!/usr/bin/env python3",
    "import signal, sys, time",
    "def bye(signum, frame):",
    "    print('stopping', flush=True)",
    "    sys.exit(3)",
    "signal.signal(signal.SIGTERM, bye)",
    "print('working', flush=True)",
    "time.sleep(600)",
    "",
  ].join("\n"),
);
fs.chmodSync(sleeper, 0o755);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oca-cancel-"));

// Config is read at import time, so the environment must be set first.
process.env.DATA_DIR = dataDir;
process.env.PYTHON = sleeper;
process.env.JOB_TIMEOUT_SECONDS = "600";

const { createServer } = await import("../src/server.js");

function dataUrls(count) {
  const dir = path.join(fixtureDir, "images");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort().slice(0, count);
  return files.map((f) => `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, f)).toString("base64")}`);
}

/**
 * Cancellation is the owner's action, so each test needs its own account: the
 * first test removes its dataDir on the way out, which takes accounts.db with
 * it, so a cookie cannot be shared between tests.
 */
async function signUp(base) {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "cancel@example.com", password: "cancel-test-pass" }),
  });
  assert.equal(res.status, 201, "the cancellation gate needs an account");
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}

async function waitFor(pred, base, id, cookie) {
  const deadline = Date.now() + 30_000;
  let status;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    status = await (await fetch(`${base}/api/captures/${id}`, { headers: { cookie } })).json();
    if (pred(status)) return status;
  }
  return status;
}

/**
 * Kill every worker the runner still holds, then give the close handlers a
 * moment. Without this, a deliberately unfinished worker (sleeping 600s) holds
 * the child's stdio pipes open and node --test would hang instead of exiting.
 */
async function stopRunner(runner) {
  for (const [, child] of runner.running) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 300));
}

test("a queued capture can be cancelled before it ever starts", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = await signUp(base);
  try {
    // Fill the single worker slot with a capture that never finishes, so the
    // second capture stays queued.
    const first = await fetch(`${base}/api/captures`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "occupier", images: dataUrls(3) }),
    });
    assert.equal(first.status, 202);
    const { id: busyId } = await first.json();
    await waitFor((s) => s.status === "running", base, busyId, cookie);

    const second = await fetch(`${base}/api/captures`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "queued victim", images: dataUrls(3) }),
    });
    assert.equal(second.status, 202);
    const { id: queuedId } = await second.json();
    await waitFor((s) => s.status === "queued", base, queuedId, cookie);

    const res = await fetch(`${base}/api/captures/${queuedId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.cancelled, true);
    assert.equal(body.was, "queued");

    const status = await (await fetch(`${base}/api/captures/${queuedId}`, { headers: { cookie } })).json();
    assert.equal(status.status, "cancelled");
    assert.equal(status.error.stage, "cancelled");
    assert.match(status.error.message, /while queued/);

    const glb = await fetch(`${base}/api/captures/${queuedId}/model.glb`, { headers: { cookie } });
    assert.equal(glb.status, 409, "no model for a cancelled capture");
    assert.equal(server.runner.runningIds.length, 1, "the occupier must keep its slot");
  } finally {
    await stopRunner(server.runner);
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a running capture can be cancelled and ends in a named cancelled state", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = await signUp(base);
  try {
    const created = await fetch(`${base}/api/captures`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "running victim", images: dataUrls(3) }),
    });
    assert.equal(created.status, 202);
    const { id } = await created.json();
    await waitFor((s) => s.status === "running", base, id, cookie);

    const res = await fetch(`${base}/api/captures/${id}`, { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).was, "running");

    const status = await waitFor((s) => s.status === "cancelled", base, id, cookie);
    assert.equal(status.status, "cancelled");
    assert.equal(status.error.stage, "cancelled");
    assert.match(status.error.message, /user's request/);
    assert.ok(status.elapsedSeconds < 30, "cancel must be prompt, not at the 600s sleep");
    assert.equal(server.runner.runningIds.length, 0, "the worker slot must be freed");

    // Terminal states cannot be cancelled again.
    const again = await fetch(`${base}/api/captures/${id}`, { method: "DELETE", headers: { cookie } });
    assert.equal(again.status, 409);
  } finally {
    await stopRunner(server.runner);
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
