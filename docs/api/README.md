# Capture API

The HTTP surface of the product: `apps/api/src/server.js`. Zero npm
dependencies — `node:http`, `node:sqlite`, `node:child_process` only — one
process that serves the JSON API, the built web app (`WEB_DIST`, SPA
fallback) and the real reconstruction worker.

Every claim below is enforced by tests that run in `sh scripts/verify.sh`:
the **api** section drives `apps/api/test/*.test.js` (63 tests across eight
files: contract, validation, rate limit, accounts and ownership, share links,
restart recovery and post-run cleanup, storage, presigned direct uploads,
retention, time limit, cancellation), and the browser e2e drives the same
routes (`node apps/web/e2e/run.mjs`, 22 steps, including the account page
deleting an account). Measured numbers quoted here are reproduced by
`docs/status.md` §2 with their own gates.

## Routes

| Method | Path | Answer |
|---|---|---|
| GET | `/api/health` | `{ ok, service, version, worker: { available, entrypoint, python, projectRoot }, limits, auth, storage, retention }` — `limits` echoes every hard limit below; `storage` names the driver actually in use (`kind`, `durable`, `directUploads`, `bucket`, `warnings`) and never a key; `retention` reports `{ enabled, capture_ttl_days, upload_abandoned_minutes }` |
| POST | `/api/auth/signup` | `{ email, password, name? }` → `201 { user }` and a session cookie |
| POST | `/api/auth/signin` | `{ email, password }` → `200 { user }` and a fresh session cookie; `401 "email or password is incorrect"` otherwise |
| POST | `/api/auth/signout` | revokes this session, clears the cookie → `200 { signed_out, revoked }` |
| GET | `/api/auth/me` | `200 { user, signed_in }` — `user: null` when signed out, so the bootstrap call is never an error |
| DELETE | `/api/auth/account` | `{ password }` → `200 { deleted, captures_deleted, objects_deleted, sessions_revoked, cancelled }`: erases the account, its captures and their stored objects, and clears the cookie. `401` for no session or a wrong password. Irreversible |
| GET | `/api/captures` | `{ captures: [...] }` — this **account's own** captures, 50 most recent. `401` without a session |
| POST | `/api/captures` | `{ name, images: [base64 data URLs], scale_calibration? }` → `202` with the capture record, status `queued`. `401` without a session. The photographs travel in the request body, bounded by `MAX_BODY_BYTES` |
| POST | `/api/captures/uploads` | `{ name, images: [{ contentType, bytes }], scale_calibration? }` — a **manifest** only, no bytes → `201 { …capture, direct: true, uploads: [{ key, name, contentType, url, headers, max_bytes }] }` and the capture is created `uploading`. `409 direct_uploads_unavailable` when the driver cannot presign (local disk), `400`/`413` on a bad manifest. `401` without a session; rate-limited like `POST /api/captures` |
| POST | `/api/captures/:id/uploads/complete` | owner only. Re-checks the objects the client says it uploaded (exists, non-empty, within `MAX_IMAGE_BYTES`, bytes really are the declared container) and only then queues the job → `200` with the capture now `queued`. `403` for a non-owner, `409` when the capture is not `uploading`, `400`/`413` naming the object that failed — and on any failure the capture is removed whole (rows, objects, working directory) rather than left half-uploaded |
| GET | `/api/captures/:id` | status, stage, progress, note, elapsed, error, the `role` (`owner` \| `shared`) the caller is reading as, and manifest fragments once the worker produced them |
| GET | `/api/captures/:id/result` | the worker's own result document; `409` while it does not exist yet |
| GET | `/api/captures/:id/model.glb` | the reconstructed model as binary GLB; `409` unless status is `completed` and the file exists |
| POST | `/api/captures/:id/share` | owner only → `200 { shared: true, share_token, model_path, ar_path }`. Idempotent: asking twice returns the same live token |
| DELETE | `/api/captures/:id/share` | owner only → `200 { shared: false }`, and the previous link stops working on the next request |
| DELETE | `/api/captures/:id` | cancel a queued or running capture → `202 { cancelled, was, capture }`. Owner only |
| * | anything else | the built web app from `WEB_DIST`, SPA fallback |

`:id` is a UUID. `DELETE` on a subresource (`/result`, `/model.glb`) answers
`405` — cancellation applies to the capture itself.

## Access

A capture is readable by exactly two parties, and no third:

1. **the owning account** — an `oca_session` cookie, no token needed;
2. **a share-link holder** — the capture's `?t=<share_token>` on the request.

Everything else is refused, and the refusal says which refusal it is: `401`
("sign in to view this capture") when there is no session and no token, `403`
("this capture belongs to another account") for a session that is not the
owner, and `403` ("this share link is no longer active") when a token was
supplied but does not match the row. Sharing endpoints answer `404` to a
non-owner so they cannot be used to discover which capture ids exist, and a
capture created before accounts existed has no owner and is readable by
nobody. Gated by `apps/api/test/auth.test.js` and, for the browser half, by
the e2e steps that read a shared model from a cookie-less context and then
revoke it.

## Lifecycle

```
queued ──▶ running ──▶ completed     (model.glb + result exist)
   │           ├─────▶ failed        (worker's own named error stage)
   │           └─────▶ cancelled     (DELETE while running: SIGTERM, then
   └──────────────────▶ cancelled       "cancelled" on close — never failed)

uploading ──▶ complete ──▶ queued      (direct uploads only: the row exists
   │                                     while the bytes are in flight, and
   └──────────────────▶ swept          is reaped by the retention sweep if
                                       the client never calls /complete)
```

- **`uploading` is a real state, not a placeholder.** 
  `POST /api/captures/uploads` creates the row before any byte exists, so the
  capture is visible to its owner and to the sweeper but never in
  `GET /api/captures` and never in the queue. `…/uploads/complete` is the only
  door out of it: it verifies the objects and enqueues, or removes the capture
  whole and names what went wrong.
- A **queued** capture cancelled by `DELETE` is dequeued without ever
  starting; a **running** one has its worker process stopped. Both end in the
  named `cancelled` state with no model written (`202`, `was: "queued"` or
  `was: "running"`).
- Terminal states (`completed`, `failed`, `cancelled`) answer `409` to
  `DELETE` with the server's own message.
- A reconstruction that exceeds the time limit is killed and reported as
  `failed` with stage `timeout` — it is never left hanging as `running`.
- **A restart re-queues unfinished work.** The job queue is in memory, so a
  capture that was `queued` or `running` when the process stopped would
  otherwise read as "in progress" for ever. On boot (`start()`, never
  `createServer`) the runner re-queues exactly those rows and runs them again
  from the beginning — their inputs are still on disk, so nothing is lost and
  nothing is falsely reported as finished.
- **A finished run prunes its working copy.** The worker's scratch directory
  goes always; the raw photographs go too once a durable store holds them
  (`KEEP_LOCAL_COPIES=1` keeps them). The published model and result stay local
  as a warm cache, and the read path falls back to the stored object.

Gated by `apps/api/test/cancel.test.js` (queued + running, with a stand-in
worker that traps SIGTERM), `apps/api/test/timeout.test.js`, and
`apps/api/test/worker.test.js` (restart recovery + post-run cleanup); the web
side by `apps/web/test/cancel.test.ts` and the e2e step "a running
reconstruction can be cancelled from the processing screen".

## Errors

Every error is the same envelope:

```json
{ "error": { "message": "human-readable, from the server itself" } }
```

Status codes in use: `400` (malformed payload, wrong image type, unsupported
calibration unit, password too short), `401` (no session, or a bad
email/password pair), `403` (someone else's capture, a revoked share link, a
non-owner finishing somebody else's upload), `404` (unknown capture; also a
non-owner asking about a capture's share link), `405` (DELETE on a subresource),
`409` (terminal state, result/model not available yet, email already
registered, `direct_uploads_unavailable`, an upload that is not `uploading`),
`413` (body or image over limit), `429` (upload or sign-in rate limit, with a
retry hint), `502` (the object store refused an upload), `503` (worker not
available — checked against the real Python entrypoint, never stubbed).

The client (`apps/web/src/lib/api.ts`) surfaces the server's message verbatim
as an `ApiError`; tests assert this rather than a generic status string.

## Hard limits (defaults; `/api/health` echoes the live values)

| Limit | Default | Env var |
|---|---|---|
| Images per capture | 2 min, 200 max | `MAX_IMAGES` |
| Bytes per image | 12 MiB | `MAX_IMAGE_BYTES` |
| Request body | 96 MiB | `MAX_BODY_BYTES` |
| Job time limit | 900 s (killed → `failed`) | `JOB_TIMEOUT_SECONDS` |
| Concurrent reconstructions | 1 (CPU-bound) | `MAX_CONCURRENT_JOBS` |
| Upload rate | burst of 5 captures, +1 per 600 s | `UPLOAD_BURST`, `UPLOAD_REFILL_SECONDS` |
| Sign-in rate | burst of 10 attempts, +1 per 300 s (spent before the scrypt check) | `AUTH_BURST`, `AUTH_REFILL_SECONDS` |
| Session lifetime | 30 days, enforced on every lookup | — |
| Cookie `Secure` flag | decided per request from the scheme; force it on or off | `COOKIE_SECURE` |
| Password length | 10 min, 200 max | — |
| Listen address / port | `0.0.0.0` / `8787` | `HOST`, `PORT` |
| Storage directory | `apps/api/data/` | `DATA_DIR` |
| Built web app | `apps/web/dist/` | `WEB_DIST` |
| Python interpreter | `python3` | `PYTHON` |
| Storage driver | `auto` → Backblaze B2 when configured, else local disk | `STORAGE_DRIVER` (`auto`/`local`/`b2`) |
| B2 credentials | none (captures stay on local disk) | `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`, `B2_PREFIX`, `B2_ENDPOINT` |
| Keep local photographs after publish | off (pruned once a durable store holds them) | `KEEP_LOCAL_COPIES` |
| Presigned direct uploads | on when the driver can presign (B2); local disk cannot, so it answers `409` and the client uses the body route | `DIRECT_UPLOADS` |
| Capture time-to-live | **0 = keep until the owner deletes it** (the default). Set to days > 0 to expire finished captures on a clock | `CAPTURE_TTL_DAYS` |
| Abandoned-upload expiry | 120 min — an `uploading` row older than this is reaped, always, whatever the TTL says | `UPLOAD_ABANDONED_MINUTES` |
| Retention sweep interval | 600 s | `RETENTION_SWEEP_SECONDS` |

## Direct-to-bucket uploads

When the configured driver can hand out a URL (Backblaze B2; see
`docs/storage/README.md`), the client skips `MAX_BODY_BYTES` entirely:

```
browser                                API                       object store
  │ POST /api/captures/uploads          │                              │
  │  manifest: [{contentType, bytes}]   │  row created status=uploading │
  │◀ 201 { direct: true, uploads:[…] } ─┤  one presigned URL per photo  │
  │                                                                   │
  │ PUT/POST each photograph, with the API's headers ────────────────▶│
  │                                                                   │
  │ POST /api/captures/:id/uploads/complete ──▶ HEAD + range read of   │
  │                                             each object, sniffed  │
  │◀ 200 capture now `queued` ─────────────────┤  then enqueue         │
```

Two things are deliberate, and both are about not lying:

- **The API does not stamp the checksum or the length into the presigned
  headers.** It never sees the bytes, so it cannot compute an honest
  `x-bz-content-sha1`; and a browser forbids a script from setting
  `content-length`. The client computes the checksum itself (WebCrypto SHA-1)
  and the HTTP stack supplies the real length.
- **What landed is re-checked before any worker sees it.** `/uploads` checks only
  the declared manifest (count, media type, declared size). `…/uploads/complete`
  then `HEAD`s each object, reads bytes 0–15 and sniffs the container
  (JPEG/PNG/WebP), compares it with the declared type, and materialises the
  bytes into the worker's working copy. Any mismatch removes the capture whole
  and names the object.

An upload token cannot be **scoped to a name or prefix** — the object store hands
out one token per bucket-wide upload URL, so a client that holds it can write
any object in the bucket until it expires (documented in
`docs/security/README.md`). The `uploading` row is the session: it is excluded
from `GET /api/captures`, and it is what the retention sweep reaps if the client
never calls `complete`.

The client (`apps/web/src/lib/upload.ts`) prefers the direct route when
`/api/health` advertises it and falls back to the request body on **any** direct
failure except `401` — a bucket whose CORS rules block the preflight, a store
that refuses an upload, a browser without WebCrypto. Gated by
`apps/api/test/direct-upload.test.js` (10 tests) and
`apps/web/test/direct-upload.test.ts` (10 tests).

## Retention

The sweep runs at boot (`start()`, never `createServer`) and every
`RETENTION_SWEEP_SECONDS` (600 s default), with the interval `unref()`ed and
cleared when the server closes. It does two different things:

- **It always reaps abandoned uploads** — `uploading` rows older than
  `UPLOAD_ABANDONED_MINUTES` (120 min default). This is housekeeping, not a
  product promise, and it is on whatever `CAPTURE_TTL_DAYS` says.
- **It expires finished captures only when a TTL is configured** —
  `CAPTURE_TTL_DAYS` defaults to **0**, which means *keep until the owner deletes
  it*. Deleting a user's reconstruction on a timer is a product decision nobody
  made, so the code does not make it by default.

A sweep cancels anything still queued or running first, then removes the
capture's objects, its working directory and its row. A per-capture failure is
logged and does not stop the rest of the sweep. Gated by
`apps/api/test/retention.test.js` (7 tests).

## Rate limiting

A token bucket per client key (`x-forwarded-for` first hop, else the socket
address), each capture costing one token; the burst bucket refills one token
per refill window. Over the bucket the API answers `429` with the server's
own message and a retry hint — gated by the upload-burst test. Idle buckets
are dropped after a full refill so the map cannot grow forever.

## Image validation

Before anything touches the disk, each payload must be a base64 data URL of
`jpeg`, `png` or `webp`, non-empty, within the per-image limit — and the
**container bytes are sniffed** (JPEG SOI, PNG magic, `RIFF….WEBP`), so a
mislabelled payload cannot fool the worker. Failures are `400`/`413` with the
reason.

The direct-upload route cannot sniff before the write — the bytes go straight to
the bucket — so it sniffs **after** they land, at
`POST /api/captures/:id/uploads/complete`: a `HEAD` for existence and size, then
a **range read of bytes 0–15** matched against the declared media type. A
mislabelled object is caught there, and the capture is removed whole rather than
queued. The extension used on disk follows the sniffed bytes, never the client's
label.

## Scale calibration

`scale_calibration: { value, unit }` with `unit` one of `mm`, `cm`, `m`,
`in`, `ft` and `value` a finite positive number. Only the **primary**
measurement fixes the model's scale; any additional dimensions are kept so
the model page can show "your ruler vs the reconstruction" as a check — they
are never used to scale anything. Without a calibration the model is
published as `units: "uncalibrated"` rather than in invented metres.

## What this API is not (yet)

- **Time-based expiry is built but off.** `CAPTURE_TTL_DAYS` defaults to `0`:
  captures are kept until their owner deletes them, because expiring somebody's
  reconstruction on a clock is a product decision (ADR 0007). Set it above zero
  to switch the sweep's expiry half on. Abandoned `uploading` rows are always
  reaped. What is still missing is a **bucket-side lifecycle rule** — the
  codebase reaps the rows and the objects it knows about, and B2's own lifecycle
  rules are not configured here.
- **Cloud storage is built but unconfigured in this sandbox.** Photographs are
  stored as they are uploaded and `result.json`/`model.glb` before a capture is
  called `completed` — into local disk by default, or into Backblaze B2 when
  `B2_KEY_ID`/`B2_APPLICATION_KEY`/`B2_BUCKET_NAME` are set. With B2 configured,
  `GET /model.glb` falls back to the stored object when the host's copy is gone,
  including for a share-token reader, and photographs upload **straight to the
  bucket** without passing through `MAX_BODY_BYTES`. `DELETE /api/auth/account`
  removes an account's objects along with its rows, and a finished capture's
  photographs are pruned from local disk once the bucket holds them. Direct
  uploads need the bucket's **CORS rules** to allow this app's origin — see
  `docs/storage/README.md`.
- **No email verification, no OTP, and no separate username.** Sign-in is the
  email address — which is what stands in for a username — and a password,
  nothing else. Nothing proves the address and there is no password reset.
  Both are deliberately deferred until after testing, an owner decision rather
  than an oversight, and both need an outbound email provider.
- **No MFA, no data export, no audit log** of who read which model. Account
  deletion exists but is one-way: there is nothing to download first. See
  `docs/security/README.md` for the full built/not-built list.
- **One deployment shape.** Node + Python in one repo; Freebuff's managed
  hosting builder is Node-only, so production goes through
  `docs/deployment/docker.md` or `docs/deployment/vps.md`.
