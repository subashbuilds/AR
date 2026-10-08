# 0001 · Sparse incremental SfM; dense MVS stays closed

Status: **closed on evidence** (5 October, re-tested 6 October)

## Context

The pipeline builds a sparse structure-from-motion cloud and a Poisson
surface from it. Coverage of the true surface is low (~12% at 24 views), so
densification was the obvious candidate: two engines were installed and
*measured* rather than argued about.

## Decision

Dense MVS is not part of the product. The binding constraint is the
**registration rate of the view set**, not the densifier.

Evidence (all in `docs/status.md`, commands in §7):

- **COLMAP** (§3b, `tests/compare_colmap.py`): reconstructs this capture
  degenerately and cannot initialise it with stock thresholds, so its dense
  MVS has nothing sound to densify. Stock thresholds' camera-radius spread on
  the fixture is 3.78× vs this repo's 1.01×.
- **Open3D Poisson** (§3c, `tests/eval_densify.py`): *does* densify our own
  good cloud and triples surface coverage — while placing 39% of the result
  in a direction the capture never saw.
- **Complete-orbit re-test** (§3c): given the exact condition §3c asked for —
  a 24-view, 360° capture — Poisson still manufactures 19.9 points of
  geometry in the unswept arc, because the solver registers only 10/24 of
  those views. `eval_densify.py --views 24` exits 1 by design on this
  fixture: the experiment's own verdict.

## Consequences

- Surface coverage stays what the sparse cloud gives it; the product reports
  coverage honestly (model page, capture ring, notebook report) instead of
  hiding it behind invented geometry.
- Raising the registration rate is the lever that would reopen this
  decision — see ADR 0003 for how far the measured levers got
  (8/12 and 10/24 stand).
- `tests/eval_densify.py` and `tests/compare_colmap.py` remain committed
  gates that are **not** wired into `verify.sh` (they need `open3d`/`colmap`,
  which CI does not have); §7 documents running them by hand.
