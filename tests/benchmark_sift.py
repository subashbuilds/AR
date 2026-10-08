"""Validate OpenCV SIFT + geometry against the fixture's exact ground truth.

This is the decision point for the feature backend: it measures real
same-point vs different-point descriptor separation, true-partner retrieval,
and the recovered relative pose for a pair of views.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def rot_angle_deg(R: np.ndarray) -> float:
    c = (np.trace(R) - 1.0) / 2.0
    return float(np.degrees(np.arccos(np.clip(c, -1.0, 1.0))))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="/tmp/fx")
    ap.add_argument("--pair", nargs=2, type=int, default=[3, 4])
    ap.add_argument("--kp", type=int, default=3000)
    args = ap.parse_args()

    gt = json.load(open(os.path.join(args.fixture, "ground_truth.json")))
    intr = gt["intrinsics"]
    fx, fy, cx, cy = intr["fx"], intr["fy"], intr["cx"], intr["cy"]
    i, j = args.pair
    ni, nj = gt["views"][i]["name"], gt["views"][j]["name"]
    Ti = np.array(gt["views"][i]["Twc"])
    Tj = np.array(gt["views"][j]["Twc"])
    di = np.load(os.path.join(args.fixture, "depth", ni.replace(".jpg", ".npy"))).astype(float)
    dj = np.load(os.path.join(args.fixture, "depth", nj.replace(".jpg", ".npy"))).astype(float)

    img_i = cv2.imread(os.path.join(args.fixture, "images", ni), cv2.IMREAD_GRAYSCALE)
    img_j = cv2.imread(os.path.join(args.fixture, "images", nj), cv2.IMREAD_GRAYSCALE)
    h, w = img_i.shape
    img_f = (img_i.astype(np.float64) / 255.0)

    sift = cv2.SIFT_create(nfeatures=args.kp, contrastThreshold=0.01)
    t0 = time.time()
    kpi, di_ = sift.detectAndCompute(img_i, None)
    kpj, dj_ = sift.detectAndCompute(img_j, None)
    t_det = time.time() - t0
    print(f"SIFT keypoints: {len(kpi)} / {len(kpj)} in {t_det:.2f}s")

    # ---- exact ground-truth correspondences from the depth maps ----
    # Pick a sample of view-i pixels with valid depth, project into view j,
    # and keep only pairs view j confirms on the same surface.
    rng = np.random.default_rng(0)
    cand = rng.integers(0, h, 4000), rng.integers(0, w, 4000)
    zi = di[cand[0], cand[1]]
    good = np.isfinite(zi) & (zi > 1e-6)
    px = cand[1][good].astype(float)
    py = cand[0][good].astype(float)
    z = zi[good]
    cam_pts = np.stack([(px - cx) * z / fx, (py - cy) * z / fy, z], axis=1)
    W = (cam_pts - Ti[:3, 3]) @ Ti[:3, :3]
    cj = (Tj @ np.hstack([W, np.ones((len(W), 1))]).T).T[:, :3]
    zj = cj[:, 2]
    front = zj > 1e-6
    pjx = np.full(len(px), np.nan)
    pjy = np.full(len(px), np.nan)
    pjx[front] = fx * cj[front, 0] / zj[front] + cx
    pjy[front] = fy * cj[front, 1] / zj[front] + cy
    inb = front & (pjx > 4) & (pjx < w - 4) & (pjy > 4) & (pjy < h - 4)
    zjs = dj[np.clip(pjy[inb].astype(int), 0, h - 1),
             np.clip(pjx[inb].astype(int), 0, w - 1)]
    same = np.isfinite(zjs) & (np.abs(zjs - zj[inb]) < 0.03)
    P = np.stack([px[inb][same], py[inb][same]], axis=1)
    Q = np.stack([pjx[inb][same], pjy[inb][same]], axis=1)
    print(f"exact correspondences: {len(P)}")

    if len(P) < 30:
        print("not enough overlap")
        return 1

    # ---- descriptor separation on exact pairs ----
    # Describe at the exact pixel locations using SIFT's compute() API.
    def describe(img, pts):
        """sift.compute returns (keypoints, descriptors); take the descriptor."""
        out = []
        for x, y in pts:
            k = cv2.KeyPoint(float(x), float(y), 1.6)
            _, d = sift.compute(img, [k])
            out.append(None if d is None or len(d) == 0 else d[0])
        return out

    A = describe(img_i, P)
    B = describe(img_j, Q)
    ok = [(a, b) for a, b in zip(A, B) if a is not None and b is not None]
    print(f"describable exact pairs: {len(ok)}")
    if len(ok) < 20:
        return 1
    Am = np.array([o[0] for o in ok], dtype=np.float64)
    Bm = np.array([o[1] for o in ok], dtype=np.float64)
    Am /= np.maximum(np.linalg.norm(Am, axis=1, keepdims=True), 1e-9)
    Bm /= np.maximum(np.linalg.norm(Bm, axis=1, keepdims=True), 1e-9)
    D = np.sqrt(np.maximum(0.0, 2.0 - 2.0 * (Am @ Bm.T)))
    diag = np.diag(D).copy()
    off = D[~np.eye(len(D), dtype=bool)]
    print(f"same-point L2: median {np.median(diag):.4f}")
    print(f"diff-point L2: median {np.median(off):.4f}")
    Dm = D.copy()
    np.fill_diagonal(Dm, np.inf)
    print(f"true partner is nearest: "
          f"{(np.argmin(Dm, axis=1) == np.arange(len(D))).mean() * 100:.1f}%")

    # ---- real matching + pose recovery ----
    t0 = time.time()
    bf = cv2.BFMatcher(cv2.NORM_L2)
    matches = bf.knnMatch(di_, dj_, k=2)
    good_m = []
    for pair in matches:
        if len(pair) < 2:
            continue
        a, b = pair
        if a.distance < 0.8 * b.distance:
            good_m.append(a)
    print(f"Lowe-ratio matches: {len(good_m)} in {time.time() - t0:.2f}s")

    pts_i = np.float32([kpi[m.queryIdx].pt for m in good_m])
    pts_j = np.float32([kpj[m.trainIdx].pt for m in good_m])

    # Validity via 3D from exact depth
    def to_world(pts, depth, T):
        x = pts[:, 0]
        y = pts[:, 1]
        xi = np.clip(np.round(x).astype(int), 0, w - 1)
        yi = np.clip(np.round(y).astype(int), 0, h - 1)
        d = depth[yi, xi]
        okm = np.isfinite(d) & (d > 1e-6)
        c = np.zeros((len(pts), 3))
        c[:, 0] = (x - cx) * d / fx
        c[:, 1] = (y - cy) * d / fy
        c[:, 2] = d
        out = (c - T[:3, 3]) @ T[:3, :3]
        out[~okm] = np.nan
        return out, okm

    Wa, oka = to_world(pts_i, di, Ti)
    Wb, okb = to_world(pts_j, dj, Tj)
    both = oka & okb
    d3 = np.linalg.norm(Wa[both] - Wb[both], axis=1)
    for tol in (0.01, 0.02, 0.05):
        n_ok = int((d3 < tol).sum())
        print(f"  matches within {tol * 100:.0f}cm: {n_ok}/{len(d3)} "
              f"({100 * n_ok / max(len(d3), 1):.1f}%)")

    K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float64)
    E, mask = cv2.findEssentialMat(pts_i, pts_j, K, method=cv2.USAC_MAGSAC,
                                   prob=0.999, threshold=1.0, maxIters=5000)
    ok_E = E is not None and E.shape[0] % 3 == 0 and E.shape[0] >= 3
    if ok_E:
        E_use = E[:3, :3]
        inl = (mask.ravel().astype(bool) if mask is not None
               else np.ones(len(pts_i), dtype=bool))
        # The RANSAC mask must line up 1:1 with the input correspondences.
        if inl.shape[0] != len(pts_i):
            inl = np.ones(len(pts_i), dtype=bool)
        pi = pts_i[inl]
        pj = pts_j[inl]
        if len(pi) < 5:
            print(f"too few inliers: {len(pi)}")
            ok_E = False

    if ok_E:
        # OpenCV 5.x returns (retval, E, R, t, mask); 4.x returns (R, t, mask).
        # Detect the shape rather than unpacking blindly, because the two APIs
        # differ and we support both.
        res = cv2.recoverPose(E_use, pi, pj, K)
        # Verified against perfect ground-truth correspondences in
        # tests/recoverpose_contract.py: the installed OpenCV returns
        # (retval, R, t, mask) with R at index 1. Select R by checking that it
        # is a proper rotation followed by a 3-vector, so the code stays
        # correct across the OpenCV 4.x/5.x signature change.
        R_est = None
        t_est = None
        for idx, cand in enumerate(res):
            if not isinstance(cand, np.ndarray) or cand.shape != (3, 3):
                continue
            if abs(float(np.linalg.det(cand)) - 1.0) > 1e-2:
                continue
            if idx + 1 >= len(res):
                continue
            nxt = np.asarray(res[idx + 1])
            if nxt.size != 3:
                continue
            R_est = np.asarray(cand, dtype=np.float64)
            t_est = nxt.astype(np.float64).ravel()
            break
        if R_est is None or t_est is None:
            raise RuntimeError(
                "could not locate R/t in recoverPose output: shapes="
                f"{[getattr(c, 'shape', type(c).__name__) for c in res]}")
        R_rel_gt = Tj[:3, :3] @ Ti[:3, :3].T
        t_rel_gt = Tj[:3, 3] - R_rel_gt @ Ti[:3, 3]
        rerr = rot_angle_deg(R_est @ R_rel_gt.T)
        t_est = np.asarray(t_est, dtype=np.float64).ravel()
        a1 = t_est / max(np.linalg.norm(t_est), 1e-12)
        a2 = t_rel_gt / max(np.linalg.norm(t_rel_gt), 1e-12)
        terr = float(np.degrees(np.arccos(np.clip(float(a1 @ a2), -1, 1))))
        print(f"MAGSAC inliers: {len(pi)}/{len(pts_i)}")
        print(f"POSE ERROR: rot {rerr:.4f} deg, trans {terr:.4f} deg")
        passed = rerr < 3.0 and terr < 5.0
        print("RESULT:", "PASS" if passed else "FAIL")
        return 0 if passed else 1

    print("essential matrix estimation failed")
    print("RESULT: FAIL")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())