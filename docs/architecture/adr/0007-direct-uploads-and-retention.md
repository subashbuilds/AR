# 0007 — Direct-to-bucket uploads, and a retention clock that is off by default

Status: **accepted** (7 October 2026)

## Context

ADR 0006 put a capture's bytes in Backblaze B2, but the photographs still had to
reach the API first: they arrived as base64 in a JSON body bounded by
`MAX_BODY_BYTES` (96 MiB), which is both a hard ceiling on a capture and a lot of
data passing through a process that does nothing with it. The object store the
bytes were going to already knows how to accept them directly.

The other open item from `docs/status.md` §5 was space that never comes back: a
run reclaimed its scratch directory and an account deletion removed everything it
owned, but a capture nobody touched stayed in the bucket for ever. "Retention"
was on the unbuilt list as *time-based lifecycle/expiry*, and the phrase hid a
product question — **whose** time, and is it ours to run out? — which no code
change can answer.

## Decision

**Photographs upload straight to the bucket, and the API verifies what landed
rather than trusting the manifest.** `POST /api/captures/uploads` takes a
*manifest* (count, media type, declared size per photograph), creates the capture
row in a new `uploading` state, and answers with one short-lived presigned upload
URL (`b2_get_upload_url`) plus the exact headers per object.
`POST /api/captures/:id/uploads/complete` then re-reads every object — a `HEAD`
for existence and size, a **range read of bytes 0–15** sniffed against the
declared container — materialises the worker's copy, and only then queues the
job. Any mismatch removes the capture whole (rows, objects, working directory)
and names the object that failed.

**The API deliberately does not stamp the checksum or the length into the
presigned headers it hands out.** It never sees the bytes, so an
`x-bz-content-sha1` computed by the API would describe something other than what
the client sends; and a browser forbids a script from setting `content-length`.
The client computes the checksum itself (WebCrypto SHA-1) and its HTTP stack
supplies the real length.

**The direct route is preferred when the deployment offers it, and the request
body is the fallback for any failure except `401`.** A bucket whose CORS rules
block the upload, a store that refuses a file, a browser without WebCrypto: each
of those falls back to the route that always worked, so a capture still succeeds
rather than the user seeing an object-store error they cannot act on. A `401` is
rethrown, because retrying a signed-out session would fail the same way twice.
`LocalStorage` reports `supportsDirectUploads: false` and answers
`409 direct_uploads_unavailable`; `DIRECT_UPLOADS=0` switches the feature off
even with B2 configured.

**Retention runs on a clock, and the clock is set to zero by default.**
`CAPTURE_TTL_DAYS` defaults to **`0` = keep until the owner deletes it**, because
expiring somebody's reconstruction on a timer is a product decision, and making
that decision silently would be the codebase deciding what a user's data is
worth. Set above zero, the sweep expires finished captures older than that.
Abandoned uploads are **always** reaped after `UPLOAD_ABANDONED_MINUTES`
(120 min default) — that is housekeeping, not a product promise; an `uploading`
row is not a capture yet. The sweep runs once at boot inside `start()` (never
`createServer`), then every `RETENTION_SWEEP_SECONDS` (600 s), with the interval
`unref()`ed and cleared when the server closes. It cancels anything still running
first, and a failure on one capture is logged without stopping the rest.

**`uploading` is a real state and stays out of the product surface.**
`GET /api/captures` excludes it, so a capture cannot be listed before its bytes
exist, and the sweep is what happens when the client never finishes.

## Consequences

- A capture's size is no longer capped by `MAX_BODY_BYTES` on the direct route —
  the API's job shrinks to authorising, handing out URLs and verifying, and the
  bytes take the short path.
- **The trust boundary moved and is re-drawn server-side.** Anything the client
  declares is a claim until the post-landing check runs. What cannot be
  constrained is the *scope* of an upload token: the store issues a bucket-wide
  write token, not one bound to a name or prefix, so a holder can write any
  object in the bucket until it expires. That is why the objects are re-read
  before use and why the bucket **must** be private
  (`docs/storage/README.md`).
- **The direct route needs bucket CORS.** A browser will preflight an upload to a
  different origin; without a rule allowing `POST` from the app's origin the
  direct route fails and every capture silently takes the slower body route —
  correct, but not what the deployment intended. Documented as a setup step, and
  the reason the fallback exists.
- **Retention defaults to doing nothing to a user's data**, and that is a stated
  position, not an omission: a deployment that wants expiry sets
  `CAPTURE_TTL_DAYS`. A bucket-side lifecycle rule is still not configured by
  this codebase, and with a TTL set the API's rows and the bucket can diverge if
  one expires a key the other still lists.
- Verified without an account: `apps/api/test/direct-upload.test.js` (10 tests)
  and `apps/api/test/retention.test.js` (7 tests) run against
  `apps/api/test/b2-stub.js`, and the browser client contract by
  `apps/web/test/direct-upload.test.ts` (10 tests). All three are wired into
  `sh scripts/verify.sh`, so they cannot rot. What they cannot prove is the real
  service: there is no Backblaze account in this environment, and the gate is
  honest about standing in a stub.
