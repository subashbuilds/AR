# ObjectCapture AR

Photograph a physical object, reconstruct it as a validated GLB with a recorded
physical scale, and place it in a room through WebXR AR.

> **Status:** the reconstruction engine **and** the product surface around it are
> built: capture app, API, Three.js viewer, QR sharing and the WebXR AR view,
> all running against the real worker and verified by driving the built app in a
> browser. Colab/Kaggle notebooks, Docker packaging, deployment guides and CI
> are built too — with one honest caveat: no docker daemon exists in CI or the
> sandbox, so the Docker **image** has never been built; the runtime contract it
> encodes is executed instead (`sh scripts/verify.sh docker`). Accounts,
> per-user ownership, revocable share links and object storage are built —
> storage runs on local disk by default and on **Backblaze B2** once its keys
> are set, so it is unconfigured here rather than absent. Photographs can upload
> **straight to the bucket** through presigned URLs, and a retention sweep reaps
> abandoned uploads and — when `CAPTURE_TTL_DAYS` is set above its default of
> `0` — expired captures. What is **not** built: email verification/password
> reset, a bucket-side lifecycle rule, and the AR path has never run on real
> hardware. Read [`docs/status.md`](docs/status.md) before assuming otherwise.

```
apps/web   Vite + React + TypeScript capture app, viewer, QR and WebXR AR
apps/api   zero-dependency Node service that queues jobs and runs the worker
services/reconstruction-worker   the reconstruction pipeline (Python)
```

## Run the product

```bash
pip install -r requirements.txt          # numpy, scipy, Pillow, OpenCV
cd apps/web && bun install && bun run build && cd ../..

node apps/api/src/server.js              # terminal 1: API on :8787, serves dist/
cd apps/web && bun run dev               # terminal 2: app on :5173, proxies /api
```

Camera capture needs a secure context, so use `localhost` in development or
serve over HTTPS. Photos can also be picked from disk, which is how the
end-to-end run works.

### Or in a notebook

`notebooks/colab/objectcapture_ar_demo.ipynb` and
`notebooks/kaggle/objectcapture_ar_demo.ipynb` run the real pipeline on the
bundled demo capture (or on your own photographs), print the manifest's honest
numbers — calibration state, per-photo review, orbit coverage — and leave a
re-parsed, validated GLB behind. Both notebooks carry the same six code cells,
generated from `notebooks/code_cells.py`; `python3 tests/test_notebooks.py`
executes those cells verbatim and fails if either notebook drifts from that
source.

### Or with Docker

```bash
docker build -t objectcapture-ar .
docker run --rm -p 8787:8787 -v oca-data:/data objectcapture-ar
```

See [`docs/deployment/docker.md`](docs/deployment/docker.md) (and
[`vps.md`](docs/deployment/vps.md) for a non-Docker host) — including what was
verified without a daemon and the honest limitations (single job, accounts
stored on the host's own disk, no cloud storage, no email verification or
password reset).

The capture flow ends at a measurement step: one real dimension fixes the
model's scale and the rest are shown back on the model page as a check, because
a single measurement makes only its own axis exact.

---

## What works today

Given a set of overlapping images of a real object, the worker:

1. validates the input set,
2. detects SIFT features,
3. builds a verified view graph with MAGSAC++ essential-matrix estimation,
4. seeds from a verified pair with enough parallax (and not so much that the
   two-view problem stops being cheiral), registers remaining views with RANSAC
   PnP,
5. refines cameras and points with Levenberg–Marquardt bundle adjustment,
6. reconstructs a surface with alpha shapes over a 3-D Delaunay tetrahedralisation,
7. reviews every photo and reports, per photo, whether it was used and why not,
8. unwraps that surface into UV charts and **bakes the photographs into a single
   texture atlas**, rejecting any texel that a camera could not actually see of
   it, by rendering the reconstruction into a depth buffer per view,
9. applies a physical scale factor from a user measurement (or labels the
   model uncalibrated),
10. writes a GLB,
11. **re-parses and validates that GLB** before reporting success,
12. **measures how completely the capture orbited the object** and reports it,
    so a partial scan is labelled as one rather than shipped as a whole.

The capture screen previews that verdict *before* the upload: an orbit ring
built from the device compass fills in as you walk round and names the widest
arc you have not photographed yet. It is a compass reading, not a
reconstruction — it knows which way the camera pointed, not where the object is
— and when the device reports no orientation at all it says the coverage is
**unmeasured** instead of drawing an empty circle that reads as zero percent.

Nothing is faked. If a stage fails, the pipeline returns a named failure stage
and writes no model.

When a photo does not make it into the model, the model page says so **by name
and with the reason** — and distinguishes a photo that matched nothing from one
that matched its neighbours perfectly but that the solver could not place,
because only one of those is the photographer's problem.

## Verified results

Measured against procedurally generated ground truth (exact camera poses and
per-pixel depth maps):

| Check | Result |
|---|---|
| Two-view pose recovery | **0.000000°** rotation error |
| N-view triangulation | **6.79e-16 m** median position error against ground truth (noiseless, 3 views); **2.30e-3 m** at 0.5 px noise over 12 views |
| Incremental SfM (8 views) | **0.3185 px** reprojection error, camera-centre error median **0.027** |
| Relative depth (gauge-free) | median **0.13%**, p90 **0.35%**; absolute scale spread **1.00** |
| SIFT matching | **86.3%** of matches correct within 5 cm |
| Capture coverage | orbit gap measured from the camera geometry, reproducing the fixture's own angles to **1e-6°** |
| Capture ring, on device | a 0–45° sweep leaves a **315°** unswept arc, shown and named before upload; completing the orbit drops it to **45°**. With no compass it reports “not being measured” (`node apps/web/e2e/run.mjs`) |
| Ring agrees with the engine | **20** Node tests, one running the real `coverage.estimate` in a Python subprocess and requiring agreement to **1e-9°** (`node --test apps/web/test/orbit.test.ts`) |
| End-to-end run | validated GLB, declared 2.0 m → reported **2.000 m** |
| Baked texture atlas | median colour error against the photographs **12.24** vs **55.66** for per-vertex colour (**−78.0%**); p90 **39.05** vs **88.48**; closer at **96.3%** of 1,031 scored surface points (`python3 -m tests.eval_texture`) |
| Notebooks (Colab + Kaggle) | both notebooks' 6 code cells executed verbatim in **5.0 s** on the real fixture, ending in a validated GLB; the demo is labelled uncalibrated with its **180° partial orbit** and per-photo review printed; a negative control proves the honesty checks can fail (`python3 tests/test_notebooks.py`) |
| Docker contract | **5 pins resolve** on PyPI with cp310/manylinux wheels, the image's CMD boots and `/api/health` answers with the worker available, `node:sqlite` loads, and the Dockerfile agrees with the code it ships — the image itself is not built anywhere (no daemon in CI or the sandbox); three negative controls (`python3 tests/test_dockerfile.py`) |
| Unit tests | **73 passing** |
| Documentation set | **19** documents across `docs/` — no empty directory, no stub, every relative link resolves, with a negative control that must fail both checks (`python3 tests/test_docs.py`) |
| Accounts and ownership | sign-up stores only a `scrypt$…` hash; a second account is refused with `403` on someone else's capture and never sees it in a list; the cookie is `HttpOnly; SameSite=Lax` and `Secure` behind TLS (with `COOKIE_SECURE` for a proxy that hides the scheme); sign-in failures are indistinguishable; sessions expire and sign-out revokes immediately; sign-in is rate limited in its own bucket; deleting an account needs the password and removes its captures (`node --test apps/api/test/auth.test.js`, 11 tests) |
| Revocable share links | the capture id alone is refused (`401`/`403`); the owner mints a separate token that a cookie-less device can read with, that is idempotent on re-issue, and that stops working on the next request after revocation — while the owner keeps access (`apps/api/test/auth.test.js`, `node apps/web/e2e/run.mjs`) |
| Share-token client contract | **5** Node tests: the `?t=` token is read from the address bar and carried on every read a shared page makes, the owner sends none, and tokens are escaped rather than concatenated (`node --test apps/web/test/share.test.ts`) |
| Presigned direct uploads | **10** Node tests over the same stand-in: a manifest creates an `uploading` row and one presigned URL per photograph, the objects are re-read (size + container sniff) before any job is queued, a mislabelled object removes the capture whole, a driver that cannot presign answers `409` instead of pretending, and the client contract falls back to the request body on any direct failure but a `401` (`node --test apps/api/test/direct-upload.test.js`, `node --test apps/web/test/direct-upload.test.ts`) |
| Retention | **7** Node tests: the sweep reaps an abandoned `uploading` row and cancels anything still running before removing a capture, and **nothing** is expired while `CAPTURE_TTL_DAYS` is `0` — the default, which keeps captures until their owner deletes them (`node --test apps/api/test/retention.test.js`) |
| Object storage | **21** Node tests over two drivers: local disk, and Backblaze B2 against a stand-in server that implements the documented protocol and records every request — the percent-encoded `X-Bz-File-Name`, the `X-Bz-Content-Sha1` B2 verifies, a rejected checksum surfaced with B2's own error, an expired token refreshed exactly once, photographs stored as they upload, a model stored before the capture is called `completed`, that model **still served after the host's copy is deleted** (share-token readers included), the working copy pruned once published, and deleting an account emptying exactly its objects from the bucket (`node --test apps/api/test/storage.test.js`) |
| Restart recovery and cleanup | **5** Node tests: a capture left `queued`/`running` when the process stopped is reproduced as stuck, then boot re-queues exactly those rows and runs them to `completed`; a finished run prunes its scratch always and its raw photographs once a durable store holds them, keeping the model cached (`node --test apps/api/test/worker.test.js`) |
| API + real worker | 12 real photographs → completed job → served GLB re-validated *with its texture decoded*; rate limiting, the job time limit, and cancellation of a queued and a running capture into the named `cancelled` state (`node --test apps/api/test/*.test.js`, 63 tests) |
| Cancellation (client) | **4** Node tests: `DELETE` to the capture itself, the 202 verdict parsed as-is, the server's 409 message surfaced as the `ApiError` the UI renders (`node --test apps/web/test/cancel.test.ts`) |
| Browser end-to-end | **22 passing steps**: sign-in gate with `returnTo`, a wrong password refused with the server's message, camera preview (1280×960), shutter, gating, measurement, real reconstruction, live orbit ring, honest unmeasured state, coverage reporting, WebGL viewer rendering the **bound texture atlas**, per-photo review naming every dropped photo with its reason, a private model, an explicit share link whose QR carries the token, a **cookie-less second device** reading it, revocation stopping that device, honest AR fallback, cancel from the processing screen into `cancelled` with no model published, and the account page deleting the account with a **wrong password refused** before the right one removes its captures and sessions (`node apps/web/e2e/run.mjs`) |
| Physical scale from the UI | declared 1.87 m → calibrated model, largest axis exactly 1.870000 m, other axes reported as a check |

Known weaknesses are documented in [`docs/status.md`](docs/status.md) §3 and
§3d. Three matter most:

- **Width and depth depend on how completely you photograph the object.** The
  reconstruction is accurate — 78.6% of its points land within 5 cm of the true
  surface — but on a capture with a **96° gap** in its orbit it covers only ~12%
  of the object, and its worst axis then reads 66% small. A full orbit brings
  that to 30%. The capture screen now warns you *while* you are still walking
  round, the worker measures it afterwards, and the model page says so; none of
  them can invent the missing photographs.
- **A single view pair is not reliable** (21.8° pose error from one
  narrow-baseline pair even though 86.3% of its matches are correct), so the
  incremental multi-view path is mandatory.
- **The texture atlas colours only what the reconstruction covers.** The atlas
  itself is measurably much better than per-vertex colour (§3d), but it bakes a
  ~11%-coverage surface, and on a partial orbit about a quarter of the atlas
  carries colour no camera actually saw. The model page says so rather than
  showing a confident smooth model of the wrong thing.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Requires Python 3.10+. No GPU and no COLMAP are needed for anything that runs
today.

## Reproduce every claim

One command runs everything — the pipeline, the API against the real worker,
and the built app in a real browser — and exits 0 only when each check behaved
as documented:

```bash
sh scripts/verify.sh              # or one section: pipeline | api | web | docker
```

By hand:

```bash
# 1. Generate the ground-truth fixture (24 rendered views + exact depth maps)
python3 tests/make_fixture.py --out /tmp/fx2 --views 24 --radius 7.0

# 2. Prove the two-view geometry is exact
python3 tests/recoverpose_contract.py

# 2b. Prove the N-view triangulation is exact in isolation
python3 tests/test_triangulation.py --fixture /tmp/fx2

# 3. Measure feature matching accuracy
python3 tests/benchmark_sift.py --fixture /tmp/fx2 --pair 3 4

# 4. Measure full incremental SfM accuracy
python3 tests/test_sfm_multiview.py --fixture /tmp/fx2 --views 8

# 5. Run the worker end-to-end and validate the GLB
python3 tests/test_end_to_end.py --fixture /tmp/fx2 --views 8

# 5b. Prove the baked texture atlas beats per-vertex colour, scored on the photos
python3 -m tests.eval_texture --fixture /tmp/fx2 --views 12

# 5c. Prove the per-photo review catches a damaged photo, against a clean baseline
python3 -m tests.eval_view_quality --fixture /tmp/fx2 --views 12

# 5d. Show the registration limit is NOT the PnP threshold; exits 1 BY DESIGN.
#     Slow (~97s), so deliberately not in verify.sh -- see docs/status.md §7.
python3 -m tests.eval_registration_rate --fixture /tmp/fx2 --views 12

# 6. Unit suite
python3 -m pytest tests/test_pipeline.py -q

# 6b. Capture-ring geometry, checked against the Python coverage estimator
node --test apps/web/test/orbit.test.ts

# 6b2. Cancellation client: DELETE verb, verdict, 409 message as ApiError
node --test apps/web/test/cancel.test.ts

# 6b3. Share-token client contract: every read on a shared page carries ?t=
node --test apps/web/test/share.test.ts

# 6c. Notebooks: execute both notebooks' cells verbatim (--fast: structural only)
python3 tests/test_notebooks.py

# 6d. Docker contract: pins resolve, the image's CMD boots, Dockerfile agrees
python3 tests/test_dockerfile.py

# 7. API against the real worker
node --test apps/api/test/api.test.js

# 7b. Accounts, ownership and revocable share links (stand-in worker, ~2s)
node --test apps/api/test/auth.test.js

# 7c. Storage: local disk, and Backblaze B2 against a stand-in server (~1s, no
#     credentials). Against the real bucket, add B2_KEY_ID / B2_APPLICATION_KEY /
#     B2_BUCKET_NAME and STORAGE_DRIVER=b2; see docs/storage/README.md.
node --test apps/api/test/storage.test.js

# 7d. Presigned direct-to-bucket uploads, verified after they land (same stub,
#     ~1s). The bucket needs CORS rules for the app's origin in a real
#     deployment; see docs/storage/README.md.
node --test apps/api/test/direct-upload.test.js

# 7e. Retention: abandoned uploads always, expired captures only when
#     CAPTURE_TTL_DAYS > 0 (the default, 0, keeps them).
node --test apps/api/test/retention.test.js

# 8. Built app driven in a real browser against the real worker
cd apps/web && bun run build && cd ../.. && node apps/web/e2e/run.mjs
```

## Run the worker directly

```bash
python3 services/reconstruction-worker/run_job.py --job job.json
```

```json
{
  "contract_version": "1",
  "job_id": "job-001",
  "inputs":  { "images_dir": "/path/to/images" },
  "outputs": { "glb_path": "/path/out/model.glb",
               "result_json": "/path/out/result.json" },
  "scale_calibration": { "value": 2.0, "unit": "m",
                         "source": "user_measurement" }
}
```

The worker logs structured JSON, one line per stage. Stages report a
fraction only where a real fraction exists; otherwise the progress field is
`null` (indeterminate) rather than an invented percentage.

## Why OpenCV rather than COLMAP?

The specification nominates COLMAP. When the decision was made COLMAP could not
be installed (no apt package lists, no CUDA), so a hand-written descriptor was
built first and **measured**: 0% true-partner retrieval, and only 15.3% of its
matches within 5 cm. It was rejected. OpenCV's maintained SIFT reached 86.3%
correct matches on the same data.

**This was re-tested on 5 October, now that `colmap` installs.** COLMAP 3.7 was
run on the same ground-truth views. With stock thresholds it cannot initialise
the capture at all ("No good initial image pair found"); when its init
thresholds are relaxed it registers 11/12 views with a *better* reprojection
error than this repo's (0.577 px vs 0.371 px) — and a degenerate structure,
with the camera-radius spread at **3.78x** where ground truth is **1.01x**.
Reprojection error is measured inside whatever frame the reconstruction settled
into, so a collapsed structure can look excellent and still be badly wrong.
Dense MVS densifies a sparse reconstruction rather than repairing one, so
COLMAP's is not integrated either. Reproduce with
`python3 tests/compare_colmap.py`; full detail in
[`docs/status.md`](docs/status.md) §3b. The full reasoning, versions, licences
and alternatives are in
[`docs/research/technology-decisions.md`](docs/research/technology-decisions.md).

## Licence notes

OpenCV is Apache-2.0; COLMAP is BSD; numpy/scipy are BSD-3.0; Pillow is
MIT-CMU. This repository redistributes no pretrained weights and no third-party
image datasets — the only imagery is procedurally generated by
`tests/make_fixture.py`.

## Test data provenance

All images and ground truth in `tests/` are generated by `tests/make_fixture.py`
(a z-buffered software rasteriser over a procedurally deformed sphere with an
asymmetric, aperiodic procedural texture). No real-world photographs, no
scanned assets, no licence encumbrance.