# Architecture

One repository, three moving parts, one evidence record:

```
apps/web                        capture app (React + Three.js + WebXR),
                                six routes, no router dependency
apps/api                        HTTP API + accounts + storage + job queue +
                                worker runner (Node, zero npm deps, node:sqlite)
services/reconstruction-worker  the Python SfM pipeline (OpenCV/numpy/scipy)
tests/                          ground-truth fixture + every gate/instrument
docs/                           this file, the ADRs, the guides, status.md
notebooks/                      Colab/Kaggle runs of the same worker
```

`docs/status.md` is the evidence record: every measured claim in this
repository points at a committed, re-runnable check that produces it.

## The shape of a capture

```
browser (apps/web)
  │  account: POST /api/auth/signup | /signin sets an HttpOnly session cookie
  │  guarded route: /capture redirects to /auth?returnTo=/capture when signed out
  │  guided capture: shutter, orbit ring (compass headings only), 12–24 shots
  │  POST /api/captures  — images as base64 data URLs, optional calibration
  │  ...or, when the deployment advertises it, POST /api/captures/uploads
  │     (a manifest: no bytes) and the photographs go straight to the bucket
  ▼
API (apps/api/src/server.js)
  │  authorises the caller (session cookie, or the capture's ?t= share token),
  │  validates payload + sniffs image bytes, writes capture dir under DATA_DIR,
  │  puts each photograph in the durable store (local disk, or B2 when
  │  configured), stores the record in SQLite against the owning account,
  │  enqueues (burst-limited), answers 202
  │  on the direct route: creates the row `uploading`, hands out presigned
  │  URLs, then re-reads every object (HEAD + range-read sniff) at
  │  POST /api/captures/:id/uploads/complete before anything is queued
  ▼
WorkerRunner (apps/api/src/worker.js)
  │  the ONLY place the Python worker starts — no mock path exists.
  │  Spawns `python3 run_job.py --job <contract.json>`, one job at a time,
  │  kills it at JOB_TIMEOUT_SECONDS, reads structured JSON progress logs.
  ▼
Pipeline (services/reconstruction-worker)
  │  incremental SfM → sparse cloud → mesh → baked texture atlas → GLB,
  │  re-validated by its own independent validator before it is written
  ▼
result.json + model.glb  ──▶  published to the durable store, then marked
                             completed  ──▶  GET /api/captures/:id[/result|/model.glb][?t=token]
                             model page, QR share sheet, /ar/:id (WebXR)
```

## Storage and accounts

`apps/api/src/storage.js` puts a capture's bytes somewhere durable: local disk
by default, Backblaze B2 when its keys are configured (ADR 0006). The worker
still needs real files, so a local working copy always exists; with a remote
driver it is a cache, and `GET /model.glb` falls back to the stored object —
which is what makes a QR-shared model survivable. Nothing is reported
`completed` until the artifacts are stored. `GET /api/health` reports the driver
actually in use, so a deployment's real posture is one request away.

When that driver can presign, the photographs skip the API entirely: the browser
uploads them straight to the bucket and the API verifies what landed (size and
container bytes) before a worker is allowed to see it (ADR 0007). An upload token
is bucket-wide rather than name-scoped, so the re-check is not belt-and-braces —
it is the boundary. `apps/api/src/retention.js` sweeps on a clock: abandoned
`uploading` rows always, finished captures only when `CAPTURE_TTL_DAYS` is set
above its default of `0`, which keeps a capture until its owner deletes it.

## Accounts and access

`apps/api/src/accounts.js` owns identity: scrypt password hashes, opaque
session tokens stored as SHA-256 digests with a 30-day expiry, and the share
tokens. Nothing about a user leaves the host and there is no third-party
identity service (ADR 0005).

A capture is readable by exactly two parties — the owning account, or a holder
of the capture's share token — and the token is a separate secret from the
capture id, created and revoked explicitly by the owner. The API answers which
refusal it is (`401` no session, `403` someone else's capture, `403` a dead
link) rather than one opaque failure, and `docs/security/README.md` states
what is still missing (email verification, password reset, cloud storage).
Each capture response carries the caller's own `role` (`owner` / `shared`) so
the UI can offer the share controls to exactly the right person.

## Job contract (version "1")

The API and the worker talk only through a JSON contract file — the same one
the notebooks write by hand:

```json
{
  "contract_version": "1",
  "job_id": "…",
  "inputs":  { "images_dir": "/…/images" },
  "outputs": { "glb_path": "/…/model.glb", "result_json": "/…/result.json" },
  "scale_calibration": { "value": 1.87, "unit": "m", "source": "user_measurement" }
}
```

`scale_calibration` is optional. Without it the result is labelled
`units: "uncalibrated"` — the pipeline never invents metres.

## Capture states

`queued → running → completed | failed | cancelled` (a queued capture can go
straight to `cancelled`). Terminal states are final; `DELETE` on them answers
409. `failed` always carries the worker's own named error stage — there is no
retry-into-success path, and a cancelled capture never appears as `failed`.

## Progress: measured vs estimated

Stage weights (`STAGE_WEIGHTS` in `worker.js`) are **static guesses**, so an
overall percentage derived from them is an *estimate* and the client labels it
as such (`progress_source: "stage_weights"`). Once a job has finished, the
worker's own `stage_seconds` refine the ETA for later jobs
(`progress_source: "measured_stage_times"`), and the UI says which one it is
showing. Per-stage progress inside the worker's own log lines is the worker's
measurement, not an estimate.

## Pipeline stages

`validate_input → feature → sfm → filter → review → surface → texture →
calibrate → export_glb → validate_output`

Relative weights: 0.02, 0.2, 0.45, 0.01, 0.01, 0.03, 0.08, 0.001, 0.01,
0.02 (`validate_input … validate_output`). Stage detail and the honest limits
of each live in `docs/reconstruction/README.md`.

## Design decisions (ADRs)

Recorded in `docs/architecture/adr/`:

1. **Sparse incremental SfM; dense MVS closed on evidence** — `0001`
2. **One gauge transform, and the wrong-gauge rule** — `0002`
3. **Registration defaults stand; five levers measured** — `0003`
4. **No fallback model, ever** — `0004`
5. **First-party accounts, and a share link that is not the URL** — `0005`
6. **Backblaze B2 over its native API, behind one storage driver** — `0006`
7. **Direct-to-bucket uploads verified after they land; retention off by default** — `0007`

## Deliberate constraints

- **Zero npm dependencies** in the API: the surface is small enough that
  `node:http` + `node:sqlite` + `node:child_process` cover it, and every
  dependency avoided is one fewer thing between a capture and the worker.
- **The worker is never stubbed.** If the Python entrypoint is missing the
  API reports `worker.available: false` from `/api/health` and fails jobs
  with that reason; it does not fake a model.
- **One job at a time** — SfM is CPU-bound and every extra slot would slow
  the job a user is waiting on.
- **Honesty over plausibility**: partial orbits are labelled, unmeasured
  compass coverage says "unmeasured", uncalibrated models stay uncalibrated,
  and a failed stage is named rather than papered over.
