# Status: what was actually built and verified

Date: **7 October 2026** (latest round: accounts/ownership, Backblaze B2 storage,
restart recovery, post-run pruning, account deletion).

This is an honest accounting. It separates what was implemented **and
verified by execution** from what was **not built**, and from what was
**blocked by the environment**. No item is claimed as complete without a
command that demonstrates it.

---

## 1. What was requested vs. what exists

The request was a full product: monorepo with a mobile capture app, a
Cloudflare Worker API on D1, Backblaze B2 storage, a Three.js viewer, QR
sharing, WebXR AR at true physical scale, notebooks, CI, Docker and ~22
documents.

**Delivered so far, in two rounds:**

1. The reconstruction engine and its verification harness (3 October) — the part
   of the system that is genuinely hard, that cannot be faked, and that
   determines whether the product is real at all.
2. The product surface on top of it (4 October): the capture web app, the API
   service that runs the worker, the Three.js viewer, QR sharing and the WebXR
   AR view — all wired to the real worker and verified by driving the built app
   in a real browser (§2, “Product surface”).

Still absent: object storage in the cloud, accounts, and the Cloudflare/B2
deployment they would need (§5). Built since the last audit: notebooks, Docker
packaging, the deployment guides and CI (§3g) — with the honest caveat that no
docker daemon exists here, so the image itself has never been built. The AR
hardware path has never been run on a phone (§4).

---

## 2. PASSED — implemented and verified by execution

### Geometry correctness

| Claim | Measurement | Command |
|---|---|---|
| Two-view pose recovery is exact | rotation error **0.000000°**, translation **0.000176°** on perfect correspondences | `python3 tests/recoverpose_contract.py` |
| Incremental SfM is accurate | **0.3185 px** mean reprojection error; camera-centre error median **0.027** / max **0.051** (8 views, 6 registered, bundle-adjusted) | `python3 tests/test_sfm_multiview.py` |
| Feature matching is sound | **86.3%** of SIFT matches correct within 5 cm (ground-truth 3D) | `python3 tests/benchmark_sift.py` |
| N-view triangulation is exact | with ground-truth poses and correspondences, median position error **6.79e-16 m** (3 views), **9.36e-16 m** (2 views), **3.48e-3 m** at 0.5 px noise over 6 views, **2.30e-3 m** over 12 views; 400/400 points solved in every case | `python3 tests/test_triangulation.py` |
| Relative depth is gauge-free accurate | median **0.13%**, p90 **0.35%** relative depth error over 940 samples; absolute scale spread p90/p10 **1.00** | `python3 -m tests.eval_accuracy --views 12` |
| Capture coverage is measured, not assumed | the worker reports the orbit gap and the app warns when the sweep is partial; the estimator reproduces the fixture's own camera geometry to **1e-6°** | `python3 tests/test_coverage.py` |

### Texturing

| Claim | Measurement | Command |
|---|---|---|
| The baked texture atlas beats per-vertex colour | median photometric error against the photographs **12.24** vs **55.66** for vertex colours (**−78.0%**); p90 **39.05** vs **88.48** (**−55.9%**); the atlas is closer at **96.3%** of 1,031 scored surface points | `python3 -m tests.eval_texture --views 12` |
| Occlusion is decided per texel, not assumed | 73.8% of covered texels are seen by a camera; the tolerance sweep shows the measured error is flat to within 1.6% across 0.05–0.1 | same |
| Both atlas parameters are measured, not chosen | chart threshold chosen on texel-density spread (7.59x → 1.19x) for a 3.5% cost in colour accuracy | same |
| The validator checks the texture, not its declaration | it follows material → texture → image → bufferView and decodes the PNG; corrupting 16 image bytes fails validation | `tests/test_pipeline.py` |
| The browser actually binds the atlas | the built app in Chromium reports `baked texture 1024×1024` in the viewer HUD, read from the loaded material | `node apps/web/e2e/run.mjs` |

### Per-photo review

| Claim | Measurement | Command |
|---|---|---|
| A damaged photo is caught | a blurred and an unrelated photo are both flagged `unusable`, with the other 11 photos' verdicts unchanged from a clean baseline | `python3 -m tests.eval_view_quality` |
| The two failure modes are distinguishable | the blurred photo reports **29** keypoints, the unrelated one **4000** | same |
| The gate is not vacuous | with the review stubbed out it exits **1** with three named failures | negative control, run manually |
| The reason is specific | photos that matched 44–72 features but could not be placed are told the solver failed, not that they are blurry | `python3 -m tests.eval_view_quality` |

### The registration limit, measured

| Claim | Measurement | Command |
|---|---|---|
| The PnP threshold is not the bottleneck | registered views have an inlier ratio of **0.77–0.91**, unregistered **0.21–0.40**; the absolute counts overlap around 28–30, which is where the threshold sits | `python3 -m tests.eval_registration_rate` (exits 1 by design, ~97s, **not** in `verify.sh`) |
| Relaxing it is not safe to ship | 8/12 → 12/12 registered costs **2.6 points** of coverage and shifts the cloud's radial distribution **27%** | same |

### Full pipeline

| Claim | Measurement | Command |
|---|---|---|
| End-to-end worker produces a validated model | 8 images → 2,249 vertices / 970 triangles → GLB **588,920 bytes** carrying a 1024px baked atlas → independent re-parse **valid**, texture decoded | `python3 tests/test_end_to_end.py` |
| Scale calibration works | declared 2.0 m → reported height **exactly 2.000 m** | same |
| Uncalibrated models are labelled | `units: "uncalibrated"`, `calibrated: false`, explanatory notes | `tests/test_pipeline.py` |
| Invalid models cannot be published | validator rejects truncation, bad magic, NaN positions, out-of-range indices, zero-size bounding boxes, implausible scale, UVs outside [0, 1], an undecodable texture image, and a texture with no TEXCOORD_0 | `tests/test_pipeline.py` |
| Pipeline fails honestly | noise input yields `ok: false` with a named stage and **no** GLB written | `tests/test_pipeline.py` |

### Test suite

**73 tests passing** (`python3 -m pytest tests/test_pipeline.py -q`).
**63 tests passing** across the eight API test files (api, auth, storage,
direct-upload, retention, worker, timeout, cancel), and **41** Node tests on
the web side (orbit 20, cancel 4, share 5, account 2, direct-upload 10).

`sh scripts/verify.sh` runs every claim in this document — pipeline, API and
browser — and exits 0 only when each one behaved as documented, including the
single-pair check that is *required* to fail. Sections can be run alone:
`sh scripts/verify.sh pipeline | api | web`.

### Direct uploads and retention (7 October)

Measured the same way as everything else here: by running it, against a
stand-in for the provider (there is no Backblaze account in this environment).

| Claim | Measurement | Command |
|---|---|---|
| Photographs can skip the API process entirely | a **manifest** (`{contentType, bytes}` per photo, no bytes) creates the capture `uploading` and answers `201` with one presigned upload URL and header set per photograph; the bytes are uploaded straight to the store | `node --test apps/api/test/direct-upload.test.js` (10 tests) |
| What landed is verified before any worker sees it | `POST /api/captures/:id/uploads/complete` `HEAD`s each object (exists, non-empty, within `MAX_IMAGE_BYTES`), then **range-reads bytes 0–15** and sniffs the container against the declared type; only then is the capture materialised and queued | same |
| A bad object does not reach the pipeline | a mislabelled or oversized object makes `complete` answer with the named object and removes the capture whole — rows, objects and working directory — leaving nothing half-uploaded | same |
| A driver that cannot presign says so | local disk reports `supportsDirectUploads: false`; `POST /api/captures/uploads` answers `409 direct_uploads_unavailable` rather than describing an upload URL it cannot mint | same |
| An `uploading` capture is not a listed capture | the row is excluded from `GET /api/captures` and from the queue until `complete` moves it to `queued` | same |
| The browser prefers direct and falls back honestly | the client uploads each object with the API's own headers and completes the capture; on any direct failure except `401` it re-sends through the request body instead, and a `401` is rethrown rather than retried | `node --test apps/web/test/direct-upload.test.ts` (10 tests) |
| An abandoned upload is reaped | an `uploading` row older than `UPLOAD_ABANDONED_MINUTES` (120 min default) is cancelled, its objects and working directory removed and its row deleted | `node --test apps/api/test/retention.test.js` (7 tests) |
| Nothing is expired while the TTL is off | with `CAPTURE_TTL_DAYS` at its default `0`, a sweep over old `completed` captures removes **none** — the negative control that keeps the codebase from deciding a user's data is stale | same |
| The TTL, when set, really expires | with a TTL configured, a finished capture older than it is cancelled if needed and removed, while a younger one is untouched | same |
| Retention states its own posture | `GET /api/health` reports `storage.directUploads` and `retention: { enabled, capture_ttl_days, upload_abandoned_minutes }` | same |

### Product surface (4 October)

Measured by running the **built** app against the **real** worker. The browser
run is `node apps/web/e2e/run.mjs`; it exits 0 with **22 passing steps**.

| Claim | Measurement | Command |
|---|---|---|
| The API reconstructs a real capture and serves it | 12 real photographs → job completes → GLB served with `model/gltf-binary`, magic `glTF`, version 2 → re-validated by the pipeline's own parser | `node --test apps/api/test/api.test.js` (6 passing) |
| API rejects what the pipeline cannot use | 1 image → 400; non-image bytes → 400 “not a JPEG, PNG or WebP file” | same |
| A failed reconstruction never yields a model | degenerate 2-frame capture → status `failed`, the worker's own message, `GET /model.glb` → 409 | same |
| A user measurement really calibrates the model | UI declares 1.87 m; `calibration.calibrated: true`, `units: "metre"`, largest model axis **1.870000 m** | `apps/web/e2e/run.mjs` |
| The other measurements are checked, not ignored | the declared width is compared with the reconstruction and the percentage shown | same |
| Partial captures are labelled, not hidden | the worker reports the orbit gap; the model page shows an `Orbit gap` statistic and a `Partial capture` warning whenever the sweep is incomplete, and shows **no** such warning when it is complete | same |
| The capture screen measures coverage *before* the upload | a sweep of 0–45° leaves a **315°** unswept arc, shown on the ring and named in its caption; completing the orbit drops the largest gap to **45°** and the caption stops asking for more | same |
| The ring admits when it cannot measure | with no orientation event at all, the ring reports `data-measured="false"` and says coverage “is not being measured” — never an empty circle that reads as 0% | same |
| The browser-side geometry matches the engine's | 20 Node tests, including one that runs the real `coverage.estimate` in a Python subprocess on a tilted orbit and requires agreement to **1e-9°** | `node --test apps/web/test/orbit.test.ts` |
| Uploads are rate limited | burst over the limit → **429** with the server's own message and `retry_after_seconds`; `GET /api/health` stays open | `apps/api/test/api.test.js` |
| A hung reconstruction is killed | stand-in worker that sleeps forever is killed at the limit → status `failed`, stage `timeout`, worker slot freed, no model served | `node --test apps/api/test/timeout.test.js` |
| A job can be cancelled | `DELETE /api/captures/:id`: queued → dequeued and `cancelled` without starting; running → worker stopped, ends `cancelled` (never `failed`/`completed`), slot freed; terminal states → 409 | `node --test apps/api/test/cancel.test.js` |
| A capture belongs to the account that made it | a second account is refused with `403` and never sees the capture in its list; the same request with no session is `401` | `node --test apps/api/test/auth.test.js` (11 tests) |
| The unguessable URL is not an access grant | signed out, the exact capture id answers `401`; only the owner may mint a link (anyone else gets `404`, so the endpoint cannot be used to discover ids) | same |
| Share links are explicit and revocable | the token is a separate secret from the id; a cookie-less device is served the model with it (`200`) and refused without it, and logout/revocation takes effect on the very next request | same |
| The stored credential is a hash | the `users` row holds `scrypt$…` and never the password; the cookie is `HttpOnly; SameSite=Lax`, and `Secure` only when the request arrived over TLS (with `COOKIE_SECURE` as the explicit override for a proxy that does not forward the scheme) | same |
| Password guessing is budgeted separately from uploads | the 11th sign-in attempt from one client is `429` with a retry hint while `GET /api/health` stays open | same |
| A signed-out visitor is sent to sign in | `/capture` → `/auth?returnTo=%2Fcapture`; signing in resumes the capture; a wrong password shows the server's own message, stays on the page and does not say whether the address exists | `apps/web/e2e/run.mjs` |
| A second device with no account can read a shared model | a fresh browser context loads `/model/<id>?t=<token>` with **no failed requests**, is told it is viewing a shared model, and is not offered the owner controls | same |
| Revoking a link stops the second device | the same token serves the model (`200`) and, after the owner clicks **Stop sharing**, is refused (`403`, "no longer active") — while the owner still reads it | same |
| Storage has two drivers and picks the right one | no B2 settings → local disk, silently; half a configuration → local disk **and** a warning naming the missing keys; `STORAGE_DRIVER=b2` with nothing set → local disk **and** a warning | `node --test apps/api/test/storage.test.js` (21 tests) |
| The B2 driver speaks the documented protocol | against a stand-in server: `Basic base64(keyId:applicationKey)`, the bucket id taken from the key's own restriction, `X-Bz-File-Name` percent-encoded (spaces and non-ASCII survive), `X-Bz-Content-Sha1` matching the bytes, the account token on reads, deletion by `(fileName, fileId)` | same |
| The wire format is asserted, not just the round trip | every request is recorded, so the test fails if a header, path or query changes — and a rejected checksum surfaces B2's own `bad_request` message instead of storing anything | same |
| An expired credential is refreshed, once | after invalidating every issued token, one `put` costs exactly one new `b2_authorize_account` and one new upload URL, and a read recovers the same way | same |
| Photographs are stored as they are uploaded | 3 real fixture JPEGs → the bucket holds `captures/<id>/images/frame_001..003.jpg` with bytes identical to the files (no re-encode), `content-type: image/jpeg` | same |
| A capture is not `completed` until its artifacts are durable | the model and `result.json` are in the bucket before the status flips, and the note says how many artifacts were stored | same |
| A stored model is served when the host's copy is gone | delete `DATA_DIR/captures/<id>/model.glb` → `GET /model.glb` returns the full 2048 bytes from the bucket, for the owner **and** for a cookie-less share-token reader | same |
| Storage failure is never silent | a refused photograph → `502` naming the object store, no bucket object, no working directory left; a refused **model** after a good reconstruction → `failed` with stage `storage`, and no model served | same |
| The application key never leaks | `/api/health` reports the driver, bucket and warnings — the key string appears nowhere in the response | same |
| A restart does not strand a capture | the queue is in memory, so a capture left `queued` or `running` when the process stopped is reproduced as stuck; boot (`start()`) re-queues exactly those rows and runs them again to `completed`, and terminal captures are untouched | `node --test apps/api/test/worker.test.js` (5 tests) |
| A finished run reclaims its disk | the worker's scratch directory is always deleted; with a durable store the raw photographs go too (the bucket holds them) while `model.glb`/`result.json` stay as a warm cache; with the local driver the photographs are kept, because there they are the only copy | same |
| Deleting an account removes its data | `DELETE /api/auth/account` needs the password as well as the session; it cancels anything running, removes exactly that account's objects from the bucket, deletes the rows and working directories, revokes its sessions, and leaves another account's capture readable | `node --test apps/api/test/auth.test.js` (11 tests), `node --test apps/api/test/storage.test.js` (21 tests) |
| Deleting an account is a deliberate, confirmed act | the account page's button is inert until the password is typed; a wrong password shows the server's own message and removes nothing (`/api/captures` still `200`); the right one erases the account, its captures and its sessions and lands signed out (`/api/captures` then `401`) | `apps/web/e2e/run.mjs` |
| The delete request is the one the API expects | a `DELETE` to `/api/auth/account` with the password in the body, and a refusal surfaced as an `ApiError` carrying the server's message rather than a generic failure | `node --test apps/web/test/account.test.ts` (2 tests) |
| Landing page renders | hero, capture CTA, non-transparent computed body background | `apps/web/e2e/run.mjs` |
| Live camera preview + wireframe box | Chromium fake device delivered **1280×960**; wireframe box is ≥2 SVG polygons over the preview | same |
| Shutter and counter work | 4 shutter presses → badge `4/24` and 4 thumbnails | same |
| Reconstruction is gated on enough photos | `Continue` disabled at 4 photos | same |
| Real photos reconstruct and open the model page | 12 fixture photographs → measure step → progress screen → `/model/<uuid>` with the worker's manifest numbers (no `NaN`) | same |
| The viewer really renders the GLB | WebGL **2.0** context via SwiftShader; HUD reports the loaded vertex/triangle counts | same |
| QR encodes the shared AR link | >500 dark pixels painted on the QR canvas; the encoded URL carries the capture's share token (`/ar/<uuid>?t=…`), not just the id | same |
| AR is honest about unsupported devices | headless Chromium has no WebXR → the page states the missing capability by name and falls back to the 3D model | same |
| Unknown model id degrades | server 404 message shown, not a blank page | same |
| No stray console errors or failed requests | assertion over the whole run, excluding the one 404 the test provokes on purpose | same |

Screenshots of every screen are written to `apps/web/e2e/screenshots/` by that
run and are gitignored.

---

## 3. Known defects and measured weaknesses

These are real and are not defects of the tests — the tests document them.

1. **Width and depth are limited by capture coverage, not by the geometry.**
   This was measured rather than assumed, and the answer changed what the fix
   had to be.

   Splitting the error into its two possible causes settled it. Against ground
   truth, on a 12-view capture: **78.6% of reconstructed points lie within 5 cm
   of the true surface**, and the pose is consistent to **0.90°**, with a
   relative depth error of **0.13%** median — so the reconstruction is
   *accurate*. But only **11–12% of the object's surface** has any
   reconstructed point near it. The cloud is not wrong; it is **incomplete**,
   and a cloud that covers a fraction of an object cannot report that object's
   full extent.

   The cause is the capture, not the pipeline. `--views 12` takes the first 12
   frames of a 24-frame orbit, which is **not** half of a circle evenly spaced:
   the largest empty arc in those 12 camera positions is **125.7°**. Anything
   facing that direction was never photographed, so no algorithm could
   reconstruct it. Reconstructing all 24 views — a 15° maximum gap — drops the
   worst principal-axis extent error from **66.55% to 29.78%** at the same
   accuracy.

   What was done about it: the worker now **measures** coverage
   (`pipeline/coverage.py`) from the registered camera centres, reports
   `capture_coverage` in the manifest, and the model page shows the orbit gap
   and a `Partial capture` warning. The app can no longer present a partial
   scan as a complete object. What it cannot do is invent the missing
   photographs — a user who orbits half way around a vase still gets a model
   of the half they photographed, and the warning says so.

2. **Registration is lossy.** 8 of 12 views registered on the 12-view fixture,
   10 of 24 on the full orbit. Failure to register a view is *not* fatal (the
   pipeline succeeds), but it reduces coverage. `registered/total` is in the
   manifest, and the orbit-gap figure in `capture_coverage` reports the
   consequence directly.

3. **No dense MVS.** Surface density is limited by sparse SIFT points. Expect
   visible facets on real captures, not a smooth scan. Raising the SIFT
   contrast threshold's aggressiveness was measured as a possible remedy and
   **rejected on evidence**: dropping `contrast_threshold` from 0.01 to 0.005
   raises keypoints from 380 to 521 per image and points from 459 to 737, but
   surface coverage only moves from 12.1% to 15.6% and the extent error barely
   moves (66.55% → 65.19%). At 0.002 the reconstruction fails outright, because
   the extra matches land mostly on the background — which occupies ~94% of
   each frame — and a false seed edge then produces no cheiral points. The
   limit is matches on the object, and only ~100 of them exist per pair however
   the threshold is set.

4. **No baked texture atlas.** Models carry per-vertex colours only.
   `validate_glb(require_texture=True)` correctly rejects them; the shipped
   pipeline does not require it and the manifest states
   `has_baked_texture: false`.

5. **Intrinsics are assumed, not calibrated.** A fixed 60° horizontal FOV. This
   biases metric dimensions; relative geometry is unaffected.

6. **A single view pair is NOT reliable on its own.** `benchmark_sift.py`
   reports `RESULT: FAIL`: despite 86.3% of its matches being geometrically
   correct, the pose recovered from that one narrow-baseline pair is off by
   **21.8° rotation / 35.4° translation**. The essential matrix from a single
   short-baseline pair is ill-conditioned, and MAGSAC++ latched onto a wrong
   dominant plane. The multi-view pipeline is unaffected because it registers
   each view against the accumulated structure rather than a single pair, and
   filters by reprojection error and parallax (§2 shows 0.3185 px reprojection
   error and a 0.90° worst pose deviation).

   **Consequence for the product:** the pipeline must always use the
   incremental multi-view path. A "just pick the best pair" shortcut would ship
   silently wrong geometry. This is the clearest evidence that the multi-view
   verification, not the per-pair one, is the meaningful measurement.

7. **The exactness test uses an adjacent pair** (views 3 and 4). A wide-baseline
   pair is better conditioned but has less overlap; the fixture generator makes
   both cases reproducible, so the narrow-baseline weakness above is a
   deliberate, inspectable case rather than an accident.

8. **`pipeline/sfm.py` is retained but superseded.** It contains the original
   hand-written numpy geometry and feature code (Shi-Tomasi corners + BRIEF).
   It is still imported by the fixture generator and the diagnostic scripts, but
   **no production code path uses it** — the pipeline runs on `features.py` +
   `incremental.py`. It is kept because it is the baseline the OpenCV decision
   was measured against (`docs/research/technology-decisions.md`), not because
   it is live.

9. **The originally rejected descriptor no longer exists, and its benchmark was
   broken until this round.** `tests/benchmark_descriptor.py` imported a float
   SIFT-style descriptor from `pipeline.features` that was deleted when the
   pipeline moved to OpenCV, so the script had been failing with
   `ImportError` while still being cited in this document. It now measures the
   descriptor that survives in `sfm.py` and reproduces the conclusion:
   same-point Hamming median **0.107** vs different-point **0.500**, **true
   partner is nearest 0.0%**, and **15.3%** of its matches correct within 5 cm —
   against OpenCV SIFT's 86.3%. The conclusion is unchanged; the earlier numbers
   (0.32 / 0.58) came from the deleted float descriptor and are no longer
   reproducible, so they are not repeated here.

---

## 3a. Defects found and fixed this round

Every item below was found by running the code and reading the numbers, not by
inspection, and each is now covered by a check that fails without the fix.

| Defect | How it showed up | Fix |
|---|---|---|
| `_extend_tracks_from_view` paired the wrong projection matrix with the matched keypoint | `P_list[1]` was `others[0]`'s matrix while `pts[1]` belonged to whichever view actually matched, so points were triangulated from correspondences that never existed | build `P_used` from the same `matched` list the pixels come from; also hoisted the per-view descriptor match out of the per-keypoint loop (it had been O(free keypoints x registered views) full matches) |
| `_triangulate_points` ignored every view after the first two | a track observed in 6 views was positioned from 2, keeping the narrow-baseline depth bias that the rest of the track exists to remove | true N-view DLT in Hartley-normalised coordinates over all observing views, plus a Gauss-Newton step; the version-fragile two-view OpenCV call is gone |
| The DLT applied `K^-1` inverted | `R = inv(Kinv) @ P` computed `K K [R\|t]` instead of `[R\|t]` | `R = Kinv @ P` |
| Seed selection ranked by inlier count | on an orbit this always picks two *adjacent* views — the most matches and the least parallax | added `_median_parallax` and `_select_seed`, preferring the most-matched pair whose median triangulation angle clears a threshold, and printing the angle chosen |
| Seed selection had no upper bound on parallax | with denser features it chose an edge at **148.8°**, looking at the object from opposite sides, and triangulated **0 of 492** inliers cheirally — the whole reconstruction aborted | `seed_max_parallax_deg = 90.0`; beyond that a two-view problem has no well-conditioned cheiral solution |
| Bundle adjustment could return a *worse* solution | LM accepted the last iterate unconditionally | snapshotting accept/reject with damping, gauge pinning via `frozen`, and points behind cameras skipped |
| `_retriangulate_all` ran unconditionally | one bad correspondence dragged its track and then the cameras with it: poses went from 1.2° to **21°** | a point is replaced only if its own mean reprojection error improves; gated on `retriangulate` |
| The coverage note contradicted its own flag | a complete orbit with a flat elevation warning printed "the model's width and depth can be smaller than the real object's" | the note branches on `full_orbit`, not on whether any warning fired |
| `centroid_offset` in the coverage report measured the coordinate frame, not the capture | it was computed as `abs(origin - rel.mean())` where `rel = centres - origin`, so `rel.mean()` is **zero by construction** and the field silently reduced to the distance from the cameras to the world origin over the orbit radius: moving a capture 100 units changed the number, changing the orbit did not | removed the field; a frame-invariance test now asserts the remaining fields are unchanged when the same orbit is translated |
| The capture ring's compass listener was gated on a permission promise that may never settle | Chromium exposes `DeviceOrientationEvent.requestPermission` but its promise never resolves, so `await`ing it before subscribing meant the listener was **never attached**. The end-to-end run drove thirteen perfectly good synthetic headings and the ring still read "unmeasured". On any browser with the same behaviour the whole feature would be silently dead | subscribe first, then request permission. Subscribing without permission is harmless — the platform simply never delivers an event — and the ring's existing unmeasured state covers a refusal honestly |
| `headingFrom` invented a bearing when it had no reference | a relative-mode call with no latched reference returned `azimuthDeg: 0`, i.e. a fabricated "facing north" that could manufacture a gap in the orbit | returns `null`; `createHeadingTracker` latches the reference from the first sample it ever sees |

The triangulation maths itself was checked in isolation with ground-truth
poses and correspondences before any of this was believed, and that check is
committed as `tests/test_triangulation.py` rather than left as a scratch
script, because three documents cite its numbers: median position error
**6.79e-16 m** with noiseless input across 3 views, **9.36e-16 m** across 2,
**3.48e-3 m** at 0.5 px noise across 6 views, **2.30e-3 m** across 12. Once
that was established, the remaining width/depth error was necessarily a
coverage problem — which is what §3.1 now says.

---

## 3b. COLMAP, finally measured (5 October)

The decision to use OpenCV rather than COLMAP was made under a blocked
environment and recorded as such. `apt-get install colmap` now works, so the
decision was **re-tested instead of left as an argument**.

On the same 12 ground-truth views the two engines were compared. Both were
given the fixture's true camera model (PINHOLE) and COLMAP was allowed to
self-calibrate the focal length:

| | registered | focal | camera-radius spread | verdict |
|---|---|---|---|---|
| Ground truth | 12/12 | 886.81 px | **1.01x** | — |
| This repo's OpenCV SfM | 8/12 | 886.81 px (assumed) | ~1.0 | correct: camera error median **0.056**, points within 5 cm **78.6%** |
| COLMAP 3.7, stock thresholds | **0/12** | — | — | **"No good initial image pair found"** |
| COLMAP 3.7, init relaxed | 11/12 | 861.5 px (−2.9%) | **3.78x** | degenerate |

Three findings, and none of them favour COLMAP here:

1. **It cannot initialise this capture at all with stock settings.** Twelve
   frames forming half an orbit with a 125.7° hole is simply not a capture
   COLMAP's defaults will start from.
2. **When forced to initialise, its structure is degenerate.** The cameras
   collapse from a sphere of one radius to a spread of **3.78x**, which is not
   a scale artefact — see the gauge note below. Its self-calibrated focal is
   fine (−2.9%), so the failure is in structure, not intrinsics.
3. **Its headline number hides all of this.** A mean reprojection error of
   0.577 px looks better than this repository's 0.371 px, and COLMAP registers
   more views (11 vs 8). Reprojection error is measured in whatever frame the
   reconstruction settled into, so a collapsed structure can be internally
   consistent and still be wrong. This is §3's lesson again, from a new
   direction.

**Why the gauge is handled carefully.** SfM fixes a reconstruction only up to a
similarity, so neither a raw camera radius (7.0) nor a raw cloud extent
(2.18) may be compared with ground truth without first solving for that
similarity. An earlier draft of the comparison script compared extents directly
and printed a reassuring **"0.93x the true object"** for the very
reconstruction whose cameras had collapsed to radius 1.6 — two different gauges,
and the number meant nothing. The verdict therefore rests on the **camera-radius
spread**, max/min, which is scale-invariant: 1.01x in truth, **3.78x** as
reconstructed.

**Consequence for dense MVS (the item this was blocking).** Dense MVS densifies
a sparse reconstruction; it cannot repair one whose cameras are off their
sphere. On this evidence COLMAP's dense MVS would densify a degenerate input,
so it is **not integrated**. `tests/compare_colmap.py` is the committed,
re-runnable gate, and it currently exits **1** with that reason.

**Scope, stated honestly.** This is one capture — a hard one, with a 125.7°
hole — and it is not a general verdict on COLMAP, which is a mature and widely
deployed system. What it establishes is narrow: on this fixture, wiring COLMAP
in would have shipped a badly wrong model, and its dense MVS inherits the
degeneracy from its sparse input.

---

## 3c. Densification measured: coverage triples, and that is the problem (5 October)

The obvious next step after §3 is to densify the sparse cloud, so it was
measured rather than assumed. Open3D 0.20 was installed (`libusb-1.0-0` was the
only missing system library) and Poisson reconstruction was applied to **this
repository's own** cloud — the one already known to be accurate — on the same
12 ground-truth views:

| | points | surface coverage | share of geometry in the **unswept arc** |
|---|---|---|---|
| Sparse cloud (shipped today) | 459 | **11.4%** | **12.9%** |
| Poisson-densified (depth 8) | 4,874 | **35.8%** | **39.1%** |
| ground truth | — | 100% | — |

Coverage went up **3.1x**, which is exactly what densification is for. And it is
not usable, because the gain is not coverage of the real object: the share of
geometry sitting in the direction the capture **never photographed** went from
12.9% to **39.1%**. Poisson always returns a watertight surface — it closes the
hull of whatever points it is given — so on a partial orbit it bridges the gap
and manufactures a confident, smooth, wrong side of the object. That is the one
failure this product exists to avoid: an object that measures well and is wrong.

**Not integrated.** `tests/eval_densify.py` is the committed gate and it exits
**1** with that reason. Densification may still be worth revisiting *conditioned
on a complete orbit*, where there is no unswept arc to fill; that is a
different experiment and is not claimed here.

**The complete-orbit experiment was run on 6 October — and registration, not
capture completeness, is the binding constraint.** §3c named a complete orbit
as the condition to re-test Poisson honestly, so `eval_densify` was run at
`--views 24` (the full 360° orbit the fixture can produce): the solver
registers only **10/24** views (§3f's rate problem, amplified — its
reconstructed cameras still leave a **110.9°** gap), and with the same
structure Poisson again fails the gate's own rule: coverage of the *reached*
surface rises 12.5% → 46.8%, but **30.2%** of the densified mesh lands in the
unswept arc (+19.9 points of manufactured geometry). The fixture now *has* a
complete orbit; the reconstruction does not. Dense MVS stays closed, and the
blocking problem is the registration rate (§3f), measured from both
directions. Reproduce: `python3 tests/eval_densify.py --fixture /tmp/fx2
--views 24` (needs open3d, exits 1 by design, ~103s).

**A gauge error caught in this very script, twice.** The first version aligned
the reconstruction with the Umeyama similarity fitted over camera centres — the
transform `eval_accuracy.py` uses for *poses*, on purpose, to isolate pose error
from shape error. Applied to points it reported **0.0%** baseline coverage for
the same cloud that `eval_accuracy` measures at 11.4%. The fix was to use the
gauge-determined transform eval_accuracy uses for points
(`X = Q·X_rec + b`, with `Q = scale·R_gtᵀR_rec`). This is the second time in
two days that comparing two reconstructions in the wrong gauge produced a
confident and completely meaningless number, which is why both gates now state
their gauge in the source.

---

## 3d. The baked texture atlas, measured against per-vertex colour (6 October)

Per-vertex colour has been replaced with a real UV-unwrapped texture atlas
(`services/reconstruction-worker/pipeline/atlas.py`): chart segmentation by
surface bend, a shelf packer, a rasteriser, and a per-texel visibility test
that renders the reconstruction into a depth buffer per view and rejects any
texel that sits behind it.

It replaced vertex colour because vertex colour *cannot* carry photographic
detail — every colour inside a triangle is a blend of three vertex colours. That
is an argument, not a measurement, so `tests/eval_texture.py` measures it.

**How it is measured.** Both models are sampled at the *same* points on the
reconstructed surface, and the truth is the *photograph*, not an analytic
re-rendering. Points are kept only if they land within 5 cm of the true surface,
so geometry error cannot flatter or damn a colour measurement. The vertex-colour
model is read the way a renderer reads it — barycentric (Gouraud); the atlas is
read the way a GPU reads it — bilinearly at texel resolution. Both are then
compared against the pixel the ground-truth camera actually recorded.

12 ground-truth views, 8 registered, a 397-vertex / 1260-face surface, scored on
1,031 points a camera photographed:

| | median | p90 |
|---|---|---|
| per-vertex colour (Gouraud) | 55.66 | 88.48 |
| **baked atlas** | **12.24** | **39.05** |

**−78.0%** on the median, **−55.9%** on the tail, and the atlas is the closer of
the two at **96.3%** of scored points. The tail improving as much as the median
matters: a texture atlas is supposed to be sharper, not merely different.

### What the bake reports, including the parts that are not good

At 1024px: 875 charts (874 seams), 25.3% of the atlas covered, 259 texels per
world unit, texel-density spread **1.19x**.

- **193,828 texels were seen by a camera** (73.8% of those covered),
  **68,662 were grown in from their neighbours**, and **0** were left bare.
  So **25.9% of the covered atlas carries colour no camera actually saw.**
  That is not a bug — 21.8% of the covered texels face away from every
  registered camera by geometry (measured directly from the interpolated
  normals), which is what an alpha-shape surface of a partial orbit produces.
  It is reported because it is visible: those patches read as flat wherever you
  look straight at them. On a fuller capture it falls sharply — the 8-view
  end-to-end run sees 86% of covered texels and leaves 7 bare.
- **874 seams is a lot.** It is the honest cost of unwrapping a bumpy
  alpha-shape surface. The alternative was fewer seams at a texel density that
  varies **7.59x** across the model; see the sweep below.
- Occlusion is decided against the *reconstruction's own* surface. On a partial
  scan, geometry the mesh never recovered cannot occlude anything, so a texel
  can still inherit colour from a photo region hidden behind missing geometry.
  This is stated in `atlas.bake`, not papered over.
- The atlas carries **no mipmaps**. One embedded PNG, linear filtering,
  clamp-to-edge. A wrong mip level would bleed another chart's colour across a
  seam, so not generating them is the conservative choice, not a shortcut.
- Baking happens **before** scale calibration. Calibration scales positions
  only, so the texture is never stretched to fit a measurement — which is
  correct, but it does mean texels-per-metre is whatever the reconstruction and
  the measurement happen to give.

### Both parameters were measured, not chosen

The chart threshold is a *maximum bend*: a chart breaks where the surface turns
by more than this. Lower means fewer, larger charts.

| max bend | charts | seams | coverage | density spread | median error |
|---|---|---|---|---|---|
| 45° | 385 | 384 | 24.0% | 7.59x | 12.65 |
| 75° | 512 | 511 | 30.3% | 7.56x | 12.07 |
| 105° | 675 | 674 | 34.7% | 2.96x | 11.83 |
| **135°** | **875** | **874** | **25.3%** | **1.19x** | **12.24** |
| 165° | 1113 | 1112 | 26.6% | 1.01x | 12.56 |

The colour error barely moves, and the reason is worth stating: a planar chart
maps a surface point to the *right* texel whatever the local density, so density
is not a colour-accuracy knob. What a low density costs is sharpness. The
default is therefore chosen on the density column, at its knee, and the colour
column shows the price is 3.5% of accuracy.

The occlusion tolerance is the other parameter, and its sweep is what makes the
default defensible rather than guessed:

| tolerance | median error | seen by a camera |
|---|---|---|
| 0.001 | 16.15 | 32.5% |
| 0.005 | 14.54 | 39.6% |
| 0.020 | 13.48 | 54.8% |
| **0.050** | **12.24** | **73.8%** |
| 0.100 | 12.05 | 91.3% |

Read honestly: the error is still falling slightly at 0.1, so this is not a
sharp knee, and everything from 0.05 to 0.1 is within 1.6% of the best value
measured. 0.05 is chosen because it is the stricter of the two — between
"reject a texel the bumpy surface is hiding" and "let an occluder bleed", the
second is the failure that matters.

### Four real defects found by running it, not reading it

1. **Barycentric weights were rotated.** The edge functions were read off in
   order (`w0, w1, w2`) instead of by opposite edge, so positions and normals
   were interpolated *mirrored* inside every triangle. The "inside" test still
   passed, so the mesh rasterised cleanly and only the geometry was scrambled.
   Caught by `test_uv_v_axis_points_down_as_gltf_requires`, which builds one
   triangle with known UVs and checks where the texels land. Fixing it moved the
   median error from 21.66 to 12.24.
2. **Red and blue were swapped in every model ever published by this repo.**
   `mesh.color_from_views` named its sample `bgr` and reversed the channels of
   an image `run.load_images` had already loaded through
   `PIL.Image.convert("RGB")`. Fixed, with a regression test that bakes a known
   RGB triple and requires it back unchanged.
3. **Unwrapped face order is not input face order.** `unwrap` regroups faces
   into charts, so indexing `unwrapped.faces[i]` against `mesh.faces[i]` pairs
   unrelated triangles. `UnwrappedMesh.source_face` is now the map, and
   `tests/eval_texture.py` builds its lookup from it.
4. **The validator's texture check measured nothing.** It was
   `bool(gltf["textures"] + gltf["images"])`, satisfied by an entry referencing
   nothing at all. It now follows material → texture → image → bufferView,
   checks the range against the buffer, and decodes the PNG. A test corrupts 16
   bytes of the embedded image and requires validation to fail.

---

## 3e. Per-photo review: the model now says which photos it used (6 October)

Until now the only thing a user learned about their photos was a count:
"4 of 12 photos were not registered". That is true and useless — it does not
say *which*, and it does not say whether to blame the photo or the solver.
`pipeline/view_quality.py` now returns one verdict per submitted photo with the
measured evidence behind it, and the model page lists every flagged photo by
name with its reason in plain words.

**The verdict is deliberately not a score.** Blur, too little overlap, a photo
of nothing and a duplicate taken from the same spot are different failures and
no single number catches them all, so the report carries the evidence and a
verdict from rules stated in the module:

| verdict | meaning |
|---|---|
| `ok` | registered, and not an outlier on track support or reprojection error |
| `weak` | registered, but clearly below the capture's median (or saw no 3-D point at all) |
| `unusable` | never registered; it contributed nothing to the model |

Every threshold is **relative to this capture** — a fraction of the median
across the views that did register — because an absolute constant means
something different at 4000 keypoints per photo than at 300. Below three
registered views the report says `relative_thresholds_used: false` and falls
back to registered/unregistered only, rather than inventing a comparison it
cannot make.

### The reason matters more than the verdict

The most common failure in this product is *not* a bad photo. On the 12-view
fixture the solver places 8 and leaves 4 — and those 4 have 44 to 72 verified
matches on their best pair. They are sharp, well textured and clearly not
photographed badly; the solver simply could not place them. So an unregistered
photo gets one of two distinct reasons:

- **matched no other photo well enough to verify a pair** → the photo itself,
- **matched other photos well (N verified features) but the solver could not
  place it** → the solver, and the surface only that photo saw is missing.

Without that second sentence the review would report the solver's limitation as
if it were the user's photography.

### How it was measured, and why the check is not theatre

`tests/eval_view_quality.py` damages a photo it chose itself — a blurred one
and one of an unrelated scene, which fail in different ways — and requires the
review to catch it.

The false-positive half needed care. This reconstruction *already* leaves four
genuinely good photos unplaced before anything is damaged, so an absolute
"how many clean photos were flagged" count could never fail and the check
would have been decorative. It is therefore **differential**: the clean capture
is reviewed first to give a baseline verdict per photo, and damaging one photo
must then (1) flag that photo, (2) leave every other photo's verdict exactly as
the baseline had it, and (3) make the reported evidence distinguish the two
damage modes. On the fixture: the blurred photo reports **29** keypoints and
the unrelated one **4000**, and in both cases the other 11 photos keep their
baseline verdicts.

**A negative control was run to prove the gate can fail.** With the review
stubbed to report no photos at all, the gate exits **1** with three named
failures. While doing that, the control exposed a real weakness — the gate
*crashed* with a `KeyError` when a photo was missing from the report instead of
failing cleanly. It now reports that as a failure, because a review that drops
a photo has not reviewed the capture.

### What it does not do

It does not tell the user how to fix a photo, only what happened to it, and it
does not judge a photo that registered normally. On this fixture nothing is
judged `weak`: the failures here are placement failures, and the report says so
rather than inventing a quality concern.

---

## 3f. The registration limit is not a threshold (6 October)

Only 8 of 12 views register on this capture, and §3e shows the four failures
are not bad photographs. That looks like `min_pnp_inliers: 30` being set too
high, so `tests/eval_registration_rate.py` measured whether lowering it works.
**It exits 1 by design: the threshold is not the bottleneck, and the fix is not
safe to ship on this evidence.**

**The inlier ratio already discriminates; the count does not.** Against the
fully-solved structure, views that register have a PnP inlier ratio of
**0.77–0.91** and views that do not have **0.21–0.40** — separated by 0.37. The
absolute *counts* overlap around 28–30, which is exactly where the threshold
sits. So the gate is not mis-set; it is a poor statistic that happens to work
because the two populations are far apart in ratio.

**Relaxing the count does register more views**, and surface coverage barely
moves — but the shape moves a lot:

| `min_pnp_inliers` | registered | points | coverage | radial shift vs current |
|---|---|---|---|---|
| **30** (shipped) | **8/12** | **459** | **78.6%** | **1.000x** |
| 20 | 11/12 | 608 | 77.6% | 1.236x |
| 15 | 11/12 | 608 | 77.6% | 1.236x |
| 10 | 12/12 | 635 | 76.1% | 1.270x |

12/12 instead of 8/12, for a 2.6-point loss of coverage — and a **27% shift in
the cloud's radial distribution**. Nothing measured here establishes which
shape is the more correct one, so shipping this on the strength of a flat
coverage number would be exactly the mistake already made twice in this
repository: a metric measured in the wrong frame looks excellent and is
meaningless.

**This gate is not wired into `verify.sh`, and not for the usual reason.** It
needs nothing beyond `requirements.txt` — unlike `compare_colmap.py` and
`eval_densify.py`, there is no missing dependency to hide behind. It simply
takes ~97s, because it runs a full structure-from-motion per variant, and
adding it would roughly double that section's runtime. The reason is stated in
`scripts/verify.sh` rather than left implicit.

### A wrong-gauge trap, hit a third time

The first version of this script reported coverage collapsing from 78.6% to
**39.5%** when the gate was relaxed, which reads as "relaxing it is
catastrophic". That number was wrong. Each run was aligned to ground truth
through *its own* fitted gauge, and the extra views drag that fit — so the three
clouds were compared in three different frames.

Every run here seeds from the same pair and declares the same gauge view, so
they share one similarity exactly. The gate therefore takes the gauge from the
shipped configuration **once** and applies it to every variant. The real numbers
are 78.6 / 77.6 / 76.1, not 78.6 / 39.5 / 53.2.

This is the third occurrence of the same class of error here (§3c, and the one
`tests/gauge.py` exists to prevent). On this problem an absolute coverage
number is only trustworthy beside a statement of the frame it was measured in,
and both the gate and `gauge.py` now say so in their source.

### The three levers, measured against ground truth (6 October)

`tests/eval_registration_levers.py` A/B-tests the remaining candidates against
the baseline, all in one shared gauge — and adds the measurement §3f was
missing: the fixture's cameras all sit at radius **7.0**, so applying the
gauge to each run's **camera centres** and measuring |r−7| judges "which shape
is more correct" directly against ground truth instead of by radial shift
alone.

| variant | reg | coverage | reproj px | radial | cam \|r−7\| med | cam r spread |
|---|---|---|---|---|---|---|
| baseline (`first3` anchors) | 8/12 | 78.6% | 0.371 | 1.000× | 0.019 | 1.01× |
| neighbor-anchors | **9/12** | 77.7% | 0.400 | 1.074× | **0.014** | 1.01× |
| ratio-acceptance (0.55 / floor 12) | 8/12 | 78.6% | 0.371 | 1.000× | 0.019 | 1.01× |

Findings:

1. **Ratio acceptance is measurably inert** on this capture: the run is
   bit-identical to baseline. A default-off attempt probe inside the
   registration loop recorded what the four holdouts were *offered* — 45–70
   2D-3D pairs every round — and the best they achieve is 22–28 PnP inliers,
   inside the bad 0.21–0.40 ratio band. The ratio gate correctly rejects every
   one of them; there is nothing for it to accept.
2. **"Thin 2D-3D supply" is disproved as the binding constraint.** The
   holdouts are offered plenty of pairs; they simply lack a pose consensus.
   The remaining suspects are the registration *order* (views are attempted
   in every round and placed by most inliers, but the structure they must fit
   is grown from whatever got registered before them) and the seed pair's
   own coverage of the object.
3. **Neighbor-ranked track-extension anchors** (extending the newest view
   against its most similar registered views, from the view graph, instead of
   the first three by index) register **one more view and place cameras
   measurably closer to the true radius** (0.014 vs 0.019 median |r−7|,
   spread unchanged at 1.01× — compare COLMAP's 3.78× in §3b) — but cost
   0.9 points of surface coverage here.

The shipped configuration therefore **stays** on the historical anchors: by
this repository's rule a lever is adopted only when it wins on every axis, and
−0.9 coverage is not bought by +1 camera when camera accuracy is already at
1% of the object's size and coverage is the product's binding limit. The code
ships both modes behind `track_extension_anchors` (`first3` default,
`neighbors` available) and a default-off `_attempt_probe` hook, so the next
round of candidates can be measured without touching the loop again. The
instrument is ~109s and, like `eval_accuracy`, reports rather than gates; it
is not in `verify.sh` for the same runtime reason as
`eval_registration_rate.py`.

### The order and seed levers, measured (6 October)

§8 item 6 left two candidates untouched: the registration **order** (which
views the structure grows through) and the **seed pair's own coverage of the
object**. `tests/eval_registration_levers.py` gained three default-inert cfg
keys to A/B them in the same shared gauge — `seed_selection` (`parallax`
shipped, `widest`, `narrowest`, `wide-strong`) and `registration_order`
(`inliers` shipped, `graph`) — plus abort reporting (a bad seed can abort; the
row prints `ABORT` rather than disappearing) and a fingerprinted
`--baseline-cache` so a 24-view lever costs one reconstruction instead of
two. `pipeline/incremental.py` holds the knobs behind `_pick_seed()` and
`_order_key()`, both pure and unit-tested (5 tests in `test_pipeline.py`).

**12 views, same gauge as the table above:**

| variant | reg | points | coverage | radial | cam \|r−7\| med | seed chosen |
|---|---|---|---|---|---|---|
| baseline (`parallax` seed, `inliers` order) | 8/12 | 459 | 78.6% | 1.000× | 0.019 | (5,6) 26.0°, 117 inliers |
| seed-widest | 2/12 | 32 | 0.0% \* | 0.153× \* | 0.227 \* | (9,10) 48.6°, 36 inliers |
| seed-narrowest (negative control) | 2/12 | 40 | 0.0% \* | 0.270× \* | 0.126 \* | (10,11) 3.3°, 44 inliers |
| seed-wide-strong | 8/12 | 460 | **80.2%** | 0.976× | 0.020 | (5,8) 38.9°, 62 inliers |
| order-graph | 8/12 | 459 | 78.6% | 1.000× | 0.019 | (5,6) — identical run |

**24 views (the complete-orbit capture), baseline row from `--baseline-cache`:**

| variant | reg | points | coverage | radial | cam \|r−7\| med |
|---|---|---|---|---|---|
| baseline | 10/24 | 605 | 74.2% | 1.000× | 0.030 |
| order-graph | 10/24 | 605 | 74.5% | 0.996× | 0.027 |
| seed-wide-strong | 10/24 | 617 | **47.8%** | 0.977× | 0.028 |

\* The two 2/12 rows' shape columns are not measurable: `point_gauge` derives
scale from tracks seen by ≥3 cameras, and a run with only its two seed
cameras has none — the scale falls back to 1.0 and the table says so in its
`scale` column rather than printing a number that would read as a verdict.

Findings:

1. **Order is inert at 12 views** — the graph-ranked run is bit-identical to
   baseline (same seed, same registration sequence). At 24 views it does
   differ slightly and lands marginally *better* on every quality axis
   (74.5% vs 74.2%, \|r−7\| 0.027 vs 0.030) — while registering the **same
   10/24**. A tie on the axis the lever exists to move is not a win.
2. **The seed pair's coverage of the object is not the missing ingredient.**
   The widest in-band edge is also the most feature-poor one (36 vs 117
   inliers) and its structure never grows past the two seeds: 2/12, and the
   negative control (narrowest) collapses the same way. The middle course —
   widest angle among edges holding ≥0.5× the best in-band inlier count —
   ties baseline at 12 views (8/12, with +1.6 coverage points) but at 24
   views costs **26.4 coverage points** (47.8% vs 74.2%). A regression on an
   axis rejects the lever by this repository's rule.
3. **A gauge lesson, this time in the other direction.** The first run of
   `seed-wide-strong` printed 0.0% coverage and a 0.444× radial shift —
   through *baseline's* (Q, b). A different seed pair changes the world's
   unit (the seed baseline *is* the unit), so a different-seed run does not
   live in baseline's frame; the number was a gauge artefact, not a shape.
   The §3f rule — runs that share a seed share one gauge — implies its
   converse: runs that do not share a seed *cannot*. The instrument now
   maps each seed variant through its own `gauge.point_gauge` (depth-map
   scale, never fitted to the object) and labels every row `shared`, `own`
   or `cached` beside a `scale` column. That is the wrong-gauge error a
   fourth time, caught before it reached a verdict — the first one that
   flattered nothing and punished a sound run instead.

**Verdict: both defaults stay** (`seed_selection: "parallax"`,
`registration_order: "inliers"`). Five levers have now met the rule — win on
every axis — and none has. The knobs ship default-inert so the next
candidate needs no loop surgery.

### What would actually fix it

Not a constant, and — now measured — not the order and not the seed. Five
levers have been taken against ground truth: the PnP threshold (§3f table),
ratio acceptance (inert, bit-identical), neighbor anchors (+1 camera for −0.9
coverage), registration order (no registrations gained at either 12 or 24
views) and seed-pair coverage (ties at 12, −26.4 coverage at 24). What the
attempt probe showed instead is that the holdouts are *offered* 45–76
correspondences every round and best out at 19–28 PnP inliers inside the bad
0.21–0.40 ratio band: the missing quantity is **pose consensus**, not supply,
not order, not seeding. Nothing in the current loop can manufacture consensus
for a view whose best solution sits in that band, so the next real candidate
must bring new evidence into the PnP decision itself — a second hypothesis
that has to agree, a re-verification against the grown structure with a
stricter ratio, or an edge re-score once neighbours of the holdout have
registered — rather than re-arranging what the loop already does. Until such
a candidate is built and measured, 8/12 and 10/24 stand as the measured state
of the art here, and dense MVS stays closed on their authority (§3c).

---

## 3g. Packaging, built and executed where execution was possible (6 October)

Three packaging deliverables landed: **Colab/Kaggle notebooks**, a
**Dockerfile + .dockerignore**, and **deployment guides**
(`docs/deployment/docker.md`, `docs/deployment/vps.md`). All are gated, and
the gating caught a real repository bug on its first run.

### The notebooks are executable documentation, and they are executed

`notebooks/colab/objectcapture_ar_demo.ipynb` and
`notebooks/kaggle/objectcapture_ar_demo.ipynb` carry six identical code cells,
generated from a single source, `notebooks/code_cells.py`. The gate
(`tests/test_notebooks.py`, 5 s) loads both with `nbformat`, proves the cells
are byte-identical to that source *and to each other*, then executes them top
to bottom on the real fixture with the real worker:

| Measured | Result |
|---|---|
| Execution | 6 cells in **5.0 s**, ending in a re-parsed, texture-requiring-validated GLB |
| Demo manifest, as printed | 157 vertices, 78 triangles, 1024 px atlas, **99.5%** of covered texels seen by a camera |
| Honesty of the demo | `MEASUREMENT = None` → result stays **uncalibrated**; the 8-photo demo's **180°** orbit gap is labelled a **partial orbit**; both warnings reach the reader's output |
| Negative controls | a doctored result (false calibration, impossible texel counts) fails the honesty checks; an edited cell fails the verbatim comparison |

The gate caught `requirements.txt` pinning `opencv-python-headless==5.0.0`,
which **does not exist on PyPI** (the release is `5.0.0.93`) — any fresh
`pip install -r requirements.txt`, including inside the notebooks and the
docker image, would have failed. Fixed to `5.0.0.93` everywhere (file,
notebook cells).

### The Docker contract, executed honestly

This sandbox and CI have **no docker daemon**; the image has never been built
or run here, and the Dockerfile header, `scripts/verify.sh` and
`docs/deployment/docker.md` all say so. What `tests/test_dockerfile.py` (3–7 s)
does execute against this tree:

- every `requirements.txt` pin resolves on PyPI **with a wheel covering
  CPython 3.10 on manylinux** — the platform `python:3.10-slim` targets — and
  pip accepts the file;
- the image's CMD, `node apps/api/src/server.js`, boots; `node:sqlite` loads;
  `/api/health` answers with `worker.available: true`;
- the Dockerfile agrees with the code it ships (env names `config.js` reads,
  the `8787` default, the health route, stage order, the `COPY --from=web`
  dist hand-off, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` so playwright's postinstall
  cannot pull three browsers into a layer), and `.dockerignore` excludes
  nothing a COPY needs;
- negative controls: an impossible pin (`5.0.0` again), a broken CMD, and a
  `.dockerignore` that excludes `apps/` each make the gate fail.

A real `docker build` remains the one unexercised step; the guide names it and
points at this gate as the contract to check first if it ever fails.

### The deployment guides state the limits as limits

`docs/deployment/docker.md` and `docs/deployment/vps.md` document the real env
names (`DATA_DIR`, `PORT`, `PYTHON`, `MAX_CONCURRENT_JOBS`, `UPLOAD_BURST`,
…), the systemd unit, TLS via Caddy with the reason it is not optional (WebXR
needs a secure context — on plain HTTP the phone falls back to the passive
viewer and the hit-test path never runs), and the same limitation list as §5:
single concurrent job, no auth (the QR link is the access control), no cloud
storage, no accounts.

## 4. BLOCKED / NOT EXERCISED

**The 3 October “no apt package lists” blocker is stale.** On 4 October
`apt-get update` succeeded in this sandbox, and the packages are now visible:

```
$ apt-cache policy colmap ffmpeg
colmap: Installed: (none)   Candidate: 3.7-2
ffmpeg:  Installed: (none)   Candidate: 7:4.4.2-0ubuntu0.22.04.1
```

They were **not** installed this round; nothing in §2 depends on them. The
previously recorded blockers below are therefore *decisions not revisited*, not
environmental impossibilities, and should be re-tested rather than assumed.

| Item | Status now | Evidence |
|---|---|---|
| COLMAP integration | **installed (3.7-2) and measured; still not integrated** — see §3b | `python3 tests/compare_colmap.py` |
| Dense MVS / Poisson meshing | **installed and measured** (§3c, including the 6 October complete-orbit re-test at 24 views); still not integrated | `python3 tests/eval_densify.py --fixture /tmp/fx2 --views 24` |
| Video frame extraction | installable from apt; not installed | `apt-cache policy ffmpeg` → `Candidate: 7:4.4.2` |

Still genuinely unverified, and not fixable from here:

| Item | Blocker |
|---|---|
| AR on real hardware | no phone, no ARCore device and no WebXR runtime. Hit-test placement is written against the spec and refuses to place a model without a detected surface, but it has **never executed** against a real XR session. |
| Physical scale on a real object | every scale number in this repo comes from synthetic ground truth. No physically measured object has been scanned. |
| Concurrent multi-user operation | the API test runs one job at a time; `MAX_CONCURRENT_JOBS` exists but load was never tested. |
| Backblaze B2, and the bucket CORS rules a direct upload needs | no B2 account here, so every storage and direct-upload gate runs against `apps/api/test/b2-stub.js`. The stub is honest about the protocol (it records requests and is asserted on the wire format), but it is not the provider: a real bucket's error codes, its CORS behaviour and its upload-token expiry are unexercised. Add `B2_KEY_ID`/`B2_APPLICATION_KEY`/`B2_BUCKET_NAME` and follow `docs/storage/README.md` to run it for real. |

---

## 5. NOT BUILT — no code exists

These were requested and are simply absent. Nothing below is stubbed,
mocked, or claimed.

- An at-rest encryption choice, a **bucket-side** lifecycle rule, and any audit
  of who read what. **Cloud object storage is no longer in this list** (7
  October): `apps/api/src/storage.js` writes every photograph as it is uploaded,
  and `result.json` plus `model.glb` before a capture is called `completed`, into
  local disk by default or into **Backblaze B2** when its keys are configured
  (ADR 0006). `GET /model.glb` falls back to the stored object, so a capture
  survives its host losing its disk, share-token links included. It is
  *unconfigured* here, not unbuilt: with no keys it behaves exactly as before
  and `/api/health` says `storage.kind: "local"`, `durable: false`.

  **Presigned uploads and server-side retention are no longer in this list
  either** (7 October, later). With B2 configured the browser uploads a capture's
  photographs **straight to the bucket** — the API hands out one short-lived
  upload URL per object and then re-reads what landed (a `HEAD` for size, a
  **range read of bytes 0–15** sniffed against the declared container) before any
  worker is allowed to see it; a mismatch removes the capture whole. The API
  cannot stamp the checksum or the length into those headers (it never sees the
  bytes, and a browser forbids a script from setting `content-length`), so the
  client computes the checksum itself. An upload token is **bucket-wide, not
  name-scoped** — the store will not bind it to a prefix — which is why the
  re-check is the boundary and why the bucket must be private. On a clock,
  `apps/api/src/retention.js` sweeps at boot and every
  `RETENTION_SWEEP_SECONDS`: it **always** reaps abandoned `uploading` rows past
  `UPLOAD_ABANDONED_MINUTES`, and expires finished captures only when
  `CAPTURE_TTL_DAYS` is set above its default of **`0`** — deleting a user's
  reconstruction on a timer is a product decision, so the default keeps captures
  until their owner asks for them to go. Gated by
  `apps/api/test/direct-upload.test.js` (10), `apps/api/test/retention.test.js`
  (7) and `apps/web/test/direct-upload.test.ts` (10), all wired into
  `verify.sh`. What remains genuinely unbuilt is the rest of this bullet: no
  SSE-C key (the bucket's own SSE-B2 setting applies), no bucket-side lifecycle
  rule configured by this codebase, and no audit log.

**Pruning on publish and account deletion are no longer in this list** (7
October). A run that finishes deletes its `work/` scratch always, and its raw
photographs once a durable store holds them (`KEEP_LOCAL_COPIES=1` to keep
them), leaving the published model and result as a warm cache — gated by
`apps/api/test/worker.test.js`. `DELETE /api/auth/account` erases an account in
one step: it is confirmed with the password, cancels anything still running,
removes every object the account owned, deletes the rows and working
directories, revokes the sessions and clears the cookie — gated by
`apps/api/test/auth.test.js` and, for the bucket side,
`apps/api/test/storage.test.js`. What neither does is age anything out: a
capture nobody deletes stays in the bucket for ever, which is stated as
unbuilt above rather than papered over.

**Restart recovery is no longer in this list** (7 October). The job queue is
in memory, so a capture that was `queued` or `running` when the process stopped
used to be stranded: it read as "in progress" for ever and the user could
neither get it nor clear it. `apps/api/test/worker.test.js` reproduces that
first, then requires boot (`start()`, never `createServer`) to re-queue exactly
those rows and run them from the start — their inputs are still on disk, so
nothing is lost and nothing is falsely reported as finished.

**Accounts, authentication and per-user ownership are no longer in this list**
(7 October). Every capture is owned by the account that made it
(`apps/api/src/accounts.js`, `apps/api/test/auth.test.js`): sign-up and sign-in
hash the password with scrypt and issue an `HttpOnly; SameSite=Lax` session
cookie; `POST`/`GET` on captures require that session, a second account gets
`403` on someone else's capture and never sees it in a list, and only the owner
may cancel or share. The share URL is no longer a bearer capability: the
token in `?t=` is a **separate secret** from the capture id and is revoked the
moment the owner clicks **Stop sharing** — the exact id alone answers `401`
(signed out) or `403` (another account). This was the top unbuilt item and the
only one that was both a security problem and a product blocker; what remains
of it is cloud storage, above.

**Notebooks, Docker packaging and the deployment guides are no longer in this
list** — they were built on 6 October and are described in §3g, with their own
honest caveat: no docker daemon exists here, so the image was never built; the
contract it encodes is executed instead. Cloudflare / B2 configuration is
*also* not built and remains so — there is nothing to configure it against
while accounts and cloud storage stay unbuilt.

**Job cancellation is no longer in this list** either (6 October): `DELETE
/api/captures/:id` cancels a queued capture (dequeued without starting) or a
running one (worker stopped), and both end in a named `cancelled` state —
never `failed`, never `completed`; terminal states answer 409. Gated by
`apps/api/test/cancel.test.js` with a stand-in worker that traps SIGTERM.
What was still absent — a cancel affordance in the web UI — is **no longer in
this list** (6 October, later): the processing screen now offers a "Cancel
reconstruction" button while a capture is queued or running, wired to
`DELETE /api/captures/:id`; the capture lands in the named `cancelled` state,
no model is published, the UI never renders a cancel as a failure, and the
retry affordance returns to a fresh capture. Gated twice: the client contract
by `apps/web/test/cancel.test.ts` (4 Node tests) and the whole flow by the
e2e step "a running reconstruction can be cancelled from the processing
screen" against the real API and real worker.

Also worth stating plainly about what *is* built: the capture screen has no
on-device object detector, so the wireframe box is a pure **guide** and knows
nothing about the object. The orbit ring is a partial exception added on
5 October: it measures the directions the **camera** pointed (from the device
compass), never the object's shape, and its caption says so. It is a preview of
what the worker will later measure from the reconstructed camera centres, not a
substitute for it, and with no compass it reports coverage as *unmeasured*
rather than drawing an empty circle that reads as zero percent.

**Per-photo review is no longer in this list** — it was built on 6 October and
is described in §3e.

**The documentation deliverables are no longer in this list** either (6
October, later): every `docs/` directory that had existed empty now holds the
document it was reserved for — `docs/api/` (REST reference: routes, states,
limits, error envelope), `docs/architecture/` plus four ADRs (dense MVS
closed, the gauge rule, registration defaults, no-fallback-model),
`docs/capture/`, `docs/reconstruction/`, `docs/security/` (built vs not-built,
every claim naming its enforcing test or its absence) and
`docs/troubleshooting/` — 19 markdown documents in total, gated by
`tests/test_docs.py`: no empty directory under `docs/`, no stub, every
relative link resolves, with a negative control that must fail both checks.
Wired into the pipeline section of `verify.sh`.

---

## 6. Repository contents actually present

Audited against the working tree on 6 October 2026; this listing is the
inventory, not a plan.

(The repo was restructured out of its `objectcapture-ar/` wrapper on 6
October 2026; the tree below is the *current* layout.)

```
./             (repository root)
  README.md                    overview + reproduction commands
  requirements.txt             pinned worker dependencies (5.0.0.93 opencv pin fixed by the notebook gate)
  Dockerfile                   api + worker + built web app in one image (contract-gated, §3g)
  .dockerignore                keeps docs/notebooks/runtime state out of the build context
  .gitignore
  notebooks/
    code_cells.py              single source both notebooks' code cells are generated from
    colab/objectcapture_ar_demo.ipynb
    kaggle/objectcapture_ar_demo.ipynb
  docs/
    api/README.md              REST reference: routes, lifecycle, limits, error envelope
    architecture/README.md     system overview, job contract, stage weights, decisions
    architecture/adr/          index + 7 ADRs: dense MVS, gauge rule, registration defaults, no-fallback, accounts + share links, storage, direct uploads + retention
    capture/README.md          what to photograph; what the UI measures vs only shows
    reconstruction/README.md   stages, config knobs, verification map, honest limits
    storage/README.md          the two storage drivers, the B2 keys, what is stored when, what is not
    security/README.md         built vs not-built security posture; every claim names a test or its absence
    troubleshooting/README.md  failure modes with the message the product actually shows
    deployment/docker.md       image contents, env vars, what was verified without a daemon
    deployment/vps.md          non-Docker host: install, systemd, TLS, same honest limits
    research/technology-decisions.md
  services/reconstruction-worker/
    run_job.py                 worker CLI (job contract -> validated GLB)
    pipeline/
      features.py              SIFT detection, description, Lowe matching   [live]
      incremental.py           view graph, seeding, PnP, filtering          [live]
      ba.py                    Levenberg-Marquardt bundle adjustment        [live]
      coverage.py              orbit completeness from camera centres       [live]
      mesh.py                  alpha-shape surface reconstruction, colouring [live]
      atlas.py                 UV unwrap, chart packing, texture baking    [live]
      view_quality.py          per-photo verdict and stated reason          [live]
      calibration.py           physical scale with provenance                [live]
      glb.py                   GLB writer + independent validator          [live]
      run.py                   stage orchestration with honest progress     [live]
      sfm.py                   superseded hand-written geometry (see §3.8)
  tests/
    __init__.py
    make_fixture.py            procedural ground-truth capture generator
    recoverpose_contract.py    exactness proof for two-view geometry
    test_triangulation.py      N-view triangulation exactness on gt correspondences
    test_coverage.py           orbit-completeness estimator vs the fixture's own angles
    eval_accuracy.py           gauge-free depth / alignment / coverage evaluator
    gauge.py                   the one reconstruction -> ground-truth transform
    eval_texture.py            baked atlas vs per-vertex colour, scored on photos
    eval_view_quality.py       per-photo review vs a known-damaged photo
    eval_registration_rate.py  why the PnP gate is not the registration limit
    eval_registration_levers.py  A/B of the §3f levers: anchors, ratio, seed, order (instrument)
    eval_densify.py            Poisson densification, measured and rejected
    compare_colmap.py          COLMAP vs this repo, measured and rejected
    benchmark_sift.py          matching accuracy vs ground truth
    sweep_inliers.py
    benchmark_descriptor.py    the rejected numpy descriptor's accuracy
    test_notebooks.py          executes both notebooks' cells verbatim, honesty-checked
    test_dockerfile.py         the image's runtime contract, executed (no daemon here)
    test_docs.py               documentation set: no empty dir, no stub, links resolve (negative control)
    test_pipeline.py           pipeline unit suite (73 passing)
    test_sfm_multiview.py      SfM pose accuracy vs ground truth
    test_end_to_end.py         full worker run + GLB validation

  apps/
    web/                       Vite + React + TypeScript capture app, viewer, QR, WebXR AR
      package.json             npm install + vite build (no bun-only config)
      bun.lock, index.html
      src/, dist/, e2e/, test/
    api/                       zero-dependency Node service that queues jobs and runs the worker
      package.json             type:module, engines >=22.5
      src/server.js            routes, access control, static app
      src/accounts.js          scrypt passwords, sessions, share tokens
      src/storage.js           local-disk and Backblaze B2 drivers (ADR 0006), presign()
      src/retention.js         the sweep: abandoned uploads always, expired captures only if CAPTURE_TTL_DAYS > 0
      src/config.js, src/worker.js, src/store.js, src/ratelimit.js
      test/api.test.js, test/auth.test.js, test/storage.test.js,
      test/direct-upload.test.js, test/retention.test.js,
      test/worker.test.js, test/timeout.test.js, test/cancel.test.js
      test/b2-stub.js          stand-in B2 server: the other side of the documented API
    web/src/lib/session.ts     the one client-side session store
    web/src/lib/upload.ts      direct-vs-body upload decision, with the fallback
    web/test/direct-upload.test.ts  the direct-upload client contract
    web/src/pages/Auth.tsx     sign in / create account
    web/src/pages/Account.tsx  account details + password-confirmed deletion
    web/test/share.test.ts     the share-token client contract
    web/test/account.test.ts   the delete-account client contract
  packages/
    config/, contracts/        monorepo workspace packages
  scripts/
    verify.sh                 runs every claim in this document (pipeline + api + web + docker sections)
  .github/workflows/ci.yml    CI = scripts/verify.sh
  docs/
    research/technology-decisions.md
    status.md                  (this file)
```

`sfm.py` and the `two_view_check.py` / `sweep_inliers.py` instruments are
retained deliberately: they are the rejected baseline and the instruments that
found each bug recorded in §3, and they remain useful for re-diagnosis. **No
production code path imports `sfm.py`.**

Earlier drafts of this section listed `diagnose_two_view.py` and
`diagnose_descriptor.py`. Those were scratch scripts and have been **deleted**;
their findings are committed as `tests/test_triangulation.py` and
`tests/test_coverage.py` instead, so every number in §3 that came from them
still has a re-runnable source.

---

## 7. How to reproduce every claim

Everything at once:

```bash
pip3 install -r requirements.txt
sh scripts/verify.sh              # everything; exits 0 when all behaved as documented
sh scripts/verify.sh pipeline     # or one section at a time:
sh scripts/verify.sh api
sh scripts/verify.sh web
sh scripts/verify.sh docker
```

By hand:

```bash
pip3 install numpy scipy Pillow opencv-python-headless pytest

# Generate the ground-truth fixture (~24 rendered views + exact depth maps)
python3 tests/make_fixture.py --out /tmp/fx2 --views 24 --radius 7.0

# Prove two-view geometry is exact
python3 tests/recoverpose_contract.py

# Prove N-view triangulation is exact on ground-truth correspondences
python3 tests/test_triangulation.py --fixture /tmp/fx2

# Prove orbit completeness is measured, not assumed
python3 tests/test_coverage.py --fixture /tmp/fx2

# Measure matching and full-SfM accuracy
python3 tests/benchmark_sift.py --fixture /tmp/fx2 --pair 3 4   # exits 1: documented
python3 tests/benchmark_descriptor.py --fixture /tmp/fx2 --pairs 3 4
python3 tests/test_sfm_multiview.py --fixture /tmp/fx2 --views 8

# Run the worker end-to-end and validate the GLB it produces
python3 tests/test_end_to_end.py --fixture /tmp/fx2 --views 8

# Prove the baked texture atlas beats per-vertex colour, scored on the photos
python3 -m tests.eval_texture --fixture /tmp/fx2 --views 12

# Prove the per-photo review catches a damaged photo, against a clean baseline
python3 -m tests.eval_view_quality --fixture /tmp/fx2 --views 12

# Show that the registration limit is NOT the PnP threshold; exits 1 BY DESIGN.
# Not in verify.sh: it runs a full SfM per variant (~97s) and would double that
# section's runtime. Same reason is stated in scripts/verify.sh.
python3 -m tests.eval_registration_rate --fixture /tmp/fx2 --views 12

# Unit suite
python3 -m pytest tests/test_pipeline.py -q

# Accuracy / coverage evaluator (not part of verify.sh: it is a measurement
# instrument, not a pass-fail gate)
python3 -m tests.eval_accuracy --views 12

# The OpenCV-vs-COLMAP decision, re-tested now that colmap is installable.
# Needs `apt-get install colmap`; exits 1 on this fixture BY DESIGN (§3b).
python3 tests/compare_colmap.py

# Densification, measured and rejected on a partial orbit (§3c).
# Needs `pip install open3d`; exits 1 BY DESIGN.
python3 tests/eval_densify.py --fixture /tmp/fx2 --views 12

# The complete-orbit variant of the same experiment (§3c, 6 October): the
# fixture HAS a full 360-deg orbit at 24 views, but the solver registers only
# 10/24 and Poisson still manufactures geometry in the unswept arc. Closed for
# the same reason; the binding constraint is the registration rate.
python3 tests/eval_densify.py --fixture /tmp/fx2 --views 24   # ~103s

# A/B-measure the §3f registration levers (anchor mode, ratio acceptance,
# seed selection, registration order) against the baseline in one gauge
# frame. An instrument, not a gate: it prints a table and exits 0. The
# measured decision was to keep every shipped default -- see docs/status.md §3f.
# Subsets must start with baseline (or pass a valid --baseline-cache): the
# gauge is baseline's, never a lever's. The cache self-invalidates whenever
# incremental.py or gauge.py changes.
python3 -m tests.eval_registration_levers --fixture /tmp/fx2 --views 12
# 24 views cost ~109s for baseline + ~99-110s per lever, so cache the
# baseline first and run the levers against it:
python3 -m tests.eval_registration_levers --fixture /tmp/fx2 --views 24 \
  --variants baseline --baseline-cache /tmp/levers24.json
python3 -m tests.eval_registration_levers --fixture /tmp/fx2 --views 24 \
  --variants order-graph --baseline-cache /tmp/levers24.json

# Whether densifying our own cloud helps or invents geometry (§3c).
# Needs `pip install open3d`; exits 1 on this fixture BY DESIGN.
python3 -m tests.eval_densify

# Notebooks: execute both notebooks' six code cells verbatim on the real
# fixture; the honesty checks and three negative controls run too.
# `--fast` checks structure and verbatim match without running the pipeline.
python3 tests/test_notebooks.py

# Docker contract: every pin resolves on the image's platform, the image's
# CMD boots and /api/health answers, and the Dockerfile agrees with the code
# it ships. The image itself is not built here (no docker daemon) -- the gate
# prints that; docs/deployment/docker.md says what a real build must check.
python3 tests/test_dockerfile.py

# Documentation set: no empty directory, no stub, every relative link
# resolves (negative control included). Also runs in verify.sh's pipeline section.
python3 tests/test_docs.py
```

### Product surface

```bash
# API + worker, no npm install needed (node >= 22.5)
node --test apps/api/test/api.test.js     # 6 tests, incl. rate limiting (+1 in timeout.test.js)
node --test apps/api/test/auth.test.js    # 11 tests: accounts, ownership, revocable share links, account deletion
node --test apps/api/test/worker.test.js  # 5 tests: restart recovery, post-run cleanup
node --test apps/api/test/timeout.test.js # a hung job is killed
node --test apps/api/test/cancel.test.js  # queued and running jobs can be cancelled (DELETE)
node --test apps/api/test/retention.test.js # 7 tests: the sweep, incl. the negative control that
                                          # nothing expires while CAPTURE_TTL_DAYS is 0

# Build the web app, then drive it in a real browser against the real worker
cd apps/web && bun install && bun run build
cd ../.. && node apps/web/e2e/run.mjs     # exits 0 on success

# Capture-ring geometry, including the cross-language check against coverage.py
node --test apps/web/test/orbit.test.ts

# The share-token client contract: every read a shared page makes must carry
# the ?t= token, and the owner must need none
node --test apps/web/test/share.test.ts

# The delete-account client contract: DELETE to /api/auth/account with the
# password, and the server's refusal surfaced as an ApiError
node --test apps/web/test/account.test.ts

# Storage: local disk and Backblaze B2. 21 tests, ~2s, NO credentials needed --
# the B2 half runs against apps/api/test/b2-stub.js, a stand-in server that
# implements the documented protocol and records every request.
node --test apps/api/test/storage.test.js

# Presigned direct-to-bucket uploads, same stand-in: a manifest mints one URL
# per photograph, what lands is re-read and sniffed before the job is queued,
# and a driver that cannot presign answers 409 instead of pretending.
node --test apps/api/test/direct-upload.test.js

# The direct-upload client contract: decode once, upload with the API's headers,
# complete, and fall back to the request body on any failure but a 401.
node --test apps/web/test/direct-upload.test.ts

# The same gate against the real Backblaze service (needs a private bucket with
# CORS rules for this app's origin, and an application key restricted to it;
# see docs/storage/README.md):
#   STORAGE_DRIVER=b2 B2_KEY_ID=… B2_APPLICATION_KEY=… B2_BUCKET_NAME=… \
#     node --test apps/api/test/storage.test.js
#     node --test apps/api/test/direct-upload.test.js

# Run the product locally (two terminals)
node apps/api/src/server.js              # API on :8787, serves apps/web/dist
cd apps/web && bun run dev               # Vite on :5173, proxies /api to :8787
```

Chromium needs its usual shared libraries plus SwiftShader for WebGL; the flags
used by the e2e run (`--use-gl=angle --use-angle=swiftshader
--disable-gpu-sandbox`) are what make the headless viewer render.

## 8. Next steps, in priority order

1. ~~**Fix width/depth accuracy**~~ — **done, 5 October.** The triangulation
   was already exact (§3a); the axis error was capture coverage. The worker now
   measures the orbit gap and the app labels partial sweeps. Raising view
   registration rate and densifying the cloud is now items 2–3's job, not a
   geometry fix.
2. ~~**Live coverage ring in the capture UI**~~ — **done, 5 October.**
   `apps/web/src/lib/orbit.ts` turns compass headings into the same gap verdict
   the worker reports, and the capture screen shows the widest unswept arc
   before the upload. It is a compass reading, not a reconstruction, and it says
   so; see §5. It does **not** judge whether individual photos are good; that
   is the per-photo review, built 6 October (§3e).
3. **Dense MVS** — **closed, 5 October, on evidence; re-tested 6 October on a
   complete-orbit capture and closed again.** Both candidate engines were
   installed and measured rather than argued about. COLMAP reconstructs this
   capture degenerately and cannot initialise it with stock thresholds, so its
   dense MVS has nothing sound to densify (§3b). Open3D's Poisson *does*
   densify our own good cloud and triples coverage — while placing 39% of the
   result in a direction the capture never saw (§3c). The 6 October re-test
   gave Poisson exactly the condition §3c asked for — a 24-view, complete-orbit
   capture — and it still manufactures 19.9 points of geometry in the unswept
   arc, because the solver registers only 10/24 of those views (§3f).
   Dense MVS stays closed; the measured lever that would change this verdict is
   the registration rate, not the densifier.
4. ~~**Baked texture atlas** with UV unwrapping, replacing vertex colours.~~
   **done, 6 October.** `pipeline/atlas.py` unwraps the surface into charts,
   packs them into one atlas and bakes the photographs in with a per-texel
   visibility test. Scored against the photographs themselves it cuts the
   median colour error **78.0%** and the tail **55.9%** versus per-vertex
   colour, and the e2e now requires the browser to actually *bind* the texture
   rather than trusting the manifest. See §3d. What it cost is stated there too:
   874 seams, and 26% of the covered atlas carrying colour no camera saw on a
   partial orbit.
5. **Accounts, per-user ownership and object storage** — **done, 7 October.**
   Passwords are scrypt hashes, sessions are HttpOnly cookies, every capture
   belongs to an account, and a share link is an explicit, revocable token
   rather than the capture id itself (§5, `apps/api/test/auth.test.js`,
   `apps/web/test/share.test.ts`, and four e2e steps). Storage followed the
   same day: `apps/api/src/storage.js` writes photographs as they are uploaded
   and `result.json`/`model.glb` before a capture is called `completed`, into
   local disk by default or into **Backblaze B2** once its keys are configured,
   with `GET /model.glb` falling back to the stored object (ADR 0006,
   `apps/api/test/storage.test.js`, 21 tests, no credentials needed).
   **What still needs the user:** the three B2 settings — `B2_KEY_ID`,
   `B2_APPLICATION_KEY`, `B2_BUCKET_NAME` — added in Settings → Environment.
   Until then the product behaves exactly as before and `/api/health` says so.
   The rest of the queue landed the same day: a finished run prunes its
   scratch directory and, once a durable store holds them, its raw photographs
   (`KEEP_LOCAL_COPIES` to opt out); `DELETE /api/auth/account` removes an
   account's captures, objects and sessions in one confirmed step; and a
   restart re-queues the captures its in-memory queue forgot.
   **Presigned uploads and the retention clock landed later the same day** (7
   October, §2): with B2 configured the photographs go straight to the bucket
   through short-lived URLs and the API re-reads every object before it queues a
   job, and `apps/api/src/retention.js` reaps abandoned uploads always and
   expired captures only when `CAPTURE_TTL_DAYS` is set above its default of
   `0`. Gate: `apps/api/test/direct-upload.test.js` (10),
   `apps/api/test/retention.test.js` (7), `apps/web/test/direct-upload.test.ts`
   (10) — all three wired into `verify.sh`. What remains open there is a
   **bucket-side lifecycle rule** and an SSE-C decision, both stated in §5.
6. **Raise the view-registration rate.** Sharply measured on 6 October (§3f),
   and the obvious fix is now ruled out: it is **not** the PnP inlier
   threshold. Lowering it registers 12/12 instead of 8/12 for a 2.6-point
   coverage loss, but shifts the reconstruction's radial distribution by 27%,
   and nothing measured says which shape is more correct. Of the remaining
   levers, two are now measured too (§3f, "The three levers"): ratio
   acceptance is **inert** (the holdouts' PnP attempts sit in the bad ratio
   band even when offered 45–70 pairs), and neighbor-ranked extension anchors
   win one view and better camera radii but cost 0.9 coverage points, so the
   shipped default stays. At 24 views (complete-orbit capture) the same
   instrument shows baseline at 10/24 registered, 74.2% of its own points on
   the true surface, cameras within 0.030 of the true radius — and
   neighbor-anchors registers *fewer* views there, so the anchor lever is not
   the fix at scale either. **The last two candidates — registration order
   and the seed pair's object coverage — were measured the same day and
   closed too** (§3f, "The order and seed levers"): graph-ranked order is
   inert at 12 views and gains no registrations at 24; seed coverage ties at
   12 and costs 26.4 coverage points at 24; both controls collapse. Five
   levers, none a winner; the shipped defaults stand. What is genuinely left
   is not a tuning knob but a new source of evidence for the PnP decision
   itself — the holdouts need pose consensus, not a different arrangement of
   the loop (§3f, "What would actually fix it").
7. **AR on a real phone.** The hit-test placement path has never executed; it
   needs a device before anything about it is called working.
8. **COLMAP comparison** — **done, 5 October.** Measured, not argued: see
   §3b and `tests/compare_colmap.py`. The decision stands, and now on evidence
   rather than on a blocked environment.

9. **Notebooks, Docker packaging, deployment guides** — **done, 6 October.**
   Executed where execution was possible and labelled where it was not: the
   notebooks run end-to-end and are honesty-checked (§3g), the Docker runtime
   contract is gated, and the one unexercised step — `docker build` itself — is
   named as such in the gate, the Dockerfile header, verify.sh and the guide.

The AR scale rule (no user resizing) is unaffected by all of the above, since
it depends only on the calibration record.

**What item 4 leaves open, now that it is built.** The atlas is a better
*container*, not more *content*: it still colours only the ~11% of the surface
the sparse cloud covers (§3), and it bakes the resolution of the photographs it
was given. Closing items 3 and 5 — a capture with a complete orbit, and enough
registered views to cover the object — is what would change those numbers. The
texture is now correct on the geometry that exists; the geometry is the
limiting factor, and nothing about the atlas pretends otherwise.