# The reconstruction pipeline

`services/reconstruction-worker/` turns a directory of photographs into a
validated, textured GLB — or into a **named failure stage** and no model
(ADR 0004). This file describes the stages, the knobs, and where each claim
is gated. The evidence record for every number is `docs/status.md`.

## Stages

| Stage | What happens | Honest limit |
|---|---|---|
| `validate_input` | ≥2 images, consistent resolution, sane formats | image count hard-capped by the API |
| `feature` | SIFT per view (OpenCV), ratio-tested matching, verified view graph | needs distinctive texture; a rejected hand-written descriptor is kept benchmarked and kept worse (`tests/benchmark_descriptor.py`) |
| `sfm` | seed pair (parallax band 3–90°, most inliers inside it) → cheiral triangulation → PnP registration rounds → bundle adjustment → re-triangulation | **8/12 views** on the fixture (10/24 at full orbit); the failures lack pose consensus, not correspondences (§3f) |
| `filter` | reprojection, track-length and parallax filters | filters can only remove, never invent |
| `review` | per-photo verdicts: ok / weak / unusable with reasons | never compares what it cannot compare (§3e) |
| `surface` | Poisson-style surface from the sparse cloud | coverage measured, not assumed; ~12.5% of the true surface at 24 views before densification decisions (§3c) |
| `texture` | UV charts → single atlas → per-texel visibility bake | median colour error **12.24 vs 55.66** for vertex colours (−78.0%); seams and unseen texels reported (§3d) |
| `calibrate` | one user measurement fixes scale on that axis | without one: `units: "uncalibrated"` — never invented |
| `export_glb` | writer emits the GLB + manifest | — |
| `validate_output` | **independent** validator re-parses the GLB: container, accessors, index ranges, finiteness, plausible metres, texture decode | the writer is not trusted; a failed validation fails the job |

Relative stage weights live in `apps/api/src/worker.js` (`STAGE_WEIGHTS`);
they are static guesses and the UI labels derived percentages as estimates.

## Configuration knobs (`pipeline/incremental.py`)

All shipped defaults are the measured winners; every alternative below is
default-inert and unit-tested, kept so the next candidate can be A/B'd
without touching the loop (ADR 0003):

| Key | Default | Measured alternative |
|---|---|---|
| `min_pnp_inliers` | 30 | lowering registers more views but shifts the radial distribution 27% — rejected |
| `pnp_min_ratio`, `pnp_ratio_floor` | 0 (off) | ratio acceptance: inert on the fixture |
| `track_extension_anchors` | `first3` | `neighbors`: +1 camera, −0.9 coverage |
| `anchor_match_budget` | 0 (unlimited) | caps extension matching cost |
| `registration_order` | `inliers` | `graph`: no registrations gained at 12 or 24 views |
| `seed_selection` | `parallax` | `widest`/`narrowest` collapse to 2/12; `wide-strong` ties at 12, −26.4 coverage at 24 |
| `seed_min/max_parallax_deg` | 3 / 90 | outside the band two-view triangulation loses its cheiral solution (0/492 at 148°) |
| `bundle_adjust`, `retriangulate` | true | re-triangulation only accepts a replacement that explains its own observations better |

## Verification map

| Claim | Gate / instrument |
|---|---|
| Unit behaviour of every stage | `python3 -m pytest tests/test_pipeline.py` (73 tests) |
| Pose/triangulation exactness vs ground truth | `tests/recoverpose_contract.py`, `tests/test_triangulation.py` |
| Multi-view accuracy | `tests/test_sfm_multiview.py --views 8` |
| Whole pipeline to a validated GLB | `tests/test_end_to_end.py` |
| Texture atlas earns its place | `python3 -m tests.eval_texture` |
| Per-photo review catches damage | `python3 tests/eval_view_quality.py` |
| Registration levers vs ground truth | `python3 -m tests.eval_registration_levers` (instrument, reports only) |
| Known-bad comparisons kept honest | `tests/benchmark_sift.py` (single pair FAILs **by design**), `tests/eval_densify.py` (exits 1 on this fixture **by design**) |

`sh scripts/verify.sh` runs the fast subset; §7 of `docs/status.md` lists
every command, its runtime, and which ones are deliberately not wired in.

## What the pipeline will not do

- Emit a model when a stage failed, or retry a failure into success.
- Invent the unphotographed side (dense MVS closed on evidence, ADR 0001).
- Invent metres without a user measurement.
- Claim registration or coverage numbers it did not measure — the manifest
  reports registered views, orbit gap, atlas statistics and per-photo
  verdicts as they are, good or bad.
