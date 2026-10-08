// Retention: the two cases where a capture is removed without its owner asking.
//
//   1. An upload that never finished. A direct-to-store upload creates its row
//      before any bytes exist; if the browser closes halfway through, the row
//      describes work nobody will ever complete. There is nothing to preserve,
//      so it is reaped on a clock with no configuration needed.
//   2. A capture older than the configured TTL. This is OFF by default
//      (`CAPTURE_TTL_DAYS=0`), because deleting a user's reconstruction on a
//      timer is a product decision, not a housekeeping detail. Turning it on
//      applies it to every capture regardless of status, so a deployment that
//      wants bounded storage gets it in one setting.
//
// Removal looks exactly like an account deletion, for the same reason: the row,
// the stored objects and the local working directory must not be able to
// disagree about whether the capture exists. A capture that is still queued or
// running is cancelled first, so no worker is left writing into a directory
// that is about to disappear.

import fsp from "node:fs/promises";

import { captureKey } from "./storage.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export class Retention {
  constructor(
    store,
    { storage = null, runner = null, logger = console, ttlDays = 0, abandonedMinutes = 120 } = {},
  ) {
    this.store = store;
    this.storage = storage;
    this.runner = runner;
    this.logger = logger;
    this.ttlMs = Math.max(0, Number(ttlDays) || 0) * DAY_MS;
    // 0 disables reaping (useful only in tests and for an operator who really
    // wants half-finished rows to accumulate).
    this.abandonedMs = Math.max(0, Number(abandonedMinutes) || 0) * MINUTE_MS;
  }

  describe() {
    return {
      captureTtlDays: this.ttlMs / DAY_MS,
      uploadAbandonedMinutes: this.abandonedMs / MINUTE_MS,
      enabled: this.ttlMs > 0 || this.abandonedMs > 0,
    };
  }

  /**
   * Remove what nobody can use any more. Returns what it did, so a test or a
   * boot log can see it rather than guess: how many rows were candidates, how
   * many were actually removed, and how many stored objects went with them.
   *
   * `now` is injectable so the expiry rules can be tested without waiting for a
   * clock to move.
   */
  async sweep({ now = Date.now() } = {}) {
    const abandoned =
      this.abandonedMs > 0 ? this.store.abandonedUploads(now - this.abandonedMs) : [];
    const expired = this.ttlMs > 0 ? this.store.createdBefore(now - this.ttlMs) : [];

    const seen = new Set();
    const removed = [];
    let objects = 0;
    for (const capture of [...abandoned, ...expired]) {
      if (seen.has(capture.id)) continue;
      seen.add(capture.id);
      try {
        if (capture.status === "queued" || capture.status === "running") {
          this.runner?.cancel(capture.id);
        }
        objects += (await this.storage?.removeAll?.(captureKey(capture.id, ""))) ?? 0;
        await fsp.rm(capture.dir, { recursive: true, force: true });
        this.store.remove(capture.id);
        removed.push(capture.id);
      } catch (err) {
        // A single unremovable capture must not stop the sweep, and it must not
        // be reported as removed either.
        this.logger.warn?.(`retention: could not remove capture ${capture.id}: ${err.message}`);
      }
    }
    return {
      abandoned: abandoned.length,
      expired: expired.length,
      removed: removed.length,
      objects,
    };
  }
}
