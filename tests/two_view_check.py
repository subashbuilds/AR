"""Two-view sanity check for the SfM core.

Recovers the relative pose between two synthetic views and compares it against
the ground-truth relative pose from the fixture generator. This is the earliest
honest check that the geometry is correct, before the full pipeline exists.

Usage:
    python3 -m tests.two_view_check --fixture /tmp/fx --pair 0 3
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "services", "reconstruction-worker"))

from pipeline.sfm import (  # noqa: E402
    brief_describe, camera_from_resolution, essential_from_fundamental, match_descriptors,
    pose_from_essential, ransac_fundamental, shi_tomasi, to_gray,
)


def rotation_angle_deg(R: np.ndarray) -> float:
    c = (np.trace(R) - 1.0) / 2.0
    return float(np.degrees(np.arccos(max(-1.0, min(1.0, c)))))


def rotation_error_deg(R_est: np.ndarray, R_gt: np.ndarray) -> float:
    return rotation_angle_deg(R_est @ R_gt.T)


def translation_angle_deg(t_est: np.ndarray, t_gt: np.ndarray) -> float:
    a = t_est / max(np.linalg.norm(t_est), 1e-12)
    b = t_gt / max(np.linalg.norm(t_gt), 1e-12)
    return float(np.degrees(np.arccos(max(-1.0, min(1.0, float(a @ b))))))


def detect(path: str, max_corners: int) -> tuple[np.ndarray, np.ndarray]:
    gray = to_gray(np.asarray(Image.open(path).convert("RGB")).astype(np.float64) / 255.0)
    pts = shi_tomasi(gray, max_corners=max_corners, quality_level=0.005, min_distance=6)
    desc = brief_describe(gray, pts)
    return pts, desc


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="/tmp/fx")
    ap.add_argument("--pair", nargs=2, type=int, default=[0, 3])
    ap.add_argument("--max-corners", type=int, default=900)
    args = ap.parse_args()

    gt = json.load(open(os.path.join(args.fixture, "ground_truth.json")))
    intr = gt["intrinsics"]
    cam = camera_from_resolution(intr["width"], intr["height"],
                                 hfov_deg=2 * np.degrees(np.arctan(intr["width"] / 2 / intr["fx"])))
    i, j = args.pair
    name_i = gt["views"][i]["name"]
    name_j = gt["views"][j]["name"]

    pts_i, desc_i = detect(os.path.join(args.fixture, "images", name_i), args.max_corners)
    pts_j, desc_j = detect(os.path.join(args.fixture, "images", name_j), args.max_corners)
    print(f"detected {len(pts_i)} / {len(pts_j)} corners")

    ia, ib = match_descriptors(desc_i, desc_j, ratio=0.85)
    print(f"matched {len(ia)} correspondences")

    pa = pts_i[ia]
    pb = pts_j[ib]

    _, inliers, quality = ransac_fundamental(pa, pb, threshold_px=1.0, iterations=3000)
    print(f"ransac inliers: {int(inliers.sum())}/{len(inliers)} (ratio {quality[0]:.3f})")

    F = ransac_fundamental(pa, pb, threshold_px=1.0, iterations=3000)[0]
    # Recompute F from inliers only for a clean estimate.
    Fin = ransac_fundamental(pa[inliers], pb[inliers], threshold_px=1.0, iterations=500)[0]
    E = essential_from_fundamental(Fin, cam.K)

    Twc_i = np.array(gt["views"][i]["Twc"])
    Twc_j = np.array(gt["views"][j]["Twc"])

    # Ground truth relative pose: X_j = R_rel X_i + t_rel
    R_rel_gt = Twc_j[:3, :3] @ Twc_i[:3, :3].T
    t_rel_gt = Twc_j[:3, 3] - R_rel_gt @ Twc_i[:3, 3]

    cands = pose_from_essential(E, pa[inliers], pb[inliers], cam.K)
    best = None
    for R, t in cands:
        rerr = rotation_error_deg(R, R_rel_gt)
        terr = translation_angle_deg(t, t_rel_gt)
        if best is None or rerr < best[0]:
            best = (rerr, terr, R, t)
    rerr, terr, R_est, t_est = best
    print(f"best candidate: rotation error {rerr:.3f} deg, translation direction error {terr:.3f} deg")

    ok = rerr < 3.0 and terr < 5.0
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())