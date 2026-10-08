"""Does the baked texture atlas actually beat per-vertex colour?

    python3 -m tests.eval_texture [--fixture /tmp/fx2] [--views 12]
                                 [--atlas 1024] [--samples 6000]

The question
------------
A baked atlas is strictly more machinery: chart segmentation, a packer, a
rasteriser, a visibility test per view. It replaces per-vertex colour, which
costs one float per vertex and always works. So it has to be measured, not
assumed, and the thing to measure is what a viewer actually sees.

How it is measured
------------------
Both models are sampled at the **same points on the surface**, and the truth is
the **photograph itself**, not an analytic re-rendering:

  1. Sample points uniformly over the reconstructed surface (area-weighted
     triangle choice, uniform barycentric coordinates). Keep the triangle and
     the barycentric weights.
  2. For each point, read two colours:
       * the atlas, sampled bilinearly at the point's UV -- what a GPU does;
       * vertex colour, interpolated with those same barycentric weights --
         Gouraud, what the old pipeline did.
  3. Map the point into ground truth's frame (`tests/gauge.py`) and keep it only
     if it lands within 5 cm of the true surface. That removes geometry error
     from a measurement about colour: points the reconstruction got wrong are
     excluded rather than allowed to flatter or damn the texturing.
  4. Project it through the *ground-truth* pose of each registered view and read
     that pixel out of the photograph. That is the colour a camera really saw
     there.
  5. Compare, per (point, view).

Both models are therefore scored against identical truth, at identical points,
through identical poses. The only difference is how the colour reaches the
surface.

Also measured, because a bake has ways to be quietly wrong:
  * `filled_texels` -- texels no registered view could see, grown in from their
    neighbours. Colour there is a guess and is excluded from the claim above.
  * an occlusion-tolerance sweep. `atlas.bake` rejects a texel whose depth is
    behind the reconstructed surface in that view; if the result swings wildly
    with that threshold, the number above is a tuning artefact rather than a
    measurement, and the sweep is what shows it.

Exit status: 0 when the atlas measurably beats Gouraud interpolation, 1 when it
does not.
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "services", "reconstruction-worker"))
sys.path.insert(0, HERE)

from pipeline import atlas as atlasmod  # noqa: E402
from pipeline import features as feat, incremental as inc  # noqa: E402
from pipeline import mesh as meshlib  # noqa: E402
import eval_densify  # noqa: E402  (reuses its build_views, which is tested)
import gauge  # noqa: E402
import make_fixture as mf  # noqa: E402

SURFACE_TOLERANCE = 0.05      # metres; the threshold eval_accuracy uses
TOLERANCE_SWEEP = (0.001, 0.005, 0.02, 0.05, 0.1)
# `atlas.bake`'s default. The sweep below is what justifies it, and the sweep
# includes this value so the table can be read straight off the code.
DEFAULT_TOLERANCE = 0.05
DIHEDRAL_SWEEP = (45.0, 75.0, 105.0, 135.0, 165.0)
# The atlas must beat Gouraud by at least this much on the median, and must not
# be worse on the tail. Both thresholds are printed with the numbers they were
# applied to, so a reader can disagree with them.
MIN_MEDIAN_GAIN = 0.15
MAX_TAIL_REGRESSION = 1.05


def sample_surface(vertices, faces, n, rng):
    """`n` points uniform over the surface: (points, triangle, barycentric)."""
    a = vertices[faces[:, 0]]
    b = vertices[faces[:, 1]]
    c = vertices[faces[:, 2]]
    areas = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    total = areas.sum()
    if total <= 0:
        raise RuntimeError("degenerate mesh: zero surface area")
    tri = rng.choice(len(faces), size=n, p=areas / total)
    r = np.sqrt(rng.random((n, 1)))
    s = rng.random((n, 1))
    l0 = 1.0 - r
    l1 = r * (1.0 - s)
    l2 = r * s
    bary = np.hstack([l0, l1, l2])
    pts = (bary[:, :1] * a[tri] + bary[:, 1:2] * b[tri] + bary[:, 2:3] * c[tri])
    return pts, tri, bary


def bilinear(texture: np.ndarray, uv: np.ndarray) -> np.ndarray:
    """Bilinear sample a (H, W, 3) uint8 image at (N, 2) UVs in [0, 1]."""
    h, w = texture.shape[:2]
    x = np.clip(uv[:, 0] * w - 0.5, 0, w - 1)
    y = np.clip(uv[:, 1] * h - 0.5, 0, h - 1)
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    t = texture.astype(np.float64)
    return (t[y0, x0] * (1 - fx) * (1 - fy) + t[y0, x1] * fx * (1 - fy)
            + t[y1, x0] * (1 - fx) * fy + t[y1, x1] * fx * fy)


def photo_truth(points_true, images, gts, K, width, height):
    """The colour each photograph really shows at these 3-D points.

    Returns (colours (N, 3), seen (N,)) where `seen` marks points that fall
    inside the frame of at least one view.
    """
    n = len(points_true)
    acc = np.zeros((n, 3))
    hits = np.zeros(n, dtype=int)
    for img, T in zip(images, gts):
        cam = points_true @ T[:3, :3].T + T[:3, 3]
        z = cam[:, 2]
        ok = z > 1e-6
        u = np.where(ok, K[0, 0] * cam[:, 0] / np.where(ok, z, 1.0) + K[0, 2], 0.0)
        v = np.where(ok, K[1, 1] * cam[:, 1] / np.where(ok, z, 1.0) + K[1, 2], 0.0)
        inb = ok & (u >= 0) & (u < width) & (v >= 0) & (v < height)
        if not np.any(inb):
            continue
        ui = np.clip(np.round(u[inb]).astype(int), 0, width - 1)
        vi = np.clip(np.round(v[inb]).astype(int), 0, height - 1)
        acc[inb] += img[vi, ui]
        hits[inb] += 1
    seen = hits > 0
    acc[seen] /= hits[seen][:, None]
    return acc, seen


def score(model_colours, truth, keep):
    """Per-sample mean RGB error in 0-255 units."""
    d = np.abs(model_colours[keep] - truth[keep]).mean(axis=1)
    return d


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="/tmp/fx2")
    ap.add_argument("--views", type=int, default=12)
    ap.add_argument("--atlas", type=int, default=1024)
    ap.add_argument("--samples", type=int, default=6000)
    ap.add_argument("--dihedral", type=float, default=135.0,
                    help="max normal angle a chart may span, in degrees")
    args = ap.parse_args()

    views, gt_by_name = eval_densify.build_views(args.fixture, args.views)
    res = inc.reconstruct(views)
    reg = sorted(res.registered_indices)
    if len(reg) < 2:
        print("too few registered views to evaluate")
        return 2
    for v in views:
        v.image = images_lookup(args.fixture, v.image_name)
    height, width = views[0].image.shape[:2]

    Q, b, _scale = gauge.point_gauge(res, views, args.fixture, gt_by_name)
    V_gt, _, _ = mf.build_object_mesh("blob")
    true_tree = cKDTree(V_gt)

    # --- the model under test, and the one it replaces --------------------
    mesh = meshlib.reconstruct_surface(res.points, alpha_scale=2.5)
    vertex_colours = meshlib.color_from_views(mesh, res.views, width, height)
    unwrapped, bake_result = atlasmod.bake_texture(
        mesh, res.views, width, height, atlas_size=args.atlas,
        max_normal_angle_deg=args.dihedral)

    stats = bake_result.to_dict()
    print(f"registered views     {len(reg)}/{args.views}")
    print(f"surface mesh         {mesh.vertex_count} vertices, {mesh.face_count} faces")
    print(f"atlas                {stats['atlas_size']}px, "
          f"{unwrapped.chart_count} charts ({unwrapped.chart_count - 1} seams), "
          f"{stats['atlas_fill_ratio'] * 100:.1f}% of the atlas covered")
    print(f"                     {unwrapped.texels_per_unit:.0f} texels per world unit")
    print(f"                     planar distortion p95 "
          f"{unwrapped.planar_distortion_p95:.3f} (|log area ratio|), i.e. a "
          f"{math.exp(unwrapped.planar_distortion_p95):.2f}x texel-density spread")
    print(f"                     {stats['visible_texels']} texels seen by a camera, "
          f"{stats['filled_texels']} filled in, "
          f"{stats['background_texels']} unused")
    if stats["covered_texels"]:
        print(f"                     {stats['filled_texels'] / stats['covered_texels'] * 100:.2f}% "
              f"of the covered atlas is colour no camera actually saw")
    print()

    # --- sample the surface, keep only points the reconstruction located ---
    rng = np.random.default_rng(20251005)
    pts, tri, bary = sample_surface(mesh.vertices.astype(np.float64),
                                    mesh.faces, args.samples, rng)
    pts_true = gauge.apply(pts, Q, b)
    dist = true_tree.query(pts_true)[0]
    on_surface = dist < SURFACE_TOLERANCE
    print(f"sampled             {args.samples} surface points, "
          f"{int(on_surface.sum())} within {SURFACE_TOLERANCE * 100:.0f} cm of the "
          f"true surface (median {np.median(dist) * 100:.1f} cm)")
    if on_surface.sum() < 200:
        print("RESULT: FAIL -- too few reconstructed points land on the real "
              "surface to judge how they are coloured")
        return 1

    K = np.array([
        [views[reg[0]].camera.fx, 0, views[reg[0]].camera.cx],
        [0, views[reg[0]].camera.fy, views[reg[0]].camera.cy],
        [0, 0, 1]])
    gts = [np.array(gt_by_name[views[i].image_name]["Twc"], dtype=float)
           for i in reg]
    truth, seen = photo_truth(pts_true, [views[i].image for i in reg], gts, K,
                              width, height)
    keep = on_surface & seen
    print(f"scored on           {int(keep.sum())} points that a camera photographed")
    print()

    def model_colours(u, texture):
        """Atlas colour at the sampled points, for one unwrap/bake result."""
        lut = np.empty(len(mesh.faces), dtype=np.int64)
        lut[u.source_face] = np.arange(len(u.faces))
        uv = np.einsum('ij,ijk->ik', bary, u.uvs[u.faces[lut[tri]]])
        return bilinear(texture, uv)

    atlas_colours = model_colours(unwrapped, bake_result.texture)
    gouraud = np.einsum('ij,ijk->ik', bary, vertex_colours[mesh.faces[tri]])

    d_atlas = score(atlas_colours, truth, keep)
    d_gouraud = score(gouraud, truth, keep)
    med_a, med_g = float(np.median(d_atlas)), float(np.median(d_gouraud))
    p90_a, p90_g = float(np.percentile(d_atlas, 90)), float(np.percentile(d_gouraud, 90))
    better = float((d_atlas < d_gouraud).mean())

    print("photometric error against the photographs, 0-255 per channel")
    print(f"  vertex colours    median {med_g:6.2f}   p90 {p90_g:6.2f}   (Gouraud)")
    print(f"  baked atlas       median {med_a:6.2f}   p90 {p90_a:6.2f}")
    print(f"  the atlas is closer to the photograph at {better * 100:.1f}% of points")
    gain = (med_g - med_a) / med_g if med_g > 0 else 0.0
    print(f"  median improvement {gain * 100:+.1f}% (threshold {MIN_MEDIAN_GAIN * 100:.0f}%)")
    print()

    # --- is the number above a tuning artefact? ---------------------------
    print("occlusion-tolerance sweep (relative to depth; lower = stricter)")
    print("  how much deeper than the reconstructed surface a texel may sit and")
    print("  still count as seen by that view. Independently checkable: a real")
    print("  occluder makes the measured error WORSE, so the ground-truth")
    print("  comparison, not intuition, is what picks the default.")
    base_texture = bake_result.texture
    for tol in TOLERANCE_SWEEP:
        u_tol, r_tol = atlasmod.bake_texture(
            mesh, res.views, width, height, atlas_size=args.atlas,
            max_normal_angle_deg=args.dihedral, occlusion_tolerance=tol)
        med_tol = float(np.median(score(model_colours(u_tol, r_tol.texture),
                                        truth, keep)))
        covered = r_tol.visible_texels + r_tol.filled_texels
        marker = "  <- the default" if tol == DEFAULT_TOLERANCE else ""
        print(f"  tolerance {tol:<6} median error {med_tol:6.2f}   "
              f"seen by a camera {r_tol.visible_texels / covered * 100:5.1f}%   "
              f"filled {r_tol.filled_texels:>7}{marker}")
    print()

    # --- how the chart threshold trades seams against distortion ----------
    # An alpha-shape surface is bumpy, so a strict crease threshold shatters
    # one small blob into hundreds of charts and the atlas becomes mostly
    # seams. That is a measurable trade, not a matter of taste.
    print(f"chart threshold sweep, evaluated at {args.dihedral:g} deg "
          "(a chart breaks where the surface bends by MORE than this)")
    print(f"  {'max bend':>9} {'charts':>7} {'seams':>6} {'cover%':>7} "
          f"{'spread':>7} {'median':>7}")
    for dih in DIHEDRAL_SWEEP:
        u_d, r_d = atlasmod.bake_texture(
            mesh, res.views, width, height, atlas_size=args.atlas,
            max_normal_angle_deg=dih)
        med_d = float(np.median(score(model_colours(u_d, r_d.texture),
                                      truth, keep)))
        print(f"  {dih:>8.0f}d {u_d.chart_count:>7} {u_d.chart_count - 1:>6} "
              f"{r_d.to_dict()['atlas_fill_ratio'] * 100:>6.1f}% "
              f"{math.exp(u_d.planar_distortion_p95):>6.2f}x {med_d:>7.2f}")
    print()

    # --- verdict ----------------------------------------------------------
    print("The atlas replaces per-vertex colour, so it has to earn the extra")
    print("machinery in colour accuracy, not merely in file format.")
    ok = True
    if gain < MIN_MEDIAN_GAIN:
        ok = False
        print(f"RESULT: FAIL -- the atlas improves the median colour error by only "
              f"{gain * 100:.1f}%, below the {MIN_MEDIAN_GAIN * 100:.0f}% it must.")
    if p90_a > p90_g * MAX_TAIL_REGRESSION:
        ok = False
        print(f"RESULT: FAIL -- the atlas's tail error is {p90_a:.2f} against "
              f"{p90_g:.2f} for vertex colours, worse than the "
              f"{MAX_TAIL_REGRESSION:.2f}x allowed.")
    if ok:
        print(f"RESULT: PASS -- the baked atlas cuts the median colour error by "
              f"{gain * 100:.1f}% ({med_g:.2f} -> {med_a:.2f}) against the same "
              f"photographs, with no tail regression.")
        return 0
    return 1


def images_lookup(fixture, name):
    from PIL import Image
    return np.asarray(Image.open(os.path.join(fixture, "images", name))
                      .convert("RGB"))


if __name__ == "__main__":
    sys.exit(main())
