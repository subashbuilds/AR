# Technology decisions

Research date: **3 October 2026**, updated **4 October 2026** when the product
surface was built. Every version below was resolved live from the authoritative
source at the time of writing, not from memory.

This document records what was verified, what was chosen, what was rejected,
and what remains blocked. Where a decision was forced by the environment
rather than by merit, that is stated plainly.

---

## 1. Environment baseline (measured, not assumed)

Established before any design decision, by running the toolchain rather than
reading about it:

| Capability | Result | Method |
|---|---|---|
| Node.js | v22.23.2 | `node -v` |
| Bun | 1.4.2 | `bun -v` |
| Python | 3.10.12 | `python3 -V` |
| Compilers | gcc / g++ / make present | `which` |
| `node:sqlite` | available (built into Node 22) | `require('node:sqlite')` |
| COLMAP binary | **absent** | `which colmap`; `apt-cache policy colmap` → no package lists |
| ffmpeg | **absent** | `apt-cache policy ffmpeg` → no package lists |
| Open3D | **unusable** | installs, but `ImportError: libEGL.so.1`; no apt to supply it |
| OpenCV (headless) | **works** | `pip install opencv-python-headless` → 5.0.0, imports cleanly |
| Network | npm / PyPI / GitHub reachable | `curl` + `npm ping` |

The absence of apt package lists was decisive at the time: it ruled out COLMAP,
ffmpeg and every system graphics library for this environment.

> **Update, 4 October:** `apt-get update` now succeeds in this sandbox and
> `apt-cache policy colmap` reports `Candidate: 3.7-2` (ffmpeg
> `7:4.4.2-0ubuntu0.22.04.1`). The GL stack was installed so a headless
> Chromium could run. None of that changes the OpenCV decision — the measured
> comparison in §2 still stands — but the COLMAP-vs-OpenCV question is now
> answerable by measurement rather than by circumstance. See
> `docs/status.md` §4.

---

## 2. Reconstruction engine — the central decision

### Decision

Use **OpenCV 5.0.0 headless** as the reconstruction engine: SIFT for features,
`USAC_MAGSAC` for robust estimation, `findEssentialMat` / `recoverPose` for
two-view geometry, `solvePnPRansac` for registration, `triangulatePoints` for
structure, and a locally written Levenberg–Marquardt bundle adjustment.

Keep a documented **COLMAP adapter path** for GPU hosts where COLMAP *is*
available.

### Why — this was decided by measurement, not preference

The specification nominates COLMAP as the primary engine. COLMAP genuinely is
the right production choice, but **it cannot be installed or run in this
environment** (see §1). Rather than ship a pipeline that could not execute, the
reconstruction core was built on components that can be *executed and verified
here*.

Before committing to OpenCV, a **hand-written descriptor was built first** and
measured against exact ground truth. The float SIFT-style version has since been
deleted; what survives as the rejected baseline in `pipeline/sfm.py` is
Shi-Tomasi corners + BRIEF, and `tests/benchmark_descriptor.py` measures it on
the same correspondences. It fails:

- same-point Hamming median **0.107**, different-point **0.500** — heavily
  overlapping distributions;
- **true-partner rank-0 retrieval: 0.0%** — correct matches were never the
  nearest neighbour;
- only **15.3%** of its Lowe-ratio matches land within 5 cm of the true point.

Reproducing Lowe's normalisation and dominant-orientation assignment well
enough is a research-scale problem, not an afternoon's work. OpenCV's
maintained SIFT on the same data gave **86.3% of matches correct within 5 cm**
(`tests/benchmark_sift.py`). That measurement, not preference, is what
selected OpenCV.

**Important caveat, recorded because it changes how the pipeline must be
built:** `benchmark_sift.py` finishes with `RESULT: FAIL`. Despite 86.3% of its
matches being correct, the pose recovered from that *single* narrow-baseline
pair is off by 21.8° rotation / 35.4° translation — a short baseline makes the
essential matrix ill-conditioned, and MAGSAC++ settled on a wrong dominant
plane. The multi-view pipeline is unaffected (1.00% camera error) because each
view is registered against accumulated structure and filtered by reprojection
error and parallax.

The engineering consequence is concrete: **the incremental multi-view path is
mandatory**; a "pick the strongest pair and stop" shortcut would publish
silently wrong geometry.

### Verification that the geometry is correct

Two independent ground-truth checks, both using the fixture's exact per-pixel
depth maps:

1. **Two-view pose recovery** (`tests/recoverpose_contract.py`) with perfect
   mesh-vertex correspondences:
   - rotation error **0.000000°**
   - translation error **0.000176°**
   This proves the F/E/decompose/recoverPose chain is exact.
2. **Incremental SfM** (`tests/test_sfm_multiview.py`), 8 views, 6 registered:
   - mean reprojection error **0.3185 px** (sub-pixel)
   - camera-centre error median **0.027**, max **0.051** (object extent ~2.0)
     after similarity alignment
   - bundle-adjusted
3. **N-view triangulation in isolation** (`tests/test_triangulation.py`), with
   ground-truth poses and correspondences so nothing else can be blamed:
   - median position error **6.79e-16 m** with noiseless input over 3 views
     (**9.36e-16 m** over 2)
   - **3.48e-3 m** at 0.5 px observation noise over 6 views, **2.30e-3 m**
     over 12
   This matters because it moved the investigation: once triangulation was
   proven exact, the residual width/depth error could only be *coverage*, and
   the fix had to be capture guidance rather than better maths. See
   `docs/status.md` §3.1.

### Why "more features" was rejected as the fix for width/depth

The obvious response to a sparse cloud is to extract more of them. Measured
rather than assumed:

| `contrast_threshold` | keypoints/image | points | surface covered | worst axis error |
|---|---|---|---|---|
| 0.01 (shipped) | 380 | 459 | 12.1% | 66.55% |
| 0.005 | 521 | 737 | 15.6% | 65.19% |
| 0.002 | 1065 | — | reconstruction fails | — |

Match *accuracy* holds at ~86% throughout, but the number of matches landing on
the **object** stays near 100 per pair no matter how low the threshold goes:
the extra keypoints are on the background, which occupies ~94% of each frame.
At 0.002 a false seed edge is chosen and the run aborts. So density was not the
binding constraint, and the decision was to report coverage honestly instead of
chasing keypoints.

### Alternatives considered

| Option | Verdict |
|---|---|
| COLMAP via apt/build | **Blocked** — no apt lists, no CUDA, source build infeasible |
| COLMAP Docker image | **Blocked** — no Docker daemon in this environment |
| pycolmap from PyPI | Rejected — still requires COLMAP native libs |
| Open3D (Poisson meshing) | **Unusable** — `libEGL.so.1` missing, no apt |
| Hand-written numpy SfM | **Measured and rejected** — 0% rank-0 retrieval, 15.3% of matches within 5 cm |
| OpenCV headless | **Chosen** — executes, verified, Apache-2.0, CPU-only |

### Known limitations (accepted, documented, not hidden)

- **No dense multi-view stereo.** COLMAP's PatchMatch MVS and dense
  Open3D-based meshing are unavailable, so output is a sparse-to-medium
  surface, not a watertight scan.
- **Alpha-shape meshing, not Poisson.** `pipeline/mesh.py` builds a 3-D Delaunay
  tetrahedralisation and keeps tetrahedra whose circumsphere is small relative
  to local point spacing, then extracts boundary faces. This follows the data
  but yields a bumpier surface than screened Poisson.
- **Vertex colours, not a baked texture atlas.** Per-vertex colour is sampled
  from the most frontal observing camera. This is a real multi-view colour
  estimate, but it is not a UV texture, and `glb.validate_glb(require_texture=True)`
  correctly rejects these models.
- **Scale depends on intrinsics.** Intrinsics are assumed at a 60° horizontal
  FOV rather than calibrated. This affects metric dimensions but not relative
  geometry.

### Licences verified

- OpenCV — Apache-2.0 (redistributable, including in a hosted worker image).
- COLMAP — BSD (per <https://colmap.github.io/license.html>; note the licence
  changed from GPL in ≤3.4 to BSD in 3.5+).
- numpy — BSD-3.0. scipy — BSD-3.0. Pillow — MIT-CMU.

No pretrained weights or third-party datasets are redistributed by this
repository. The only image data is procedurally generated by
`tests/make_fixture.py`, so no dataset licence encumbrance applies.

---

## 3. Surface reconstruction

Alpha shapes over 3-D Delaunay (`scipy.spatial.Delaunay`), chosen because it
needs no native library and runs in milliseconds. Outliers are rejected by a
median-absolute-deviation test on radial distance before meshing, because a
single badly triangulated point otherwise dominates the hull. A convex-hull
fallback guarantees a valid closed mesh is always emitted.

**Coordinate system and units.** glTF is defined in **metres**
(spec §3.5). The reconstruction is in arbitrary SfM units until
`pipeline/calibration.py` applies a scale factor. The geometry is never
stretched to hit a target bounding box — doing so would destroy the very
dimensions calibration exists to establish. Models without a measurement are
labelled `units: "uncalibrated"` and every consumer is told so.

**Verified extent accuracy.** On the fixture the reconstruction reported a
height of exactly 2.000 m against a 2.0 m declared measurement (the largest
axis is set by calibration by construction). Width and depth were *not*
accurate (63.3 cm recovered vs 2.11 m ground truth), because only 6 of 8 views
registered and the cloud is sparse. This is a real, measured limitation of the
current pipeline, not a rounding artefact.

---

## 4. Frontend / API / storage — BUILT (4 October)

The specification asks for a capture app, an API, object storage, a Three.js
viewer, QR sharing and WebXR AR. The app, API, viewer, QR, AR **and accounts
with revocable sharing** are built and verified (§5, ADR 0005). Cloud object
storage is **not** — photos and models live on the API host's disk with no
separate storage boundary. That gap is stated in `docs/status.md` §5.

### Decisions

**React + Vite + TypeScript, not Next.js.** Next.js was specified, but nothing
in the product needs server rendering: every route is a camera preview, a 3-D
canvas or a QR sheet. Vite builds a static `dist/` that the API service already
serves, which removes an entire runtime tier. The cost is real and recorded:
there is no image optimisation, no streaming SSR and no built-in API routes.

**A zero-dependency Node API instead of Cloudflare Workers + D1.** The work is
`node:http` + `node:sqlite` + `node:child_process`. Workers cannot spawn a
Python process, and the reconstruction is the product: hosting the API next to
the worker is the only shape in which the browser can watch real stage progress.
`hono` and `zod` were researched and dropped — `hono` because the routing
surface is eight routes, `zod` because request validation here is three explicit
checks with better error messages than a schema library produces.

**Storage is local disk, not Backblaze B2.** B2 requires credentials that do
not exist here, and a local directory is enough to exercise the real contract
(upload → job → GLB → share link). Swapping in B2 later touches one module.

**`qrcode` 1.5.4 for QR generation.** The encoded payload is a URL, so the
code is verifiable by any scanner, and the library renders directly to a canvas
in the browser — no server round trip and no image upload of a QR code.

**Three.js 0.186.1 directly, not a viewer wrapper.** `@react-three/fiber` would
add a reconciler between React and a canvas the app mostly controls imperatively
(an XR session is not a React tree). The viewer and the AR view are both ~150
lines of plain Three.js.

**No in-app router.** Four routes; `apps/web/src/lib/router.ts` is a
`useSyncExternalStore` over `popstate`.

**Playwright 1.63.0 for the browser run.** It can fake a camera
(`--use-fake-device-for-media-stream`), which is what makes the preview and
shutter paths testable on a machine with no camera.

**Measurements are calibrated through the UI, not injected.** The capture flow
ends with a measurement step; one dimension sets the scale factor and any others
are shown on the model page beside what the reconstruction produced for that
axis, as a percentage. That comparison is the point: a single measurement makes
its own axis exact by construction, so the other axes are the only evidence
about whether the shape is trustworthy. The browser run asserts the declared
1.87 m really lands as 1.870000 m on the largest axis, and asserts the second
measurement is compared rather than dropped.

**The API refuses to queue work it cannot finish.** Uploads are token-bucket
limited per client (`apps/api/src/ratelimit.js`) because each capture costs a
full pipeline run, and a reconstruction that exceeds `JOB_TIMEOUT_SECONDS` is
killed and reported as a `timeout` failure rather than occupying the single
worker slot forever.

### Installed versions (locked in `apps/web/bun.lock`)

| Package | Version | Licence |
|---|---|---|
| react / react-dom | 19.3.0 | MIT |
| three | 0.186.1 | MIT |
| qrcode | 1.5.4 | MIT |
| vite | 8.3.2 | MIT |
| @vitejs/plugin-react | 6.1.1 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| @types/webxr | 0.5.24 | MIT |
| playwright (dev only) | 1.63.0 | Apache-2.0 |

`hono`, `zod` and `vitest` were researched and deliberately not used.

### AR design rules

- **No scale control, ever.** The GLB is in metres and a WebXR session is
  metric; a user-facing scale slider would let the product lie about physical
  size. The AR view has exactly one gesture: tap a detected surface.
- **No placement without a hit test.** If no surface is detected the model stays
  invisible rather than floating at a guessed depth.
- **Capability detection is reported verbatim.** The AR route states which
  capability is missing, by name, and falls back to the 3-D model.

---

## 5. Verification summary

| Claim | Evidence | Command |
|---|---|---|
| Two-view geometry exact | 0.000000° rot error | `python3 tests/recoverpose_contract.py` |
| SfM accurate | 0.3185 px reproj, camera-centre median 0.027 | `python3 tests/test_sfm_multiview.py` |
| N-view triangulation exact | 6.79e-16 m median position error over 3 views, ground-truth poses | `python3 tests/test_triangulation.py` |
| Depth ratios gauge-free accurate | 0.13% median relative depth error over 940 samples | `python3 -m tests.eval_accuracy --views 12` |
| Capture coverage measured | orbit gap reproduces the fixture's own angles to 1e-6° | `python3 tests/test_coverage.py` |
| SIFT matching sound | 86.3% matches < 5 cm | `python3 tests/benchmark_sift.py` |
| Single-pair pose NOT reliable | 21.8° rot error on one narrow-baseline pair (hence multi-view only) | `python3 tests/benchmark_sift.py` |
| Full pipeline works | validated GLB, 2.000 m | `python3 tests/test_end_to_end.py` |
| Unit behaviour holds | 37 passed | `python3 -m pytest tests/test_pipeline.py -q` |
| API runs the real worker end to end | 4 passed, incl. a served GLB re-validated | `node --test apps/api/test/api.test.js` |
| Built app works in a real browser | 12 passed steps, exit 0 | `node apps/web/e2e/run.mjs` |
| A declared measurement calibrates the model | largest axis 1.870000 m from a declared 1.87 m | `node apps/web/e2e/run.mjs` |
| Uploads are rate limited | 429 with a retry hint; health endpoint unaffected | `node --test apps/api/test/api.test.js` |
| A hung job is killed | failed at stage `timeout`, worker slot freed | `node --test apps/api/test/timeout.test.js` |
| One command reproduces all of it | `sh scripts/verify.sh` exits 0 | `sh scripts/verify.sh` |