// Reconstruction job runner.
//
// This is the only place that starts the Python worker. There is no mock path:
// if the worker cannot start, or exits non-zero, the capture is marked failed
// with the worker's own error message. Progress comes from the worker's
// structured stdout logs, not from a timer.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { config, workerEntrypoint } from "./config.js";
import { captureKey } from "./storage.js";

/**
 * Relative cost of each pipeline stage. These are static weights, not
 * measurements, so an overall percentage derived from them is an ESTIMATE. The
 * API marks such progress as `progress_source: "stage_weights"` and the client
 * labels it "estimated". Once a job finishes, `stage_seconds` from the worker
 * result refines the ETA of later jobs.
 */
export const STAGE_WEIGHTS = {
  validate_input: 0.02,
  feature: 0.2,
  sfm: 0.45,
  filter: 0.01,
  review: 0.01,
  surface: 0.03,
  texture: 0.08,
  calibrate: 0.001,
  export_glb: 0.01,
  validate_output: 0.02,
};

const TOTAL_WEIGHT = Object.values(STAGE_WEIGHTS).reduce((a, b) => a + b, 0);

/**
 * Progress weights. Static until a real job finishes; afterwards the worker's own
 * `stage_seconds` replaces the guess, so later jobs get a measured ETA instead of
 * a guess. Either way the client labels the number as an estimate.
 */
export function progressWeights(measuredSeconds) {
  if (!measuredSeconds || Object.keys(measuredSeconds).length === 0) {
    return { weights: STAGE_WEIGHTS, total: TOTAL_WEIGHT, source: "stage_weights" };
  }
  const total = Object.values(measuredSeconds).reduce((a, b) => a + b, 0);
  if (total <= 0) return { weights: STAGE_WEIGHTS, total: TOTAL_WEIGHT, source: "stage_weights" };
  const weights = {};
  for (const [k, v] of Object.entries(measuredSeconds)) weights[k] = v / total;
  return { weights, total: 1, source: "measured_stage_times" };
}

function weightDone(stagesDone, table) {
  const sum = stagesDone.reduce((acc, s) => acc + (table.weights[s] || 0), 0);
  return Math.min(sum / table.total, 0.99);
}

export class WorkerRunner {
  constructor(store, { logger = console, storage = null, keepLocalCopies = config.keepLocalCopies } = {}) {
    this.store = store;
    this.logger = logger;
    /**
     * Whether a published capture's photographs are left on local disk. Only
     * meaningful with a durable store; the local driver never prunes them.
     */
    this.keepLocalCopies = keepLocalCopies;
    /**
     * Where published artifacts are copied. With the local driver this is a
     * no-op -- the worker already wrote them at the keys that map to its own
     * output paths -- and with a remote driver it makes them durable before the
     * capture is called completed.
     */
    this.storage = storage;
    this.queue = [];
    this.running = new Map();
    /** Stage durations measured by the most recent finished job, if any. */
    this.measuredSeconds = null;
    /** Captures whose close() must end in "cancelled", not "failed". */
    this.cancelRequested = new Set();
  }

  /**
   * Cancel a queued or running capture at the user's request. A queued
   * capture is dequeued and cancelled immediately; a running one has its
   * worker process killed and is marked cancelled when the child closes.
   * Returns { ok, was } with `was` = "queued" | "running" | null.
   */
  cancel(id) {
    const queuedIdx = this.queue.indexOf(id);
    if (queuedIdx >= 0) {
      this.queue.splice(queuedIdx, 1);
      this.cancelRequested.add(id);
      this.store.update(id, {
        status: "cancelled",
        stage: "cancelled",
        note: "cancelled before a worker slot was assigned",
        progress: null,
        error: JSON.stringify({
          stage: "cancelled",
          message: "cancelled at the user's request while queued",
        }),
      });
      return { ok: true, was: "queued" };
    }
    const child = this.running.get(id);
    if (child) {
      this.cancelRequested.add(id);
      this.store.update(id, {
        stage: "cancelling",
        note: "cancel requested; stopping the worker",
      });
      child.kill("SIGTERM");
      return { ok: true, was: "running" };
    }
    return { ok: false, was: null };
  }

  enqueue(id) {
    this.queue.push(id);
    this.pump();
  }

  /**
   * Re-attach to work that outlived the process.
   *
   * The queue is in memory, so a restart forgets every capture waiting in it and
   * abandons the one in flight -- both would then read as "in progress" for
   * ever, which is exactly what a user cannot recover from. The inputs are still
   * on disk and the job contract is rewritten from the row, so the honest
   * outcome is to run the capture again: not to report it as finished (it is
   * not), and not to fail it (nothing went wrong with it).
   *
   * Returns how many captures were re-queued. Called from `start()` on boot and
   * never from `createServer`: a second process opening the same data directory
   * must not adopt work that another process is already running.
   */
  recover() {
    const stranded = this.store.unfinished();
    for (const capture of stranded) {
      this.queue.push(capture.id);
      this.store.update(capture.id, {
        status: "queued",
        stage: "queued",
        note: "re-queued after the API restarted; the run starts again from the beginning",
        progress: null,
        progress_source: null,
        stage_progress: null,
        eta_seconds: null,
        elapsed_seconds: null,
        worker_code: null,
        error: null,
      });
    }
    if (stranded.length > 0) this.pump();
    return stranded.length;
  }

  get runningIds() {
    return [...this.running.keys()];
  }

  pump() {
    while (this.running.size < config.maxConcurrentJobs && this.queue.length > 0) {
      const id = this.queue.shift();
      const child = this.run(id);
      this.running.set(id, child);
    }
  }

  run(id) {
    const capture = this.store.get(id);
    if (!capture) return null;

    const dir = capture.dir;
    const jobPath = path.join(dir, "job.json");
    const imagesDir = path.join(dir, "images");
    const glbPath = path.join(dir, "model.glb");
    const resultPath = path.join(dir, "result.json");
    const workDir = path.join(dir, "work");

    const job = {
      contract_version: "1",
      job_id: capture.id,
      name: capture.name,
      inputs: { images_dir: imagesDir },
      outputs: { glb_path: glbPath, result_json: resultPath },
      scale_calibration: capture.calibration || null,
      config: {},
    };
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));

    const startedAt = Date.now();
    const completed = new Set();
    this.store.update(id, {
      status: "running",
      stage: "starting",
      note: `worker: ${config.python} run_job.py`,
    });

    const child = spawn(
      config.python,
      [workerEntrypoint(), "--job", jobPath, "--workdir", workDir],
      { cwd: config.workerDir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdoutBuf = "";
    let stderr = "";
    let timedOut = false;

    // A reconstruction that runs forever would occupy the single worker slot and
    // pile up queued jobs. It is killed and reported as an explicit failure.
    const timer = setTimeout(() => {
      timedOut = true;
      this.logger.warn?.(`capture ${id}: exceeded ${config.jobTimeoutSeconds}s, killing the worker`);
      child.kill("SIGKILL");
    }, config.jobTimeoutSeconds * 1000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line) this.handleLog(id, line, completed, startedAt);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      this.store.update(id, {
        status: "failed",
        stage: "spawn",
        progress: null,
        error: JSON.stringify({
          stage: "spawn",
          message: `could not start the reconstruction worker (${config.python}): ${err.message}`,
        }),
      });
      this.running.delete(id);
      this.pump();
    });

    child.on("close", async (code) => {
      clearTimeout(timer);
      if (stdoutBuf.trim()) this.handleLog(id, stdoutBuf.trim(), completed, startedAt);
      const elapsed = (Date.now() - startedAt) / 1000;
      const wasCancelled = this.cancelRequested.delete(id);
      let result = null;
      if (fs.existsSync(resultPath)) {
        try {
          result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
        } catch (err) {
          this.logger.error?.(`capture ${id}: unreadable result.json: ${err.message}`);
        }
      }

      if (result && result.manifest && result.manifest.stage_seconds) {
        // Real timings make the next job's ETA a measurement, not a guess.
        this.measuredSeconds = result.manifest.stage_seconds;
      }

      if (wasCancelled) {
        // The user asked for this stop, so it is a completed interaction with
        // a named state of its own -- not a failure and never a success.
        this.store.update(id, {
          status: "cancelled",
          stage: "cancelled",
          note: `cancelled after ${elapsed.toFixed(1)}s`,
          progress: null,
          worker_code: code,
          error: JSON.stringify({
            stage: "cancelled",
            message: "cancelled at the user's request",
          }),
        });
      } else if (code === 0 && result && result.state === "completed") {
        let stored = null;
        try {
          stored = await this.publish(id, dir);
        } catch (err) {
          // A reconstruction that cannot be stored is not a finished capture.
          // Saying "completed" here would promise a model that may not exist.
          const message = `the reconstruction could not be stored: ${err.message}`;
          this.store.update(id, {
            status: "failed",
            stage: "storage",
            note: message.slice(0, 300),
            progress: null,
            worker_code: code,
            error: JSON.stringify({ stage: "storage", message }),
            result: JSON.stringify(result),
          });
          this.running.delete(id);
          this.pump();
          return;
        }
        this.store.update(id, {
          status: "completed",
          stage: "done",
          note:
            `reconstruction finished in ${elapsed.toFixed(1)}s` +
            (stored === null ? "" : `, ${stored} artifact${stored === 1 ? "" : "s"} stored`),
          progress: 1,
          progress_source: "complete",
          worker_code: code,
          result: JSON.stringify(result),
        });
        this.prune(id, dir);
      } else {
        const message = timedOut
          ? `the reconstruction exceeded the ${config.jobTimeoutSeconds}s limit and was stopped`
          : (result && result.error && result.error.message) ||
            `worker exited with code ${code}` +
              (stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : "");
        this.store.update(id, {
          status: "failed",
          stage: timedOut ? "timeout" : (result && result.error && result.error.stage) || "worker",
          note: `reconstruction failed after ${elapsed.toFixed(1)}s`,
          progress: null,
          worker_code: code,
          error: JSON.stringify({
            stage: timedOut ? "timeout" : (result && result.error && result.error.stage) || "worker",
            message,
          }),
          result: result ? JSON.stringify(result) : null,
        });
      }
      this.running.delete(id);
      this.pump();
    });

    return child;
  }

  /**
   * Disk hygiene after a run that finished. The worker's scratch directory is
   * always disposable. The raw photographs are, too, once a durable store holds
   * them: they are the bulk of a capture and nothing reads them again after the
   * job completes. The published model and result are left in place as a warm
   * cache -- the read path falls back to the stored object when they are gone.
   * With the local driver nothing but the scratch directory is touched, because
   * there the disk copy is the only copy.
   */
  prune(id, dir) {
    try {
      fs.rmSync(path.join(dir, "work"), { recursive: true, force: true });
      if (this.storage?.describe?.().durable && !this.keepLocalCopies) {
        fs.rmSync(path.join(dir, "images"), { recursive: true, force: true });
      }
    } catch (err) {
      // Failing to reclaim disk must never turn a good reconstruction into a
      // failure; it is reported and nothing else changes.
      this.logger.warn?.(`capture ${id}: could not prune the working copy: ${err.message}`);
    }
  }

  /**
   * Copy the published artifacts into the durable store, and only then let the
   * capture be called completed. Returns how many objects were stored, or null
   * when there is no storage attached.
   */
  async publish(id, dir) {
    if (!this.storage) return null;
    let count = 0;
    for (const name of ["result.json", "model.glb"]) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) {
        // A successful stage that wrote no model is a contradiction, not an
        // empty result: name it instead of completing the capture silently.
        if (name === "model.glb") {
          throw new Error("the worker reported success but wrote no model.glb");
        }
        continue;
      }
      await this.storage.putFile(captureKey(id, name), file);
      count += 1;
    }
    return count;
  }

  handleLog(id, line, completed, startedAt) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      this.logger.warn?.(`capture ${id}: non-JSON worker log: ${line.slice(0, 200)}`);
      return;
    }
    if (entry.event === "stage" && typeof entry.stage === "string") {
      const note = entry.note ? String(entry.note).slice(0, 300) : null;
      completed.add(entry.stage);
      const table = progressWeights(this.measuredSeconds);
      const frac = weightDone([...completed], table);
      const elapsed = (Date.now() - startedAt) / 1000;
      this.store.update(id, {
        stage: entry.stage,
        note,
        // The worker's own per-stage fraction is honest; the overall figure is
        // an estimate derived from static stage weights.
        stage_progress: typeof entry.progress === "number" ? entry.progress : null,
        progress: frac,
        progress_source: table.source,
        elapsed_seconds: Number(elapsed.toFixed(3)),
        eta_seconds: frac > 0.01 ? Number((elapsed * (1 - frac) / frac).toFixed(1)) : null,
      });
    } else if (entry.event === "job_finished") {
      this.store.update(id, { elapsed_seconds: entry.elapsed_seconds ?? null });
    } else if (entry.level === "error") {
      this.logger.warn?.(`capture ${id}: worker error: ${entry.event || ""} ${entry.error || ""}`);
    }
  }
}