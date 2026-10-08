"""Determine the exact recoverPose return contract for the installed OpenCV.

OpenCV changed this API between 4.x and 5.x, so rather than hard-coding
indices we probe the returned tuple and identify R and t by shape and by the
rotation determinant.
"""

from __future__ import annotations

import json
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_fixture as mf  # noqa: E402


def classify(res) -> tuple:
    """Return (R, t) from an OpenCV recoverPose result, version-agnostically."""
    shapes = [(type(c).__name__, getattr(c, "shape", None)) for c in res]
    cands = []
    for idx, c in enumerate(res):
        if isinstance(c, np.ndarray) and c.shape == (3, 3):
            det = float(np.linalg.det(c))
            cands.append((idx, det))
    rot = None
    trans = None
    for idx, det in cands:
        if abs(det - 1.0) < 1e-2 and idx + 1 < len(res):
            nxt = np.asarray(res[idx + 1])
            if nxt.size == 3:
                rot = np.asarray(c, dtype=np.float64)
                trans = nxt.astype(np.float64).ravel()
                break
    return rot, trans, shapes


def main() -> int:
    gt = json.load(open("/tmp/fx2/ground_truth.json"))
    intr = gt["intrinsics"]
    fx, fy, cx, cy = intr["fx"], intr["fy"], intr["cx"], intr["cy"]
    Ti = np.array(gt["views"][3]["Twc"])
    Tj = np.array(gt["views"][4]["Twc"])
    K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]])

    V, F, _ = mf.build_object_mesh("blob")

    def proj(T):
        c = (T @ np.hstack([V, np.ones((len(V), 1))]).T).T[:, :3]
        z = c[:, 2]
        ok = z > 1e-6
        u = np.zeros(len(V))
        v = np.zeros(len(V))
        u[ok] = fx * c[ok, 0] / z[ok] + cx
        v[ok] = fy * c[ok, 1] / z[ok] + cy
        return u, v, ok

    ui, vi, oki = proj(Ti)
    uj, vj, okj = proj(Tj)
    h, w = 768, 1024
    sel = (oki & okj & (ui > 5) & (ui < w - 5) & (uj > 5) & (uj < w - 5)
           & (vi > 5) & (vi < h - 5) & (vj > 5) & (vj < h - 5))
    pi = np.float32(np.stack([ui[sel], vi[sel]], 1))
    pj = np.float32(np.stack([uj[sel], vj[sel]], 1))
    print(f"perfect correspondences: {len(pi)}")

    E, mask = cv2.findEssentialMat(pi, pj, K, method=cv2.USAC_MAGSAC,
                                   prob=0.9999, threshold=0.3, maxIters=20000)
    inl = mask.ravel().astype(bool)
    res = cv2.recoverPose(E[:3, :3], pi[inl], pj[inl], K)

    R_est, t_est, shapes = classify(res)
    print("recoverPose output shapes:", shapes)
    if R_est is None:
        print("FAILED to classify recoverPose output")
        return 1

    R_gt = Tj[:3, :3] @ Ti[:3, :3].T
    t_gt = Tj[:3, 3] - R_gt @ Ti[:3, 3]

    c = (np.trace(R_est) - 1) / 2
    rerr = float(np.degrees(np.arccos(np.clip(c, -1, 1))))
    a1 = t_est / max(np.linalg.norm(t_est), 1e-12)
    a2 = t_gt / max(np.linalg.norm(t_gt), 1e-12)
    terr = float(np.degrees(np.arccos(np.clip(float(a1 @ a2), -1, 1))))

    print(f"inliers {int(inl.sum())}/{len(inl)}")
    print(f"rot err  {rerr:.6f} deg")
    print(f"trans err {terr:.6f} deg")
    print(f"t_est {t_est.round(5).tolist()}")
    print(f"t_gt  {t_gt.round(5).tolist()}")
    print("RESULT:", "PASS" if rerr < 0.5 and terr < 1.0 else "FAIL")
    return 0 if (rerr < 0.5 and terr < 1.0) else 1


if __name__ == "__main__":
    raise SystemExit(main())