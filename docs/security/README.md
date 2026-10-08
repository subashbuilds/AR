# Security posture — what is and is not protected

This document states the current model honestly. It is a description of what
the code does, not a certification; the enforced parts name the test that
enforces them. `docs/status.md` §5 carries the same list as "not built".

## What is built

- **Accounts.** Email + password, first-party. The password is hashed with
  scrypt (`node:crypto`, N=16384, r=8, p=1, 64-byte key, per-user random salt)
  and only the hash is stored; the plaintext never reaches disk, a log or a
  response. Sign-in failures are deliberately indistinguishable — one message
  for both halves of the pair, and an unknown address still costs a full scrypt
  comparison — so the endpoint cannot be used to enumerate accounts. Gated by
  `apps/api/test/auth.test.js`.
- **Sessions.** An opaque 256-bit token in an `HttpOnly; SameSite=Lax` cookie,
  stored server-side as a SHA-256 digest with a 30-day expiry that is enforced
  on every lookup. `SameSite=Lax` means a cross-site POST does not carry the
  session, so no separate CSRF token is needed for the JSON API; `Secure` is
  added whenever the request arrived over TLS (`x-forwarded-proto`, or a TLS
  socket). Sign-out revokes the row, so a copied cookie stops working
  immediately.
- **Per-user ownership.** A capture belongs to the account that created it.
  `POST`/`GET /api/captures` require a session and only ever return that
  account's captures; a second account gets `403` on someone else's capture and
  can neither read, cancel nor share it. `GET /api/captures/:id` with no
  session answers `401`.
- **Revocable share links.** The capture id is no longer a bearer capability.
  Reading a capture requires either the owning session or the capture's
  `?t=` **share token** — a separate 192-bit secret that only the owner can
  create (`POST /api/captures/:id/share`, `404` for anyone else, so the
  endpoint cannot reveal which ids exist) and that is deleted by
  `DELETE /api/captures/:id/share`. Revocation applies to the next request
  because the token is compared against the row, never cached. A capture that
  has never been shared is private even to someone holding the exact URL.
- **Unguessable identifiers.** Captures are addressed by server-generated
  UUIDs (`randomUUID`), not sequential ids, so ids cannot be enumerated.
- **Account deletion that actually deletes.** `DELETE /api/auth/account`
  erases the account and is confirmed with the password as well as the session,
  so a borrowed browser is not enough. The password check spends the sign-in
  budget rather than being a free oracle. In one step it cancels anything still
  running, removes every object the account owned from the store, deletes each
  capture's working directory and row, revokes every session and drops the user
  row, then clears the cookie. Gated by `apps/api/test/auth.test.js` (password
  required, another account's capture survives, a share link dies with its
  capture), for the bucket side by `apps/api/test/storage.test.js` (exactly
  that account's objects go), and for the UI by `apps/web/test/account.test.ts`
  plus the e2e step where the button stays inert until the password is typed
  and a wrong one removes nothing.
- **Input hardening before anything touches disk.** Image payloads must be
  base64 data URLs of jpeg/png/webp *and* the container bytes are sniffed
  (JPEG SOI / PNG magic / RIFF-WEBP) — a mislabelled payload is rejected with
  400/413. Request body, per-image and per-capture limits are enforced in the
  API before writes (`MAX_BODY_BYTES`, `MAX_IMAGE_BYTES`, `MAX_IMAGES`).
- **Rate limiting, in two independent buckets.** Uploads: a burst of 5
  captures, +1 per 600 s (`UPLOAD_BURST`, `UPLOAD_REFILL_SECONDS`). Sign-in and
  sign-up: a burst of 10 attempts per client, +1 per 300 s (`AUTH_BURST`,
  `AUTH_REFILL_SECONDS`), spent *before* the scrypt comparison so guessing
  costs the attacker more than it costs the server. Both answer 429 with a
  retry hint, and neither can lock a signed-in user out of reading.
- **Resource bounds.** One reconstruction at a time, and every job is killed
  at `JOB_TIMEOUT_SECONDS` (900 s default) and reported `failed` with stage
  `timeout` — a hung job cannot occupy the service forever
  (`apps/api/test/timeout.test.js`).
- **Response hygiene.** No server filesystem path is ever returned to a client
  (`dir` is stripped from every capture response). Static and API responses
  carry `x-content-type-options: nosniff`, `referrer-policy: same-origin`
  (a share token is in the URL, and a URL leaks through `Referer`) and
  `x-frame-options: DENY`. The GLB is served `private, max-age=60` rather than
  `immutable`, because a revocable link must not hand out a year-long cache.
- **No third-party calls, unless storage is configured.** With the default
  local driver nothing leaves the host. With Backblaze B2 configured, a
  capture's photographs, `result.json` and `model.glb` are copied to the
  bucket, over HTTPS, under keys the codebase builds itself
  (`captures/<id>/…`, optionally behind `B2_PREFIX`). The application key is
  read from the environment, used for nothing but its own API, and never
  returned in a response (the health endpoint reports the driver, the bucket
  name and any warnings — never the key), and no public bucket URL is ever
  handed to a client: reads still go through this API's own authorisation, so
  revoking a share link still revokes access to a stored model.
  `docs/storage/README.md` says what a bucket must be configured as, and
  `apps/api/test/storage.test.js` asserts the key never appears in
  `/api/health`.
- **Direct uploads move the trust boundary, and it is re-drawn server-side.**
  With B2 configured the browser uploads a capture's photographs straight to the
  bucket through short-lived presigned URLs, so the API never sees those bytes
  before they exist. It therefore does not trust anything the client says about
  them: it re-reads every object at `POST /api/captures/:id/uploads/complete`
  (a `HEAD` for size, a range read of the first bytes to sniff the container),
  compares that against the declared manifest, and only then materialises the
  worker's copy and queues the job. A mismatch removes the capture whole. What
  cannot be constrained is the **scope** of an upload token — the object store
  issues a bucket-wide write token, not one bound to a name or prefix — so a
  client holding it can write any object in the bucket until it expires; treating
  the bucket as untrusted input space is why this check exists and why the bucket
  **must** be private. `uploading` rows are excluded from `GET /api/captures`
  until they complete, and an abandoned one is reaped by the retention sweep
  (`apps/api/test/direct-upload.test.js`, `apps/api/test/retention.test.js`).
- **Process isolation of the worker.** The Python worker runs as a spawned
  child with a time limit and can be stopped (`DELETE` → SIGTERM); the child
  is the only component that executes repository Python on user data.

## What is NOT built (the honest list)

1. **No email verification, no OTP, and no password reset.** Sign-in is an
   email address — which is what stands in for a username; there is no separate
   username field — and a password, nothing else. That is a deliberate deferral
   for the testing phase, decided by the product owner rather than overlooked. Any address can be registered without proving control of it,
   and a forgotten password has no recovery path; both need an outbound email
   provider, so both are absent rather than half-built.
2. **No default expiry, no SSE-C key, no bucket lifecycle rule, and no audit
   log.** Cloud storage itself exists (local disk by default, Backblaze B2 when
   configured — ADR 0006), a capture is not called `completed` until its
   artifacts are stored, photographs can be uploaded straight to the bucket
   through presigned URLs (ADR 0007), and a sweep reaps abandoned uploads and —
   only when `CAPTURE_TTL_DAYS` is set above its default of `0` — expired
   captures. What is still missing: by default a capture nobody deletes stays
   in the bucket for ever, because expiring a user's reconstruction on a timer
   is a product decision nobody has made; the codebase configures no bucket
   lifecycle rule, chooses no encryption-at-rest key (it relies on the bucket's
   own SSE-B2 setting), and keeps no audit log of who read which model; and a
   public bucket would bypass this API's authorisation entirely, so the bucket
   **must** be private, with CORS rules scoped to the app's own origin
   (`docs/storage/README.md`).
3. **No transport policy of its own.** The code serves plain HTTP; TLS is
   the deployer's job (`docs/deployment/vps.md` puts it behind a reverse
   proxy). Note the dependency this creates: `Secure` is decided from
   `x-forwarded-proto`, so a proxy that does not forward the scheme gets a
   cookie without the flag. That is not hypothetical — it is what happens on
   this project's own Freebuff preview, observed: its HTTPS signup response
   carries `HttpOnly; SameSite=Lax` and no `Secure`. The cookie is still
   HttpOnly and same-site, and the preview only serves HTTPS, but a deployment
   behind such a proxy should set `COOKIE_SECURE=1` explicitly rather than rely
   on the scheme being reported. The code cannot tell that proxy apart from a
   genuinely plain-HTTP request, so it will not guess.
4. **No MFA, and no data export.** Deletion exists and is irreversible —
   `DELETE /api/auth/account` removes the account, its captures and their
   objects, whether or not a copy was wanted first — so there is no
   download-before-delete step and no second factor gating it beyond the
   password. Deleting an account is also the only way to remove a specific
   capture's bytes; there is no per-capture delete yet.
5. **No cross-origin credentialed API surface.** API responses still send
   `access-control-allow-origin: *`, but without
   `access-control-allow-credentials` a browser will not attach the session
   cookie cross-origin, so a third-party site cannot read a private capture.
   There is no supported cross-origin client; the app is served same-origin
   by the same process.
6. **Deployment-level gaps.** No reverse-proxy hardening, no WAF, no audit
   log of who read which model, and no backup story for `DATA_DIR`.

## Consequences

- A share link is a bearer token: whoever holds the URL can read the model
  until the owner revokes it. Treat it as public to that extent, and use
  **Stop sharing** when the link should stop working.
- Passwords are the only account factor. Encourage long passphrases: the
  minimum is 10 characters and the rate limit is 10 attempts per client per
  5 minutes, which is a real but modest brake on guessing.
- A deployment that must not be public should still not be: front it with
  TLS, and note in its own docs that `DATA_DIR` is unencrypted local disk.
- Anything added to this file must either name its enforcing test or be
  listed under "not built". Claims without either are not allowed here.
