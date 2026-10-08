// Capture HTTP API.
//
// Routes (all JSON unless noted):
//   GET  /api/health                     worker availability and hard limits
//   POST /api/auth/signup                { email, password, name? } -> session cookie
//   POST /api/auth/signin                { email, password }         -> session cookie
//   POST /api/auth/signout               revoke this session
//   GET  /api/auth/me                    the signed-in account, or null
//   DELETE /api/auth/account             erase the account, its captures and objects (password confirmed)
//   GET  /api/captures                   the caller's own captures (401 without a session)
//   POST /api/captures                   { name, images: [data URL], scale_calibration? }
//   POST /api/captures/uploads           { name, images: [{ contentType, bytes }] } -> upload URLs
//   POST /api/captures/:id/uploads/complete  verify the uploaded objects and queue the job
//   GET  /api/captures/:id               status, progress and the worker's manifest
//   GET  /api/captures/:id/result        the worker's own result document
//   GET  /api/captures/:id/model.glb     the reconstructed model (binary)
//   POST /api/captures/:id/share         create (or return) the capture's share link
//   DELETE /api/captures/:id/share       revoke it, immediately
//   *                                    the built web app from WEB_DIST, SPA fallback
//
// Access is not left to the UUID. A capture is readable by exactly two parties:
// the account that owns it, and whoever holds its `?t=` share token. A capture
// that has never been shared is private even to someone with the exact URL, and
// revoking a share link takes effect on the next request (the token is compared
// against the row, never trusted from a cache).
//
// Capture bytes live in `storage.js`: local disk by default, Backblaze B2 when
// its keys are configured. The worker still needs real files, so a local
// working copy always exists; with B2 that copy is a cache and a read falls
// back to the stored object when the file is gone.
//
// Zero npm dependencies: node:http, node:sqlite and node:child_process only.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";

import {
  Accounts,
  clearedCookie,
  isSecureRequest,
  newShareToken,
  readSessionToken,
  sessionCookie,
} from "./accounts.js";
import { config, workerAvailable, workerEntrypoint, PROJECT_ROOT } from "./config.js";
import { RateLimiter } from "./ratelimit.js";
import { Retention } from "./retention.js";
import { captureKey, contentTypeFor, createStorage, extensionFor } from "./storage.js";
import { Store } from "./store.js";
import { WorkerRunner } from "./worker.js";

const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".glb": "model/gltf-binary",
  ".woff2": "font/woff2",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: { message, ...extra } });
}

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Rate-limit key. Behind the platform's proxy every request arrives from the
 * proxy, so x-forwarded-for is the only per-client signal there is.
 */
function clientKey(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

async function readJsonBody(req) {
  const body = await readBody(req, config.maxBodyBytes);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw bad("request body is not valid JSON");
  }
}

/** Constant-time comparison, for share tokens that arrive from the network. */
function sameToken(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The shape clients receive. `dir` is a path on this host and is not the
 * client's business; `userId` is replaced by the caller's own `role` on the
 * capture, which is what the UI actually needs to decide whether to offer
 * sharing controls.
 */
function publicCapture(capture, role) {
  if (!capture) return capture;
  // `pendingUploads` is bookkeeping for the direct-upload path; the client is
  // told the manifest explicitly when it is offered one, so it is not part of
  // every capture response.
  const { dir, userId, pendingUploads, ...rest } = capture;
  return { ...rest, role, owned: role === "owner" };
}

/**
 * Who may read a capture.
 *   owner  — the signed-in account that created it
 *   shared — anyone holding its share token (the second-phone QR link)
 *   denied — everyone else, including a signed-in account that is not the owner
 */
function captureAccess(capture, user, shareParam) {
  if (user && capture.userId && user.id === capture.userId) return "owner";
  if (capture.shareToken && sameToken(shareParam, capture.shareToken)) return "shared";
  return "denied";
}

/**
 * Refuse a read, saying which refusal it is. The distinction matters: an owner
 * who is simply signed out should be sent to the sign-in page, while a second
 * phone with a revoked link should be told the link is dead rather than looped
 * through an account it does not have.
 */
function denyCapture(res, { user, shareParam, capture }) {
  if (!capture.userId) {
    sendError(
      res,
      403,
      "this capture predates accounts and has no owner, so it cannot be opened",
    );
    return;
  }
  if (shareParam) {
    sendError(res, 403, "this share link is no longer active; ask the owner for a new one");
    return;
  }
  if (!user) {
    sendError(res, 401, "sign in to view this capture");
    return;
  }
  sendError(res, 403, "this capture belongs to another account");
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error(`request body exceeds ${limit} bytes`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The container these bytes really are, or null. Used on both upload paths: on
 * the request-body path the bytes are in hand, and on the direct-upload path
 * the first bytes of the stored object are fetched before the worker ever sees
 * it -- so a mislabelled payload cannot fool the worker either way.
 */
function sniffImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return "png";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/** Drain a stream into a Buffer. Async iteration, so a body that ends before a
 * listener could attach still resolves rather than hanging. */
async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Accept only real base64 image data URLs and verify the container bytes. */
function decodeDataUrl(dataUrl) {
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(
    String(dataUrl || ""),
  );
  if (!m) {
    throw Object.assign(new Error("each image must be a base64 data URL of jpeg, png or webp"), {
      statusCode: 400,
    });
  }
  const buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (buf.length === 0) {
    throw Object.assign(new Error("image payload is empty"), { statusCode: 400 });
  }
  if (buf.length > config.maxImageBytes) {
    throw Object.assign(
      new Error(`image is ${buf.length} bytes, limit is ${config.maxImageBytes}`),
      { statusCode: 413 },
    );
  }
  // Sniff the real container so a mislabelled payload cannot fool the worker.
  // The extension follows the bytes, not the label, so a data URL that calls a
  // PNG "jpeg" is stored as a PNG rather than as a file whose name lies.
  const sniffed = sniffImageType(buf);
  if (!sniffed) {
    throw Object.assign(new Error("image bytes are not a JPEG, PNG or WebP file"), {
      statusCode: 400,
    });
  }
  return { buf, ext: sniffed };
}

const CALIBRATION_UNITS = ["mm", "cm", "m", "in", "ft"];

/**
 * Accepts the primary measurement used to fix the model's scale, plus any
 * additional dimensions the user supplied. The extra dimensions are NOT used to
 * scale anything — they are kept so the client can report how far the
 * reconstruction is from the user's own ruler, which is the only honest way to
 * present a scale factor derived from a single measurement.
 */
function normaliseCalibration(input) {
  if (!input || typeof input !== "object") return null;
  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = String(input.unit || "m").toLowerCase();
  if (!CALIBRATION_UNITS.includes(unit)) {
    throw Object.assign(new Error(`unsupported calibration unit "${unit}"`), { statusCode: 400 });
  }
  const calibration = {
    value,
    unit,
    source: String(input.source || "user_measurement").slice(0, 80),
  };
  if (Number.isFinite(Number(input.model_value))) calibration.model_value = Number(input.model_value);
  if (typeof input.axis === "string") calibration.axis = input.axis;

  const checks = [];
  if (Array.isArray(input.checks)) {
    for (const item of input.checks.slice(0, 4)) {
      const axis = ["height", "width", "depth"].includes(String(item && item.axis))
        ? String(item.axis)
        : null;
      const v = Number(item && item.value);
      const u = String((item && item.unit) || unit).toLowerCase();
      if (!axis || !Number.isFinite(v) || v <= 0 || !CALIBRATION_UNITS.includes(u)) continue;
      // The primary measurement must not be counted twice.
      if (axis === calibration.axis) continue;
      checks.push({ axis, value: v, unit: u });
    }
  }
  calibration.checks = checks;
  return calibration;
}

export function createServer({
  store,
  runner,
  accounts,
  storage,
  retention,
  webDist = config.webDist,
  limiter,
  authLimiter: injectedAuthLimiter,
} = {}) {
  const activeStore = store || new Store(config.dataDir);
  const activeStorage = storage || createStorage(config);
  const activeRunner = runner || new WorkerRunner(activeStore, { storage: activeStorage });
  const activeAccounts = accounts || new Accounts(config.dataDir);
  const activeRetention =
    retention ||
    new Retention(activeStore, {
      storage: activeStorage,
      runner: activeRunner,
      ttlDays: config.captureTtlDays,
      abandonedMinutes: config.uploadAbandonedMinutes,
    });
  /**
   * Direct uploads need a driver that can hand out an upload URL. Asking for
   * them on local disk is not a misconfiguration to warn about: the client is
   * told `direct: false` and keeps using the request-body path, which is the
   * behaviour every deployment had before this existed.
   */
  const directUploadsEnabled =
    config.directUploads !== false &&
    typeof activeStorage.presign === "function" &&
    Boolean(activeStorage.supportsDirectUploads);
  const activeLimiter =
    limiter ||
    new RateLimiter({ capacity: config.uploadBurst, refillSeconds: config.uploadRefillSeconds });
  // Sign-in attempts get their own bucket: guessing a password costs CPU, so it
  // must not be shareable with, or reachable through, the upload budget.
  const authLimiter =
    injectedAuthLimiter ||
    new RateLimiter({ capacity: config.authBurst, refillSeconds: config.authRefillSeconds });
  const sweep = setInterval(() => {
    activeLimiter.sweep();
    authLimiter.sweep();
  }, 60_000);
  sweep.unref?.();

  const currentUser = (req) => activeAccounts.userForToken(readSessionToken(req));

  /**
   * `Secure` on the session cookie. Decided per request unless the operator
   * has declared it, because a proxy that terminates TLS without forwarding the
   * scheme is indistinguishable from a plain-HTTP request from in here.
   */
  const secureCookie = (req) =>
    config.cookieSecure === null ? isSecureRequest(req) : config.cookieSecure;

  /** Returns true when the request was refused for being over the auth budget. */
  const authBudget = (req, res) => {
    const verdict = authLimiter.take(`auth:${clientKey(req)}`);
    if (verdict.allowed) return false;
    res.setHeader?.("retry-after", String(verdict.retryAfterSeconds));
    sendJson(res, 429, {
      error: {
        message:
          `Too many sign-in attempts from this client. Try again in ` +
          `${verdict.retryAfterSeconds} seconds.`,
        retry_after_seconds: verdict.retryAfterSeconds,
      },
    });
    return true;
  };

  const openSession = (req, res, user, status) => {
    const token = activeAccounts.startSession(user.id);
    res.setHeader("set-cookie", sessionCookie(token, { secure: secureCookie(req) }));
    sendJson(res, status, { user });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);
    applySecurityHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        // The API is same-origin with the app it serves. These headers exist for
        // non-browser tooling; a browser cross-origin request never receives a
        // session cookie (no allow-credentials), so it cannot read a private
        // capture even if it guesses the id.
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,authorization",
        "access-control-max-age": "86400",
      });
      res.end();
      return;
    }

    try {
      if (pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          service: "objectcapture-ar-api",
          version: "1.0.0",
          worker: {
            available: workerAvailable(),
            entrypoint: workerEntrypoint(),
            python: config.python,
            projectRoot: PROJECT_ROOT,
          },
          limits: {
            minImages: 2,
            maxImages: config.maxImages,
            maxImageBytes: config.maxImageBytes,
            maxBodyBytes: config.maxBodyBytes,
            jobTimeoutSeconds: config.jobTimeoutSeconds,
            uploadBurst: config.uploadBurst,
            uploadRefillSeconds: config.uploadRefillSeconds,
            authBurst: config.authBurst,
            authRefillSeconds: config.authRefillSeconds,
          },
          auth: {
            accounts: true,
            sessionDays: 30,
            shareLinks: true,
            // null means "decided per request from the request's scheme".
            cookieSecure: config.cookieSecure,
          },
          // Which driver is really in use, so a deployment can be checked from
          // outside without reading its configuration.
          storage: {
            ...activeStorage.describe(),
            warnings: activeStorage.warnings || [],
            // Whether a client may upload straight to the store. False on local
            // disk, where there is no URL to hand out.
            directUploads: directUploadsEnabled,
          },
          // What the retention rules would remove, and whether they are on.
          retention: activeRetention.describe(),
          activeJobs: activeRunner.runningIds,
        });
        return;
      }

      if (pathname === "/api/auth/signup" && req.method === "POST") {
        // The body is drained before the budget is checked so a refused
        // request cannot leave an unread body on a keep-alive connection.
        const body = await readJsonBody(req);
        if (authBudget(req, res)) return;
        const user = activeAccounts.signUp({
          email: body.email,
          password: body.password,
          name: body.name,
        });
        openSession(req, res, user, 201);
        return;
      }

      if (pathname === "/api/auth/signin" && req.method === "POST") {
        const body = await readJsonBody(req);
        // The budget is spent before the scrypt comparison, so guessing costs
        // the attacker more than it costs this server.
        if (authBudget(req, res)) return;
        const user = activeAccounts.signIn({ email: body.email, password: body.password });
        if (!user) {
          // One message for both halves of the pair: the endpoint must not be
          // usable to discover which addresses have accounts.
          throw bad("email or password is incorrect", 401);
        }
        openSession(req, res, user, 200);
        return;
      }

      if (pathname === "/api/auth/signout" && req.method === "POST") {
        const token = readSessionToken(req);
        const revoked = activeAccounts.endSession(token);
        res.setHeader("set-cookie", clearedCookie({ secure: secureCookie(req) }));
        sendJson(res, 200, { signed_out: true, revoked });
        return;
      }

      if (pathname === "/api/auth/me" && req.method === "GET") {
        // 200 with a null user rather than 401: this is the bootstrap call every
        // page makes, and "signed out" is a normal answer, not an error.
        const user = currentUser(req);
        sendJson(res, 200, { user: user ?? null, signed_in: Boolean(user) });
        return;
      }

      if (pathname === "/api/auth/account" && req.method === "DELETE") {
        // Deleting an account destroys data, so it is confirmed with the
        // password as well as the session: a borrowed browser must not be
        // enough to erase somebody's reconstructions.
        const user = currentUser(req);
        if (!user) {
          sendError(res, 401, "sign in to delete your account");
          return;
        }
        const body = await readJsonBody(req);
        // The password check costs an scrypt hash, so it spends the same budget
        // as a sign-in attempt rather than becoming a free password oracle.
        if (authBudget(req, res)) return;
        if (!activeAccounts.verifyUserPassword(user.id, body.password)) {
          throw bad("password is incorrect", 401);
        }
        const owned = activeStore.allForUser(user.id);
        // Stop anything still in flight before its directory is removed, so no
        // worker is left writing into a capture that no longer exists.
        let stopped = 0;
        for (const capture of owned) {
          if (capture.status === "queued" || capture.status === "running") {
            if (activeRunner.cancel(capture.id).ok) stopped += 1;
          }
        }
        // The bytes go with the rows, in whichever driver holds them, and the
        // local working copy goes too -- a deleted capture must not survive as
        // an unlisted directory on the host.
        let objects = 0;
        for (const capture of owned) {
          objects += await activeStorage.removeAll(captureKey(capture.id, ""));
          await fsp.rm(capture.dir, { recursive: true, force: true });
          activeStore.remove(capture.id);
        }
        const revoked = activeAccounts.deleteUser(user.id);
        console.log(
          JSON.stringify({
            event: "account_deleted",
            captures: owned.length,
            objects,
            sessions: revoked.sessions,
          }),
        );
        res.setHeader("set-cookie", clearedCookie({ secure: secureCookie(req) }));
        sendJson(res, 200, {
          deleted: true,
          captures_deleted: owned.length,
          objects_deleted: objects,
          sessions_revoked: revoked.sessions,
          cancelled: stopped,
        });
        return;
      }

      if (pathname === "/api/captures" && req.method === "GET") {
        const user = currentUser(req);
        if (!user) {
          sendError(res, 401, "sign in to list your captures");
          return;
        }
        // Only this account's own captures. There is no cross-account listing.
        sendJson(res, 200, {
          captures: activeStore.list(user.id, 50).map((c) => publicCapture(c, "owner")),
        });
        return;
      }

      if (pathname === "/api/captures" && req.method === "POST") {
        const user = currentUser(req);
        if (!user) {
          sendError(res, 401, "sign in to start a capture");
          return;
        }
        const verdict = activeLimiter.take(clientKey(req));
        if (!verdict.allowed) {
          res.setHeader?.("retry-after", String(verdict.retryAfterSeconds));
          sendJson(res, 429, {
            error: {
              message:
                `Too many captures from this client. Each one costs a full reconstruction; ` +
                `try again in ${verdict.retryAfterSeconds} seconds.`,
              retry_after_seconds: verdict.retryAfterSeconds,
            },
          });
          return;
        }
        if (!workerAvailable()) {
          sendError(res, 503, `reconstruction worker not found at ${workerEntrypoint()}`);
          return;
        }
        const parsed = await readJsonBody(req);
        const images = Array.isArray(parsed.images) ? parsed.images : [];
        if (images.length < 2) {
          sendError(res, 400, `need at least 2 images to reconstruct, received ${images.length}`);
          return;
        }
        if (images.length > config.maxImages) {
          sendError(res, 400, `${images.length} images exceeds the maximum of ${config.maxImages}`);
          return;
        }
        let calibration;
        try {
          calibration = normaliseCalibration(parsed.scale_calibration);
        } catch (err) {
          sendError(res, err.statusCode || 400, err.message);
          return;
        }

        const id = randomUUID();
        const dir = activeStore.captureDir(id);
        const imagesDir = path.join(dir, "images");
        await fsp.mkdir(imagesDir, { recursive: true });

        const decoded = [];
        try {
          for (let i = 0; i < images.length; i += 1) {
            const { buf, ext } = decodeDataUrl(images[i]);
            const name = `frame_${String(i + 1).padStart(3, "0")}.${ext}`;
            const file = path.join(imagesDir, name);
            await fsp.writeFile(file, buf);
            // The worker needs a real file; the durable store gets its own copy
            // so the photographs survive this host losing its disk.
            await activeStorage.putFile(captureKey(id, `images/${name}`), file, {
              contentType: contentTypeFor(name),
            });
            decoded.push(file);
          }
        } catch (err) {
          await fsp.rm(dir, { recursive: true, force: true });
          // A capture whose photographs could not be stored must not be accepted
          // and then reported as somebody's reconstruction.
          const where = err.b2 ? "the object store" : "the disk";
          sendError(
            res,
            err.statusCode && err.statusCode < 500 ? err.statusCode : 502,
            `image ${decoded.length + 1} could not be stored in ${where}: ${err.message}`,
          );
          return;
        }

        activeStore.create({
          id,
          name: String(parsed.name || "captured object").slice(0, 120),
          imageCount: decoded.length,
          calibration,
          dir,
          userId: user.id,
        });
        activeRunner.enqueue(id);
        sendJson(res, 202, publicCapture(activeStore.get(id), "owner"));
        return;
      }

      if (pathname === "/api/captures/uploads" && req.method === "POST") {
        // The direct-to-store path. Nothing is sent through this process, so
        // the only thing checked here is what the client declares: the count,
        // the media types and the sizes. The bytes are verified after they land
        // (POST /uploads/complete), before anything is reconstructed.
        const user = currentUser(req);
        if (!user) {
          sendError(res, 401, "sign in to start a capture");
          return;
        }
        if (!directUploadsEnabled) {
          // Not an error the user caused: this deployment keeps captures on
          // local disk, which has no upload URL to hand to a browser. The
          // client falls back to the request-body path.
          sendError(
            res,
            409,
            "direct uploads need a durable object store; this deployment stores captures on local disk",
            { code: "direct_uploads_unavailable" },
          );
          return;
        }
        const verdict = activeLimiter.take(clientKey(req));
        if (!verdict.allowed) {
          res.setHeader?.("retry-after", String(verdict.retryAfterSeconds));
          sendJson(res, 429, {
            error: {
              message:
                `Too many captures from this client. Each one costs a full reconstruction; ` +
                `try again in ${verdict.retryAfterSeconds} seconds.`,
              retry_after_seconds: verdict.retryAfterSeconds,
            },
          });
          return;
        }
        if (!workerAvailable()) {
          sendError(res, 503, `reconstruction worker not found at ${workerEntrypoint()}`);
          return;
        }
        const parsed = await readJsonBody(req);
        const images = Array.isArray(parsed.images) ? parsed.images : [];
        if (images.length < 2) {
          sendError(res, 400, `need at least 2 images to reconstruct, received ${images.length}`);
          return;
        }
        if (images.length > config.maxImages) {
          sendError(res, 400, `${images.length} images exceeds the maximum of ${config.maxImages}`);
          return;
        }
        let calibration;
        try {
          calibration = normaliseCalibration(parsed.scale_calibration);
        } catch (err) {
          sendError(res, err.statusCode || 400, err.message);
          return;
        }

        // The manifest fixes each object's name now, because the name is part
        // of what the client is told to upload and of what the worker will
        // later read off disk. That is why a mismatched container is refused at
        // completion: the extension has already been promised.
        const manifest = [];
        for (let i = 0; i < images.length; i += 1) {
          const declared = images[i] && typeof images[i] === "object" ? images[i] : {};
          const ext = extensionFor(declared.contentType);
          if (!ext) {
            sendError(
              res,
              400,
              `image ${i + 1} declares an unsupported type; send image/jpeg, image/png or image/webp`,
            );
            return;
          }
          const bytes = Number(declared.bytes);
          if (!Number.isFinite(bytes) || bytes <= 0) {
            sendError(res, 400, `image ${i + 1} must declare the number of bytes it will send`);
            return;
          }
          if (bytes > config.maxImageBytes) {
            sendError(
              res,
              413,
              `image ${i + 1} declares ${bytes} bytes, limit is ${config.maxImageBytes}`,
            );
            return;
          }
          manifest.push({ name: `frame_${String(i + 1).padStart(3, "0")}.${ext}`, contentType: declared.contentType, bytes });
        }

        const id = randomUUID();
        const dir = activeStore.captureDir(id);
        await fsp.mkdir(path.join(dir, "images"), { recursive: true });
        const uploads = [];
        try {
          for (const item of manifest) {
            const key = captureKey(id, `images/${item.name}`);
            const target = await activeStorage.presign({ key, contentType: item.contentType });
            if (!target || !target.url) {
              throw new Error("the configured store could not produce an upload URL");
            }
            uploads.push({
              key,
              name: item.name,
              contentType: item.contentType,
              url: target.url,
              headers: target.headers,
              max_bytes: config.maxImageBytes,
            });
          }
        } catch (err) {
          await fsp.rm(dir, { recursive: true, force: true });
          sendError(res, 502, `could not prepare the upload: ${err.message}`);
          return;
        }

        activeStore.create({
          id,
          name: String(parsed.name || "captured object").slice(0, 120),
          imageCount: manifest.length,
          calibration,
          dir,
          userId: user.id,
          status: "uploading",
          pendingUploads: manifest,
        });
        sendJson(res, 201, {
          ...publicCapture(activeStore.get(id), "owner"),
          direct: true,
          uploads,
        });
        return;
      }

      const captureMatch =
        /^\/api\/captures\/([0-9a-f-]{36})(\/result|\/model\.glb|\/share|\/uploads\/complete)?$/.exec(
          pathname,
        );
      if (captureMatch && captureMatch[2] === "/uploads/complete") {
        if (req.method !== "POST") {
          sendError(res, 405, "completing an upload accepts POST");
          return;
        }
        const capture = activeStore.get(captureMatch[1]);
        const user = currentUser(req);
        if (!capture) {
          sendError(res, 404, "capture not found");
          return;
        }
        if (!user || !capture.userId || user.id !== capture.userId) {
          sendError(res, 403, "only the account that owns a capture can finish its upload");
          return;
        }
        if (capture.status !== "uploading") {
          sendError(
            res,
            409,
            `this capture is not waiting for an upload (status: ${capture.status})`,
          );
          return;
        }
        const manifest = activeStore.pendingUploads(capture.id);
        if (!manifest || manifest.length === 0) {
          sendError(res, 409, "this capture has no upload to complete");
          return;
        }
        const imagesDir = path.join(capture.dir, "images");
        try {
          for (const item of manifest) {
            const key = captureKey(capture.id, `images/${item.name}`);
            const head = await activeStorage.head(key);
            if (!head) throw bad(`image ${item.name} was never uploaded`, 400);
            if (head.length === 0) throw bad(`image ${item.name} is empty`, 400);
            if (head.length > config.maxImageBytes) {
              throw Object.assign(
                new Error(`image ${item.name} is ${head.length} bytes, limit is ${config.maxImageBytes}`),
                { statusCode: 413 },
              );
            }
            // The bytes are the only thing that can be trusted here. The
            // declared media type already chose this object's name, so a
            // mismatch would leave a file whose name lies about its contents.
            const probe = await activeStorage.open(key, { range: "bytes=0-15" });
            if (!probe) throw bad(`image ${item.name} was never uploaded`, 400);
            const sniffed = sniffImageType(await readAll(probe.stream));
            if (!sniffed) {
              throw bad(`image ${item.name} is not a JPEG, PNG or WebP file`, 400);
            }
            const declaredExt = path.extname(item.name).replace(/^\./, "");
            if (sniffed !== declaredExt) {
              throw bad(
                `image ${item.name} was declared ${item.contentType} but its bytes are ${sniffed}`,
                400,
              );
            }
            // The worker needs real files, so the object is materialised into
            // the working copy before anything is queued.
            const full = await activeStorage.open(key);
            if (!full) throw bad(`image ${item.name} disappeared before it could be read`, 400);
            await fsp.mkdir(imagesDir, { recursive: true });
            await pipeline(full.stream, fs.createWriteStream(path.join(imagesDir, item.name)));
          }
        } catch (err) {
          // A capture whose upload is unusable is not a capture. It is removed
          // whole -- objects, working copy and row -- exactly as account
          // deletion does, and the reason is named.
          await activeStorage.removeAll(captureKey(capture.id, ""));
          await fsp.rm(capture.dir, { recursive: true, force: true });
          activeStore.remove(capture.id);
          sendError(res, err.statusCode || 502, `the upload was not usable: ${err.message}`);
          return;
        }
        activeStore.update(capture.id, {
          status: "queued",
          stage: "queued",
          note: "waiting for a worker slot",
          pending_uploads: null,
        });
        activeRunner.enqueue(capture.id);
        sendJson(res, 202, publicCapture(activeStore.get(capture.id), "owner"));
        return;
      }

      if (captureMatch && captureMatch[2] === "/share") {
        // Sharing is the owner's decision alone. A non-owner gets the same 404
        // as an unknown id, so the endpoint cannot be used to discover which
        // capture ids exist.
        const capture = activeStore.get(captureMatch[1]);
        const user = currentUser(req);
        if (!capture || !user || !capture.userId || user.id !== capture.userId) {
          sendError(res, 404, "capture not found");
          return;
        }
        if (req.method === "POST") {
          // Idempotent: asking twice returns the same live link rather than
          // invalidating the QR code that was already printed or sent.
          const token = activeStore.shareToken(capture.id) || newShareToken();
          activeStore.setShareToken(capture.id, token);
          sendJson(res, 200, {
            shared: true,
            share_token: token,
            model_path: `/model/${capture.id}?t=${token}`,
            ar_path: `/ar/${capture.id}?t=${token}`,
            note: "anyone with this link can read the model until you revoke it",
          });
          return;
        }
        if (req.method === "DELETE") {
          activeStore.setShareToken(capture.id, null);
          sendJson(res, 200, {
            shared: false,
            share_token: null,
            note: "the previous link stopped working immediately",
          });
          return;
        }
        sendError(res, 405, "the share link accepts POST (create) and DELETE (revoke)");
        return;
      }
      if (captureMatch && req.method === "DELETE") {
        // Cancellation (the one mutating verb a capture supports): stop a
        // queued or running reconstruction at the user's request. Terminal
        // states cannot be cancelled.
        if (captureMatch[2]) {
          sendError(res, 405, "DELETE applies to the capture, not its subresources");
          return;
        }
        const capture = activeStore.get(captureMatch[1]);
        if (!capture) {
          sendError(res, 404, "capture not found");
          return;
        }
        const user = currentUser(req);
        if (!user || !capture.userId || user.id !== capture.userId) {
          sendError(res, 403, "only the account that owns a capture can cancel it");
          return;
        }
        if (capture.status === "completed" || capture.status === "failed" ||
            capture.status === "cancelled") {
          sendError(res, 409, `capture is already ${capture.status} and cannot be cancelled`);
          return;
        }
        const verdict = activeRunner.cancel(capture.id);
        if (!verdict.ok) {
          sendError(res, 409, "capture is not queued or running");
          return;
        }
        sendJson(res, 202, { cancelled: true, was: verdict.was,
                             capture: publicCapture(activeStore.get(capture.id), "owner") });
        return;
      }
      if (captureMatch) {
        const capture = activeStore.get(captureMatch[1]);
        if (!capture) {
          sendError(res, 404, "capture not found");
          return;
        }
        const user = currentUser(req);
        const shareParam = url.searchParams.get("t");
        const role = captureAccess(capture, user, shareParam);
        if (role === "denied") {
          denyCapture(res, { user, shareParam, capture });
          return;
        }
        const suffix = captureMatch[2] || "";
        if (suffix === "") {
          sendJson(res, 200, publicCapture(capture, role));
          return;
        }
        if (suffix === "/result") {
          if (!capture.result) {
            sendError(res, 409, `result is not available yet (status: ${capture.status})`);
            return;
          }
          sendJson(res, 200, capture.result);
          return;
        }
        if (capture.status !== "completed") {
          sendError(res, 409, `model is not available yet (status: ${capture.status})`);
          return;
        }
        const key = captureKey(capture.id, "model.glb");
        const localGlb = activeStorage.localFile(key) ?? path.join(capture.dir, "model.glb");
        // Local copy first (it is what the worker just wrote), then the durable
        // store: a capture whose host lost its disk is still servable.
        const found = fs.existsSync(localGlb)
          ? { stream: fs.createReadStream(localGlb), length: (await fsp.stat(localGlb)).size, contentType: "model/gltf-binary" }
          : await activeStorage.open(key);
        if (!found) {
          sendError(res, 409, `the model for this capture is no longer stored (status: ${capture.status})`);
          return;
        }
        res.writeHead(200, {
          "content-type": found.contentType || "model/gltf-binary",
          ...(found.length ? { "content-length": found.length } : {}),
          "access-control-allow-origin": "*",
          // A shared link is revocable, so the bytes must not outlive the
          // decision to share them: no immutable long-lived cache.
          "cache-control": "private, max-age=60",
          "content-disposition": `inline; filename="${capture.name.replace(/[^\w.-]+/g, "_")}.glb"`,
        });
        found.stream.pipe(res);
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendError(res, 404, `no such endpoint: ${pathname}`);
        return;
      }

      await serveStatic(webDist, pathname, res);
    } catch (err) {
      // Expected client errors carry a statusCode; anything else is a bug worth
      // a stack trace on the server, never a silent 500.
      if (!err.statusCode) console.error(`api error on ${req.method} ${pathname}:`, err);
      if (!res.headersSent) {
        sendError(res, err.statusCode || 500, err.message || "internal server error");
      } else {
        res.end();
      }
    }
  });

  server.store = activeStore;
  server.runner = activeRunner;
  server.accounts = activeAccounts;
  server.storage = activeStorage;
  server.retention = activeRetention;
  return server;
}

// The share link is a bearer token in a URL, and a URL leaks: it lands in the
// Referer header of every outbound link, in browser history, in a chat preview.
// Only a token the holder chose to paste in should ever reach the server, so
// cross-origin requests get no credentialed access at all (the API is served
// same-origin as the app; there is no cross-origin client to support).
function applySecurityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("x-frame-options", "DENY");
}

async function serveStatic(root, pathname, res) {
  if (!fs.existsSync(root)) {
    sendError(res, 404, `web app is not built; expected ${root}. Run "bun run build" in apps/web.`);
    return;
  }
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root))) {
    sendError(res, 403, "forbidden");
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(root, "index.html"); // SPA fallback
  }
  const body = await fsp.readFile(file);
  const type = MIME_BY_EXT[path.extname(file)] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600",
  });
  res.end(body);
}

export async function start({ port = config.port, host = config.host } = {}) {
  const server = createServer();
  await new Promise((resolve) => server.listen(port, host, resolve));
  // A restart leaves captures that were queued or running when the process
  // stopped. Recovery is deliberately here, at boot, and not in createServer: a
  // second process opening the same data directory must not adopt work that
  // another one is already running.
  const requeued = server.runner.recover();
  if (requeued > 0) {
    console.log(JSON.stringify({ event: "recovery_requeued", captures: requeued }));
  }
  // Retention is also a boot-time job, and for the same reason: an upload
  // abandoned by a *previous* process is exactly the kind a fresh one should
  // clear. Like recovery it lives here rather than in createServer, so a test's
  // short-lived server never has a timer reaching into a database it has closed.
  const sweep = () =>
    server.retention
      .sweep()
      .then((result) => {
        if (result.removed > 0) console.log(JSON.stringify({ event: "retention_swept", ...result }));
      })
      .catch((err) => console.error("retention sweep failed:", err.message));
  void sweep();
  if (config.retentionSweepSeconds > 0) {
    const timer = setInterval(sweep, config.retentionSweepSeconds * 1000);
    timer.unref?.();
    server.on("close", () => clearInterval(timer));
  }
  return server;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  start().then((server) => {
    const addr = server.address();
    console.log(
      JSON.stringify({
        event: "api_listening",
        host: addr.address,
        port: addr.port,
        dataDir: config.dataDir,
        webDist: config.webDist,
        workerAvailable: workerAvailable(),
      }),
    );
  });
}