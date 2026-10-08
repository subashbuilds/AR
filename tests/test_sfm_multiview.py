"""Multi-view SfM validation against ground truth.

Runs the full incremental reconstruction on a set of fixture views and checks:
  * how many cameras registered (ground truth: all supplied views are valid);
  * pose error of each recovered camera, after aligning the reconstruction's
    arbitrary world frame to the ground-truth frame with a similarity;
  * point-cloud accuracy against the ground-truth surface.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "services", "reconstruction-worker"))

import make_fixture as mf  # noqa: E402
from pipeline import features as feat  # noqa: E402
from pipeline.incremental import Camera, View, reconstruct  # noqa: E402


def umeyama_alignment(src: np.ndarray, dst: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Least-squares similarity transform mapping src onto dst.

    Returns (R, t, scale) such that dst ~= scale * R @ src + t. SfM output is
    defined only up to a similarity, so this is required to compare against
    ground-truth metric coordinates.
    """
    mu_s = src.mean(axis=0)
    mu_d = dst.mean(axis=0)
    s0 = src - mu_s
    d0 = dst - mu_d
    cov = d0.T @ s0 / len(src)
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1
    R = U @ S @ Vt
    var_s = (s0 ** 2).sum() / len(src)
    scale = float((D * np.diag(S)).sum() / max(var_s, 1e-12))
    t = mu_d - scale * R @ mu_s
    return R, t, scale


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="/tmp/fx2")
    ap.add_argument("--views", type=int, default=8)
    ap.add_argument("--max-reproj", type=float, default=3.0)
    args = ap.parse_args()

    gt = json.load(open(os.path.join(args.fixture, "ground_truth.json")))
    intr = gt["intrinsics"]
    cam = Camera.from_hfov(intr["width"], intr["height"],
                           hfov_deg=2 * np.degrees(np.arctan(
                               intr["width"] / 2.0 / intr["fx"])))

    names = [v["name"] for v in gt["views"]][: args.views]
    print(f"loading {len(names)} views from {args.fixture}")

    t0 = time.time()
    views: list[View] = []
    for idx, nm in enumerate(names):
        img = np.asarray(Image.open(os.path.join(args.fixture, "images", nm))
                         .convert("RGB"))
        fs = feat.detect_and_describe(img, nm, nfeatures=4000,
                                      contrast_threshold=0.01)
        views.append(View(index=idx, image_name=nm, camera=cam,
                          keypoints=fs.keypoints.astype(np.float64),
                          descriptors=fs.descriptors,
                          sizes=fs.sizes, angles=fs.angles))
        print(f"  {nm}: {len(fs)} keypoints")
    t_feat = time.time() - t0
    print(f"feature time: {t_feat:.1f}s")

    t0 = time.time()
    try:
        result = reconstruct(views)
    except RuntimeError as e:
        print(f"SfM FAILED: {e}")
        return 1
    t_sfm = time.time() - t0
    print(f"SfM time: {t_sfm:.1f}s")
    print(f"registered: {len(result.registered_indices)}/{len(views)}")
    print(f"points: {len(result.points)}")
    print(f"mean reproj error: {result.mean_reprojection_error:.4f} px")
    print(f"median track length: {result.median_track_length:.1f}")
    print(f"bundle adjusted: {result.bundle_adjusted}")

    if len(result.points) < 50:
        print("TOO FEW POINTS")
        return 1

    # ---- pose accuracy after similarity alignment ----
    reg = result.registered_indices
    # Build matched camera-centre correspondences using view index pairing.
    src = np.array([views[vi].center for vi in reg])
    dst = np.array([-np.array(gt["views"][vi]["Twc"])[:3, :3].T
                    @ np.array(gt["views"][vi]["Twc"])[:3, 3] for vi in reg])
    # Ground-truth centre in world coordinates.
    dst = np.array([(lambda T: -T[:3, :3].T @ T[:3, 3])(
        np.array(gt["views"][vi]["Twc"])) for vi in reg])
    R_al, t_al, scale = umeyama_alignment(src, dst)
    print(f"alignment scale: {scale:.5f}")

    errs = []
    for k, vi in enumerate(reg):
        centre_est = views[vi].center
        centre_gt = dst[k]
        centre_pred = scale * R_al @ centre_est + t_al
        errs.append(float(np.linalg.norm(centre_pred - centre_gt)))
    errs = np.array(errs)
    print(f"camera centre error: median {np.median(errs):.5f} "
          f"max {errs.max():.5f} (object scale ~2.0)")
    print(f"  relative to object extent: median {np.median(errs) / 2.0 * 100:.2f}%")

    # ---- point accuracy: distance from each point to the GT surface ----
    V, _, _ = mf.build_object_mesh("blob")
    centroid = V.mean(axis=0)
    # Radius of the blob at each direction (ray/sphere intersection approx).
    d = np.linalg.norm(result.points - centroid, axis=1)

    print(f"point radial distance: median {np.median(d):.4f} "
          f"min {d.min():.4f} max {d.max():.4f}")

    ok_pose = float(np.median(errs)) < args.max_reproj
    print("RESULT:", "PASS" if ok_pose else "FAIL")
    return 0 if ok_pose else 1


if __name__ == "__main__":
    raise SystemExit(main())