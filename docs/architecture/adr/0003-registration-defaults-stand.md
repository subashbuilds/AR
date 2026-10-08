# 0003 · Registration defaults stand after five levers were measured

Status: **closed on evidence** (6 October)

## Context

Only 8 of 12 views register on the demo capture (10 of 24 at full orbit),
and §3e shows the four failures are good photographs. That looks like a
tuning problem, so candidates were A/B-measured against ground truth in one
gauge (`tests/eval_registration_levers.py`, instrument — prints a table,
exits 0, adopts nothing). The adoption rule: **a lever wins only if it wins
on every axis** — registered count up, surface coverage not down, radial
distribution not moved, camera radius |r−7| not degraded.

## Decision

Every shipped default stays:

| Lever | Measured outcome |
|---|---|
| `min_pnp_inliers: 30` | Lowering it reaches 12/12 for −2.6 coverage points and a **27% radial shift** with no evidence which shape is right — rejected (§3f) |
| Ratio acceptance (`pnp_min_ratio`) | **Inert**: holdouts sit in the bad 0.21–0.40 ratio band; run bit-identical to baseline — ships default-off |
| Neighbor extension anchors (`track_extension_anchors`) | +1 camera, cameras closer to true radius (0.014 vs 0.019), but −0.9 coverage at 12 views and *fewer* registrations at 24 — stays `first3` |
| Registration order (`registration_order`) | Bit-identical at 12 views; at 24 views marginally better quality axes but the **same 10/24** — tie on the axis it exists to move, rejected |
| Seed-pair coverage (`seed_selection`) | Widest and narrowest in-band seeds collapse to 2/12; the middle course ties at 12 views and costs **26.4 coverage points** at 24 — rejected |

## Consequences

- The knobs ship **default-inert** in `pipeline/incremental.py`
  (`pnp_min_ratio`/`pnp_ratio_floor`, `track_extension_anchors`,
  `registration_order`, `seed_selection`, `seed_wide_strong_frac`, plus the
  default-off `_attempt_probe`), each behind a pure unit-tested helper, so
  the next candidate needs no loop surgery.
- What the attempt probe *did* show: holdouts are offered 45–76 2D–3D pairs
  every round and best out at 19–28 inliers. The missing quantity is **pose
  consensus**, not supply, order or seeding — a winning candidate must add
  evidence to the PnP decision itself, not rearrange the loop (§3f,
  "What would actually fix it").
- Until such a candidate is built and measured, 8/12 and 10/24 are the
  measured state of the art here, and ADR 0001's verdict (no dense MVS)
  stands on their authority.
