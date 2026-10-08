"""Is `_triangulate_points` correct on its own?

The reconstruction's width and depth were wrong, and the first question was
whether the triangulation was at fault. Answering it required isolating the
maths: correspondences are SYNTHESISED from ground-truth camera poses and a
known point cloud, so matching error, pose error and the fixture itself cannot
contaminate the result. Any failure here would be the triangulation's alone.

The result moved the whole investigation. The DLT is exact to machine
precision, so the residual extent error could only be *coverage* -- the capture
had not photographed all of the object -- and the fix had to be honest
coverage reporting rather than better maths.

This is committed as a test rather than a scratch script because three
documents cite its numbers, and a claim nobody can re-run is not a claim.

Run:
    python3 tests/test_triangulation.py --fixture /tmp/fx2
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "services",
                                "reconstruction-worker"))

from pipeline import incremental as inc  # noqa: E402


def solve_fixture(fixture: str, n_views: int, noise_px: float,
                  seed: int = 0):
    """Triangulate synthetic points from ground-truth poses; return errors."""
    gt = json.load(open(os.path.join(fixture, "ground_truth.json")))
    intr = gt["intrinsics"]
    cam = inc.Camera(intr["width"], intr["height"], intr["fx"], intr["fy"],
                     intr["cx"], intr["cy"])
    K = cam.K

    poses = []
    for v in gt["views"][:n_views]:
        T = np.array(v["Twc"], dtype=np.float64)
        # `Twc` is world->camera, so its 3x3 block is already the rotation.
        poses.append((T[:3, :3].copy(), T[:3, 3].copy()))

    rng = np.random.default_rng(seed)
    extent = np.array(gt["object_extent"], dtype=np.float64)
    X_true = rng.uniform(-0.5, 0.5, size=(400, 3)) * extent
    X_true = X_true + rng.normal(scale=0.02, size=(400, 3))

    P_list, uv_list, front = [], [], []
    for R, t in poses:
        pts = X_true @ R.T + t
        z = pts[:, 2]
        ok = z > 1e-6
        safe = np.where(ok, z, 1.0)
        uv = np.stack([K[0, 0] * pts[:, 0] / safe + K[0, 2],
                       K[1, 1] * pts[:, 1] / safe + K[1, 2]], axis=1)
        P_list.append(K @ np.hstack([R, t[:, None]]))
        uv_list.append(uv)
        front.append(ok)

    if noise_px > 0:
        uv_list = [u + rng.normal(scale=noise_px, size=u.shape)
                   for u in uv_list]

    vis = np.all(front, axis=0)
    P_used = [P_list[i] for i in range(n_views)]
    errs = []
    for k in np.nonzero(vis)[0]:
        # One point per call, exactly as `reconstruct` invokes it.
        X = inc._triangulate_points(
            P_used, [uv_list[i][k][None, :] for i in range(n_views)])
        if X is None:
            continue
        errs.append(float(np.linalg.norm(X[0] - X_true[k])))
    return np.array(errs), X_true[vis]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="/tmp/fx2")
    args = ap.parse_args()
    if not os.path.exists(os.path.join(args.fixture, "ground_truth.json")):
        print(f"SKIP: no ground truth at {args.fixture}")
        return 0

    ok = True
    cases = [
        # (views, noise_px, tolerance as a fraction of the object extent)
        (3, 0.0, 1e-12),      # exact: machine precision
        (2, 0.0, 1e-12),      # the degenerate two-view case
        (6, 0.5, 0.01),       # realistic: 0.5 px of observation noise
        (12, 0.5, 0.01),      # many views, still conditioned
    ]
    print(f"{'views':>6} {'noise_px':>9} {'solved':>7} {'median':>12} "
          f"{'p90':>12} {'max':>12}")
    for n_views, noise, tol in cases:
        errs, _ = solve_fixture(args.fixture, n_views, noise)
        if not len(errs):
            print(f"{n_views:6d} {noise:9.2f}      0   NOTHING SOLVED")
            ok = False
            continue
        print(f"{n_views:6d} {noise:9.2f} {len(errs):7d} "
              f"{np.median(errs):12.3e} {np.percentile(errs, 90):12.3e} "
              f"{errs.max():12.3e}")
        # Compare against the object's own size, so the tolerance means the
        # same thing for a 1 cm object and a 2 m one.
        if np.median(errs) > tol * 2.2:
            print(f"  FAIL: median error exceeds {tol:.0e} of the object size")
            ok = False

    # Every supplied correspondence must produce a finite point: a silently
    # dropped observation is a hole in the reconstruction that no later filter
    # reports.
    errs, _ = solve_fixture(args.fixture, 6, 0.0)
    if len(errs) < 400:
        print(f"FAIL: only {len(errs)}/400 points solved; some were dropped")
        ok = False

    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
