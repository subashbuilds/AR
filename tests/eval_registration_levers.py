"""Which registration lever actually moves the registration rate?

    python3 -m tests.eval_registration_levers [--fixture /tmp/fx2] [--views 12]

Context (docs/status.md 3f): 8 of 12 views register on the demo capture. The
four failures are good photographs -- 44-72 verified edge matches -- that the
solver cannot place. Relaxing `min_pnp_inliers` 30 -> 10 registers 12/12 but
shifts the cloud's radial distribution by 27%, so the threshold stays. Three
candidates remain, and this script measures each against the untouched
baseline in the SAME gauge frame:

  A. baseline            -- the pipeline's shipped configuration
  B. neighbor anchors    -- track extension matches against the views that are
                            actually similar to the newest view (graph-ranked)
                            instead of the first three by index, aiming to
                            grow the 2D-3D supply that later attempts draw on
  C. ratio acceptance    -- accept a PnP attempt whose inlier RATIO clears
                            0.55 (measured gap: registered 0.77-0.91,
                            unregistered 0.21-0.40), with an absolute floor
                            of 12 so a tiny-but-clean solution cannot carry
                            the whole reconstruction

The three above were measured on 6 October and closed (status.md 3f). This
script then gained the two levers that report left open, both default-inert
cfg keys in pipeline/incremental.py:

  D. seed-widest         -- seed_selection="widest": among the edges inside
                            the parallax band, take the largest triangulation
                            angle. On an orbit that is the seed pair's own
                            coverage of the object (the 3f open question).
  E. seed-narrowest      -- seed_selection="narrowest": smallest angle inside
                            the band. NEGATIVE CONTROL -- poor depth
                            conditioning should not beat the shipped rule.
  F. seed-wide-strong    -- seed_selection="wide-strong": widest angle among
                            edges holding >= seed_wide_strong_frac (0.5) of
                            the best in-band inlier count. Added after D
                            measured 2/12: pure width picked a feature-poor
                            edge (36 vs 117 inliers), so width is only
                            allowed to compete where support is comparable.
  G. order-graph         -- registration_order="graph": among the views that
                            pass the PnP gate each round, grow through the
                            one with the strongest verified view-graph edge
                            into the registered set instead of the most PnP
                            inliers (the 3f order question).

Every run is evaluated in ground truth's frame through gauge.py's one
defined transform, with the 3f wrong-gauge rule honoured: variants that seed
from the same pair as baseline share baseline's single (Q, b); a seed lever
changes the world's scale, so a different-seed run gets its own point_gauge
(depth-map scale, never fitted to the object). A variant whose reconstruction
ABORTS (a seed pair can do that) is reported as ABORTed in the table, not
dropped and not silently scored. Output is a table, then a verdict. This script REPORTS; it does
not pass or fail on behalf of a configuration, so it is an instrument, not a
gate: it exits 0 having printed numbers, and any adoption decision is made by
a human against the table (and, if adopted, encoded in a committed gate with
its own tolerance).
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sys

import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "services", "reconstruction-worker"))
sys.path.insert(0, HERE)

from pipeline import incremental as inc  # noqa: E402
import eval_densify  # noqa: E402
import gauge  # noqa: E402

SURFACE_TOLERANCE = 0.05  # metres; shared with eval_registration_rate.py
RATIO_MIN = 0.55          # between the measured populations' bands
RATIO_FLOOR = 12          # absolute minimum inliers regardless of ratio


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="/tmp/fx2")
    ap.add_argument("--views", type=int, default=12)
    ap.add_argument("--variants", default="all",
                    help="comma list from: baseline,neighbor-anchors,"
                         "ratio-acceptance,both,seed-widest,seed-narrowest,"
                         "seed-wide-strong,order-graph (baseline must come "
                         "first); 'all' runs every variant and takes ~4 min "
                         "at 12 views")
    ap.add_argument("--baseline-cache", default="",
                    help="JSON path. When set, a completed baseline run's "
                         "row + gauge are stored here and reused by later "
                         "lever-only runs (the pipeline is deterministic), "
                         "so a 24-view lever costs one reconstruction, not "
                         "two. Self-invalidates if incremental.py or "
                         "gauge.py changed since it was written.")
    args = ap.parse_args()

    base_views_proto, gt = eval_densify.build_views(args.fixture, args.views)
    n = args.views

    def _solver_fingerprint() -> str:
        h = hashlib.sha1()
        for p in (os.path.join(HERE, os.pardir, "services", "reconstruction-worker",
                               "pipeline", "incremental.py"),
                  os.path.join(HERE, "gauge.py")):
            with open(os.path.normpath(p), "rb") as fh:
                h.update(fh.read())
        return h.hexdigest()

    variants = [
        ("baseline", {}),
        ("neighbor-anchors", {"track_extension_anchors": "neighbors"}),
        ("ratio-acceptance", {"pnp_min_ratio": RATIO_MIN,
                              "pnp_ratio_floor": RATIO_FLOOR}),
        ("both", {"track_extension_anchors": "neighbors",
                  "pnp_min_ratio": RATIO_MIN,
                  "pnp_ratio_floor": RATIO_FLOOR}),
        ("seed-widest", {"seed_selection": "widest"}),
        ("seed-narrowest", {"seed_selection": "narrowest"}),
        ("seed-wide-strong", {"seed_selection": "wide-strong"}),
        ("order-graph", {"registration_order": "graph"}),
    ]
    if args.variants != "all":
        wanted = [s.strip() for s in args.variants.split(",")]
        known = {name for name, _ in variants}
        bad = [w for w in wanted if w not in known]
        if bad or not wanted:
            print(f"unknown --variants {bad}; choose from {sorted(known)}")
            return 2
        # A subset run has no baseline of its own unless requested, so the
        # gauge is taken from the FIRST requested variant and the table says
        # which run it came from. Never drop the baseline from a subset: the
        # gauge would silently become a lever's own frame (the 3f trap).
        variants = [v for v in variants if v[0] in wanted]

    fingerprint = _solver_fingerprint()
    cached = None
    if args.baseline_cache and os.path.exists(args.baseline_cache):
        with open(args.baseline_cache) as fh:
            cached = json.load(fh)
        if (cached.get("fingerprint") != fingerprint
                or cached.get("fixture") != os.path.abspath(args.fixture)
                or cached.get("views") != args.views):
            print("  (baseline cache is stale: solver/gauge/fixture/views "
                  "changed -- recomputing)", file=sys.stderr)
            cached = None
    if variants[0][0] != "baseline" and cached is None:
        print("the first requested variant must be baseline so the gauge "
              "is not fitted to a lever's frame (or provide a valid "
              "--baseline-cache)")
        return 2
    # A cache hit means baseline's numbers are already known; don't pay for
    # a second deterministic reconstruction of it.
    run_variants = [v for v in variants
                    if not (v[0] == "baseline" and cached is not None)]
    baseline_ran = any(v[0] == "baseline" for v in run_variants)
    if cached is not None and variants[0][0] != "baseline":
        # Keep baseline the first row (and the gauge source) in the table.
        variants = [("baseline", {})] + variants

    runs = {}
    probes = {}
    aborted: dict[str, str] = {}
    for name, cfg_delta in run_variants:
        views = copy.deepcopy(base_views_proto)
        cfg = dict(cfg_delta)
        cfg["_attempt_probe"] = probes.setdefault(name, [])
        try:
            res = inc.reconstruct(views, cfg)
        except RuntimeError as exc:
            # A bad seed can abort before any PnP round. That is a RESULT for
            # the table, not a reason to drop the variant.
            aborted[name] = str(exc)
            runs[name] = (views, None, gt)
            print(f"  [{name}] ABORTED: {exc}", file=sys.stderr)
            continue
        runs[name] = (views, res, gt)
        print(f"  [{name}] {len(res.registered_indices)}/{n} "
              "views registered", file=sys.stderr)

    base_seeds: tuple
    if cached is not None:
        # Baseline comes from the cache: same deterministic numbers, same
        # gauge, no second reconstruction.
        base_seeds = tuple(cached["seeds"])
        Q = np.asarray(cached["Q"], dtype=float)
        b = np.asarray(cached["b"], dtype=float)
        ref_med = float(cached["ref_med"])
        print(f"  (baseline row+gauge loaded from {args.baseline_cache})",
              file=sys.stderr)
    else:
        base_views, base_res, _gt = runs["baseline"]
        if base_res is None:
            print(f"baseline aborted ({aborted['baseline']}); no gauge, "
                  "nothing to compare against")
            return 2
        Q, b, _scale = gauge.point_gauge(base_res, base_views, args.fixture, gt)
        base_seeds = tuple(base_res.seed_indices)
        ref = gauge.apply(np.asarray(base_res.points), Q, b)
        ref_med = float(np.median(np.linalg.norm(ref - ref.mean(axis=0), axis=1)))
    V_gt, _, _ = __import__("make_fixture").build_object_mesh("blob")
    tree = cKDTree(V_gt)

    print(f"\nall variants in the SAME ground-truth frame")
    print("  gauge rule: a variant that seeds from the SAME pair as baseline")
    print("  is mapped through baseline's single (Q, b) -- the 3f")
    print("  wrong-gauge rule. A seed lever changes the world's scale (the")
    print("  seed baseline IS the unit), so a different-seed run cannot live in")
    print("  baseline's frame; those rows get their own point_gauge -- the one")
    print("  defined transform in gauge.py, whose scale comes from the depth")
    print("  maps, not from the object. scale = that depth scale (1.000 means")
    print("  it could not be measured: no 3-view track, i.e. <3 cameras).")
    print("  coverage = fraction of the run's OWN points that land within 5 cm"
          " of the true")
    print("  surface -- the §3 headline metric. eval_densify measures the"
          " opposite direction")
    print("  (fraction of the true surface the cloud reaches); the two numbers"
          " are not")
    print("  comparable.")
    print(f"  {'variant':<18} {'reg':>6} {'points':>7} {'coverage':>9} "
          f"{'reproj px':>10} {'radial':>7} {'cam |r-7| med':>13} "
          f"{'cam r spread':>12} {'scale':>7}  gauge")
    rows = []
    for name, _delta in variants:
        if name == "baseline" and cached is not None:
            row = tuple(cached["row"])
            rows.append(row)
            print(f"  {'baseline (cached)':<18} {row[1]:>3}/{n} {row[2]:>7} "
                  f"{row[3]:>8.1f}% {row[4]:>10.3f} {row[5]:>6.3f}x "
                  f"{row[6]:>12.3f} {row[7]:>11.2f}x {row[8]:>7.3f}  "
                  f"cached")
            continue
        views_r, res, _g = runs[name]
        if res is None:
            rows.append(None)
            print(f"  {name:<18} {'ABORT':>6}  {aborted[name]}")
            continue
        if tuple(res.seed_indices) == base_seeds:
            Qv, bv, sv = Q, b, None
            gauge_tag = "shared"
        else:
            Qv, bv, sv = gauge.point_gauge(res, views_r, args.fixture, gt)
            gauge_tag = "own (different seed)"
        pts = gauge.apply(np.asarray(res.points), Qv, bv)
        cov = float((tree.query(pts)[0] < SURFACE_TOLERANCE).mean()) * 100.0
        shift = float(np.median(np.linalg.norm(pts - pts.mean(axis=0), axis=1))
                      / ref_med)
        err = res.mean_reprojection_error
        # The fixture's cameras all sit at radius 7.0 and the gauge maps into
        # the ground-truth frame, so camera-centre radius error is a direct
        # correctness check on which shape is right -- the question the 27%
        # radial shift in 3f could not answer.
        centres = np.array([views_r[i].center for i in
                            res.registered_indices])
        centres = gauge.apply(centres, Qv, bv)
        radii = np.linalg.norm(centres, axis=1)
        cam_err = float(np.median(np.abs(radii - 7.0)))
        cam_spread = float(radii.max() / max(radii.min(), 1e-9))
        if sv is None:
            _, _s0, sv = gauge.point_gauge(res, views_r, args.fixture, gt)
        rows.append((name, len(res.registered_indices), len(pts), cov, err,
                     shift, cam_err, cam_spread, sv))
        print(f"  {name:<18} {rows[-1][1]:>3}/{n} {len(pts):>7} "
              f"{cov:>8.1f}% {err:>10.3f} {shift:>6.3f}x "
              f"{cam_err:>12.3f} {cam_spread:>11.2f}x {sv:>7.3f}  "
              f"{gauge_tag}")

    # ---- diagnostics: what did the never-registered views get offered? -----
    print("\nattempt probe (default-off hook): attempts that FAILED the PnP "
          "gate, per variant")
    print(f"  {'variant':<18} {'n_fail':>6} {'offered p50':>11} "
          f"{'offered max':>12} {'best inl':>9}")
    for name, _delta in variants:
        if name == "baseline" and cached is not None:
            rows_f = cached.get("probes") or []
            reg = set(cached.get("registered") or [])
        elif runs[name][1] is None:
            print(f"  {name:<18} (aborted before any attempt)")
            continue
        else:
            rows_f = probes.get(name) or []
            reg = set(runs[name][1].registered_indices)
        never = [r for r in rows_f if r["view"] not in reg]
        if not never:
            print(f"  {name:<18} {len(rows_f):>6} (no failed attempt for a "
                  "never-registered view)")
            continue
        offered = sorted(r["offered"] for r in never)
        best_inl = max(r["inliers"] for r in never)
        p50 = offered[len(offered) // 2]
        print(f"  {name:<18} {len(never):>6} {p50:>11} {offered[-1]:>12} "
              f"{best_inl:>9}")

    # ---- verdict, decided by the table --------------------------------------
    base_row = rows[0]
    print("\nVERDICT: read the table. A lever earns adoption only if it raises")
    print("the registration count WITHOUT costing surface coverage, WITHOUT")
    print("moving the radial distribution, and WITHOUT degrading camera-radius")
    print("accuracy against the fixture's true 7.0 -- the ground truth the 27%")
    print("shift in 3f could not be judged against. seed-narrowest is a negative")
    print("control: if it WINS, the gauge or the fixture is wrong, not the")
    print("shipped default. This script reports; it does not adopt.")
    print(f"RESULT: baseline {base_row[1]}/{n} at {base_row[3]:.1f}% coverage, "
          f"cameras at |r-7| median {base_row[6]:.3f}")

    if args.baseline_cache and baseline_ran:
        brow = next((r for r in rows if r and r[0] == "baseline"), None)
        if brow is not None:
            payload = {
                "fingerprint": fingerprint,
                "fixture": os.path.abspath(args.fixture),
                "views": args.views,
                "row": list(brow),
                "Q": np.asarray(Q).tolist(),
                "b": np.asarray(b).tolist(),
                "ref_med": ref_med,
                "seeds": list(base_seeds),
                "registered": list(runs["baseline"][1].registered_indices),
                "probes": probes.get("baseline", []),
            }
            with open(args.baseline_cache, "w") as fh:
                json.dump(payload, fh)
            print(f"baseline row+gauge cached in {args.baseline_cache}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
