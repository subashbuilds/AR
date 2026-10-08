// Verifies the job time limit with a stand-in "worker" that never finishes.
//
// node --test apps/api/test/timeout.test.js
//
// The point is that a stuck reconstruction is killed, frees the single worker
// slot, and is reported as a named failure with no model — never left queued
// forever and never silently treated as success.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..", "..");
const fixtureDir = process.env.FIXTURE_DIR || "/tmp/fx2";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oca-timeout-"));
const sleeper = path.join(dataDir, "slow_worker.py");
fs.writeFileSync(
  sleeper,
  "#!/usr/bin/env python3\nimport time\nprint('working', flush=True)\ntime.sleep(600)\n",
);
fs.chmodSync(sleeper, 0o755);

// Config is read at import time, so the environment must be set first.
process.env.DATA_DIR = dataDir;
process.env.PYTHON = sleeper;
process.env.JOB_TIMEOUT_SECONDS = "1";

const { createServer } = await import("../src/server.js");

function dataUrls(count) {
  const dir = path.join(fixtureDir, "images");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort().slice(0, count);
  return files.map((f) => `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, f)).toString("base64")}`);
}

test("a reconstruction that exceeds the time limit is killed and reported as failed", async (t) => {
  if (!fs.existsSync(path.join(fixtureDir, "images"))) {
    t.skip("fixture missing");
    return;
  }
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.limits.jobTimeoutSeconds, 1);

    // Captures require an account; the time limit is what is under test here.
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "timeout@example.com", password: "timeout-test-pass" }),
    });
    assert.equal(signup.status, 201, "the timeout gate needs an account");
    const cookie = (signup.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

    const created = await fetch(`${base}/api/captures`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "slow capture", images: dataUrls(3) }),
    });
    assert.equal(created.status, 202);
    const { id } = await created.json();

    const deadline = Date.now() + 30_000;
    let status;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      status = await (await fetch(`${base}/api/captures/${id}`, { headers: { cookie } })).json();
      if (status.status === "failed" || status.status === "completed") break;
    }

    assert.equal(status.status, "failed", "a hung worker must not succeed");
    assert.equal(status.error.stage, "timeout");
    assert.match(status.error.message, /exceeded the 1s limit/);
    assert.ok(status.elapsedSeconds < 30, "it should be killed promptly, not at the 600s sleep");

    const glb = await fetch(`${base}/api/captures/${id}/model.glb`, { headers: { cookie } });
    assert.equal(glb.status, 409, "no model may be served for a timed-out capture");
    assert.equal(server.runner.runningIds.length, 0, "the worker slot must be freed");
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});