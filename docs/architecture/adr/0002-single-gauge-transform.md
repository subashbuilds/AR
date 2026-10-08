# 0002 · One gauge transform, and the wrong-gauge rule

Status: **accepted**

## Context

A reconstruction is defined only up to a similarity (origin, orientation,
scale). Comparing one to the ground-truth fixture therefore requires a
transform into the fixture's frame — and getting that wrong has produced
wrong verdicts in this repository **four times**: a coverage number collapsed
from 78.6% to 39.5% because each run was aligned through *its own* fitted
similarity (§3f), `eval_densify.py` once applied a pose-fitted transform to
points and reported 0.0% coverage for a cloud another gate measured at
11.4% (§3c), and — in the other direction — a sound run once measured 0.0%
because it was mapped through a *different seed pair's* frame (§3f, order
and seed levers).

## Decision

There is exactly one place that computes the reconstruction→ground-truth
transform: `tests/gauge.py`.

- **POINTS**: `X_true = s·(Q·X_rec) + b`, where `Q` comes from camera poses,
  `s` from the fixtures' exact per-pixel **depth maps** (median true/reconstructed
  camera-space z over ≥3-view tracks), `b` a median translation. Nothing is
  fitted to the object's points, so a collapsed or stretched cloud cannot
  hide behind the alignment.
- **POSES**: `eval_accuracy.py` keeps its own rotation-only maths on
  purpose — it isolates pose error from shape error, and the two are not
  interchangeable.
- **The rule** (§3f): runs that **share a seed** share ONE gauge — take it
  from the baseline once and apply it to every variant. Runs that do **not**
  share a seed *cannot* share a frame (the seed baseline is the world's
  unit), so they are gauged through their own `point_gauge`, labelled as
  such, with the depth scale shown next to the row. A per-run similarity
  **fitted to points** is never used to compare runs.

## Consequences

- `eval_registration_levers.py` prints the gauge source per row (`shared`,
  `own`, `cached`) and a `scale` column; a scale of `1.000` means the depth
  scale could not be measured (no ≥3-view track) and the shape columns for
  that row are not a verdict.
- Any new evaluation script must import `gauge.py` rather than re-deriving
  an alignment; if a script needs a *different* transform (poses vs points),
  that difference must be stated in its docstring like `gauge.py`'s.
- Absolute coverage numbers are only trustworthy beside a statement of the
  frame they were measured in — every table in `docs/status.md` says which.
