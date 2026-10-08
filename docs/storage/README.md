# Storage

Where a capture's bytes live, and what changes when they live somewhere else.

One interface (`apps/api/src/storage.js`), two drivers:

| Driver | Selected when | Durability |
|---|---|---|
| `LocalStorage` | by default, or `STORAGE_DRIVER=local` | files under `DATA_DIR` on this host only |
| `B2Storage` | `B2_KEY_ID`, `B2_APPLICATION_KEY` and `B2_BUCKET_NAME` are all set | the objects are in the bucket before the capture is called `completed` |

The driver in use is reported by `GET /api/health` — `storage.kind`,
`storage.durable`, `storage.directUploads`, `storage.bucket` and any
`storage.warnings`. Nothing about the application key is ever returned, logged
or put in a URL, and a presigned **upload** URL (which a client must hold for a
few seconds) is never returned by health or written to a log.

## What is stored, and when

```
POST /api/captures      each photograph is validated, written to the working
                        copy under DATA_DIR, and put in the bucket as
                        captures/<id>/images/frame_001.jpg …
POST /api/captures/uploads  the presigned variant: the API creates the row and
                        hands the browser one upload URL per photograph, so
                        the bytes go straight into the bucket and never
                        through the API process at all
POST …/uploads/complete the API re-reads each object (HEAD + a range read of
                        the first bytes), materialises the worker's copy, and
                        only then queues the job
worker finishes         result.json and model.glb are put in the bucket, and
                        only then does the capture become `completed`
GET  /model.glb         the local working copy if it is there, otherwise the
                        stored object -- a capture whose host lost its disk is
                        still servable, including through a share-token link
DELETE /api/auth/account  every object the account owned is removed from the
                        bucket, and its working directories are deleted
```

Two things this deliberately does **not** do:

- **The worker still needs a real filesystem.** It is spawned with an
  `images_dir` and writes `glb_path`/`result_json`, so a local working copy
  always exists. With a remote driver that copy is a *cache*: it is what the
  read path prefers and what the worker reads, but it is no longer the only
  copy. It is pruned on the schedule described under "Retention" below.
- **The direct route does not trust the client's checksum.** The client computes
  the SHA-1 the store verifies (`x-bz-content-sha1`), because the API never sees
  the bytes; the API instead re-reads each object after it lands and sniffs its
  container bytes before any worker is allowed to see it. A mislabelled or
  truncated object does not reach the pipeline — the capture is removed whole.

## Presigned uploads

The browser uploads straight to the bucket when the driver can presign it:

1. `POST /api/captures/uploads` sends a **manifest** — the count, media type and
   declared size of each photograph, never the bytes — and the API creates the
   capture row in the `uploading` state.
2. The API answers with a short-lived upload URL and the exact headers to send
   for each photograph (`b2_get_upload_url`, one per object).
3. The browser uploads each photograph itself, with its own computed SHA-1.
4. `POST /api/captures/:id/uploads/complete` makes the API re-read every object,
   verify its size and sniff its container bytes, materialise the worker's copy,
   and only then queue the job.

Three facts worth stating plainly:

- **An upload token cannot be scoped to one name or prefix.** The store hands
  out a bucket-wide write token for an upload URL, so a client holding it can
  write any object in the bucket until it expires. That is why the objects are
  still re-checked server-side before use and why the bucket **must** be
  private.
- **The API does not fill in `content-length` or the checksum** of the presigned
  headers: it never sees the bytes, and a browser forbids a script from setting
  `content-length`. The caller's HTTP stack supplies the length; the client
  computes the checksum.
- **It is off, honestly, where it cannot work.** `LocalStorage` reports
  `supportsDirectUploads: false` and `presign()` returns `null`, so
  `POST /api/captures/uploads` answers `409 direct_uploads_unavailable` and the
  browser uses the request-body route. It never pretends to presign. Set
  `DIRECT_UPLOADS=0` to switch the whole feature off even with B2 configured.

Gated twice: the API contract by `apps/api/test/direct-upload.test.js` (10
tests) and the browser client by `apps/web/test/direct-upload.test.ts` (10
tests).

## Retention

Two things reclaim space, both driven by events rather than a timer:

- **After a run finishes**, the worker's `work/` scratch directory is deleted,
  always. The raw photographs are deleted too **once a durable driver holds
  them** — they are the bulk of a capture and nothing reads them after the job
  completes. The published `model.glb` and `result.json` are left in place as a
  warm local cache; the read path still falls back to the bucket when they are
  gone. With the local driver nothing but the scratch directory is touched,
  because there the disk copy is the only copy. Set `KEEP_LOCAL_COPIES=1` to
  keep the photographs too. Gated by `apps/api/test/worker.test.js`.
- **When an account is deleted** (`DELETE /api/auth/account`, confirmed with the
  password), every object the account owned is removed from the bucket, each
  capture's working directory is deleted, and the rows and sessions go with
  them. A capture that was still running is cancelled first, so no worker is
  left writing into a directory that no longer exists. Gated by
  `apps/api/test/storage.test.js` (the bucket loses exactly that account's
  objects) and `apps/api/test/auth.test.js` (the password is required; another
  account's capture survives).

Failure is never silent. If a photograph cannot be stored the capture is
refused with `502` and the working directory is removed; if the model cannot be
stored after a *successful* reconstruction, the capture ends `failed` with
stage `storage`, because reporting `completed` would promise a model that may
not exist.

### On a clock

Beyond the event-driven reclamation above, a sweep runs at boot (`start()`) and
every `RETENTION_SWEEP_SECONDS` (600 s), and does two things:

- **always** reaps `uploading` rows older than `UPLOAD_ABANDONED_MINUTES`
  (120 min) — an abandoned direct upload would otherwise linger for ever with a
  half-filled capture directory;
- **when `CAPTURE_TTL_DAYS` is set above 0** (default is **`0` = keep**, because
  expiring a user's reconstruction on a timer is a product decision), expires
  finished captures older than that, oldest first.

A sweep cancels anything still queued or running before it removes the capture,
and an error on one capture is logged and does not stop the rest. Gated by
`apps/api/test/retention.test.js` (7 tests), including the negative control that
**nothing** is expired while the TTL is `0`.

## Configuration

| Env var | Meaning |
|---|---|
| `STORAGE_DRIVER` | `auto` (default: B2 if configured, else local), `local`, or `b2` |
| `B2_KEY_ID` | the application key **id** |
| `B2_APPLICATION_KEY` | the application key |
| `B2_BUCKET_NAME` | the bucket, by name |
| `B2_PREFIX` | optional key prefix, e.g. `prod/` |
| `B2_ENDPOINT` | optional; defaults to `https://api.backblazeb2.com`. Exists so a test can point the whole surface at a stand-in |
| `KEEP_LOCAL_COPIES` | `1` keeps a published capture's photographs on local disk instead of pruning them; off by default, and never applies to the local driver |
| `DIRECT_UPLOADS` | `1`/`0` forces presigned uploads on or off; unset = on whenever the driver can presign (B2), off for local disk |
| `CAPTURE_TTL_DAYS` | days after which a finished capture is swept; **`0` (default) keeps captures until their owner deletes them** |
| `UPLOAD_ABANDONED_MINUTES` | minutes before an `uploading` row is considered abandoned and reaped (default `120`) |
| `RETENTION_SWEEP_SECONDS` | how often the sweep runs (default `600`) |

Half a configuration is not ignored: it falls back to local disk **and**
reports a warning naming the missing keys, so a bucket does not quietly stay
empty. Asking for `STORAGE_DRIVER=b2` with nothing configured warns too.

### Setting up the bucket

1. Create a **private** bucket in the Backblaze web UI (a public bucket would
   let anyone read a model without the product's own authorisation).
2. Create an application key restricted to that one bucket, with
   `listBuckets`, `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`.
3. **Add CORS rules for the app's origin.** Direct uploads send the photographs
   from the browser to the bucket, so a browser will preflight the request; a
   bucket that answers no CORS rules makes the direct route fail and the client
   falls back to the request-body route (correct, but slower). Allow `POST` from
   the app's origin with the headers the API hands out
   (`authorization`, `x-bz-file-name`, `x-bz-content-sha1`, `content-type`), and
   `Access-Control-Expose-Headers: x-bz-file-id` if you want the object id back.
4. Add `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME` in Settings →
   Environment. Nothing else in the codebase needs to change.

The bucket name is resolved to a bucket id the way the API intends: from the
key's own bucket restriction when it has one, otherwise through
`b2_list_buckets`.

## Which API, and why

The **native** B2 API v4, not the S3-compatible one:

- `b2_authorize_account` (`Basic base64(keyId:applicationKey)`), `b2_get_upload_url`,
  `b2_upload_file`, `b2_download_file_by_name`, `b2_list_file_names`,
  `b2_delete_file_version`, `b2_list_buckets` — nothing else is called.
- It needs `fetch` and `node:crypto` only, so the API keeps its zero-dependency
  property. SigV4 signing would be a second authentication scheme to implement
  and get right for no capability this product uses.
- Documented paths and headers are implemented literally, which is why the gate
  asserts the wire format rather than only that a file round-trips: a
  percent-encoded `X-Bz-File-Name`, the `X-Bz-Content-Sha1` B2 verifies, the
  account token on reads, `(fileName, fileId)` on deletes.
- A rejected credential (401/403) clears every cached token and retries the
  request **once**, which is what Backblaze's documentation prescribes; anything
  else is re-thrown untouched.

## How this is verified

```sh
node --test apps/api/test/storage.test.js        # 21 tests, ~2s, no credentials
node --test apps/api/test/direct-upload.test.js  # 10 tests, presigned uploads
node --test apps/api/test/retention.test.js      #  7 tests, the sweep
```

Three halves:

1. **the drivers**, against `apps/api/test/b2-stub.js` — a stand-in server that
   implements the other side of the documented protocol and records every
   request, so the assertions are about what went over the wire;
2. **the API with B2 configured** — photographs stored as they are uploaded, the
   model and result stored before `completed`, the model still served after the
   local copy is deleted (including through a share-token link), a capture
   refused when its photographs cannot be stored, a reconstruction failed when
   only its model cannot be, the working copy pruned once published, and an
   account deletion that empties exactly that account's objects from the bucket.

Negative controls are part of it: a rejected checksum must surface B2's own
error, an expired token must be refreshed rather than fail, a key that tries to
escape the storage root must be refused, and asking for `b2` with no
configuration must warn instead of pretending.

3. **presigned uploads and retention**, against the same stand-in — a manifest
   is accepted, one upload URL is handed out per photograph, the objects are
   re-read and sniffed before the job is queued, a mislabelled object removes the
   capture whole, a driver that cannot presign answers `409` rather than
   pretending, and the sweep reaps an abandoned `uploading` row while leaving
   finished captures alone at the default TTL.

These gates run in `sh scripts/verify.sh api`, so they cannot rot.

### Against the real service

Not run here — there is no Backblaze account in this environment, and the gate
above is honest about standing in a stub for the provider. To exercise the real
thing, with credentials in the environment:

```sh
STORAGE_DRIVER=b2 B2_KEY_ID=… B2_APPLICATION_KEY=… B2_BUCKET_NAME=… \
  node --test apps/api/test/storage.test.js
```

…or run the product and watch `GET /api/health`:

```sh
curl -s localhost:8787/api/health | python3 -m json.tool | grep -A5 storage
# "kind": "b2", "durable": true, "bucket": "…", "warnings": []
```

Then create a capture in the app and confirm the objects appear:
`captures/<id>/images/frame_001.jpg`, `captures/<id>/result.json`,
`captures/<id>/model.glb`.

## Not built

- **No bucket-side lifecycle rule.** The application sweeps its own rows and
  objects on the clock described above, and by default
  (`CAPTURE_TTL_DAYS=0`) it keeps captures until their owner deletes them. B2's
  own lifecycle rules are not configured by this codebase; a deployment that
  wants the bucket itself to expire keys must set that in the Backblaze UI and
  accept that the API's rows will then point at objects that are gone.
- **No resumable/multipart uploads.** A photograph is one object in one
  request; a connection dropped mid-upload means starting that photograph again
  (or falling back to the body route). Large captures are not chunked.
- **No encryption decision of its own.** B2's server-side encryption (SSE-B2)
  applies to a bucket that enables it; this codebase sets no SSE-C keys.
- **No audit log** of who read what, and no export-before-delete.
- **Object Lock, versioning policy and CORS rules** are not configured by the
  code; a bucket that needs them needs them set in the Backblaze UI.
