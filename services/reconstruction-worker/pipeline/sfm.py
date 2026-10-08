"""Structure-from-Motion core.

Implements the geometry of incremental SfM directly on numpy so the pipeline can
run on a plain CPU box with no COLMAP/ceres/CUDA toolchain:

  * Shi-Tomasi corner detection (good features to track)
  * BRIEF-like binary descriptors
  * Lowe-ratio matching with cross-check
  * Normalised 8-point fundamental matrix + RANSAC
  * Essential matrix from F and intrinsics
  * Pose from E via cheirality-checked decomposition
  * Incremental triangulation with reprojection-error filtering

Conventions (documented in docs/reconstruction/coordinate-system.md):
  * World space is right-handed, Y-up is applied at export time, not here.
  * Camera looks down +Z in its own frame (OpenCV convention).
  * 3D points and camera centres share the same world unit; the scale is
    arbitrary until `ScaleCalibration` is applied by the pipeline.

Every public function is pure with respect to file I/O so it can be unit tested.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

import numpy as np

# --------------------------------------------------------------------------
# Linear algebra helpers
# --------------------------------------------------------------------------

# Intrinsic matrix from a pinhole camera, with optional radial distortion k1,k2.
K_EPS = 1e-12


def skew(v: np.ndarray) -> np.ndarray:
    x, y, z = v
    return np.array([[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]], dtype=np.float64)


def normalize_points(pts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Hartley normalisation. Returns normalised points and the 3x3 matrix T."""
    mean = pts.mean(axis=0)
    centred = pts - mean
    dist = np.sqrt(np.sum(centred**2, axis=1))
    scale = np.sqrt(2.0) / max(float(dist.mean()), K_EPS)
    T = np.array(
        [[scale, 0.0, -scale * mean[0]],
         [0.0, scale, -scale * mean[1]],
         [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )
    return (centred * scale) @ T[:2, :2].T, T


def so3_exp(w: np.ndarray) -> np.ndarray:
    """Exponential map of so(3) -> SO(3)."""
    theta = float(np.linalg.norm(w))
    if theta < 1e-12:
        K = skew(w)
        return np.eye(3) + K + 0.5 * K @ K
    axis = w / theta
    K = skew(axis)
    return np.eye(3) + math.sin(theta) * K + (1.0 - math.cos(theta)) * (K @ K)


def rodrigues(rvec: np.ndarray) -> np.ndarray:
    return so3_exp(rvec)


def project_rotation(R: np.ndarray) -> np.ndarray:
    U, _, Vt = np.linalg.svd(R)
    Rn = U @ Vt
    if np.linalg.det(Rn) < 0:
        U[:, -1] *= -1
        Rn = U @ Vt
    return Rn


def transform_similarity(S: np.ndarray, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    """4x4 similarity with a positive scale factor applied to rotation."""
    return np.array([[S * R[0, 0], S * R[0, 1], S * R[0, 2], t[0]],
                     [S * R[1, 0], S * R[1, 1], S * R[1, 2], t[1]],
                     [S * R[2, 0], S * R[2, 1], S * R[2, 2], t[2]],
                     [0.0, 0.0, 0.0, 1.0]], dtype=np.float64)


def invert_transform(T: np.ndarray) -> np.ndarray:
    R = T[:3, :3]
    t = T[:3, 3]
    out = np.eye(4)
    out[:3, :3] = R.T
    out[:3, 3] = -R.T @ t
    return out


# --------------------------------------------------------------------------
# Camera model
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Camera:
    """Pinhole camera with a single radial distortion term."""

    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float
    k1: float = 0.0
    k2: float = 0.0

    @property
    def K(self) -> np.ndarray:
        return np.array([[self.fx, 0.0, self.cx],
                         [0.0, self.fy, self.cy],
                         [0.0, 0.0, 1.0]], dtype=np.float64)

    def unproject_normalized(self, uv: np.ndarray) -> np.ndarray:
        """Pixel -> normalised camera rays, with inverse distortion applied."""
        x = (uv[:, 0] - self.cx) / self.fx
        y = (uv[:, 1] - self.cy) / self.fy
        r2 = x * x + y * y
        # Iteratively invert r_d = r (1 + k1 r^2 + k2 r^4).
        radial = 1.0 + self.k1 * r2 + self.k2 * r2 * r2
        for _ in range(8):
            f = 1.0 + self.k1 * r2 * radial**2 + self.k2 * (r2 * radial**2) ** 2 - radial
            df = 2.0 * r2 * (self.k1 + 2.0 * self.k2 * r2) * radial**2
            step = f / np.maximum(np.abs(df), 1e-9) * np.sign(f)
            radial = radial - step
            r2 = r2 - step
            r2 = np.maximum(r2, 1e-12)
        scale = 1.0 / np.maximum(radial, 1e-9)
        return np.stack([x * scale, y * scale, np.ones_like(x)], axis=1)

    def distort_normalized(self, xy: np.ndarray) -> np.ndarray:
        r2 = xy[:, 0] ** 2 + xy[:, 1] ** 2
        radial = 1.0 + self.k1 * r2 + self.k2 * r2 * r2
        return xy * radial[:, None]


def camera_from_resolution(width: int, height: int, hfov_deg: float = 60.0) -> Camera:
    """Intrinsics from a horizontal field of view, assuming square pixels."""
    fx = 0.5 * width / math.tan(0.5 * math.radians(hfov_deg))
    return Camera(width=width, height=height, fx=fx, fy=fx,
                  cx=width * 0.5, cy=height * 0.5)


# --------------------------------------------------------------------------
# Feature detection and description
# --------------------------------------------------------------------------


def to_gray(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image.astype(np.float64)
    return (0.299 * image[..., 0] + 0.587 * image[..., 1] + 0.114 * image[..., 2]).astype(np.float64)


def image_gradients(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:-1] = 0.5 * (gray[:, 2:] - gray[:, :-2])
    gy[1:-1, :] = 0.5 * (gray[2:, :] - gray[:-2, :])
    return gx, gy


def shi_tomasi(gray: np.ndarray, mask: Optional[np.ndarray] = None,
               max_corners: int = 600, quality_level: float = 0.01,
               min_distance: int = 7, block_size: int = 7) -> np.ndarray:
    """Good-features-to-track via the min-eigenvalue of the structure tensor."""
    gx, gy = image_gradients(gray)
    win = block_size

    def box(a: np.ndarray) -> np.ndarray:
        c = np.cumsum(np.cumsum(a, axis=0), axis=1)
        c = np.pad(c, ((1, 0), (1, 0)))
        h, w = a.shape
        y0 = np.arange(h)[:, None]
        x0 = np.arange(w)[None, :]
        ys = np.clip(y0 + win // 2, 0, h)
        xs = np.clip(x0 + win // 2, 0, w)
        ya, xa = np.clip(y0 - win // 2, 0, h), np.clip(x0 - win // 2, 0, w)
        total = c[ys, xs] - c[ya, xs] - c[ys, xa] + c[ya, xa]
        return total / float(win * win)

    a = box(gx * gx)
    b = box(gx * gy)
    d = box(gy * gy)
    tr = a + d
    det = a * d - b * b
    disc = np.maximum(tr * tr / 4.0 - det, 0.0)
    sqrt_disc = np.sqrt(disc)
    min_eig = tr / 2.0 - sqrt_disc

    valid = np.zeros_like(gray, dtype=bool)
    valid[win:gray.shape[0] - win, win:gray.shape[1] - win] = True
    if mask is not None:
        valid &= mask.astype(bool)

    min_eig = np.where(valid, min_eig, -1.0)
    vmax = float(min_eig.max())
    if vmax <= 0:
        return np.zeros((0, 2), dtype=np.float64)
    thresh = max(quality_level * vmax, 1e-4)
    ys, xs = np.nonzero(min_eig > thresh)
    if len(ys) == 0:
        return np.zeros((0, 2), dtype=np.float64)

    scores = min_eig[ys, xs]
    order = np.argsort(-scores)
    ys, xs, scores = ys[order], xs[order], scores[order]

    picked: list[int] = []
    picked_xy: list[tuple[float, float]] = []
    # Spatial bucketing keeps the suppression loop near-linear for dense frames.
    cell = max(float(min_distance), 1.0)
    grid: dict[tuple[int, int], list[int]] = {}
    for i in range(len(ys)):
        cx_i, cy_i = float(xs[i]), float(ys[i])
        gx_i, gy_i = int(cx_i // cell), int(cy_i // cell)
        ok = True
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for j in grid.get((gx_i + dx, gy_i + dy), ()):  # noqa: B007
                    px, py = picked_xy[j]
                    if (px - cx_i) ** 2 + (py - cy_i) ** 2 < cell * cell:
                        ok = False
                        break
                if not ok:
                    break
            if not ok:
                break
        if not ok:
            continue
        grid.setdefault((gx_i, gy_i), []).append(len(picked))
        picked.append(i)
        picked_xy.append((cx_i, cy_i))
        if len(picked) >= max_corners:
            break

    idx = np.array(picked, dtype=np.int64)
    return np.stack([xs[idx].astype(np.float64), ys[idx].astype(np.float64)], axis=1)


_BRIEF_PATTERN_CACHE: dict[tuple[int, int], np.ndarray] = {}


def brief_pattern(width: int, height: int, seed: int = 0xB2EF) -> np.ndarray:
    """Deterministic BRIEF sampling pattern so runs are reproducible."""
    key = (width, height)
    cached = _BRIEF_PATTERN_CACHE.get(key)
    if cached is not None:
        return cached
    rng = np.random.default_rng(seed)
    half = int(math.sqrt(width * height))
    pts = rng.integers(-half, half + 1, size=(256, 2))
    mask = (
        (np.abs(pts[:, 0]) < width // 2) & (np.abs(pts[:, 1]) < height // 2)
    )
    pattern = pts[mask][:256]
    if len(pattern) < 256:
        pattern = rng.integers(-half, half + 1, size=(256, 2))
    _BRIEF_PATTERN_CACHE[key] = pattern.astype(np.int64)
    return _BRIEF_PATTERN_CACHE[key]


def brief_describe(gray: np.ndarray, points: np.ndarray,
                   patch: int = 15) -> np.ndarray:
    """BRIEF binary descriptors, returned as a boolean matrix (N x 256).

    The sampling pattern gives (dy, dx) offsets. For a sub-pixel point the
    patch origin is the integer pixel and the fractional remainder is applied
    as a bilinear offset, so descriptors stay stable for corners at any
    sub-pixel location.
    """
    n = len(points)
    desc = np.zeros((n, 256), dtype=bool)
    if n == 0:
        return desc
    half = patch // 2
    ih, iw = gray.shape
    pattern = brief_pattern(patch, patch)
    ph, pw = pattern[:, 0].astype(np.float64), pattern[:, 1].astype(np.float64)

    for i in range(n):
        x, y = float(points[i, 0]), float(points[i, 1])
        xi, yi = int(math.floor(x)), int(math.floor(y))
        fx, fy = x - xi, y - yi
        if xi - half < 0 or yi - half < 0 or xi + half + 2 > iw or yi + half + 2 > ih:
            continue
        # Sample with a 1px margin so +half offsets can never leave the patch.
        patch_img = gray[yi - half:yi + half + 2, xi - half:xi + half + 2]
        ph_, pw_ = patch_img.shape
        base = half

        ay = np.clip(np.round(base + fy + ph).astype(np.int64), 0, ph_ - 1)
        ax = np.clip(np.round(base + fx + pw).astype(np.int64), 0, pw_ - 1)
        by = np.clip(np.round(base + fy - ph).astype(np.int64), 0, ph_ - 1)
        bx = np.clip(np.round(base + fx - pw).astype(np.int64), 0, pw_ - 1)
        desc[i] = patch_img[ay, ax] < patch_img[by, bx]
    return desc


def match_descriptors(desc_a: np.ndarray, desc_b: np.ndarray,
                      ratio: float = 0.8, cross_check: bool = True
                      ) -> tuple[np.ndarray, np.ndarray]:
    """Lowe-ratio matching over Hamming distance.

    Returns index arrays (idx_a, idx_b). Packed-bit XOR plus popcount keeps this
    fast enough for a few hundred features per frame on CPU.
    """
    if len(desc_a) < 2 or len(desc_b) < 2:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.int64)

    def pack(d: np.ndarray) -> np.ndarray:
        return np.packbits(d.astype(np.uint8), axis=1)

    pa, pb = pack(desc_a), pack(desc_b)
    dist = np.count_nonzero(pa[:, None, :] ^ pb[None, :, :], axis=2)

    order = np.argsort(dist, axis=1)
    first = order[:, 0]
    second = order[:, 1]
    d1 = dist[np.arange(len(dist)), first]
    d2 = dist[np.arange(len(dist)), second]

    good = (d1.astype(np.float64) <= ratio * np.maximum(d2, 1))
    ia = np.nonzero(good)[0]

    if cross_check:
        rev_order = np.argsort(dist, axis=0)
        rev_best = rev_order[0, :]
        keep = rev_best[first[ia]] == ia
        ia = ia[keep]
    return ia, first[ia]


# --------------------------------------------------------------------------
# Two-view geometry
# --------------------------------------------------------------------------


def eight_point_fundamental(pts_a: np.ndarray, pts_b: np.ndarray) -> np.ndarray:
    """Normalised 8-point algorithm; F maps b-points to a-points."""
    if len(pts_a) < 8:
        raise ValueError("fundamental matrix needs at least 8 correspondences")
    an, Ta = normalize_points(pts_a)
    bn, Tb = normalize_points(pts_b)
    A = np.zeros((len(an), 9), dtype=np.float64)
    A[:, 0] = bn[:, 0]
    A[:, 1] = bn[:, 1]
    A[:, 2] = 1.0
    A[:, 3] = -an[:, 0] * bn[:, 0]
    A[:, 4] = -an[:, 0] * bn[:, 1]
    A[:, 5] = -an[:, 0]
    A[:, 6] = -an[:, 1] * bn[:, 0]
    A[:, 7] = -an[:, 1] * bn[:, 1]
    A[:, 8] = -an[:, 1]
    _, _, Vt = np.linalg.svd(A)
    F = Vt[-1].reshape(3, 3)
    # Enforce the rank-2 constraint.
    U, S, Vt2 = np.linalg.svd(F)
    S[2] = 0.0
    F = U @ np.diag(S) @ Vt2
    F = Ta.T @ F @ Tb
    return F / max(float(np.linalg.norm(F)), K_EPS)


def sampson_error(F: np.ndarray, pts_a: np.ndarray, pts_b: np.ndarray) -> np.ndarray:
    """First-order geometric error; comparable across correspondences."""
    ones = np.ones(len(pts_a))
    xa = np.column_stack([pts_a, ones])
    xb = np.column_stack([pts_b, ones])
    Fx_a = (F @ xa.T).T
    Ftx_b = (F.T @ xb.T).T
    num = np.sum(xb * Fx_a, axis=1) ** 2
    den = Fx_a[:, 0] ** 2 + Fx_a[:, 1] ** 2 + Ftx_b[:, 0] ** 2 + Ftx_b[:, 1] ** 2
    return num / np.maximum(den, 1e-12)


def ransac_fundamental(pts_a: np.ndarray, pts_b: np.ndarray,
                       threshold_px: float = 1.5, iterations: int = 2000,
                       confidence: float = 0.999, seed: int = 0
                       ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """RANSAC F estimation. Returns (F, inlier_mask, quality)."""
    n = len(pts_a)
    if n < 8:
        raise ValueError("need at least 8 correspondences for RANSAC")
    rng = np.random.default_rng(seed)
    best_inliers = np.zeros(n, dtype=bool)
    best_F: Optional[np.ndarray] = None
    best_score = -1.0
    thr = max(float(threshold_px), 1e-6)

    for it in range(iterations):
        idx = rng.choice(n, size=8, replace=False)
        try:
            F = eight_point_fundamental(pts_a[idx], pts_b[idx])
        except (np.linalg.LinAlgError, ValueError):
            continue
        err = sampson_error(F, pts_a, pts_b)
        inliers = err < thr
        count = int(inliers.sum())
        if count > best_score:
            best_score = float(count)
            best_inliers = inliers
            best_F = F
            ratio = count / n
            # Adaptive stopping (Fischler & Bolles).
            if ratio > 0 and ratio < 1.0:
                denom = np.log(max(1.0 - confidence, 1e-9) / max(math.log(max(1.0 - ratio, 1e-9)), 1e-9))
                needed = int(math.ceil(math.log(max(1.0 - confidence, 1e-9)) / denom))
                if needed <= it + 1:
                    break
    if best_score < 8 or best_F is None:
        raise RuntimeError(
            "fundamental matrix estimation failed: fewer than 8 inliers "
            f"(best {int(best_score)}/{n})")

    # Re-fit on all inliers for a lower-noise final estimate.
    if best_score >= 8:
        try:
            refined = eight_point_fundamental(pts_a[best_inliers], pts_b[best_inliers])
            ref_err = sampson_error(refined, pts_a, pts_b)
            ref_inliers = ref_err < thr
            if int(ref_inliers.sum()) >= max(8, int(0.9 * best_score)):
                best_F = refined
                best_inliers = ref_inliers
                best_score = float(ref_inliers.sum())
        except (np.linalg.LinAlgError, ValueError):
            pass

    return best_F, best_inliers, np.array([best_score / n])


def essential_from_fundamental(F: np.ndarray, K: np.ndarray) -> np.ndarray:
    Ki = np.linalg.inv(K)
    E = Ki.T @ F @ Ki
    U, S, Vt = np.linalg.svd(E)
    if np.linalg.det(U) < 0:
        U[:, -1] *= -1
    if np.linalg.det(Vt) < 0:
        Vt[-1, :] *= -1
    return U @ np.diag([1.0, 1.0, 0.0]) @ Vt


def pose_from_essential(E: np.ndarray, pts_a: np.ndarray, pts_b: np.ndarray,
                        K: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
    """Four candidate (R, t) pairs, ranked by cheirality vote count."""
    U, _, Vt = np.linalg.svd(E)
    if np.linalg.det(U) < 0:
        U[:, -1] *= -1
    if np.linalg.det(Vt) < 0:
        Vt[-1, :] *= -1

    W = np.array([[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
    R1 = U @ W @ Vt
    R2 = U @ W.T @ Vt
    t = U[:, 2]
    if t[2] < 0:
        t = -t

    rays_a = _normalized_rays(pts_a, K)
    rays_b = _normalized_rays(pts_b, K)
    P1 = np.hstack([np.eye(3), np.zeros((3, 1))])

    candidates: list[tuple[np.ndarray, np.ndarray]] = []
    for R in (R1, R2):
        for sign in (1.0, -1.0):
            tvec = sign * t
            P2 = np.hstack([R, tvec[:, None]])
            C2 = -R.T @ tvec
            pos = 0
            for x1 in rays_a:
                v1 = P1 @ np.append(x1, 1.0)
                v2 = P2 @ np.append(x1, 1.0)
                # Midpoint method keeps the triangulation depth-invariant.
                A = np.vstack([v1, v2])
                _, _, Vh = np.linalg.svd(A)
                X = Vh[-1]
                if abs(X[3]) < 1e-12:
                    continue
                X = X / X[3]
                if X[2] > 0 and (X - C2)[2] > 0:
                    pos += 1
            candidates.append((R, tvec, pos))  # type: ignore[arg-type]
    candidates.sort(key=lambda c: -c[2])  # type: ignore[index]
    return [(c[0], c[1]) for c in candidates[:4]]  # type: ignore[index]


def _normalized_rays(pts: np.ndarray, K: np.ndarray) -> np.ndarray:
    ones = np.ones(len(pts))
    homo = np.column_stack([pts, ones])
    return np.linalg.inv(K) @ homo.T


# --------------------------------------------------------------------------
# Views, tracks and triangulation
# --------------------------------------------------------------------------


@dataclass
class View:
    view_id: int
    image_name: str
    camera: Camera
    R: Optional[np.ndarray] = None   # world -> camera rotation
    t: Optional[np.ndarray] = None   # world -> camera translation
    points: np.ndarray = field(default_factory=lambda: np.zeros((0, 2)))
    descriptors: Optional[np.ndarray] = None
    registered: bool = False

    @property
    def center(self) -> np.ndarray:
        if self.R is None or self.t is None:
            raise RuntimeError(f"view {self.view_id} is not registered")
        return -self.R.T @ self.t

    @property
    def projection(self) -> np.ndarray:
        K = self.camera.K
        R = np.eye(3) if self.R is None else self.R
        t = np.zeros(3) if self.t is None else self.t
        return K @ np.hstack([R, t[:, None]])


@dataclass
class Track:
    """A 3D point observed by several views."""
    xyz: np.ndarray
    obs: dict[int, int] = field(default_factory=dict)  # view_id -> feature index
    color: Optional[np.ndarray] = None
    error: float = 0.0


def triangulate_multiview(Rt: list[np.ndarray], K: np.ndarray,
                         observations: list[np.ndarray]) -> np.ndarray:
    """Linear (DLT) triangulation. Rt are 3x4 world->camera matrices."""
    rows = []
    for P, uv in zip(Rt, observations):
        x, y = uv
        rows.append(x * P[2] - P[0])
        rows.append(y * P[2] - P[1])
    A = np.vstack(rows)
    _, _, Vh = np.linalg.svd(A)
    X = Vh[-1]
    if abs(X[3]) < 1e-12:
        raise RuntimeError("triangulation produced a point at infinity")
    return X[:3] / X[3]


def reprojection_error(P: np.ndarray, X: np.ndarray, uv: np.ndarray) -> float:
    p = P @ np.append(X, 1.0)
    if abs(p[2]) < 1e-9:
        return float("inf")
    proj = p[:2] / p[2]
    return float(np.linalg.norm(proj - uv))


def triangulate_track(views: Sequence[View], obs: dict[int, int],
                      min_angle_deg: float = 1.0) -> Optional[tuple[np.ndarray, float]]:
    """Triangulate one track, rejecting degenerate/low-parallax geometry."""
    ids = [v for v in obs if views[v].registered]
    if len(ids) < 2:
        return None
    Rt = [views[v].projection for v in ids]
    observations = [views[v].points[obs[v]] for v in ids]
    centers = np.array([views[v].center for v in ids])

    # Parallax check: triangulation is ill-conditioned when rays are parallel.
    best_pair, best_angle = None, 0.0
    for i in range(len(centers)):
        for j in range(i + 1, len(centers)):
            d = centers[j] - centers[i]
            n = np.linalg.norm(d)
            if n < 1e-9:
                continue
            cosang = abs(float(d @ views[ids[i]].R[2]) / n)
            ang = math.degrees(math.acos(min(1.0, cosang)))
            if ang > best_angle:
                best_angle, best_pair = ang, (i, j)
    if best_pair is None or best_angle < min_angle_deg:
        return None

    X = triangulate_multiview(Rt, None, observations)  # type: ignore[arg-type]
    errs = [reprojection_error(P, X, uv) for P, uv in zip(Rt, observations)]
    return X, float(np.mean(errs))