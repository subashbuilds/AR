"""Descriptor benchmark against exact ground truth.

For a pair of views we take dense grid samples in view i, lift them to world
space with the fixture's exact depth map, project them into view j, and keep
only points that view j independently confirms on the same surface. Those are
exact correspondences, so we can measure:

  * separation between same-point and different-point descriptor distances
  * the fraction of true partners that are the nearest neighbour (rank-0)

These are the numbers that decide whether the matcher can work at all.

The descriptor under test is the hand-written one retained in
``pipeline/sfm.py`` (Shi-Tomasi corners + BRIEF). The shipped pipeline does NOT
use it: OpenCV's SIFT measured far better and was chosen instead (compare with
``tests/benchmark_sift.py``, which runs the same correspondences through the
production matcher). This script exists to keep that decision reproducible.
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

from pipeline.sfm import (  # noqa: E402
    brief_describe, match_descriptors, shi_tomasi,
)


def load_gray(fixture: str, name: str) -> np.ndarray:
    im = np.asarray(Image.open(os.path.join(fixture, "images", name))
                    .convert("RGB")).astype(np.float64) / 255.0
    return (0.299 * im[..., 0] + 0.587 * im[..., 1] + 0.114 * im[..., 2])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="/tmp/fx")
    ap.add_argument("--pairs", nargs="+", type=int, default=[3, 4])
    ap.add_argument("--grid", type=int, default=45)
    ap.add_argument("--kp-max", type=int, default=1500)
    ap.add_argument("--pair-cap", type=int, default=500,
                    help="max exact correspondences used in the dense "
                         "pairwise distance matrix (memory bound)")
    args = ap.parse_args()

    gt = json.load(open(os.path.join(args.fixture, "ground_truth.json")))
    intr = gt["intrinsics"]
    fx, fy, cx, cy = intr["fx"], intr["fy"], intr["cx"], intr["cy"]
    i, j = args.pairs
    ni, nj = gt["views"][i]["name"], gt["views"][j]["name"]
    Ti = np.array(gt["views"][i]["Twc"])
    Tj = np.array(gt["views"][j]["Twc"])
    di = np.load(os.path.join(args.fixture, "depth", ni.replace(".jpg", ".npy"))).astype(float)
    dj = np.load(os.path.join(args.fixture, "depth", nj.replace(".jpg", ".npy"))).astype(float)
    gi = load_gray(args.fixture, ni)
    gj = load_gray(args.fixture, nj)
    h, w = di.shape

    # ---- exact correspondence set from the depth maps ----
    step = max(h // args.grid, 1)
    ys, xs = np.mgrid[0:h:step, 0:w:step]
    z = di[ys.ravel(), xs.ravel()]
    good = np.isfinite(z) & (z > 1e-6)
    px = xs.ravel()[good].astype(float)
    py = ys.ravel()[good].astype(float)
    z = z[good]
    cam_pts = np.stack([(px - cx) * z / fx, (py - cy) * z / fy, z], axis=1)
    W = (cam_pts - Ti[:3, 3]) @ Ti[:3, :3]
    cj = (Tj @ np.hstack([W, np.ones((len(W), 1))]).T).T[:, :3]
    zj = cj[:, 2]
    front = zj > 1e-6
    pjx = np.full(len(px), np.nan)
    pjy = np.full(len(px), np.nan)
    pjx[front] = fx * cj[front, 0] / zj[front] + cx
    pjy[front] = fy * cj[front, 1] / zj[front] + cy
    inb = front & (pjx > 6) & (pjx < w - 6) & (pjy > 6) & (pjy < h - 6)
    # View j must independently confirm the same surface depth.
    zjs = dj[np.clip(pjy[inb].astype(int), 0, h - 1),
             np.clip(pjx[inb].astype(int), 0, w - 1)]
    same = np.isfinite(zjs) & (np.abs(zjs - zj[inb]) < 0.03)
    pix_i = np.stack([px[inb][same], py[inb][same]], axis=1)
    pix_j = np.stack([pjx[inb][same], pjy[inb][same]], axis=1)
    print(f"exact correspondences: {len(pix_i)}")

    if len(pix_i) < 30:
        print("not enough overlap")
        return 1

    # ---- descriptor separation on those exact pairs ----
    if len(pix_i) > args.pair_cap:
        step_cap = len(pix_i) // args.pair_cap + 1
        pix_i, pix_j = pix_i[::step_cap], pix_j[::step_cap]
        print(f"correspondence set capped to {len(pix_i)} for the dense matrix")

    def pts_from(pix):
        return np.ascontiguousarray(pix.astype(np.float64))

    A = brief_describe(gi, pts_from(pix_i)).astype(np.uint8)
    B = brief_describe(gj, pts_from(pix_j)).astype(np.uint8)
    bits = A.shape[1]
    # BRIEF is binary, so the only meaningful distance is Hamming, normalised
    # to [0, 1] by the descriptor length.
    D = np.count_nonzero(A[:, None, :] != B[None, :, :], axis=2) / float(bits)
    n = len(D)
    diag = np.diag(D).copy()
    off = D[~np.eye(n, dtype=bool)]
    print(f"same-point Hamming: median {np.median(diag):.4f} p90 {np.percentile(diag, 90):.4f}")
    print(f"diff-point Hamming: median {np.median(off):.4f} p10 {np.percentile(off, 10):.4f}")
    Dm = D.copy()
    np.fill_diagonal(Dm, np.inf)
    rank0 = float((np.argmin(Dm, axis=1) == np.arange(n)).mean())
    print(f"true partner is nearest: {rank0 * 100:.1f}%")

    # ---- keypoint detection + matching on real features ----
    t0 = time.time()
    kpi = shi_tomasi(gi, max_corners=args.kp_max)
    kpj = shi_tomasi(gj, max_corners=args.kp_max)
    t_det = time.time() - t0
    print(f"keypoints: {len(kpi)} / {len(kpj)} in {t_det:.2f}s")
    if len(kpi) < 10 or len(kpj) < 10:
        return 1

    t0 = time.time()
    di_ = brief_describe(gi, kpi)
    dj_ = brief_describe(gj, kpj)
    t_desc = time.time() - t0
    print(f"descriptors in {t_desc:.2f}s")

    ia, ib = match_descriptors(di_, dj_, ratio=0.85)
    print(f"matches: {len(ia)}")

    # Validate matches against exact geometry.
    def to_world(pts, depth, T):
        x = pts[:, 0]
        y = pts[:, 1]
        xi = np.clip(np.round(x).astype(int), 0, depth.shape[1] - 1)
        yi = np.clip(np.round(y).astype(int), 0, depth.shape[0] - 1)
        d = depth[yi, xi]
        ok = np.isfinite(d) & (d > 1e-6)
        c = np.zeros((len(pts), 3))
        c[:, 0] = (x - cx) * d / fx
        c[:, 1] = (y - cy) * d / fy
        c[:, 2] = d
        out = (c - T[:3, 3]) @ T[:3, :3]
        out[~ok] = np.nan
        return out

    Wa = to_world(kpi[ia], di, Ti)
    Wb = to_world(kpj[ib], dj, Tj)
    both = np.isfinite(Wa).all(axis=1) & np.isfinite(Wb).all(axis=1)
    d3 = np.linalg.norm(Wa[both] - Wb[both], axis=1)
    for tol in (0.01, 0.02, 0.05):
        print(f"  matches within {tol * 100:.0f}cm: {(d3 < tol).sum()}/{len(d3)} "
              f"({100 * (d3 < tol).mean():.1f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())