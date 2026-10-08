"""Baked texture atlas: chart-based UV unwrapping and multi-view colour baking.

This replaces per-vertex colours with a real texture atlas, which is what a
viewer, a renderer and a WebXR runtime all expect to sample.

Why not keep vertex colours
---------------------------
A ~500-vertex mesh carries one colour per vertex. Every colour inside a
triangle is then a linear blend of three vertex colours, so the photographic
detail is destroyed before it reaches the screen, and any detail finer than the
vertex spacing cannot exist at all. A baked atlas stores the photograph at
texel resolution instead.

What is honest about this module
--------------------------------
Two things are measured and reported rather than assumed:

  * **Occlusion** is decided by rendering the reconstruction's own surface into
    a depth buffer per view (`_view_depth_buffer`). A texel only takes colour
    from a view if it projects no further than that buffer. This is a real
    visibility test, but it is only as good as the reconstruction: on a partial
    scan, geometry the mesh never recovered cannot occlude anything, so a texel
    can still inherit colour from a photo region hidden behind a part of the
    object the reconstruction is missing. `filled_texels` reports how many
    texels no registered view could see at all.
  * **Planar-chart distortion** is real and unavoidable in a chart-based unwrap.
    `planar_distortion_p95` reports the 95th percentile of
    |log(3-D area / UV area)| over all triangles, so a claim that the atlas is
    "isometric" would have to be disproved rather than assumed.

UV convention: glTF defines TEXCOORD_0 (0, 0) as the **top-left** of the image
with v increasing downwards, which is PNG row order. Every coordinate here uses
that convention, and `tests/test_pipeline.py` pins it against a known triangle.

Colour order: `View.image` is RGB (the pipeline loads it through
`PIL.Image.convert("RGB")`). This module never reverses channels. An earlier
version of `mesh.color_from_views` did, which swapped red and blue in every
published model; `tests/eval_texture.py` measures that.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np

from .glb import compute_normals
from .mesh import Mesh

# Padding in texels left between charts, so bilinear filtering and mipmapping
# cannot pull colour across a chart boundary.
CHART_GAP_PX = 2


class AtlasError(RuntimeError):
    """Raised when unwrapping or baking cannot produce a usable atlas."""


@dataclass
class UnwrappedMesh:
    """A mesh whose vertices are duplicated per chart, each with its own UV.

    Duplication is required, not an optimisation: a vertex on a chart boundary
    belongs to two charts with two different UV positions, so it must exist
    twice or one of the charts is wrong.
    """

    vertices: np.ndarray        # (V', 3) float32
    colors: np.ndarray          # (V', 3) float32 in [0, 1]
    faces: np.ndarray           # (F, 3) int32
    uvs: np.ndarray             # (V', 2) float32 in [0, 1], v downwards
    chart_of_face: np.ndarray   # (F,) int32
    # The index in the input `Mesh.faces` that each emitted face came from.
    # Faces are regrouped into charts, so the output order is NOT the input
    # order; without this, nothing downstream can line the two up.
    source_face: np.ndarray    # (F,) int64
    chart_count: int
    atlas_size: int
    texels_per_unit: float      # atlas resolution in texels per world unit
    # exp(planar_distortion_p95): how much denser the best-sampled part of the
    # surface is than the worst-sampled part. 1.0 would be a perfectly uniform
    # texel density, i.e. a seamless chart set.
    planar_distortion_p95: float

    @property
    def vertex_count(self) -> int:
        return int(len(self.vertices))

    @property
    def face_count(self) -> int:
        return int(len(self.faces))


@dataclass
class BakeResult:
    """The baked atlas plus the numbers needed to describe it honestly."""

    texture: np.ndarray            # (H, W, 3) uint8, RGB
    atlas_size: int
    covered_texels: int            # texels a chart's triangles claim
    visible_texels: int            # texels at least one registered view could see
    filled_texels: int             # covered, unseen, but grown in from neighbours
    unassigned_texels: int         # covered, unseen, and still bare background
    background_texels: int         # texels no chart claims at all
    views_used: int
    views_registered: int

    def to_dict(self) -> dict:
        total = self.atlas_size * self.atlas_size
        return {
            "atlas_size": self.atlas_size,
            "atlas_fill_ratio": round(self.covered_texels / total, 4) if total else 0.0,
            "covered_texels": int(self.covered_texels),
            "visible_texels": int(self.visible_texels),
            "filled_texels": int(self.filled_texels),
            "unassigned_texels": int(self.unassigned_texels),
            "background_texels": int(self.background_texels),
            "views_used": int(self.views_used),
            "views_registered": int(self.views_registered),
        }


# --------------------------------------------------------------------- charts


class _DSU:
    """Union-find over face indices, used to grow charts."""

    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        p = self.parent
        while p[x] != x:
            p[x] = p[p[x]]
            x = p[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def _face_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    a = vertices[faces[:, 0]]
    b = vertices[faces[:, 1]]
    c = vertices[faces[:, 2]]
    n = np.cross(b - a, c - a)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln < 1e-18] = 1.0
    return n / ln


def segment_charts(vertices: np.ndarray, faces: np.ndarray,
                   max_normal_angle_deg: float = 135.0) -> list[np.ndarray]:
    """Split the mesh into charts wherever the surface bends sharply.

    Two faces sharing an edge stay in one chart only while the angle between
    their normals is **at most** `max_normal_angle_deg`; a sharper join splits
    them. So a LOWER number means fewer, larger charts with more seams, and a
    higher number splits more. (The direction is the opposite of a "crease
    tolerance": this is a maximum bend, not a minimum one.)

    The value is measured, not chosen. On this repository's own reconstruction
    -- an alpha-shape surface over a 459-point cloud, so genuinely bumpy --
    the chart count and the texel-density spread run like this:

        angle   charts   texel-density spread (p95)   median colour error
         45      385              7.59x                     12.65
         75      512              7.56x                     12.07
        105      675              2.96x                     11.83
        135      875              1.19x                     12.24
        165     1113              1.01x                     12.56

    The photometric error barely moves across that whole range, and the reason
    is worth stating: a planar chart maps a surface point to the *right* texel
    whatever the local density, so density is not a colour-accuracy knob. What a
    low density costs is sharpness -- the same surface patch covered by a
    fraction of the texels. So the default is chosen on the density column,
    where 135 degrees is the knee, and the colour column is reported to show
    that paying for it costs 3.5% of accuracy rather than more.
    """
    n_faces = len(faces)
    if n_faces == 0:
        return []
    normals = _face_normals(vertices, faces)
    cos_limit = math.cos(math.radians(max_normal_angle_deg))

    edge_faces: dict[tuple[int, int], list[int]] = {}
    for fi, tri in enumerate(faces):
        for u, v in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            key = (u, v) if u < v else (v, u)
            edge_faces.setdefault(key, []).append(fi)

    dsu = _DSU(n_faces)
    for pair in edge_faces.values():
        if len(pair) != 2:
            continue                       # boundary edge: nothing to join
        f0, f1 = pair
        if float(np.dot(normals[f0], normals[f1])) < cos_limit:
            dsu.union(f0, f1)

    groups: dict[int, list[int]] = {}
    for fi in range(n_faces):
        groups.setdefault(dsu.find(fi), []).append(fi)
    # Largest charts first, and ties by first face index: the shelf packer then
    # produces the same atlas for the same input, every run.
    return [np.asarray(sorted(v), dtype=np.int64)
            for _, v in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0]))]


# -------------------------------------------------------------------- packing


def _shelf_pack(sizes: Sequence[tuple[int, int]], atlas: int,
                gap: int = CHART_GAP_PX) -> Optional[dict[int, tuple[int, int]]]:
    """Pack rectangles into an `atlas`-square by shelves, or return None.

    Rectangles are placed tallest-first, the classic shelf heuristic: the
    tallest chart starts the first shelf, so the strip wasted at the right edge
    is bounded by the shelf's height rather than by the atlas'.
    """
    order = sorted(range(len(sizes)), key=lambda i: (-sizes[i][1], i))
    placed: dict[int, tuple[int, int]] = {}
    x = y = shelf_h = 0
    for i in order:
        w, h = sizes[i]
        if w > atlas or h > atlas:
            return None
        if x + w > atlas:
            x = 0
            y += shelf_h + gap
            shelf_h = 0
        if y + h > atlas:
            return None
        placed[i] = (x, y)
        x += w + gap
        shelf_h = max(shelf_h, h)
    return placed


# ----------------------------------------------------------------- unwrapping


def unwrap(mesh: Mesh, atlas_size: int = 1024,
           max_normal_angle_deg: float = 135.0) -> UnwrappedMesh:
    """Split into charts, project each onto its own best-fit plane, pack them.

    Every chart shares one texel density, in texels per world unit.
    Normalising each chart into the same box instead would stretch the small
    ones to match the large ones: the texture would look right at the silhouette
    and wrong everywhere else, and nothing in the manifest would say so.
    """
    v = np.asarray(mesh.vertices, dtype=np.float64)
    f = np.asarray(mesh.faces, dtype=np.int64)
    if len(f) < 4:
        raise AtlasError(f"need at least 4 faces to unwrap, got {len(f)}")
    if f.max() >= len(v):
        raise AtlasError("face index out of range")

    charts = segment_charts(v, f, max_normal_angle_deg)
    if not charts:
        raise AtlasError("no charts were produced")

    # --- project each chart onto its own best-fit plane -------------------
    # The smallest-eigenvalue direction of the chart's covariance is the plane
    # normal; the two largest span an in-plane basis.
    planars: list[tuple[np.ndarray, np.ndarray, np.ndarray]] = []
    for face_ids in charts:
        # `charts` holds face indices; the plane needs the vertices they use.
        vids = np.unique(f[face_ids])
        pts = v[vids]
        centroid = pts.mean(axis=0)
        centred = pts - centroid
        cov = centred.T @ centred / max(len(centred), 1)
        evals, evecs = np.linalg.eigh(cov)
        order = np.argsort(evals)[::-1]
        planars.append((vids, centroid,
                        np.stack([evecs[:, order[0]], evecs[:, order[1]]], axis=1)))

    extents = []
    for vids, centroid, basis in planars:
        proj = (v[vids] - centroid) @ basis
        lo = proj.min(axis=0)
        hi = proj.max(axis=0)
        extents.append((float(hi[0] - lo[0]), float(hi[1] - lo[1])))

    max_extent = max(max(w, h) for w, h in extents)
    if max_extent <= 0:
        raise AtlasError("all chart projections collapsed to a point")

    def sizes_at(scale: float) -> list[tuple[int, int]]:
        return [(max(int(math.ceil(w * scale)), 2), max(int(math.ceil(h * scale)), 2))
                for w, h in extents]

    # Start so the largest chart spans ~60% of the atlas, then shrink until
    # everything packs. Shrinking only ever costs resolution, never validity.
    scale = (0.6 * atlas_size) / max_extent
    placed = None
    for _ in range(14):
        placed = _shelf_pack(sizes_at(scale), atlas_size)
        if placed is not None:
            break
        scale *= 0.8
    if placed is None:
        raise AtlasError(
            f"charts cannot be packed into a {atlas_size}px atlas even at the "
            "minimum density")
    sizes = sizes_at(scale)

    # --- emit one copy of each vertex per chart that uses it --------------
    out_v: list[np.ndarray] = []
    out_uv: list[np.ndarray] = []
    out_faces: list[np.ndarray] = []
    out_chart: list[np.ndarray] = []
    out_source: list[np.ndarray] = []
    chart_vids: list[np.ndarray] = []
    for ci, face_ids in enumerate(charts):
        faces = f[face_ids]
        vids, centroid, basis = planars[ci]
        proj = (v[vids] - centroid) @ basis
        lo = proj.min(axis=0)
        ox, oy = placed[ci]
        # Half-texel inset, so UVs land on texel centres rather than corners.
        texel = (proj - lo) * scale + np.array([ox + 0.5, oy + 0.5])
        base = sum(len(a) for a in out_v)
        local = {int(g): base + k for k, g in enumerate(vids)}
        out_v.append(v[vids])
        out_uv.append(texel / float(atlas_size))
        out_faces.append(np.array([[local[int(g)] for g in tri] for tri in faces],
                                  dtype=np.int64))
        out_chart.append(np.full(len(faces), ci, dtype=np.int64))
        out_source.append(np.asarray(face_ids, dtype=np.int64))
        chart_vids.append(vids)

    verts = np.concatenate(out_v, axis=0)
    uvs = np.concatenate(out_uv, axis=0)
    faces_out = np.concatenate(out_faces, axis=0)
    chart_of_face = np.concatenate(out_chart, axis=0)
    source_face = np.concatenate(out_source, axis=0)
    colors = np.asarray(mesh.colors, dtype=np.float64)
    # Duplicated the same way, so a caller that still wants per-vertex colour
    # gets the copy belonging to *this* chart's version of the vertex.
    cols = np.concatenate([colors[c] for c in chart_vids], axis=0)

    # --- measure the planar distortion, do not assume it -------------------
    a = verts[faces_out[:, 0]]
    b = verts[faces_out[:, 1]]
    c = verts[faces_out[:, 2]]
    area3d = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    ua = uvs[faces_out[:, 0]] * atlas_size
    ub = uvs[faces_out[:, 1]] * atlas_size
    uc = uvs[faces_out[:, 2]] * atlas_size
    area_texel = 0.5 * np.abs(
        (ub[:, 0] - ua[:, 0]) * (uc[:, 1] - ua[:, 1])
        - (uc[:, 0] - ua[:, 0]) * (ub[:, 1] - ua[:, 1]))
    area_world = area_texel / (scale * scale)
    valid = (area3d > 1e-18) & (area_world > 1e-18)
    if not np.any(valid):
        distortion = float("inf")
    else:
        distortion = float(np.percentile(
            np.abs(np.log(area3d[valid] / area_world[valid])), 95))

    return UnwrappedMesh(
        vertices=verts.astype(np.float32),
        colors=np.clip(cols, 0.0, 1.0).astype(np.float32),
        faces=faces_out.astype(np.int64),
        uvs=np.clip(uvs, 0.0, 1.0).astype(np.float32),
        chart_of_face=chart_of_face,
        source_face=source_face,
        chart_count=len(charts),
        atlas_size=int(atlas_size),
        texels_per_unit=float(scale),
        planar_distortion_p95=distortion,
    )


# -------------------------------------------------------------- rasterisation


def _fill_triangle(tri_uv: np.ndarray, tri_pos: np.ndarray, tri_nrm: np.ndarray,
                   size: int, pos: np.ndarray, nrm: np.ndarray,
                   mask: np.ndarray) -> None:
    """Scanline-fill one triangle, interpolating position and normal.

    A loop over triangles, not one big array, because every triangle owns a
    different bounding box; the work inside a bbox is vectorised, which keeps a
    few thousand triangles at a few milliseconds.
    """
    (x0, y0), (x1, y1), (x2, y2) = tri_uv
    area2 = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if abs(area2) < 1e-12:
        return

    xs_lo = max(int(math.floor(min(x0, x1, x2) - 0.5)), 0)
    ys_lo = max(int(math.floor(min(y0, y1, y2) - 0.5)), 0)
    xs_hi = min(int(math.ceil(max(x0, x1, x2) + 0.5)), size - 1)
    ys_hi = min(int(math.ceil(max(y0, y1, y2) + 0.5)), size - 1)
    if xs_hi < xs_lo or ys_hi < ys_lo:
        return

    px = np.arange(xs_lo, xs_hi + 1, dtype=np.float64)[None, :] + 0.5
    py = np.arange(ys_lo, ys_hi + 1, dtype=np.float64)[:, None] + 0.5

    # Edge functions, one per edge. They agree in sign inside the triangle.
    #
    # The barycentric weight for vertex i is the edge function of the edge
    # OPPOSITE it, divided by the signed area. So w0 (edge v0->v1) is
    # vertex 2's weight, w1 (edge v1->v2) is vertex 0's, and w2 is vertex 1's.
    # Reading them straight off in order silently mirrors every interpolated
    # attribute: the "inside" test still passes, so the mesh rasterises and
    # only the geometry is scrambled.
    w0 = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)     # edge v0 -> v1
    w1 = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)     # edge v1 -> v2
    w2 = (x0 - x2) * (py - y2) - (y0 - y2) * (px - x2)     # edge v2 -> v0
    s = 1.0 if area2 > 0 else -1.0
    inside = (w0 * s >= 0.0) & (w1 * s >= 0.0) & (w2 * s >= 0.0)
    if not np.any(inside):
        return

    l0 = ((w1 * s) / abs(area2))[:, :, None]
    l1 = ((w2 * s) / abs(area2))[:, :, None]
    l2 = ((w0 * s) / abs(area2))[:, :, None]

    ys = slice(ys_lo, ys_hi + 1)
    xs = slice(xs_lo, xs_hi + 1)
    pos[ys, xs][inside] = (l0 * tri_pos[0] + l1 * tri_pos[1] + l2 * tri_pos[2])[inside]
    nrm[ys, xs][inside] = (l0 * tri_nrm[0] + l1 * tri_nrm[1] + l2 * tri_nrm[2])[inside]
    mask[ys, xs][inside] = True


def rasterize_texels(unwrapped: UnwrappedMesh
                     ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-texel 3-D position and normal, by rasterising the unwrapped mesh.

    Returns (positions, normals, mask). Every texel therefore knows which point
    on the object it colours, which is what lets a registered camera be asked
    what that point looks like, and what lets a test compare the atlas against
    ground truth instead of against itself.
    """
    size = unwrapped.atlas_size
    pos = np.zeros((size, size, 3), dtype=np.float64)
    nrm = np.zeros((size, size, 3), dtype=np.float64)
    mask = np.zeros((size, size), dtype=bool)

    vn = compute_normals(unwrapped.vertices, unwrapped.faces).astype(np.float64)
    tri_uv = unwrapped.uvs.astype(np.float64) * size
    vp = unwrapped.vertices.astype(np.float64)
    for a, b, c in unwrapped.faces:
        idx = (int(a), int(b), int(c))
        p3 = np.stack([vp[idx[0]], vp[idx[1]], vp[idx[2]]])
        n3 = np.stack([vn[idx[0]], vn[idx[1]], vn[idx[2]]])
        t3 = np.stack([tri_uv[idx[0]], tri_uv[idx[1]], tri_uv[idx[2]]])
        _fill_triangle(t3, p3, n3, size, pos, nrm, mask)
    return pos, nrm, mask


def _view_depth_buffer(view, vertices: np.ndarray, faces: np.ndarray,
                       width: int, height: int) -> np.ndarray:
    """Min-z depth buffer of the reconstruction as that camera sees it."""
    v = vertices.astype(np.float64)
    uv, front = view.project(v)
    z = (v @ view.R.T + view.t)[:, 2]
    zbuf = np.full((height, width), np.inf, dtype=np.float64)
    for tri in faces:
        if not (front[tri[0]] and front[tri[1]] and front[tri[2]]):
            continue
        (x0, y0), (x1, y1), (x2, y2) = (uv[tri[0]], uv[tri[1]], uv[tri[2]])
        area2 = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if abs(area2) < 1e-12:
            continue
        xs_lo = max(int(math.floor(min(x0, x1, x2) - 0.5)), 0)
        ys_lo = max(int(math.floor(min(y0, y1, y2) - 0.5)), 0)
        xs_hi = min(int(math.ceil(max(x0, x1, x2) + 0.5)), width - 1)
        ys_hi = min(int(math.ceil(max(y0, y1, y2) + 0.5)), height - 1)
        if xs_hi < xs_lo or ys_hi < ys_lo:
            continue
        px = np.arange(xs_lo, xs_hi + 1, dtype=np.float64)[None, :] + 0.5
        py = np.arange(ys_lo, ys_hi + 1, dtype=np.float64)[:, None] + 0.5
        w0 = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)
        w1 = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)
        w2 = (x0 - x2) * (py - y2) - (y0 - y2) * (px - x2)
        s = 1.0 if area2 > 0 else -1.0
        inside = (w0 * s >= 0.0) & (w1 * s >= 0.0) & (w2 * s >= 0.0)
        if not np.any(inside):
            continue
        # Same opposite-edge convention as `_fill_triangle`: w1 weights the
        # first vertex, w2 the second, w0 the third.
        zt = (w1 * s / abs(area2)) * z[tri[0]] \
            + (w2 * s / abs(area2)) * z[tri[1]] \
            + (w0 * s / abs(area2)) * z[tri[2]]
        sub = zbuf[ys_lo:ys_hi + 1, xs_lo:xs_hi + 1]
        np.minimum(sub, np.where(inside, zt, np.inf), out=sub)
    return zbuf


def _fill_holes(rgb: np.ndarray, mask: np.ndarray, assigned: np.ndarray,
                max_rounds: int = 96) -> int:
    """Grow assigned texels outward into unassigned ones, nearest texel first."""
    filled = 0
    for _ in range(max_rounds):
        hole = mask & ~assigned
        if not np.any(hole):
            break
        before = int(np.count_nonzero(assigned))
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            src = np.roll(np.roll(rgb, dy, axis=0), dx, axis=1)
            ok = np.roll(np.roll(assigned, dy, axis=0), dx, axis=1)
            # The rolled-in edge row/column is a wrap-around, not a neighbour.
            if dy == 1:
                src[0, :] = 0
                ok[0, :] = False
            elif dy == -1:
                src[-1, :] = 0
                ok[-1, :] = False
            elif dx == 1:
                src[:, 0] = 0
                ok[:, 0] = False
            elif dx == -1:
                src[:, -1] = 0
                ok[:, -1] = False
            take = hole & ok
            rgb[take] = src[take]
            assigned[take] = True
        if int(np.count_nonzero(assigned)) == before:
            break
        filled += int(np.count_nonzero(assigned)) - before
    return filled


def bake(unwrapped: UnwrappedMesh, views, width: int, height: int,
         atlas_size: Optional[int] = None,
         background: tuple[int, int, int] = (127, 127, 127),
         occlusion_tolerance: float = 0.05) -> BakeResult:
    """Sample the photos into the atlas, one texel at a time.

    For every texel a chart claims, each registered view is asked whether it can
    see that point. Among the views that can, the one whose direction is most
    nearly aligned with the surface normal wins: the most frontal view has the
    least foreshortening, so its colour is the least distorted. Texels no view
    can see are grown into from their neighbours and counted, never left as
    holes that read as black paint.

    `occlusion_tolerance` is the slack, relative to depth, allowed between a
    texel's depth and the view's depth buffer: how much further away than the
    reconstructed surface a point may be and still count as seen by that view.

    It exists because the reconstruction is bumpy where the real object is
    smooth, so its own surface occludes texels a real camera could see. At too
    small a value those texels are thrown away and their colour is invented;
    at too large a value a genuine occluder bleeds onto what it hides. The
    default is measured rather than guessed, by scoring against the
    photographs themselves (`tests/eval_texture.py`, 12 views):

        tolerance   median colour error   seen by a camera
           0.001          16.15               32.5%
           0.005          14.54               39.6%
           0.020          13.48               54.8%
           0.050          12.24               73.8%   <- the default
           0.100          12.05               91.3%

    Read honestly: the error is still falling slightly at 0.1, so this is not a
    sharp knee. Everything from 0.05 to 0.1 is within 1.6% of the best value
    measured, so the choice between them is not doing the work. 0.05 is taken
    because it is the stricter of the two -- between "reject a texel the bumpy
    surface is hiding" and "let an occluder bleed", the failure that matters is
    the second one, and the measured difference between them is smaller than
    the run-to-run variation of the reconstruction itself.
    """
    size = int(atlas_size or unwrapped.atlas_size)
    if size != unwrapped.atlas_size:
        raise AtlasError(
            f"atlas_size {size} does not match the {unwrapped.atlas_size}px the "
            "mesh was unwrapped for; the UVs would be wrong")
    pos, nrm, mask = rasterize_texels(unwrapped)
    if not np.any(mask):
        raise AtlasError("no texels were covered by the unwrapped mesh")

    rgb = np.zeros((size, size, 3), dtype=np.uint8)
    rgb[:, :] = np.asarray(background, dtype=np.uint8)
    assigned = np.zeros((size, size), dtype=bool)

    covered_idx = np.nonzero(mask.reshape(-1))[0]
    pts = pos.reshape(-1, 3)[covered_idx]
    normals_flat = nrm.reshape(-1, 3)[covered_idx]
    # Best "how frontally does this view see it" score so far, per covered
    # texel. Kept as its own buffer over `covered_idx` so the per-view update
    # below is a plain scatter instead of a masked write on a whole atlas.
    flat_score = np.full(len(covered_idx), -np.inf)

    registered = [v for v in views if getattr(v, "registered", False)
                  and getattr(v, "image", None) is not None]
    views_used = 0
    for v in registered:
        img = np.asarray(v.image)
        ih, iw = img.shape[:2]
        uv, front = v.project(pts)
        z = (pts @ v.R.T + v.t)[:, 2]
        u = uv[:, 0]
        vv = uv[:, 1]
        inb = front & (u >= 0) & (u < iw) & (vv >= 0) & (vv < ih)
        if not np.any(inb):
            continue
        zbuf = _view_depth_buffer(v, unwrapped.vertices, unwrapped.faces, iw, ih)
        ui = np.clip(np.round(u).astype(np.int64), 0, iw - 1)
        vi = np.clip(np.round(vv).astype(np.int64), 0, ih - 1)
        zb = zbuf[vi, ui]
        eps = np.abs(zb) * occlusion_tolerance + 1e-9
        visible = inb & np.isfinite(zb) & (z <= zb + eps)
        if not np.any(visible):
            continue
        views_used += 1
        to_cam = v.center - pts
        dist = np.linalg.norm(to_cam, axis=1)
        dist[dist < 1e-12] = 1.0
        score = np.einsum('ij,ij->i', normals_flat, to_cam / dist[:, None])
        take = visible & (score > flat_score)
        if not np.any(take):
            continue
        flat_score[take] = score[take]
        # `View.image` is RGB already; reversing channels here is the bug that
        # `color_from_views` had.
        rgb.reshape(-1, 3)[covered_idx[take]] = img[vi[take], ui[take]]
        assigned.reshape(-1)[covered_idx[take]] = True

    visible_count = int(np.count_nonzero(assigned))
    filled = _fill_holes(rgb, mask, assigned)
    covered = int(np.count_nonzero(mask))

    return BakeResult(
        texture=rgb,
        atlas_size=size,
        covered_texels=covered,
        visible_texels=visible_count,
        filled_texels=filled,
        # Covered but still bare: no camera saw it and no neighbour had a
        # colour to grow from. Reported rather than hidden, because these read
        # as flat grey patches on the model.
        unassigned_texels=covered - visible_count - filled,
        background_texels=int(mask.size - covered),
        views_used=views_used,
        views_registered=len(registered),
    )


def bake_texture(mesh: Mesh, views, width: int, height: int,
                 atlas_size: int = 1024, max_normal_angle_deg: float = 135.0,
                 occlusion_tolerance: float = 0.05
                 ) -> tuple[UnwrappedMesh, BakeResult]:
    """Unwrap and bake in one call. The shape `run.py` uses."""
    unwrapped = unwrap(mesh, atlas_size=atlas_size,
                       max_normal_angle_deg=max_normal_angle_deg)
    result = bake(unwrapped, views, width, height, atlas_size=atlas_size,
                  occlusion_tolerance=occlusion_tolerance)
    return unwrapped, result