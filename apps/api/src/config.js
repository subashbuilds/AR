// Runtime configuration for the capture API.
//
// Everything is environment driven so the same code runs in dev, in a test and
// on a VPS without edits. Defaults point at the in-repo reconstruction worker;
// no external network service is contacted.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** "1"/"true" → true, "0"/"false" → false, anything else (incl. unset) → null. */
function parseOptionalFlag(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** objectcapture-ar/ (this file lives at apps/api/src/config.js) */
export const PROJECT_ROOT = path.resolve(here, "..", "..", "..");

export const config = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8787),

  /** Where capture images, job contracts, GLB output and the SQLite state live. */
  dataDir: process.env.DATA_DIR || path.join(PROJECT_ROOT, "apps", "api", "data"),

  /** Built web app served as static files (apps/web/dist). */
  webDist: process.env.WEB_DIST || path.join(PROJECT_ROOT, "apps", "web", "dist"),

  /** The real reconstruction worker. Never stubbed. */
  workerDir: path.join(PROJECT_ROOT, "services", "reconstruction-worker"),
  python: process.env.PYTHON || "python3",

  /** Jobs run one at a time; the SfM pipeline is CPU bound. */
  maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS || 1),

  /** A reconstruction that exceeds this is killed and reported as a failure. */
  jobTimeoutSeconds: Number(process.env.JOB_TIMEOUT_SECONDS || 900),

  /** Upload rate limit: a burst of `uploadBurst` captures, one more per
   * `uploadRefillSeconds`. Each capture costs a full pipeline run. */
  uploadBurst: Number(process.env.UPLOAD_BURST || 5),
  uploadRefillSeconds: Number(process.env.UPLOAD_REFILL_SECONDS || 600),

  /** Sign-in budget: a burst of `authBurst` attempts per client, refilled one
   * at a time every `authRefillSeconds`. A password guess costs an scrypt hash,
   * so this bucket is deliberately separate from the upload budget. */
  authBurst: Number(process.env.AUTH_BURST || 10),
  authRefillSeconds: Number(process.env.AUTH_REFILL_SECONDS || 300),

  /**
   * Where a capture's bytes live: `auto` (B2 when configured, else local
   * disk), `local`, or `b2` (which refuses to fall back silently -- it warns
   * through `/api/health` instead).
   */
  storageDriver: process.env.STORAGE_DRIVER || "auto",

  /**
   * Backblaze B2, native API. Nothing here is required: with the three keys
   * absent the service stores captures on local disk exactly as it did before.
   * `endpoint` exists so a test can point the whole surface at a stand-in
   * server; it defaults to B2's own account endpoint.
   */
  b2: {
    keyId: process.env.B2_KEY_ID,
    applicationKey: process.env.B2_APPLICATION_KEY,
    bucket: process.env.B2_BUCKET_NAME,
    prefix: process.env.B2_PREFIX || "",
    endpoint: process.env.B2_ENDPOINT || "https://api.backblazeb2.com",
  },

  /**
   * Whether the session cookie carries `Secure`.
   *
   * null (the default) decides per request: Secure when the request arrived
   * over TLS or says `x-forwarded-proto: https`. `COOKIE_SECURE=1` forces it on
   * and `COOKIE_SECURE=0` forces it off. Set it explicitly when TLS is
   * terminated by a proxy that does NOT forward the scheme — the code has no
   * way to tell such a proxy apart from a plain-HTTP request.
   */
  cookieSecure: parseOptionalFlag(process.env.COOKIE_SECURE),

  /**
   * Keep a capture's raw photographs on local disk after they are published to
   * a durable store. Off by default: the bucket is authoritative and the
   * photographs are the bulk of a capture. It never applies to the local
   * driver, where the disk copy is the only copy there is.
   */
  keepLocalCopies: parseOptionalFlag(process.env.KEEP_LOCAL_COPIES) === true,

  /**
   * Whether a client may upload photographs *straight to the store* with the
   * short-lived upload URL the API hands it, instead of sending them through
   * this process inside the request body.
   *
   * null (the default) enables it whenever the configured driver can actually
   * hand out such a URL -- today only Backblaze B2, whose upload URL is
   * bucket-scoped. `DIRECT_UPLOADS=1` forces it on, `=0` forces it off, and a
   * driver that cannot presign is never asked to pretend.
   */
  directUploads: parseOptionalFlag(process.env.DIRECT_UPLOADS),

  /**
   * Retention. `captureTtlDays` is 0 by default, which means captures are kept
   * until their owner deletes them: expiring a user's reconstruction on a
   * clock is opt-in, not a surprise. `uploadAbandonedMinutes` reaps captures
   * whose direct upload never finished, which are unusable by definition and
   * safe to remove without asking anyone.
   */
  captureTtlDays: Number(process.env.CAPTURE_TTL_DAYS || 0),
  uploadAbandonedMinutes: Number(process.env.UPLOAD_ABANDONED_MINUTES || 120),
  /** How often the retention sweep runs; it is also run once at boot. */
  retentionSweepSeconds: Number(process.env.RETENTION_SWEEP_SECONDS || 600),

  /** Hard limits enforced by the API before anything touches the disk. */
  maxImages: Number(process.env.MAX_IMAGES || 200),
  maxImageBytes: Number(process.env.MAX_IMAGE_BYTES || 12 * 1024 * 1024),
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 96 * 1024 * 1024),
};

export function workerEntrypoint() {
  return path.join(config.workerDir, "run_job.py");
}

/** A worker run is only attempted when the Python entrypoint is really there. */
export function workerAvailable() {
  return fs.existsSync(workerEntrypoint());
}