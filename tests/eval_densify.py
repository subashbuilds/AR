"""Would densifying our own sparse cloud help, or invent geometry we never saw?

    python3 -m tests.eval_densify [--fixture /tmp/fx2] [--views 12] [--depth 8]

The question
------------
`docs/status.md` §3 shows the reconstruction is *accurate* (78.6% of its points
land within 5 cm of the true surface) but sparse -- only ~11.4% of the true
surface has any point near it, and the worst axis reads 66% small. Densification
is the obvious remedy, so this measures whether it actually helps before any of
it is wired into the pipeline.

Why this is not a free win
--------------------------
Poisson reconstruction always returns a watertight surface: it closes the hull
of whatever points it is given. On a capture with a hole in its orbit that is a
liability rather than a feature. It will happily bridge across the direction
that was never photographed and produce a model that *looks* complete. That
would be the exact failure this product exists to avoid -- a confident, smooth,
wrong object -- so this script measures that specific effect, not just density.

The measurement is deliberately like-for-like
---------------------------------------------
The baseline coverage number (11.4% at 12 views) comes from
`tests/eval_accuracy.py`, so this script rebuilds THAT module's
gauge-determined point alignment rather than inventing a second, subtly
different one. Getting this wrong is not hypothetical: the first version of
this file fitted a similarity over camera centres and reported 0.0% coverage
for the very cloud `eval_accuracy` measures at 11.4%. See the long comment
above the alignment block.

Requires: `open3d` (pip), plus this repository's requirements.txt.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "services", "reconstruction-worker"))
sys.path.insert(0, HERE)

from pipeline import features as feat, incremental as inc  # noqa: E402
from pipeline import coverage as covmod  # noqa: E402
import gauge  # noqa: E402
import make_fixture as mf  # noqa: E402

COVERAGE_RADIUS = 0.05  # metres; the same threshold eval_accuracy uses


def build_views(fixture, n_views):
    gt = json.load(open(os.path.join(fixture, "ground_truth.json")))
    K_gt = gt["intrinsics"]
    gt_by_name = {v["name"]: v for v in gt["views"]}
    img_dir = os.path.join(fixture, "images")
    names = sorted(n for n in os.listdir(img_dir) if n.endswith(".jpg"))
    names = [n for n in names if n in gt_by_name][:n_views]

    from PIL import Image

    views = []
    for i, n in enumerate(names):
        arr = np.asarray(Image.open(os.path.join(img_dir, n)).convert("RGB"))
        fs = feat.detect_and_describe(arr, n, nfeatures=4000, contrast_threshold=0.01)
        # TRUE intrinsics, exactly as eval_accuracy does: this experiment is
        # about densification, not about estimating a focal length.
        cam = inc.Camera(K_gt["width"], K_gt["height"], K_gt["fx"], K_gt["fy"],
                         K_gt["cx"], K_gt["cy"])
        views.append(inc.View(index=i, image_name=n, camera=cam,
                              keypoints=fs.keypoints.astype(np.float64),
                              descriptors=fs.descriptors,
                              sizes=fs.sizes, angles=fs.angles))
    return views, gt_by_name


def coverage_of(reference, samples):
    """Fraction of the true surface within COVERAGE_RADIUS of `samples`."""
    if len(samples) == 0:
        return 0.0
    d = cKDTree(np.asarray(samples)).query(reference)[0]
    return float((d < COVERAGE_RADIUS).mean())


def unswept_fraction(points, gap_centre_deg, gap_half_deg):
    """Share of `points` lying in the orbit arc that was never photographed.

    Directions are measured from the reconstruction's own centroid, so this is
    gauge-invariant: both the sparse cloud and the densified mesh are compared
    in the same frame, and no similarity needs solving.
    """
    p = np.asarray(points)
    centre = p.mean(axis=0)
    rel = p - centre
    az = np.degrees(np.arctan2(rel[:, 2], rel[:, 0])) % 360.0
    delta = np.abs((az - gap_centre_deg + 180.0) % 360.0 - 180.0)
    return float((delta <= gap_half_deg).mean())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="/tmp/fx2")
    ap.add_argument("--views", type=int, default=12)
    ap.add_argument("--depth", type=int, default=8, help="Poisson octree depth")
    args = ap.parse_args()

    try:
        import open3d as o3d
    except ImportError as exc:
        print(f"open3d is required: {exc}", file=sys.stderr)
        return 2

    views, gt_by_name = build_views(args.fixture, args.views)
    res = inc.reconstruct(views)
    reg = sorted(res.registered_indices)
    if len(reg) < 2:
        print("too few registered views to evaluate")
        return 2

    # ---- gauge-determined alignment --------------------------------------
    # This is the part that is easy to get wrong, and this script got it wrong
    # first time: it used the Umeyama similarity fitted over camera centres --
    # the transform eval_accuracy uses for POSES, deliberately, to isolate pose
    # error from shape error -- and applied it to points. It reported 0.0%
    # coverage for the baseline cloud that eval_accuracy measures at 11.4%.
    #
    # The transform it must use now lives in exactly one place, `tests/gauge.py`,
    # shared with eval_texture.py, so a third divergent copy cannot appear.
    # Nothing in it is fitted to the object, so a stretched or collapsed cloud
    # cannot hide behind the alignment.
    Q, b, _scale = gauge.point_gauge(res, views, args.fixture, gt_by_name)
    pts = gauge.apply(np.asarray(res.points), Q, b)

    cap = covmod.estimate([views[i].center for i in reg], point_count=len(pts))
    V_gt, _, _ = mf.build_object_mesh("blob")

    # Locate the unswept arc from the RECONSTRUCTED cameras, in the SAME frame
    # the points live in, so one arc is tested for both clouds. This comparison
    # is gauge-invariant: both clouds are measured in one frame, so no
    # similarity needs solving.
    centres = np.array([views[i].center for i in reg]) @ Q.T + b
    c_rel = centres - centres.mean(axis=0)
    c_az = np.sort(np.degrees(np.arctan2(c_rel[:, 2], c_rel[:, 0])) % 360.0)
    if len(c_az) > 1:
        gaps = np.diff(c_az)
        wrap = (c_az[0] + 360.0) - c_az[-1]
        k = int(np.argmax(np.append(gaps, wrap)))
        end = c_az[k] if k < len(gaps) else c_az[-1]
        start = c_az[k + 1] if k < len(gaps) else c_az[0]
        span = (wrap if k == len(gaps) else gaps[k])
        gap_centre = (end + span / 2.0) % 360.0
    else:
        gap_centre, span = 0.0, 360.0

    base_cov = coverage_of(V_gt, pts)
    base_unswept = unswept_fraction(pts, gap_centre, span / 2.0)

    print(f"registered views     {len(reg)}/{args.views}")
    print(f"orbit gap            {cap.max_gap_deg:.1f} deg ({'FULL' if cap.full_orbit else 'PARTIAL'})")
    print()
    print("sparse cloud (what the pipeline ships today)")
    print(f"  points             {len(pts)}")
    print(f"  surface coverage   {base_cov * 100:.1f}%  of the true surface within 5 cm")
    print(f"  in unswept arc     {base_unswept * 100:.1f}%")

    # ---- densify ---------------------------------------------------------
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.asarray(pts))
    pcd.estimate_normals()
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd, depth=args.depth)
    o3d.utility.random.seed(42)
    dense = mesh.sample_points_uniformly(number_of_points=200_000)
    dense_pts = np.asarray(dense.points)

    dens_cov = coverage_of(V_gt, dense_pts)
    dens_unswept = unswept_fraction(dense_pts, gap_centre, span / 2.0)

    print()
    print(f"Poisson-densified (open3d, depth {args.depth})")
    print(f"  mesh vertices      {len(np.asarray(mesh.vertices))}")
    print(f"  surface coverage   {dens_cov * 100:.1f}%  ({dens_cov - base_cov:+.1f} vs sparse)")
    print(f"  in unswept arc     {dens_unswept * 100:.1f}%  ({dens_unswept - base_unswept:+.1f} vs sparse)")

    # ---- verdict ---------------------------------------------------------
    print()
    print("Densification is worth integrating only if it improves coverage AND does")
    print("not manufacture geometry in a direction that was never photographed.")
    invented = dens_unswept - base_unswept
    if dens_cov > base_cov * 1.05 and invented > 0.10:
        print(f"RESULT: FAIL -- coverage rose {(dens_cov - base_cov) * 100:+.1f} points but "
              f"{invented * 100:.1f} of it")
        print("was placed in the unswept arc. Poisson closed the hull across a")
        print("direction the capture never saw, which is a confident wrong model.")
        return 1
    if dens_cov > base_cov * 1.05:
        print("RESULT: PASS -- coverage improved without inflating the unswept arc.")
        return 0
    print("RESULT: FAIL -- densification did not measurably improve surface coverage.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
