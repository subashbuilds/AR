"""Synthetic ground-truth capture generator.

Renders a textured 3D object from a known orbit of camera poses so the SfM
pipeline can be validated against *known* geometry. This is test fixture code
(clearly isolated from production behaviour): it never ships in a job path.

Usage:
    python3 -m tests.make_fixture --out DIR --views 24
"""

from __future__ import annotations

import argparse
import json
import math
import os
from typing import Optional

import numpy as np
from PIL import Image

# Reuse the exact camera model from the pipeline so intrinsics cannot drift.
import sys
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "services", "reconstruction-worker"))

from pipeline.sfm import Camera, camera_from_resolution  # noqa: E402


def build_object_mesh(kind: str = "blob") -> tuple[np.ndarray, np.ndarray]:
    """Return (vertices Vx3, faces Fx3) plus per-vertex colour."""
    if kind == "blob":
        n_theta, n_phi = 96, 48
        th = np.linspace(0, math.pi, n_theta)
        ph = np.linspace(0, 2 * math.pi, n_phi)
        T, P = np.meshgrid(th, ph, indexing="ij")
        # Superellipsoid-ish lump: deterministic, non-symmetric, textured.
        r = 1.0 + 0.18 * np.sin(3 * P) * np.sin(T) ** 2 + 0.10 * np.cos(2 * T + P)
        x = r * np.sin(T) * np.cos(P)
        y = r * np.cos(T) * 0.85
        z = r * np.sin(T) * np.sin(P)
        V = np.stack([x.ravel(), y.ravel(), z.ravel()], axis=1)

        def vid(i, j):
            return i * n_phi + (j % n_phi)

        F = []
        for i in range(n_theta - 1):
            for j in range(n_phi):
                F.append([vid(i, j), vid(i + 1, j), vid(i + 1, j + 1)])
                F.append([vid(i, j), vid(i + 1, j + 1), vid(i, j + 1)])
        F = np.array(F, dtype=np.int64)

        # Checker + stripe texture so features are trackable and visually rich.
        cols = []
        for p in V:
            u = (p[0] * 2.0) % 1.0
            w = (p[2] * 2.0) % 1.0
            band = 0.5 + 0.5 * np.sin(p[1] * 6.0)
            r = 0.9 if (u > 0.5) else 0.2
            g = 0.85 if (w > 0.5) else 0.25
            b = 0.3 + 0.6 * band
            cols.append([r, g, b])
        return V, F, np.array(cols)

    raise ValueError(f"unknown mesh kind: {kind}")


def uv_param(p: np.ndarray) -> np.ndarray:
    """Stable 2D surface parameterisation used to drive the fixture texture."""
    n = p / max(float(np.linalg.norm(p)), 1e-9)
    return np.stack([np.arctan2(n[2], n[0]) / (2 * math.pi) + 0.5,
                     n[1] * 0.5 + 0.5], axis=0)


def texture(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Rich, asymmetric, non-periodic procedural texture.

    Design constraints, each of which matters for feature matching:

    * Non-periodic on purpose. A perfect checkerboard is 4-fold symmetric, so
      its dominant gradient orientation is ambiguous and orientation-normalised
      descriptors (SIFT-style) cannot disambiguate it. Real objects do not have
      exact lattice symmetry, so the fixture must not either.
    * Asymmetric in brightness, so the local orientation is well defined and
      stable under viewpoint change.
    * Multi-band, so there are corners at several scales without aliasing.

    Built from incommensurate sinusoids plus a smooth value-noise field, which
    is aperiodic but band-limited (no hash speckle, which aliases badly under
    JPEG and defeats sub-pixel localisation).
    """
    # Texture cycles across the object. This is an aliasing/feature-density
    # trade-off: cycles must be fine enough to give hundreds of well-localised
    # corners, but coarse enough that after 3x3 supersampling and downsampling
    # at least ~4 real pixels remain per cycle. At the default 1024x768 render
    # (~300 px object) this is the safe optimum; lower values starve the
    # detector, higher values alias and destroy sub-pixel localisation.
    uu = u * 22.0
    vv = v * 22.0

    def vnoise(x, y, freq, seed):
        """Smooth, deterministic 2-D value noise with aperiodic content."""
        gx = freq * 0.5
        gy = freq * 0.7320508075688772  # irrational offset kills periodicity
        pts_x = x * gx + seed * 13.7
        pts_y = y * gy + seed * 7.1
        xi = np.floor(pts_x)
        yi = np.floor(pts_y)
        xf = pts_x - xi
        yf = pts_y - yi
        # Smoothstep interpolation.
        u = xf * xf * (3 - 2 * xf)
        v = yf * yf * (3 - 2 * yf)

        def h(ix, iy):
            val = np.sin(ix * 127.1 + iy * 311.7) * 43758.5453
            return val - np.floor(val)

        n00 = h(xi, yi)
        n10 = h(xi + 1, yi)
        n01 = h(xi, yi + 1)
        n11 = h(xi + 1, yi + 1)
        return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v

    n1 = vnoise(uu, vv, 1.0, 1) * 2.0 - 1.0
    n2 = vnoise(uu, vv, 2.3, 2) * 2.0 - 1.0
    n3 = vnoise(uu, vv, 4.7, 3) * 2.0 - 1.0

    # Sharp asymmetric edges give strong, well-localised corners.
    edge = np.tanh(3.0 * n1)
    band = np.sin(1.7 * uu + 0.9 * vv + 1.3)
    fine = np.sin(4.3 * uu - 3.1 * vv + 0.4)

    r = 0.5 + 0.30 * edge + 0.12 * n2 + 0.06 * fine
    g = 0.5 + 0.22 * n2 - 0.16 * edge + 0.09 * band + 0.05 * n3
    b = 0.5 - 0.24 * edge + 0.14 * n3 + 0.08 * band + 0.06 * n1
    return np.stack([r, g, b], axis=1)


def _raster_depth(V, F, Twc, cam, width, height, ss):
    """Second pass: exact per-pixel world position via barycentric depth."""
    W, H = width * ss, height * ss
    fx, fy = cam.fx * ss, cam.fy * ss
    cx, cy = cam.cx * ss, cam.cy * ss
    world = np.hstack([V, np.ones((len(V), 1))])
    cp = (Twc @ world.T).T[:, :3]
    z = cp[:, 2]
    ok = z > 1e-6
    u = np.where(ok, fx * cp[:, 0] / np.where(ok, z, 1) + cx, 0.0)
    v = np.where(ok, fy * cp[:, 1] / np.where(ok, z, 1) + cy, 0.0)

    depth = np.full((H, W), np.inf)
    tri = cp[F]
    zt = np.where(tri[:, :, 2] < 1e-6, 1e-6, tri[:, :, 2])
    okf = (tri[:, :, 2] > 1e-6).all(axis=1)
    Ut, Vt = u[F], v[F]

    for t in range(len(F)):
        if not okf[t]:
            continue
        u0, u1, u2 = Ut[t]
        v0, v1, v2 = Vt[t]
        z0, z1, z2 = zt[t]
        minx = max(int(math.floor(min(u0, u1, u2))), 0)
        maxx = min(int(math.ceil(max(u0, u1, u2))), W - 1)
        miny = max(int(math.floor(min(v0, v1, v2))), 0)
        maxy = min(int(math.ceil(max(v0, v1, v2))), H - 1)
        if minx > maxx or miny > maxy:
            continue
        det = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2)
        if abs(det) < 1e-12:
            continue
        xs = np.arange(minx, maxx + 1)
        ys = np.arange(miny, maxy + 1)
        gx, gy = np.meshgrid(xs, ys)
        w0 = ((v1 - v2) * (gx - u2) + (u2 - u1) * (gy - v2)) / det
        w1 = ((v2 - v0) * (gx - u2) + (u0 - u2) * (gy - v2)) / det
        w2 = 1.0 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        zz = w0 / z0 + w1 / z1 + w2 / z2
        zz = np.where(np.abs(zz) > 1e-12, 1.0 / zz, np.inf)
        flat = (gy * W + gx)[inside]
        vals = zz[inside]
        upd = vals < depth.reshape(-1)[flat]
        if not upd.any():
            continue
        depth.reshape(-1)[flat[upd]] = vals[upd]

    depth = depth.reshape(height, ss, width, ss)
    # Keep the sub-pixel minimum so the sampled depth stays on the surface.
    depth = depth.min(axis=(1, 3))
    return depth


def orbit_poses(n_views: int, radius: float, height: float,
                elevation_deg: float = 8.0) -> list[np.ndarray]:
    """World->camera matrices on a tilted orbit.

    Each returned 4x4 maps world points into the camera frame
    (x right, y down, z forward, OpenCV convention), which is what
    `render()` expects. The basis is orthonormal with det = +1 and the
    translation is -R * eye, so the camera centre is exactly `eye`.
    """
    poses = []
    elev = math.radians(elevation_deg)
    for i in range(n_views):
        a = 2 * math.pi * i / n_views
        # Alternate the elevation a little to exercise a non-planar capture.
        el = elev * (1.0 if i % 2 == 0 else -0.6)
        eye = np.array([
            radius * math.cos(a) * math.cos(el),
            radius * math.sin(el) + height * 0.15,
            radius * math.sin(a) * math.cos(el),
        ])
        fwd = -eye
        fwd = fwd / np.linalg.norm(fwd)
        # Pick the reference axis least aligned with the view direction, then
        # build a right-handed basis explicitly. cross(fwd, up) alone is
        # degenerate near the poles.
        axis = np.array([1.0, 0.0, 0.0])
        if abs(float(fwd @ axis)) > 0.9:
            axis = np.array([0.0, 0.0, 1.0])
        right = np.cross(fwd, axis)
        right = right / np.linalg.norm(right)
        down = np.cross(fwd, right)
        down = down / np.linalg.norm(down)
        fwd = np.cross(right, down)
        fwd = fwd / np.linalg.norm(fwd)
        Rwc = np.stack([right, down, fwd], axis=0)
        assert abs(np.linalg.det(Rwc) - 1.0) < 1e-9, "camera basis must be a rotation"
        Twc = np.eye(4)
        Twc[:3, :3] = Rwc
        Twc[:3, 3] = -Rwc @ eye
        poses.append(Twc)
    return poses


def render(V: np.ndarray, F: np.ndarray, C: np.ndarray, Twc: np.ndarray,
           cam: Camera, width: int, height: int, supersample: int = 2) -> np.ndarray:
    """Simple z-buffered rasteriser with flat shading."""
    ss = supersample
    W, H = width * ss, height * ss
    fx, fy = cam.fx * ss, cam.fy * ss
    cx, cy = cam.cx * ss, cam.cy * ss

    world = np.hstack([V, np.ones((len(V), 1))])
    cam_pts = (Twc @ world.T).T[:, :3]
    z = cam_pts[:, 2]
    valid = z > 1e-4
    u = np.where(valid, fx * cam_pts[:, 0] / np.where(valid, z, 1) + cx, 0.0)
    v = np.where(valid, fy * cam_pts[:, 1] / np.where(valid, z, 1) + cy, 0.0)

    color_img = np.zeros((H, W, 3), dtype=np.float64)
    zbuf = np.full((H, W), np.inf)

    tri = cam_pts[F]
    zt = tri[:, :, 2]
    ok = (zt > 1e-4).all(axis=1)
    Ut = u[F]
    Vt_ = v[F]
    zt = np.where(zt < 1e-4, 1e-4, zt)

    # Precompute per-face shading once (lighting does not depend on the view).
    face_rgb = np.zeros((len(F), 3), dtype=np.float64)
    face_normals = np.zeros((len(F), 3), dtype=np.float64)
    light = np.array([0.4, 0.7, 0.55])
    light /= np.linalg.norm(light)
    for t in range(len(F)):
        vv0, vv1, vv2 = V[F[t, 0]], V[F[t, 1]], V[F[t, 2]]
        n = np.cross(vv1 - vv0, vv2 - vv0)
        nn = np.linalg.norm(n)
        if nn < 1e-12:
            continue
        n = n / nn
        face_normals[t] = n
        shade = 0.35 + 0.65 * abs(float(n @ light))
        centroid = (vv0 + vv1 + vv2) / 3.0
        uu = (centroid[0] * 2.0) % 1.0
        ww = (centroid[2] * 2.0) % 1.0
        band = 0.5 + 0.5 * math.sin(centroid[1] * 6.0)
        face_rgb[t] = np.array([0.9 if uu > 0.5 else 0.2, 0.85 if ww > 0.5 else 0.25,
                                0.3 + 0.6 * band]) * shade

    for t in range(len(F)):
        if not ok[t]:
            continue
        u0, u1, u2 = Ut[t]
        v0, v1, v2 = Vt_[t]
        z0, z1, z2 = zt[t]
        minx = max(int(math.floor(min(u0, u1, u2))), 0)
        maxx = min(int(math.ceil(max(u0, u1, u2))), W - 1)
        miny = max(int(math.floor(min(v0, v1, v2))), 0)
        maxy = min(int(math.ceil(max(v0, v1, v2))), H - 1)
        if minx > maxx or miny > maxy:
            continue
        det = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2)
        if abs(det) < 1e-12:
            continue
        xs = np.arange(minx, maxx + 1)
        ys = np.arange(miny, maxy + 1)
        gx, gy = np.meshgrid(xs, ys)
        w0 = ((v1 - v2) * (gx - u2) + (u2 - u1) * (gy - v2)) / det
        w1 = ((v2 - v0) * (gx - u2) + (u0 - u2) * (gy - v2)) / det
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-9) & (w1 >= -1e-9) & (w2 >= -1e-9)
        if not inside.any():
            continue
        zinv = w0 / z0 + w1 / z1 + w2 / z2
        zz = np.where(np.abs(zinv) > 1e-12, 1.0 / np.where(np.abs(zinv) > 1e-12, zinv, 1), np.inf)

        # IMPORTANT: write through flat indices. `zbuf[gy, gx]` would return a
        # copy, so the depth/color updates would be silently discarded.
        flat = (gy * W + gx)[inside]
        zz_in = zz[inside]
        upd = zz_in < zbuf.reshape(-1)[flat]
        if not upd.any():
            continue
        sel_flat = flat[upd]

        # Per-pixel texture via barycentric interpolation of a world-space
        # parameterisation. Flat per-face colour would leave triangle interiors
        # gradient-free, which yields almost no trackable corners.
        w0u, w1u = w0[inside][upd], w1[inside][upd]
        p0, p1, p2 = V[F[t, 0]], V[F[t, 1]], V[F[t, 2]]
        # Spherical-ish UV from object position.
        uv0 = uv_param(p0)
        uv1 = uv_param(p1)
        uv2 = uv_param(p2)
        uu = w0u * uv0[0] + w1u * uv1[0] + (1 - w0u - w1u) * uv2[0]
        vv = w0u * uv0[1] + w1u * uv1[1] + (1 - w0u - w1u) * uv2[1]
        rgb_pix = texture(uu, vv) * face_rgb[t][None, :]

        zbuf.reshape(-1)[sel_flat] = zz_in[upd]
        color_img.reshape(-1, 3)[sel_flat] = np.clip(rgb_pix, 0.0, 1.0)

    # Box-downsample only: blurring here would destroy the corner signal the
    # detector depends on, and real sensors keep native sharpness.
    img = color_img.reshape(height, ss, width, ss, 3).mean(axis=(1, 3))
    yy, xx = np.mgrid[0:height, 0:width]
    cxr, cyr = width / 2.0, height / 2.0
    r = np.sqrt(((xx - cxr) / cxr) ** 2 + ((yy - cyr) / cyr) ** 2)
    img *= np.clip(1.05 - 0.18 * r**2, 0.0, 1.4)[:, :, None]
    rng = np.random.default_rng(1234)
    img += rng.normal(0.0, 0.004, img.shape)
    return np.clip(img, 0.0, 1.0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--views", type=int, default=24)
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument("--height", type=int, default=768)
    ap.add_argument("--kind", default="blob")
    ap.add_argument("--radius", type=float, default=9.5)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    img_dir = os.path.join(args.out, "images")
    os.makedirs(img_dir, exist_ok=True)
    depth_dir = os.path.join(args.out, "depth")
    os.makedirs(depth_dir, exist_ok=True)

    V, F, cols = build_object_mesh(args.kind)
    cam = camera_from_resolution(args.width, args.height, hfov_deg=60.0)
    # Capture geometry matters: photogrammetry needs ~60-70% overlap between
    # adjacent views. At radius 4.2 with a ~2-unit-wide object, adjacent views
    # overlapped only ~32%, which starves matching of real correspondences.
    # radius=9.5 with 24 views gives ~60-70% overlap.
    poses = orbit_poses(args.views, radius=args.radius, height=1.1)
    ss = 3  # supersampling: keeps the high-frequency texture from aliasing

    gt = {"views": [], "intrinsics": {
        "width": args.width, "height": args.height, "fx": cam.fx,
        "fy": cam.fy, "cx": cam.cx, "cy": cam.cy},
        "capture": {"radius": args.radius, "views": args.views}}
    for i, Twc in enumerate(poses):
        arr = render(V, F, cols, Twc, cam, args.width, args.height, supersample=ss)
        name = f"frame_{i:04d}.jpg"
        Image.fromarray((arr * 255).astype(np.uint8)).save(
            os.path.join(img_dir, name), quality=97, subsampling=0)
        # Exact per-pixel depth: lets tests lift any detected pixel to its true
        # 3D position, so correspondence correctness is measured, not assumed.
        depth = _raster_depth(V, F, Twc, cam, args.width, args.height, ss)
        np.save(os.path.join(depth_dir, f"frame_{i:04d}.npy"), depth.astype(np.float32))
        gt["views"].append({"name": name, "Twc": Twc.tolist()})
        print(f"rendered {name}")

    # Ground-truth object extent, used by dimension/scale validation tests.
    gt["object_bbox_min"] = V.min(axis=0).tolist()
    gt["object_bbox_max"] = V.max(axis=0).tolist()
    gt["object_extent"] = (V.max(axis=0) - V.min(axis=0)).tolist()

    with open(os.path.join(args.out, "ground_truth.json"), "w") as f:
        json.dump(gt, f, indent=2)
    print(f"wrote ground truth for {len(poses)} views to {args.out}")


if __name__ == "__main__":
    main()