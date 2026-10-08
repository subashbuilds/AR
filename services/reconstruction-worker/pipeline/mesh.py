"""Surface reconstruction and texturing from a sparse coloured point cloud.

Given the SfM point cloud this module produces a triangle mesh suitable for
real-time display:

  * outlier rejection using the point cloud's own spread, so a handful of badly
    triangulated points cannot dominate the hull;
  * alpha-shape style surface reconstruction via 3-D Delaunay
    tetrahedralisation, keeping only tetrahedra whose circumsphere is small
    relative to the local sampling density, then extracting their boundary
    faces. This yields a closed surface that tracks the actual samples rather
    than the convex hull;
  * vertex colours sampled by projecting each vertex into its best view, which
    is a genuine multi-view colour estimate rather than a single-view smear.

Why alpha shapes instead of Poisson reconstruction: this was decided when
Poisson (screened/adaptive) could not be installed here. **That is no longer
true** -- Open3D 0.20 now installs, and Poisson was measured on this
repository's own cloud rather than left as an argument. It triples surface
coverage and puts 39% of the result in the orbit arc the capture never
photographed, because Poisson always closes the hull of whatever points it is
given (docs/status.md §3c, tests/eval_densify.py, which exits 1 by design).
So alpha shapes are kept for a measured reason, not an environmental one. They
need only scipy, run in seconds, and do not manufacture the side of the object
nobody walked around to. The trade-off is a less smooth surface.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

import numpy as np
from scipy.spatial import Delaunay


@dataclass
class Mesh:
    """Triangle mesh with per-vertex colour, in world units."""

    vertices: np.ndarray        # (V, 3) float32
    colors: np.ndarray         # (V, 3) float32 in [0, 1]
    faces: np.ndarray           # (F, 3) int32

    @property
    def vertex_count(self) -> int:
        return len(self.vertices)

    @property
    def face_count(self) -> int:
        return len(self.faces)

    def bbox(self) -> tuple[np.ndarray, np.ndarray]:
        if len(self.vertices) == 0:
            return np.zeros(3), np.zeros(3)
        return self.vertices.min(axis=0), self.vertices.max(axis=0)

    def extent(self) -> np.ndarray:
        lo, hi = self.bbox()
        return hi - lo

    def surface_area(self) -> float:
        """Sum of triangle areas (used to reject degenerate meshes)."""
        if len(self.faces) == 0:
            return 0.0
        a = self.vertices[self.faces[:, 0]]
        b = self.vertices[self.faces[:, 1]]
        c = self.vertices[self.faces[:, 2]]
        return float(0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1).sum())


def estimate_outlier_radius(points: np.ndarray) -> float:
    """Robust characteristic radius of the cloud via median nearest-neighbour
    distance. Used to reject stray triangulations without assuming the object
    is centred at the origin."""
    if len(points) < 2:
        return float("inf")
    # Sub-sample for tractability on large clouds.
    if len(points) > 4000:
        step = len(points) // 4000 + 1
        sample = points[::step]
    else:
        sample = points
    try:
        from scipy.spatial import cKDTree
        d, _ = cKDTree(sample).query(sample, k=2)
        nn = d[:, 1]
    except Exception:
        return float(np.median(np.linalg.norm(
            points[:, None, :] - points[None, ::7, :], axis=-1)))
    med = float(np.median(nn[nn > 0])) if np.any(nn > 0) else 1.0
    return med * 4.0


def reconstruct_surface(points: np.ndarray, colors: Optional[np.ndarray] = None,
                        alpha_scale: float = 2.5,
                        max_outlier_radius: Optional[float] = None
                        ) -> Mesh:
    """Build a closed triangle surface from a 3-D point cloud.

    ``alpha_scale`` controls how tight the surface hugs the samples: smaller
    values keep only tetrahedra that are small compared with the local point
    spacing, producing a bumpy surface that follows the data; larger values
    fill in concavities and give a smoother, more convex result.
    """
    pts = np.asarray(points, dtype=np.float64)
    if len(pts) < 4:
        raise ValueError("need at least 4 points to build a surface")

    # --- outlier rejection ---
    if max_outlier_radius is None:
        max_outlier_radius = estimate_outlier_radius(pts)
    centroid = pts.mean(axis=0)
    radii = np.linalg.norm(pts - centroid, axis=1)
    keep = radii <= np.percentile(radii, 99.0)
    # Always keep enough points to form a solid.
    if keep.sum() < 8:
        keep = np.ones(len(pts), dtype=bool)
    filtered = pts[keep]
    if colors is not None:
        filtered_colors = np.asarray(colors, dtype=np.float64)[keep]
    else:
        filtered_colors = None

    if len(filtered) < 4:
        raise ValueError("too few inlier points to build a surface")

    # --- Delaunay tetrahedralisation ---
    try:
        tri = Delaunay(filtered)
    except Exception as exc:  # QhullError and friends
        raise RuntimeError(f"3-D Delaunay tetrahedralisation failed: {exc}") from exc

    tets = tri.simplices
    if len(tets) == 0:
        raise RuntimeError("Delaunay produced no tetrahedra")

    # --- alpha criterion: circumradius vs local sampling density ---
    p = filtered[tets]  # (T, 4, 3)
    a = p[:, 1] - p[:, 0]
    b = p[:, 2] - p[:, 0]
    c = p[:, 3] - p[:, 0]
    # Solve for the circumcentre as the solution of M x = |v|^2 / 2.
    M = np.stack([a, b, c], axis=2)  # columns are the edge vectors
    rhs = 0.5 * np.sum(np.stack([a, b, c], axis=1) ** 2, axis=2)
    det = np.linalg.det(M)
    valid = np.abs(det) > 1e-18
    centre = np.zeros((len(tets), 3))
    centre[valid] = p[:, 0][valid]
    if np.any(valid):
        inv = np.linalg.inv(M[valid])
        sol = np.einsum('tij,tj->ti', inv, rhs[valid])
        centre[valid] = p[:, 0][valid] + sol
    circum_r = np.linalg.norm(centre - p[:, 0], axis=1)

    # Local edge length of each tetrahedron sets the scale it must beat.
    edges = np.stack([np.linalg.norm(a, axis=1), np.linalg.norm(b, axis=1),
                      np.linalg.norm(c, axis=1),
                      np.linalg.norm(p[:, 2] - p[:, 1], axis=1),
                      np.linalg.norm(p[:, 3] - p[:, 1], axis=1),
                      np.linalg.norm(p[:, 3] - p[:, 2], axis=1)], axis=1)
    local = edges.mean(axis=1)
    keep_tet = valid & (circum_r < alpha_scale * local)

    if keep_tet.sum() == 0:
        # Fall back to the convex hull so we still emit a valid closed mesh.
        return _convex_hull_mesh(filtered, filtered_colors)

    # --- boundary faces of the retained tetrahedra form the surface ---
    kept = tets[keep_tet]
    # Orient every face consistently and cancel pairs shared by two tets.
    faces = np.concatenate([kept[:, [0, 2, 1]], kept[:, [0, 1, 3]],
                            kept[:, [0, 3, 2]], kept[:, [1, 3, 2]]])
    keys = np.sort(faces, axis=1)
    uniq, inverse, counts = np.unique(keys, axis=0, return_inverse=True,
                                      return_counts=True)
    boundary = uniq[counts == 1]
    if len(boundary) == 0:
        return _convex_hull_mesh(filtered, filtered_colors)

    # Remap to the filtered point indices, keeping only real vertices.
    used = np.unique(boundary)
    remap = -np.ones(len(filtered), dtype=np.int64)
    remap[used] = np.arange(len(used))
    faces_out = remap[boundary].astype(np.int64)
    verts = filtered[used]

    # Drop triangles that are degenerate in world space.
    a = verts[faces_out[:, 0]]
    b = verts[faces_out[:, 1]]
    c = verts[faces_out[:, 2]]
    areas = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    eps = max(float(np.median(areas)) * 1e-4, 1e-12)
    faces_out = faces_out[areas > eps]

    if len(faces_out) == 0:
        return _convex_hull_mesh(filtered, filtered_colors)

    if filtered_colors is not None:
        cols = filtered_colors[used]
    else:
        cols = np.full((len(verts), 3), 0.8, dtype=np.float64)

    return Mesh(vertices=verts.astype(np.float32),
                colors=np.clip(cols, 0.0, 1.0).astype(np.float32),
                faces=faces_out.astype(np.int64))


def _convex_hull_mesh(points: np.ndarray, colors: Optional[np.ndarray]) -> Mesh:
    """Convex hull fallback, so a valid closed mesh is always produced."""
    try:
        hull = Delaunay(points)
        simp = hull.simplices
    except Exception:
        # Last-resort tetrahedron.
        v = points[:4].astype(np.float32)
        f = np.array([[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]], dtype=np.int64)
        cols = (np.asarray(colors[:4], dtype=np.float32)
                if colors is not None
                else np.full((4, 3), 0.8, dtype=np.float32))
        return Mesh(v, np.clip(cols, 0, 1), f)

    # Keep only hull faces: a tetrahedron face on the convex hull appears once.
    keys = np.sort(simp, axis=1)
    allf = np.concatenate([simp[:, [0, 2, 1]], simp[:, [0, 1, 3]],
                           simp[:, [0, 3, 2]], simp[:, [1, 3, 2]]])
    fk = np.sort(allf, axis=1)
    uniq, counts = np.unique(fk, axis=0, return_counts=True)
    boundary = uniq[counts == 1]
    used = np.unique(boundary)
    remap = -np.ones(len(points), dtype=np.int64)
    remap[used] = np.arange(len(used))
    verts = points[used]
    faces_out = remap[boundary]
    cols = (np.asarray(colors, dtype=np.float64)[used]
            if colors is not None else np.full((len(verts), 3), 0.8))
    return Mesh(verts.astype(np.float32),
                np.clip(cols, 0, 1).astype(np.float32),
                faces_out.astype(np.int64))


def color_from_views(mesh: Mesh, views, width: int, height: int,
                     max_offset_px: float = 4.0) -> np.ndarray:
    """Sample per-vertex colour by projecting into the best view.

    For each vertex we pick the registered camera that views it most frontally
    and sample that image, which avoids the smearing that comes from averaging
    views across occlusions or different exposures.

    `v.image` is RGB: `run.load_images` opens every photograph through
    `PIL.Image.convert("RGB")`, and `atlas.bake` relies on the same
    convention. An earlier version of this function named the sample `bgr` and
    reversed its channels, so every vertex colour this pipeline published had
    red and blue swapped. The atlas path does not reverse channels, so leaving
    the reversal here would have made the two paths disagree.
    """
    import cv2

    out = mesh.colors.copy()
    if len(mesh.vertices) == 0 or not views:
        return out

    remaining = list(range(len(mesh.vertices)))
    assigned: dict[int, np.ndarray] = {}

    for v in views:
        if not v.registered or not remaining:
            continue
        idx = np.array(remaining, dtype=np.int64)
        uv, front = v.project(mesh.vertices[idx].astype(np.float64))
        ui = uv[:, 0]
        vi = uv[:, 1]
        inb = (front & (ui >= 0) & (ui < width) & (vi >= 0) & (vi < height))
        if not np.any(inb):
            continue
        # Frontal score: the angle between the view ray and the optical axis.
        centres = []
        for k in np.nonzero(inb)[0]:
            g = idx[k]
            ray = mesh.vertices[g].astype(np.float64) - v.center
            n = np.linalg.norm(ray)
            if n < 1e-12:
                continue
            centres.append((g, float(abs((ray / n)[2]))))
        if not centres:
            continue
        centres.sort(key=lambda t: -t[1])
        for g, _score in centres:
            if g in assigned:
                continue
            x = int(round(float(ui[np.nonzero(idx == g)[0][0]])))
            y = int(round(float(vi[np.nonzero(idx == g)[0][0]])))
            rgb = v.image[y, x]
            assigned[g] = np.asarray(rgb, dtype=np.float32) / 255.0
        remaining = [g for g in remaining if g not in assigned]

    for g, col in assigned.items():
        out[g] = col
    return out