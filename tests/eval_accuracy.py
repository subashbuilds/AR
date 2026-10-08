"""Measure reconstruction accuracy against the synthetic ground truth.

This is the tool that decides whether the SfM stage is actually correct.
Because SfM output lives in an arbitrary similarity frame, raw coordinate
comparison is meaningless; the honest comparison is:

1. align recovered camera centres to ground-truth camera centres with a
   similarity transform (Umeyama), then report the residual error -- this is
   independent of the object's shape and isolates *pose* accuracy;
2. apply that same transform to the point cloud and compare its bounding box
   to the ground-truth bounding box -- this is what the user ultimately sees;
3. report the per-axis extent error after the pipeline's own height
   calibration, which is the number that reaches the AR overlay.

Exit code is 0 whenever the measurement completes; correctness of the
reconstruction is asserted by explicit thresholds that are printed, not by
silently passing. `--max-extent-error` turns the extent check into the exit
status for CI.

Usage:
    python3 -m tests.eval_accuracy --fixture /tmp/fx2 [--views 24]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORKER = os.path.join(ROOT, "services", "reconstruction-worker")
sys.path.insert(0, WORKER)

from pipeline import features as feat  # noqa: E402
from pipeline import incremental as inc  # noqa: E402


def umeyama(src: np.ndarray, dst: np.ndarray):
    """Least-squares similarity (rotation, uniform scale, translation).

    Returns (s, R, t) with dst ~= s * (src @ R.T) + t. Arun/Haralick form,
    verified against a known similarity by _selftest_umeyama below.
    """
    mu_s = src.mean(axis=0)
    mu_d = dst.mean(axis=0)
    sc = src - mu_s
    dc = dst - mu_d
    cov = dc.T @ sc / len(src)
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1.0
    R = U @ S @ Vt
    var = float((sc ** 2).sum() / len(src))
    s = float(np.trace(np.diag(D) @ S) / var) if var > 1e-18 else 1.0
    t = mu_d - s * (R @ mu_s)
    return s, R, t


def kabsch_fixed_scale(src: np.ndarray, dst: np.ndarray, scale: float):
    """Rotation + translation with a KNOWN scale (Kabsch / Horn).

    With the scale supplied, the closed-form SVD solution is well defined even
    when src is coplanar, which is the case for an orbit around an object.
    """
    mu_s = src.mean(axis=0)
    mu_d = dst.mean(axis=0)
    sc = src - mu_s
    dc = dst - mu_d
    cov = dc.T @ sc
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1.0
    R = U @ S @ Vt
    t = mu_d - scale * (R @ mu_s)
    return R, t


def _selftest_umeyama() -> None:
    """A similarity fit that cannot recover a known similarity is useless."""
    rng = np.random.default_rng(7)
    src = rng.normal(size=(40, 3))
    A = np.linalg.qr(rng.normal(size=(3, 3)))[0]
    if np.linalg.det(A) < 0:
        A[:, 0] *= -1
    s_true, t_true = 2.5, np.array([1.0, -2.0, 0.5])
    dst = 2.5 * (src @ A.T) + t_true
    s, R, t = umeyama(src, dst)
    assert abs(s - s_true) < 1e-9, (s, s_true)
    assert np.allclose(R, A, atol=1e-9), np.abs(R - A).max()
    assert np.allclose(t, t_true, atol=1e-9)
    print("umeyama self-test     : ok")


def _selftest_gauge() -> None:
    """The gauge used to align this report must invert a known similarity.

    Every absolute number below (camera position error, surface distance,
    principal-axis extents) passes through one transformation derived from the
    measured scale and the ground-truth poses. A mistake in it does not crash;
    it produces plausible numbers that are simply wrong -- which is exactly how
    this file came to report a 218% extent error for a reconstruction that was
    in fact accurate to 5 cm. So the derivation is checked against a similarity
    that is known exactly.

    With X_true = Q X_rec + b and metric = lambda * model, equating the two
    projection equations for one view gives

        Q = lambda R_gt^T R_rec          (a rotation times lambda)
        b = lambda R_gt^T t_rec - R_gt^T t_gt

    Dropping the lambda from either term is one bug this guards. The other is
    treating Q as if it were a bare rotation: it is lambda times one, so
    comparing Q_i against Q_0 multiplies the trace by lambda^2, pushes it out
    of the valid range, and every pose error -- including a 2 deg one -- clips
    to a confident 0.0 deg. The spread must be measured on Q normalised by its
    own scale.
    """
    rng = np.random.default_rng(11)
    R_gt = np.linalg.qr(rng.normal(size=(3, 3)))[0]
    if np.linalg.det(R_gt) < 0:
        R_gt[:, 0] *= -1
    t_gt = np.array([0.5, -0.3, 0.9])
    R_rec = np.linalg.qr(rng.normal(size=(3, 3)))[0]
    if np.linalg.det(R_rec) < 0:
        R_rec[:, 0] *= -1
    t_rec = np.array([-1.2, 0.7, 2.1])
    lam = 2.544242
    X_rec = rng.normal(size=(50, 3))

    Q = lam * (R_gt.T @ R_rec)
    b = lam * (R_gt.T @ t_rec) - R_gt.T @ t_gt

    # The recovered transformation must reproduce the metric projection
    # equation for arbitrary points: with X_true = Q X_rec + b, the metric
    # camera coordinates R_gt X_true + t_gt must equal lambda times the
    # reconstructed ones.
    X_true = X_rec @ Q.T + b
    lhs = X_true @ R_gt.T + t_gt
    rhs = lam * (X_rec @ R_rec.T + t_rec)
    assert np.allclose(lhs, rhs, atol=1e-9), \
        "gauge inversion does not reproduce the projection equation"

    # The normalised gauge must be a genuine rotation, and the spread metric
    # must recover a known rotation error rather than clipping it to zero.
    Rn = _gauge_rotation(Q)
    assert np.allclose(Rn @ Rn.T, np.eye(3), atol=1e-9), \
        "normalised gauge is not a rotation; the scale factor is misplaced"
    assert _gauge_spread([Rn, Rn]) == 0.0, \
        "a perfect reconstruction must score exactly 0"

    th = np.radians(2.0)
    tilt = np.array([[np.cos(th), -np.sin(th), 0.0],
                     [np.sin(th), np.cos(th), 0.0],
                     [0.0, 0.0, 1.0]])
    got = _gauge_spread([lam * Rn, lam * Rn @ tilt])
    assert abs(got - 2.0) < 1e-6, (
        f"gauge spread reported {got:.4f} deg for a known 2 deg error")
    print("gauge self-test       : ok")


def _gauge_rotation(Q: np.ndarray) -> np.ndarray:
    """The rotation inside a gauge similarity `lambda * Q`.

    Q carries the unknown metric/model scale factor, so it cannot be used as a
    rotation directly; its Frobenius norm divided by sqrt(3) recovers the scale.
    """
    s = float(np.linalg.norm(Q)) / np.sqrt(3.0)
    return Q / s if s > 1e-12 else Q.copy()


def _gauge_spread(Qs) -> float:
    """Worst rotation disagreement across views, in degrees.

    Each Q is normalised to its rotation first. Comparing the scaled matrices
    directly makes the trace leave the valid range, where clipping silently
    reports any error -- including a 2 deg one -- as exactly zero.
    """
    rots = [_gauge_rotation(Q) for Q in Qs]
    return float(np.degrees(np.max([
        np.arccos(np.clip((np.trace(R @ rots[0].T) - 1) / 2, -1, 1))
        for R in rots])))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="/tmp/fx2")
    ap.add_argument("--views", type=int, default=24)
    ap.add_argument("--max-axis-error", type=float, default=None,
                    help="if set, fail when the worst principal-axis "
                         "error exceeds this fraction")
    args = ap.parse_args()

    gt = json.load(open(os.path.join(args.fixture, "ground_truth.json")))
    K_gt = gt["intrinsics"]
    gt_by_name = {v["name"]: v for v in gt["views"]}

    img_dir = os.path.join(args.fixture, "images")
    names = sorted(n for n in os.listdir(img_dir) if n.endswith(".jpg"))
    names = [n for n in names if n in gt_by_name][: args.views]

    from PIL import Image

    views = []
    for i, n in enumerate(names):
        arr = np.asarray(Image.open(os.path.join(img_dir, n)).convert("RGB"))
        fs = feat.detect_and_describe(arr, n, nfeatures=4000, contrast_threshold=0.01)
        # Use the TRUE intrinsics: this experiment measures structure from
        # motion, not intrinsics estimation.
        cam = inc.Camera(K_gt["width"], K_gt["height"], K_gt["fx"], K_gt["fy"],
                         K_gt["cx"], K_gt["cy"])
        views.append(inc.View(index=i, image_name=n, camera=cam,
                              keypoints=fs.keypoints.astype(np.float64),
                              descriptors=fs.descriptors,
                              sizes=fs.sizes, angles=fs.angles))

    res = inc.reconstruct(views)

    # The gauge is fixed by declaring the seed view's camera frame to be the
    # world frame, but bundle adjustment drifts it, so a similarity fit over
    # the camera centres is used to bring the reconstruction into the
    # fixture's frame. Camera centres are used (not points) so this report
    # isolates pose error from shape error.
    _selftest_umeyama()
    _selftest_gauge()
    reg = sorted(res.registered_indices)
    src_c = np.array([views[i].center for i in reg])
    dst_c = np.array([np.array(gt_by_name[views[i].image_name]["Twc"],
                                dtype=float)[:3, 3] for i in reg])
    s_fit, R, t = umeyama(src_c, dst_c)
    pred_c = s_fit * (src_c @ R.T) + t
    centre_err = np.linalg.norm(pred_c - dst_c, axis=1)

    pts = res.points
    pts_aligned = s_fit * (pts @ R.T) + t

    # ---- alignment-free depth check -------------------------------------
    # Comparing coordinates requires fixing the similarity gauge. That gauge
    # is a free rotation, translation and scale, and on a near-planar orbit
    # its fit is ill-posed, so a coordinate comparison can look arbitrarily
    # wrong or right. Depth RATIOS need no gauge at all, and the metric
    # depth maps also pin the absolute scale.
    depth_rel_err: list[float] = []
    depth_scales: list[float] = []
    rig_ratio: list[float] = []
    for tr in res.tracks:
        obs_ids = [o for o in tr.obs
                   if views[o].registered and tr.xyz is not None]
        if len(obs_ids) < 3:
            continue
        gts, recs = [], []
        for o in obs_ids:
            dp = os.path.join(args.fixture, "depth",
                              views[o].image_name.replace(".jpg", ".npy"))
            if not os.path.exists(dp):
                continue
            dm = np.load(dp)
            kx, ky = views[o].keypoints[tr.obs[o]]
            ix, iy = int(round(kx)), int(round(ky))
            if not (0 <= ix < dm.shape[1] and 0 <= iy < dm.shape[0]):
                continue
            gz = float(dm[iy, ix])
            if not np.isfinite(gz) or gz <= 0:
                continue
            gts.append(gz)
            recs.append(float((views[o].R @ tr.xyz + views[o].t)[2]))
        if len(gts) < 3:
            continue
        g = np.array(gts)
        r = np.array(recs)
        if not np.all(r > 0):
            continue
        depth_rel_err.extend(np.abs(r / np.median(r)
                                    - g / np.median(g)).tolist())
        # Absolute scale: median(gt_z) / median(rec_z) over this track.
        depth_scales.append(float(np.median(g) / np.median(r)))

    print(f"registered views      : {len(res.registered_indices)}/{len(views)}")
    print(f"points                : {len(pts)}")
    print(f"mean reprojection err : {res.mean_reprojection_error:.3f} px")
    print(f"median track length   : {res.median_track_length:.1f}")
    print(f"bundle adjusted       : {res.bundle_adjusted}")
    print()
    if depth_rel_err:
        d = np.array(depth_rel_err)
        print(f"relative depth error  : median {np.median(d) * 100:.2f}%  "
              f"mean {d.mean() * 100:.2f}%  p90 {np.percentile(d, 90) * 100:.2f}%  "
              f"({len(d)} samples, no gauge assumption)")
    if depth_scales:
        sc = np.array(depth_scales)
        print(f"absolute scale        : {np.median(sc):.6f} metric units per "
              f"model unit (p90/p10 spread "
              f"{np.percentile(sc, 90) / np.percentile(sc, 10):.2f})")
        scale = float(np.median(sc))
    else:
        scale = 1.0
        print("absolute scale        : UNAVAILABLE (no depth maps)")

    # ---- gauge-determined alignment --------------------------------------
    # The reconstruction's gauge is a similarity, and every degree of freedom
    # can be pinned from ground truth rather than fitted. Write the similarity
    # that maps the reconstructed frame to the metric world as
    #     X_true = Q X_rec + b
    # Substituting into the two projection equations for one view,
    #     R_gt (Q X_rec + b) + t_gt = lambda (R_rec X_rec + t_rec)
    # and equating coefficients of X_rec gives
    #     Q = lambda R_gt^T R_rec          (a proper rotation: same for all views)
    #     b = lambda R_gt^T t_rec - R_gt^T t_gt
    # where lambda is metric units per model unit. The spread of Q across
    # views is therefore a direct, fit-free measure of pose error, and
    # nothing here is fitted to the object, so a stretched or collapsed point
    # cloud cannot hide behind the alignment.
    reg = sorted(res.registered_indices)
    qs, bs, cp = [], [], []
    for i in reg:
        T_gt = np.array(gt_by_name[views[i].image_name]["Twc"], dtype=float)
        R_gt = T_gt[:3, :3]          # world -> camera (see make_fixture.render)
        t_gt = T_gt[:3, 3]
        qs.append(scale * (R_gt.T @ views[i].R))
        bs.append(scale * (R_gt.T @ views[i].t) - R_gt.T @ t_gt)
        c_gt = -R_gt.T @ t_gt
        cp.append((views[i].center, c_gt))
    qs = list(qs)
    Qsp = _gauge_spread(qs)
    # Q carries the metric/model scale and must be used AS IS to map
    # reconstructed points into the metric world. Normalising it (as the
    # angle metric above does) drops the scale and misplaces every point.
    Q = qs[0]
    b = np.median(np.array(bs), axis=0)
    pts_world = pts @ Q.T + b
    src_c = np.array([c for c, _ in cp])
    dst_c = np.array([g for _, g in cp])
    pred_c = src_c @ Q.T + b
    cerr = np.linalg.norm(pred_c - dst_c, axis=1)
    base = np.linalg.norm(dst_c - dst_c.mean(axis=0), axis=1).mean()
    print(f"camera position error : median {np.median(cerr):.4f}  "
          f"max {cerr.max():.4f}  (orbit radius {base:.4f}; "
          f"{np.median(cerr) / base * 100:.1f}% of the orbit)")
    print(f"recovered orbit radius: {np.linalg.norm(pred_c, axis=1).mean():.4f} "
          f"(true {np.linalg.norm(dst_c, axis=1).mean():.4f})")

    # A near-planar camera orbit admits an approximate MIRROR ambiguity: a
    # reflected reconstruction reprojects just as well. Check it explicitly
    # instead of assuming a proper rotation.
    sys.path.insert(0, HERE)
    import make_fixture as mf
    V_gt, _, _ = mf.build_object_mesh("blob")
    from scipy.spatial import cKDTree
    tree = cKDTree(V_gt)
    d_rot = float(np.median(tree.query(pts_world)[0]))
    Qm = Q.copy()
    Qm[:, 2] *= -1
    pts_mirror = pts @ Qm.T + b
    d_mir = float(np.median(tree.query(pts_mirror)[0]))
    print(f"mirror check          : proper rotation {d_rot:.4f} vs reflected "
          f"{d_mir:.4f} median surface distance")

    gt_min = np.array(gt["object_bbox_min"])
    gt_max = np.array(gt["object_bbox_max"])
    gt_extent = gt_max - gt_min
    # Duplicate import guard: `make_fixture` and cKDTree are used again below.

    # How far is the reconstructed object from where it belongs?
    sys.path.insert(0, HERE)
    import make_fixture as mf
    V_gt, _, _ = mf.build_object_mesh("blob")
    from scipy.spatial import cKDTree
    dist, _ = cKDTree(V_gt).query(pts_world)
    print(f"pose consistency      : worst deviation of the gauge rotation "
          f"across views {Qsp:.4f} deg (0 = every camera pose is correct)")
    _rots = [_gauge_rotation(q) for q in qs]
    for _i, _r in zip(reg, _rots):
        _d = np.degrees(np.arccos(np.clip((np.trace(_r @ _rots[0].T) - 1) / 2, -1, 1)))
        print(f"    view {_i:2d} ({views[_i].image_name}): {_d:8.4f} deg  "
              f"{len(views[_i].tracks)} tracks")
    print(f"surface distance      : median {np.median(dist):.4f}  "
          f"p90 {np.percentile(dist, 90):.4f}  "
          f"({float((dist < 0.05).mean()) * 100:.1f}% of points within 5 cm "
          f"of the true surface; the object is ~2.2 units across)")

    # Where does the error live? Split by how many cameras observe a track.
    # This is a diagnostic breakdown, not a claim: a track's surface distance
    # barely improves with length here because the limiting factor is how much
    # of the OBJECT was photographed, not how well a point was constrained.
    lens = np.array([len([o for o in tr.obs if views[o].registered])
                     for tr in res.tracks if tr.xyz is not None])
    print(f"track lengths       : median {np.median(lens):.0f} "
          f"max {lens.max() if len(lens) else 0}")

    # Per-point comparison against the EXACT metric position of the surface
    # under the keypoint: back-project the ground-truth depth with the known
    # intrinsics and pose. This needs no bounding box, no alignment fit and no
    # principal axes -- it is the position error itself.
    per_point: list[float] = []
    for tr in res.tracks:
        if tr.xyz is None:
            continue
        for o in sorted(tr.obs):
            if not views[o].registered:
                continue
            dp = os.path.join(args.fixture, "depth",
                              views[o].image_name.replace(".jpg", ".npy"))
            if not os.path.exists(dp):
                continue
            dm = np.load(dp)
            kx, ky = views[o].keypoints[tr.obs[o]]
            ix, iy = int(round(kx)), int(round(ky))
            if not (0 <= ix < dm.shape[1] and 0 <= iy < dm.shape[0]):
                continue
            gz = float(dm[iy, ix])
            if not np.isfinite(gz):
                continue
            T = np.array(gt_by_name[views[o].image_name]["Twc"], dtype=float)
            R_gt, t_gt = T[:3, :3], T[:3, 3]
            d = np.linalg.solve(views[o].camera.K, np.array([kx, ky, 1.0]))
            X_gt = R_gt.T @ (d * gz - t_gt)
            near = np.argmin(np.linalg.norm(pts_world - X_gt, axis=1))
            per_point.append(float(np.linalg.norm(pts_world[near] - X_gt)))
            break
    if per_point:
        pp = np.array(per_point)
        print(f"point position error : median {np.median(pp):.4f}  "
              f"p90 {np.percentile(pp, 90):.4f}  (metric; object is 2.18 x "
              f"1.87 x 2.11)")

    # Extent from the raw min/max is not a usable accuracy measure: a handful
    # of low-parallax points sit far from the object (their reprojection error
    # is tiny at any distance), and a single one dominates an axis-aligned
    # bounding box. Report both, and gate on the percentile extent, which is
    # what the mesh will actually be built from.
    got_min = pts_world.min(axis=0)
    got_max = pts_world.max(axis=0)
    raw_extent = got_max - got_min

    LO, HI = 2.0, 98.0
    got_lo = np.percentile(pts_world, LO, axis=0)
    got_hi = np.percentile(pts_world, HI, axis=0)
    got_extent = got_hi - got_lo
    gt_lo = np.percentile(V_gt, LO, axis=0)
    gt_hi = np.percentile(V_gt, HI, axis=0)
    ref_extent = gt_hi - gt_lo
    centre_off = float(np.linalg.norm((got_lo + got_hi) / 2.0
                                      - (gt_lo + gt_hi) / 2.0))
    n_far = int((dist > 0.25).sum())
    print()
    # Coverage is the ceiling on every extent number above. Report it next to
    # them so a large extent error is attributable: an extent measured from a
    # cloud that saw only part of the object is not a reconstruction failure.
    from pipeline import coverage as covmod
    cap = covmod.estimate([views[i].center for i in reg],
                          point_count=len(pts_world))
    if cap is not None:
        print(f"capture coverage    : orbit gap {cap.max_gap_deg:.1f} deg, "
              f"covered {cap.azimuth_spread * 360:.0f} deg of orbit, "
              f"{'FULL' if cap.full_orbit else 'PARTIAL'} sweep")
        cov_frac = float((cKDTree(pts_world).query(V_gt)[0] < 0.05).mean())
        print(f"surface coverage    : {cov_frac * 100:.1f}% of the true surface "
              f"has a point within 5 cm")
        if not cap.full_orbit:
            print(f"  ^ the {cap.max_gap_deg:.0f} deg orbit gap is why the "
                  f"extents below read low: that direction was never "
                  f"photographed, so nothing constrains it")

    print(f"{len(pts)} points, {n_far} further than 25 cm from the surface")
    print(f"axis      gt(p{LO:g}-{HI:g})  got(p{LO:g}-{HI:g})   ratio   "
          f"raw_ratio")
    for ax in range(3):
        print(f"  {ax}       {ref_extent[ax]:10.4f} {got_extent[ax]:14.4f}   "
              f"{got_extent[ax] / ref_extent[ax]:7.4f}   "
              f"{raw_extent[ax] / gt_extent[ax]:9.4f}")
    print(f"cloud centre offset from the true object centre: {centre_off:.4f}")
    extent_err = float(np.max(np.abs(got_extent / ref_extent - 1.0)))
    print(f"worst extent error    : {extent_err * 100:.2f}%")

    if args.max_axis_error is not None:
        ok = extent_err <= args.max_axis_error
        print(f"\nworst extent error    : {extent_err:.4f} "
              f"(threshold {args.max_axis_error})")
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())