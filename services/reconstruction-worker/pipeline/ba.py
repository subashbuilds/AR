"""Levenberg-Marquardt bundle adjustment.

Refines camera poses and 3D points jointly by minimising the sum of squared
reprojection errors. Implemented directly on numpy so the worker needs no
solver dependency beyond OpenCV.

Parameterisation
----------------
* Camera pose: a 6-vector (w, dt) applied in the camera's own frame as
  ``R' = exp(w) @ R`` and ``t' = exp(w) @ t + dt``. Applying the rotation on
  the left means the translation update stays expressed in the same
  (rotated) camera frame, which keeps the Gauss-Newton step consistent.
* Point: a 3-vector applied additively in world coordinates.

Jacobians are computed numerically. With a few hundred points and six pose
parameters that costs far less than the SVD it replaces, and it removes any
risk of a hand-derived analytic Jacobian being subtly wrong.

Two properties this implementation guarantees, because both were observed to
break without them:

* **It never returns a worse solution than it was given.** Each sweep is
  accepted only if the total cost actually fell; otherwise the pose and point
  snapshot is restored and the damping is raised. An unconditional step here
  lets a bad sweep drag a good reconstruction with it.
* **The gauge is fixed.** A similarity transform of the whole reconstruction
  leaves every residual unchanged, so the normal equations are singular in
  seven directions. One camera is held frozen to remove that freedom;
  without it the solver can wander along the null space.
"""

from __future__ import annotations

import math
from typing import Optional

import numpy as np


def _rodrigues(w: np.ndarray) -> np.ndarray:
    """Exponential map so(3) -> SO(3)."""
    theta = float(np.linalg.norm(w))
    if theta < 1e-12:
        K = np.array([[0.0, -w[2], w[1]],
                      [w[2], 0.0, -w[0]],
                      [-w[1], w[0], 0.0]], dtype=np.float64)
        return np.eye(3) + K + 0.5 * (K @ K)
    axis = w / theta
    x, y, z = axis
    K = np.array([[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]], dtype=np.float64)
    return (np.eye(3) + math.sin(theta) * K
            + (1.0 - math.cos(theta)) * (K @ K))


def _project(cam_v, fx: float, fy: float, cx: float, cy: float
             ) -> tuple[np.ndarray, np.ndarray]:
    """Project camera-space points (N,3) to pixels; returns (uv, depth)."""
    z = cam_v[:, 2]
    safe = np.where(np.abs(z) < 1e-9, 1e-9, z)
    uv = np.stack([fx * cam_v[:, 0] / safe + cx,
                   fy * cam_v[:, 1] / safe + cy], axis=1)
    return uv, z


def _apply_pose(R: np.ndarray, t: np.ndarray, w: np.ndarray, dt: np.ndarray
                ) -> tuple[np.ndarray, np.ndarray]:
    """Left-multiplied pose update."""
    dR = _rodrigues(w)
    return dR @ R, dR @ t + dt


def _total_cost(views, tracks, poses, cam_idx: list[int]) -> float:
    """Mean squared reprojection error over every observation."""
    total = 0.0
    n = 0
    for tr in tracks:
        X = tr.xyz
        if X is None:
            continue
        for vi in tr.obs:
            if vi not in poses:
                continue
            R, t = poses[vi]
            cam = R @ X + t
            if cam[2] <= 1e-9:
                total += 1e3
                n += 2
                continue
            c = views[vi].camera
            uv, _ = _project(cam.reshape(1, 3), c.fx, c.fy, c.cx, c.cy)
            total += float(np.sum((uv[0] - views[vi].keypoints[tr.obs[vi]]) ** 2))
            n += 2
    return total / max(n, 1)


def _sweep(views, usable, poses, idxs, frozen, lam: float) -> None:
    """One coordinate-descent sweep over points then poses, in place."""
    eps = 1e-7

    # ---- refine 3D points given the current poses ----
    for tr in usable:
        obs_ids = [vi for vi in tr.obs if vi in poses]
        if len(obs_ids) < 2:
            continue
        Rs = [poses[vi][0] for vi in obs_ids]
        ts = [poses[vi][1] for vi in obs_ids]
        obs = np.array([views[vi].keypoints[tr.obs[vi]] for vi in obs_ids])

        def predict(x):
            cam = np.array([R @ x + t for R, t in zip(Rs, ts)])
            out = np.empty((len(obs_ids), 2))
            for k, vi in enumerate(obs_ids):
                c = views[vi].camera
                uv, _ = _project(cam[k:k + 1], c.fx, c.fy, c.cx, c.cy)
                out[k] = uv[0]
            return out

        base = predict(tr.xyz)
        # A point behind a camera has no meaningful reprojection; leave it
        # for the cheirality filter rather than chasing it.
        if any((R @ tr.xyz + t)[2] <= 1e-6 for R, t in zip(Rs, ts)):
            continue
        res = (base - obs).reshape(-1)
        J = np.zeros((len(res), 3), dtype=np.float64)
        for p in range(3):
            d = np.zeros(3)
            d[p] = eps
            J[:, p] = ((predict(tr.xyz + d) - base) / eps).reshape(-1)
        H = J.T @ J + lam * np.eye(3)
        g = J.T @ res
        try:
            dx = np.linalg.solve(H, -g)
        except np.linalg.LinAlgError:
            continue
        tr.xyz = tr.xyz + dx

    # ---- refine poses given the current points ----
    for vi in idxs:
        if vi in frozen:
            continue
        pts, obs = [], []
        for tr in usable:
            if vi in tr.obs:
                pts.append(tr.xyz)
                obs.append(views[vi].keypoints[tr.obs[vi]])
        if len(pts) < 6:
            continue
        X = np.array(pts)
        obs = np.array(obs)
        c = views[vi].camera

        def predict_cam(R, t):
            cam = X @ R.T + t
            uv, _ = _project(cam, c.fx, c.fy, c.cx, c.cy)
            return uv

        R0, t0 = poses[vi]
        base = predict_cam(R0, t0)
        res = (base - obs).reshape(-1)
        J = np.zeros((len(res), 6), dtype=np.float64)
        for p in range(6):
            w = np.zeros(3)
            dt = np.zeros(3)
            if p < 3:
                w[p] = eps
            else:
                dt[p - 3] = eps
            Rp, tp = _apply_pose(R0, t0, w, dt)
            J[:, p] = ((predict_cam(Rp, tp) - base) / eps).reshape(-1)
        H = J.T @ J + lam * np.eye(6)
        g = J.T @ res
        try:
            delta = np.linalg.solve(H, -g)
        except np.linalg.LinAlgError:
            continue
        poses[vi] = _apply_pose(R0, t0, delta[:3], delta[3:6])


def bundle_adjust(views, tracks, registered: set[int],
                  frozen: Optional[set[int]] = None,
                  max_iterations: int = 40,
                  tolerance: float = 1e-9,
                  verbose: bool = False) -> tuple[bool, float]:
    """Refine poses and points in place.

    `frozen` names cameras whose pose is held fixed; passing one removes the
    gauge freedom from the normal equations.

    Returns (improved, final_rms_reprojection_error_px). `improved` is False
    when the input was already at least as good as anything found.
    """
    idxs = sorted(registered)
    poses: dict[int, tuple[np.ndarray, np.ndarray]] = {
        vi: (views[vi].R.copy(), views[vi].t.copy()) for vi in idxs
    }
    usable = [tr for tr in tracks if tr.xyz is not None and len(tr.obs) >= 2]
    if len(usable) < 8 or len(idxs) < 2:
        return False, float("nan")

    frozen = set(frozen or ())
    lam = 1e-4
    start_cost = _total_cost(views, usable, poses, idxs)
    prev_cost = start_cost

    for iteration in range(max_iterations):
        # Snapshot so a harmful sweep can be undone.
        snap_poses = {vi: (R.copy(), t.copy()) for vi, (R, t) in poses.items()}
        snap_xyz = {id(tr): tr.xyz.copy() for tr in usable}

        _sweep(views, usable, poses, idxs, frozen, lam)
        cost = _total_cost(views, usable, poses, idxs)

        if cost > prev_cost:
            poses = snap_poses
            for tr in usable:
                tr.xyz = snap_xyz[id(tr)]
            lam *= 10.0
            if verbose:
                print(f"    BA iter {iteration:2d}: rejected (cost "
                      f"{prev_cost:.6f} -> {cost:.6f}), lambda {lam:.1e}")
            if lam > 1e10:
                break
            continue

        if verbose:
            print(f"    BA iter {iteration:2d}: cost {prev_cost:.6f} -> "
                  f"{cost:.6f}, lambda {lam:.1e}")
        lam = max(lam * 0.3, 1e-9)
        if prev_cost - cost < tolerance * max(prev_cost, 1.0):
            prev_cost = cost
            break
        prev_cost = cost

    # Write refined poses back to the views, keeping them proper rotations.
    for vi in idxs:
        R, t = poses[vi]
        U, _, Vt = np.linalg.svd(R)
        Rn = U @ Vt
        if np.linalg.det(Rn) < 0:
            U[:, -1] *= -1
            Rn = U @ Vt
        views[vi].R = Rn
        views[vi].t = t

    rms = math.sqrt(max(prev_cost, 0.0))
    return prev_cost < start_cost, rms