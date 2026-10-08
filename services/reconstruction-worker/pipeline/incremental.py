"""Incremental structure-from-motion.

Builds camera poses and a sparse 3D point cloud from unordered images:

  1. pairwise essential-matrix verification builds a view graph;
  2. the best-connected pair seeds the reconstruction;
  3. remaining views are registered by PnP (RANSAC + refine);
  4. new points are triangulated and existing tracks are extended and filtered
     by reprojection error, cheirality and parallax angle.

Two-view geometry is verified exactly against ground-truth poses in
tests/recoverpose_contract.py (0.000000 deg rotation error on perfect
correspondences), so this module builds on known-correct primitives.

Scale is arbitrary at this stage. `calibration.py` converts to real units.

Conventions
-----------
* World coordinates are right-handed; the camera frame is OpenCV-style
  (x right, y down, z forward).
* `View.R`, `View.t` map world -> camera.
* Camera centre is `-R^T t`.
"""

from __future__ import annotations

import itertools
import math
import sys
from dataclasses import dataclass, field
from typing import Optional, Sequence

import cv2
import numpy as np

from . import ba
from . import features as feat


@dataclass(frozen=True)
class Camera:
    """Pinhole camera with optional radial/tangential distortion."""

    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float
    dist: tuple[float, ...] = ()

    @property
    def K(self) -> np.ndarray:
        return np.array([[self.fx, 0.0, self.cx],
                         [0.0, self.fy, self.cy],
                         [0.0, 0.0, 1.0]], dtype=np.float64)

    @property
    def dist_coeffs(self) -> np.ndarray:
        if not self.dist:
            return np.zeros(5, dtype=np.float64)
        return np.array(self.dist, dtype=np.float64)

    @classmethod
    def from_hfov(cls, width: int, height: int, hfov_deg: float = 60.0,
                  dist: Sequence[float] = ()) -> "Camera":
        fx = 0.5 * width / math.tan(0.5 * math.radians(hfov_deg))
        return cls(width, height, fx, fx, width * 0.5, height * 0.5,
                   tuple(float(d) for d in dist))


@dataclass
class View:
    """One image and its (eventually) estimated pose."""

    index: int
    image_name: str
    camera: Camera
    keypoints: np.ndarray                       # (N, 2) float64 pixels
    descriptors: np.ndarray                     # (N, 128) float32
    sizes: np.ndarray
    angles: np.ndarray
    R: Optional[np.ndarray] = None              # world -> camera
    t: Optional[np.ndarray] = None
    # Tracks observed by this view: {track_id: keypoint_index}
    tracks: dict[int, int] = field(default_factory=dict)

    @property
    def registered(self) -> bool:
        return self.R is not None and self.t is not None

    @property
    def center(self) -> np.ndarray:
        if not self.registered:
            raise RuntimeError(f"view {self.index} is not registered")
        return -self.R.T @ self.t

    def projection(self) -> np.ndarray:
        """3x4 world -> camera projection matrix."""
        if not self.registered:
            raise RuntimeError(f"view {self.index} is not registered")
        return self.camera.K @ np.hstack([self.R, self.t[:, None]])

    def project(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Project world points; returns (pixels, positive_depth_mask).

        `points` is (N, 3) in world coordinates. The camera frame is
        OpenCV-style, so no axis permutation is applied here.
        """
        pts = np.asarray(points, dtype=np.float64).reshape(-1, 3)
        cam = pts @ self.R.T + self.t
        depth = cam[:, 2]
        valid = depth > 1e-9
        uv = np.zeros((len(pts), 2), dtype=np.float64)
        uv[valid, 0] = self.camera.fx * cam[valid, 0] / depth[valid] + self.camera.cx
        uv[valid, 1] = self.camera.fy * cam[valid, 1] / depth[valid] + self.camera.cy
        return uv, valid


@dataclass
class Track:
    """A reconstructed 3D point and its observations."""

    point_id: int
    obs: dict[int, int] = field(default_factory=dict)   # view index -> keypoint
    xyz: Optional[np.ndarray] = None
    error: float = float("inf")
    observations: int = 0

    @property
    def length(self) -> float:
        """Number of views observing this point."""
        return len(self.obs)


@dataclass
class SfMResult:
    views: list[View]
    tracks: list[Track]
    points: np.ndarray                     # (P, 3)
    point_track_ids: np.ndarray            # (P,) index into tracks
    registered_indices: list[int]
    # Index of the view whose camera frame was declared to be the world
    # frame. Exposed so external code can align the reconstruction to a
    # known frame of reference without re-deriving the gauge convention.
    gauge_index: int
    mean_reprojection_error: float
    median_track_length: float
    bundle_adjusted: bool = False
    # Both views of the seed pair, not just the gauge one. A seed view is not a
    # PnP registration, and telling the user "placed by PnP" for a view whose
    # pose came from the seed pair would be wrong.
    seed_indices: list[int] = field(default_factory=list)
    # How well each photo matched anything at all, from the best verified edge
    # in the view graph. A photo with zero inliers on every edge is isolated in
    # the capture, which is a different failure from "PnP could not place it",
    # and the user needs to be told which one happened. Views with no verified
    # edge at all are simply absent from these maps.
    best_edge_inliers: dict = field(default_factory=dict)
    best_edge_ratio: dict = field(default_factory=dict)


def _recover_pose(E: np.ndarray, pts_i: np.ndarray, pts_j: np.ndarray,
                  K: np.ndarray) -> tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    """Recover (R, t) mapping camera i points into camera j.

    Verified against ground truth in tests/recoverpose_contract.py.
    Returns (None, None) when no pose is recoverable.
    """
    if len(pts_i) < 5:
        return None, None
    try:
        res = cv2.recoverPose(E, np.float32(pts_i), np.float32(pts_j), K)
    except cv2.error:
        return None, None

    # OpenCV returns (retval, R, t, mask) on 5.x and (R, t, mask) on 4.x.
    # Identify R as a proper rotation followed by a 3-vector.
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
        return (np.asarray(cand, dtype=np.float64),
                nxt.astype(np.float64).ravel())
    return None, None


def build_view_graph(views: list[View], min_matches: int = 15,
                     essential_threshold_px: float = 1.0,
                     refit_threshold_px: float = 0.75,
                     matcher_ratio: float = 0.8,
                     min_inlier_ratio: float = 0.35) -> dict[tuple[int, int], dict]:
    """Pairwise essential-matrix verification over all view pairs.

    Returns { (i, j): {"inliers": idx_i, "idx_j", "E": E, "score": float} }.
    Pairs are verified geometrically, not merely by raw match count, so
    repetitive-texture false matches do not create edges.
    """
    graph: dict[tuple[int, int], dict] = {}
    for i, j in itertools.combinations(range(len(views)), 2):
        a, b = views[i], views[j]
        if len(a.keypoints) < min_matches or len(b.keypoints) < min_matches:
            continue
        ia, ib, _ = feat.match(feat.FeatureSet(a.image_name, a.keypoints,
                                               a.sizes, a.angles, a.descriptors),
                               feat.FeatureSet(b.image_name, b.keypoints,
                                               b.sizes, b.angles, b.descriptors),
                               ratio=matcher_ratio)
        if len(ia) < min_matches:
            continue
        pa = np.ascontiguousarray(a.keypoints[ia], dtype=np.float32)
        pb = np.ascontiguousarray(b.keypoints[ib], dtype=np.float32)
        try:
            E, mask = cv2.findEssentialMat(pa, pb, a.camera.K,
                                       method=cv2.USAC_MAGSAC,
                                       prob=0.9999,
                                       threshold=essential_threshold_px,
                                       maxIters=10000)
        except cv2.error:
            continue
        if E is None or E.shape[0] < 3 or mask is None:
            continue
        inl = mask.ravel().astype(bool)
        if inl.shape[0] != len(ia):
            continue
        ratio = float(inl.mean())
        if inl.sum() < min_matches or ratio < min_inlier_ratio:
            continue
        # `inl` always indexes the FULL match arrays; the refit below narrows
        # it in place so that pa, pb, ia and ib stay aligned with it.
        sel = inl

        # Refit the essential matrix on its own inliers at a tighter
        # threshold. Roughly one match in nine is wrong, and those wrong
        # matches are mutually consistent with a different geometry, so they
        # pull E away from the truth far more than they raise its residual:
        # measured against ground-truth poses, the estimate fitted BETTER than
        # ground truth on 7 of 8 edges while being 2 deg off. Restricting the
        # fit to the consensus set first removes that bias -- median relative
        # rotation error fell from 2.13 deg to 1.37 deg, and to 0.49 deg when
        # the correspondences are clean, which is the noise floor.
        if refit_threshold_px > 0:
            try:
                E2, m2 = cv2.findEssentialMat(pa[sel], pb[sel], a.camera.K,
                                              method=cv2.USAC_MAGSAC,
                                              prob=0.9999,
                                              threshold=refit_threshold_px,
                                              maxIters=10000)
            except cv2.error:
                E2 = None
            if E2 is not None and E2.shape[0] >= 3 and m2 is not None:
                sub = m2.ravel().astype(bool)
                if sub.shape[0] == int(sel.sum()) and sub.sum() >= min_matches:
                    narrowed = sel.copy()
                    narrowed[sel] = sub
                    if narrowed.sum() >= min_matches:
                        E = E2[:3, :3]
                        sel = narrowed
                        ratio = float(sel.mean())

        # recoverPose also performs the cheirality check.
        R, t = _recover_pose(E[:3, :3], pa[sel], pb[sel], a.camera.K)
        if R is None:
            continue
        graph[(i, j)] = {
            "inliers": (ia[sel], ib[sel]),
            "E": E[:3, :3],
            "R": R,
            "t": t,
            "score": float(inl.sum()),
            "ratio": ratio,
        }
    return graph


def _triangulate_points(P_list: list[np.ndarray], pts_list: list[np.ndarray]
                        ) -> Optional[np.ndarray]:
    """Linear triangulation of N views; returns (N, 3) or None.

    Every supplied view contributes. Triangulating from only the first two
    views -- even when more are available -- discards exactly the information
    that makes depth well conditioned, and on a turntable capture the first
    two views are adjacent, which is the worst-conditioned pair available.

    Linear DLT gives the initial estimate; a short Gauss-Newton step against
    the same observations removes the bias DLT leaves along the viewing rays.
    The DLT below is version-independent and uses all views.
    """
    if len(P_list) < 2 or len(P_list) != len(pts_list):
        return None
    Ps = [np.asarray(P, dtype=np.float64)[:3, :4] for P in P_list]
    obs = [np.asarray(p, dtype=np.float64).reshape(-1, 2) for p in pts_list]
    n_pts = min(len(o) for o in obs)
    if n_pts < 1:
        return None

    # For P = K [R|t] and a pixel (u, v) the projection identity is
    #     u * (P row 2 . X) - (P row 0 . X) = 0
    #     v * (P row 2 . X) - (P row 1 . X) = 0
    # which is exact in raw pixel coordinates. It is badly conditioned
    # numerically (pixels are ~1e3 while translations are ~1e0), so each
    # view is Hartley-normalised -- centroid at the origin, mean distance
    # sqrt(2) -- and its projection matrix is transformed to match.
    #
    # It is tempting to normalise with the intrinsics instead, by reading K
    # back out of P. That is wrong: P = K [R|t] has R mixed into those
    # entries, so only the view whose rotation is the identity recovers a
    # valid K. Every other view then solves with fabricated intrinsics and
    # returns divergent points.
    norms = []
    for P, o in zip(Ps, obs):
        uv = np.hstack([o, np.ones((len(o), 1))])
        centroid = uv[:, :2].mean(axis=0)
        scale = np.sqrt(2.0) / max(
            float(np.mean(np.linalg.norm(uv[:, :2] - centroid, axis=1))), 1e-9)
        T = np.array([[scale, 0.0, -scale * centroid[0]],
                      [0.0, scale, -scale * centroid[1]],
                      [0.0, 0.0, 1.0]], dtype=np.float64)
        norms.append((T @ P, uv @ T.T))

    out = np.zeros((n_pts, 3), dtype=np.float64)
    for k in range(n_pts):
        A = np.zeros((2 * len(Ps), 4), dtype=np.float64)
        for i, (Pn, uv) in enumerate(norms):
            un, vn = uv[k, 0], uv[k, 1]
            A[2 * i] = un * Pn[2] - Pn[0]
            A[2 * i + 1] = vn * Pn[2] - Pn[1]
        try:
            _, _, Vt = np.linalg.svd(A)
        except np.linalg.LinAlgError:
            return None
        w = Vt[-1, 3]
        if abs(w) < 1e-12:
            continue
        X = Vt[-1, :3] / w
        if not np.all(np.isfinite(X)):
            continue
        # A near-degenerate configuration solves for a point behind the
        # cameras or at astronomical distance. Refine from a finite start
        # only; the caller applies the cheirality and range tests.
        if not np.all(np.isfinite(X)) or float(np.linalg.norm(X)) > 1e6:
            continue
        out[k] = _refine_point(X, Ps, [o[k] for o in obs])
    if not np.all(np.isfinite(out)):
        return None
    return out


def _refine_point(X: np.ndarray, Ps: list[np.ndarray],
                  obs: list[np.ndarray], iterations: int = 8) -> np.ndarray:
    """Gauss-Newton refinement of one 3D point against its observations."""
    def residual(x):
        cam = np.array([P[:, :3] @ x + P[:, 3] for P in Ps])
        z = cam[:, 2]
        uv = np.stack([cam[:, 0] / np.where(np.abs(z) < 1e-12, 1e-12, z),
                       cam[:, 1] / np.where(np.abs(z) < 1e-12, 1e-12, z)], axis=1)
        return (uv - np.array(obs)).reshape(-1)

    r = residual(X)
    lam = 1e-6
    eps = 1e-7
    for _ in range(iterations):
        J = np.zeros((len(r), 3), dtype=np.float64)
        for p in range(3):
            d = np.zeros(3)
            d[p] = eps
            J[:, p] = (residual(X + d) - r) / eps
        g = J.T @ r
        H = J.T @ J
        improved = False
        for _try in range(4):
            try:
                step = np.linalg.solve(H + lam * np.eye(3), -g)
            except np.linalg.LinAlgError:
                lam *= 10.0
                continue
            cand = X + step
            rc = residual(cand)
            if np.sum(rc ** 2) < np.sum(r ** 2):
                X, r = cand, rc
                lam = max(lam * 0.1, 1e-9)
                improved = True
                break
            lam *= 10.0
        if not improved or np.linalg.norm(step) < 1e-10:
            break
    return X


def _reprojection_errors(views: list[View], track: Track) -> np.ndarray:
    """Per-observation reprojection error for a track."""
    errs = []
    for vi, ki in track.obs.items():
        v = views[vi]
        if not v.registered:
            continue
        uv, _ = v.project(track.xyz.reshape(1, 3))
        errs.append(float(np.linalg.norm(uv[0] - v.keypoints[ki])))
    return np.array(errs, dtype=np.float64)


def filter_tracks(views: list[View], tracks: list[Track],
                  max_reproj_px: float = 2.0,
                  min_track_length: int = 2,
                  min_parallax_deg: float = 1.5) -> list[Track]:
    """Drop tracks with poor geometry: long reprojection error, no parallax,
    too few observations, or a point behind any observing camera."""
    kept: list[Track] = []
    for tr in tracks:
        if tr.xyz is None:
            continue
        if tr.length < min_track_length:
            continue
        errs = _reprojection_errors(views, tr)
        if len(errs) == 0:
            continue
        if float(np.mean(errs)) > max_reproj_px:
            continue
        # Parallax: reject points whose observing rays are nearly parallel,
        # because their depth is ill-conditioned.
        idxs = [vi for vi in tr.obs if views[vi].registered]
        if len(idxs) < 2:
            continue
        centers = np.array([views[vi].center for vi in idxs])
        best = 0.0
        for a in range(len(centers)):
            for b in range(a + 1, len(centers)):
                d = centers[b] - centers[a]
                nd = np.linalg.norm(d)
                if nd < 1e-12:
                    continue
                # Angle between the two viewing rays at the point.
                v1 = tr.xyz - centers[a]
                v2 = tr.xyz - centers[b]
                n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
                if n1 < 1e-12 or n2 < 1e-12:
                    continue
                cosang = float(np.clip((v1 / n1) @ (v2 / n2), -1, 1))
                best = max(best, math.degrees(math.acos(cosang)))
        if best < min_parallax_deg:
            continue
        # Cheirality: the point must be in front of every observing camera.
        front = True
        for vi in tr.obs:
            v = views[vi]
            cam = v.R @ tr.xyz + v.t
            if cam[2] <= 1e-6:
                front = False
                break
        if not front:
            continue
        tr.error = float(np.mean(errs))
        tr.observations = len(errs)
        kept.append(tr)
    return kept


def reconstruct(views: list[View], config: Optional[dict] = None
                ) -> SfMResult:
    """Run incremental SfM over a set of views."""
    cfg = {
        "min_matches": 15,
        "essential_threshold_px": 1.0,
        "refit_threshold_px": 0.75,
        "matcher_ratio": 0.8,
        "min_inlier_ratio": 0.35,
        "pnp_reproj_px": 2.0,
        "min_pnp_inliers": 30,
        "pnp_confidence": 0.9999,
        "pnp_iters": 20000,
        "max_reproj_px": 2.0,
        "min_track_length": 2,
        "min_parallax_deg": 1.5,
        "seed_min_parallax_deg": 3.0,
        # Beyond ~90 deg the two views look at the object from opposite sides
        # and the two-view triangulation stops having a cheiral solution; an
        # edge measured at 148 deg produced 0 of 492 cheiral points.
        "seed_max_parallax_deg": 90.0,
        "bundle_adjust": True,
        # Track extension re-matches the newly registered view against these
        # anchors to pull its keypoints into existing tracks and to seed new
        # ones. Historically the first three by index were used, which is
        # index-adjacent rather than visually adjacent: with a 0/1, 1/2, ...
        # capture the newest view's own azimuth neighbours were excluded the
        # moment more than three views were registered. Measured consequence
        # (docs/status.md §3f): the 2D-3D supply for later PnP attempts is
        # 39-70 pairs, and 4 of 12 views fail to register at all. Default is
        # the historical behaviour; 'neighbors' ranks the candidate anchors by
        # verified graph edge inliers against the newest view and lets every
        # registered view compete.
        "track_extension_anchors": "first3",
        # Cap on the number of anchor matches performed per registration round
        # (matching is the loop's cost). 0 = no cap.
        "anchor_match_budget": 0,
        # Which seed pair to take among the edges inside the parallax band
        # (docs/status.md 3f, the seed-pair-coverage question): "parallax" is
        # the shipped rule (most inliers inside the band); "widest" takes the
        # largest triangulation angle inside the band -- on an orbit that is
        # the seed pair's own coverage of the object -- and "narrowest" takes
        # the smallest, kept as a negative control. The cheiral fallback when
        # NO pair qualifies is unchanged in every mode.
        "seed_selection": "parallax",
        # Only read when seed_selection == "wide-strong": the fraction of the
        # best in-band inlier count an edge must reach before its angle is
        # allowed to compete (0.5 measured; see _pick_seed).
        "seed_wide_strong_frac": 0.5,
        # Which view the structure grows through next, among the views that
        # pass the PnP gate this round (the registration-order question):
        # "inliers" (shipped) takes the most PnP inliers; "graph" takes the
        # view with the strongest verified view-graph edge into the
        # registered set, tie-broken by PnP inliers. Order only matters
        # through what track extension and filtering do between rounds.
        "registration_order": "inliers",
    }
    if config:
        cfg.update(config)

    n = len(views)
    if n < 2:
        raise RuntimeError("structure-from-motion needs at least 2 views")

    graph = build_view_graph(
        views,
        min_matches=cfg["min_matches"],
        essential_threshold_px=cfg["essential_threshold_px"],
        refit_threshold_px=cfg["refit_threshold_px"],
        matcher_ratio=cfg["matcher_ratio"],
        min_inlier_ratio=cfg["min_inlier_ratio"],
    )
    if not graph:
        raise RuntimeError(
            "no view pair could be verified: insufficient overlap or "
            "insufficient distinctive texture between images")

    # Best verified edge per view, in both directions, recorded while the graph
    # is in hand. Re-deriving it later would mean re-matching every pair.
    best_edge_inliers: dict[int, int] = {}
    best_edge_ratio: dict[int, float] = {}
    for (i, j), e in graph.items():
        for a, b in ((i, j), (j, i)):
            score = int(e["score"])
            if score > best_edge_inliers.get(a, 0):
                best_edge_inliers[a] = score
                best_edge_ratio[a] = float(e["ratio"])
    # The graph is also the similarity source for track-extension anchor
    # ranking ("track_extension_anchors": "neighbors"); make it available
    # without threading it through every call site.
    cfg["_view_graph"] = graph

    # Seed from a verified pair, preferring one whose baseline actually
    # constrains depth. Ranking by inlier count alone always picks two
    # adjacent views on an orbit: they share the most features and the
    # least parallax, so every depth they triangulate is ill-conditioned.
    # Measure the real conditioning instead of guessing at it.
    forced = cfg.get("force_seed")
    if forced is not None and tuple(forced) in graph:
        i0, j0 = forced
        edge = graph[(i0, j0)]
        print(f"  seed forced to ({i0},{j0}) with "
              f"{int(edge['score'])} inliers", file=sys.stderr)
    else:
        (i0, j0), edge = _select_seed(graph, views, cfg)

    # Gauge fixing: declare view i0's camera frame to be the world frame, so
    # X_cam(i0) == X_world. The edge pose (R, t) maps points from camera i0
    # into camera j0, i.e. X_cam(j0) = R @ X_cam(i0) + t. Because both views
    # are then expressed in the same world (= cam i0) frame, j0's world->camera
    # transform is exactly (R, t). Using the edge pose *unmodified* is what
    # makes the seed pair's triangulation cheiral.
    views[i0].R = np.eye(3)
    views[i0].t = np.zeros(3)
    views[j0].R = np.array(edge["R"], dtype=np.float64)
    views[j0].t = np.array(edge["t"], dtype=np.float64).ravel()

    tracks: list[Track] = []
    next_id = 0

    # Create tracks from the seed pair. Keep only correspondences that
    # triangulate to a finite point in front of BOTH cameras.
    ia, ib = edge["inliers"]
    P_i = views[i0].projection()
    P_j = views[j0].projection()
    n_seed = 0
    for k_a, k_b in zip(ia, ib):
        pa = views[i0].keypoints[k_a][None, :].astype(np.float64)
        pb = views[j0].keypoints[k_b][None, :].astype(np.float64)
        X = _triangulate_points([P_i, P_j], [pa, pb])
        if X is None or not np.all(np.isfinite(X)):
            continue
        cam_i = views[i0].R @ X[0] + views[i0].t
        cam_j = views[j0].R @ X[0] + views[j0].t
        if cam_i[2] <= 1e-6 or cam_j[2] <= 1e-6:
            continue
        # Reject absurdly distant points: they indicate a degenerate
        # correspondence rather than real geometry.
        if float(np.linalg.norm(X[0])) > 1e4:
            continue
        tr = Track(point_id=next_id)
        tr.xyz = X[0]
        tr.obs = {i0: int(k_a), j0: int(k_b)}
        tracks.append(tr)
        next_id += 1
        n_seed += 1

    print(f"  seed pair ({i0},{j0}): {n_seed}/{len(ia)} inliers triangulated cheirally",
          file=sys.stderr)

    if not tracks:
        raise RuntimeError(
            "seed pair produced no cheiral triangulations; the two views may "
            "have insufficient parallax")

    tracks = filter_tracks(views, tracks, max_reproj_px=cfg["max_reproj_px"],
                           min_track_length=cfg["min_track_length"],
                           min_parallax_deg=cfg["min_parallax_deg"])

    registered = {i0, j0}

    # Register remaining views by PnP against the current 3D structure.
    remaining = [k for k in range(n) if k not in registered]
    round_no = 0
    while remaining:
        round_no += 1
        best: Optional[tuple] = None
        for vi in remaining:
            # Build 2D-3D pairs by descriptor-matching this view against every
            # registered view, then looking up the 3D point that the matched
            # keypoint already belongs to. We cannot project predicted
            # positions here because this view has no pose yet.
            obj: list[np.ndarray] = []
            img: list[np.ndarray] = []
            seen_kpts: set[int] = set()
            for other in registered:
                v_o = views[other]
                ia_o, ib_o, _ = feat.match(
                    feat.FeatureSet(views[vi].image_name, views[vi].keypoints,
                                    views[vi].sizes, views[vi].angles,
                                    views[vi].descriptors),
                    feat.FeatureSet(v_o.image_name, v_o.keypoints, v_o.sizes,
                                    v_o.angles, v_o.descriptors),
                    ratio=cfg["matcher_ratio"], cross_check=False)
                # Reverse lookup: keypoint index in `other` -> 3D point.
                lookup: dict[int, np.ndarray] = {}
                for tr in tracks:
                    if tr.xyz is None:
                        continue
                    k = tr.obs.get(other)
                    if k is not None:
                        lookup[k] = tr.xyz
                for k_vi, k_o in zip(ia_o, ib_o):
                    X = lookup.get(int(k_o))
                    if X is None or int(k_vi) in seen_kpts:
                        continue
                    seen_kpts.add(int(k_vi))
                    obj.append(X)
                    img.append(views[vi].keypoints[int(k_vi)])
            if len(obj) < cfg["min_pnp_inliers"] and not (
                    cfg.get("pnp_min_ratio", 0.0) > 0 and
                    len(obj) >= int(cfg.get("pnp_ratio_floor", 12))):
                continue
            obj_arr = np.array(obj, dtype=np.float64)
            img_arr = np.array(img, dtype=np.float32)
            ok, rvec, tvec, inliers = cv2.solvePnPRansac(
                obj_arr, img_arr, views[vi].camera.K,
                views[vi].camera.dist_coeffs,
                flags=cv2.SOLVEPNP_ITERATIVE,
                iterationsCount=cfg["pnp_iters"],
                reprojectionError=cfg["pnp_reproj_px"],
                confidence=cfg["pnp_confidence"])
            if not ok or inliers is None or len(inliers) < cfg["min_pnp_inliers"]:
                if cfg.get("_attempt_probe") is not None:
                    # Default-off diagnostics for the §3f question: what did
                    # this attempt actually get offered and achieve?
                    cfg["_attempt_probe"].append({
                        "round": round_no, "view": vi,
                        "offered": len(obj),
                        "inliers": 0 if inliers is None else int(len(inliers)),
                        "ok": bool(ok),
                    })
                continue
            n_in = int(len(inliers))
            # §3f candidate: accept on inlier RATIO when the absolute count is
            # small. The measured populations (eval_registration_rate.py)
            # separate cleanly in ratio -- registered 0.77-0.91, unregistered
            # 0.21-0.40 -- while the counts overlap around the threshold. This
            # path is INERT unless pnp_min_ratio > 0, and even then requires
            # pnp_ratio_floor inliers so a tiny-but-clean solution cannot
            # register a view the structure barely constrains.
            ratio_ok = (
                cfg.get("pnp_min_ratio", 0.0) > 0
                and n_in / max(1, len(obj_arr)) >= cfg["pnp_min_ratio"]
                and n_in >= int(cfg.get("pnp_ratio_floor", 12))
            )
            if n_in < cfg["min_pnp_inliers"] and not ratio_ok:
                if cfg.get("_attempt_probe") is not None:
                    cfg["_attempt_probe"].append({
                        "round": round_no, "view": vi,
                        "offered": len(obj), "inliers": n_in, "ok": True,
                    })
                continue
            # Every candidate here has cleared the gate; this only decides
            # which one the structure grows through next (3f order lever).
            key = _order_key(vi, n_in, registered, cfg)
            if best is None or key > best[0]:
                best = (key, vi, rvec, tvec)

        if best is None:
            break

        _, vi, rvec, tvec = best
        R, _ = cv2.Rodrigues(rvec)
        views[vi].R = np.asarray(R, dtype=np.float64)
        views[vi].t = np.asarray(tvec, dtype=np.float64).ravel()
        registered.add(vi)
        remaining.remove(vi)

        # Extend existing tracks into this view. One descriptor match per
        # already-observing anchor view yields the candidate correspondences
        # for every track at once. Choosing the keypoint nearest a predicted
        # pixel instead -- as this loop used to -- links features that merely
        # look close on a densely sampled surface, and each such link is a
        # silent reprojection error that survives into the bundle adjustment.
        anchors = _track_extension_anchors(views, vi, registered, cfg)
        luts: dict[int, dict[int, int]] = {}
        for o in anchors:
            ia_n, ib_n, _ = feat.match(
                feat.FeatureSet(views[vi].image_name, views[vi].keypoints,
                                views[vi].sizes, views[vi].angles,
                                views[vi].descriptors),
                feat.FeatureSet(views[o].image_name, views[o].keypoints,
                                views[o].sizes, views[o].angles,
                                views[o].descriptors),
                ratio=cfg["matcher_ratio"], cross_check=False)
            lut: dict[int, int] = {}
            for a, b in zip(ia_n, ib_n):
                lut.setdefault(int(b), int(a))
            luts[o] = lut

        claimed = {tr.obs[vi] for tr in tracks if vi in tr.obs}
        extended = 0
        for tr in tracks:
            if tr.xyz is None or vi in tr.obs:
                continue
            k = None
            for o in tr.obs:
                if o in luts and tr.obs[o] in luts[o]:
                    k = luts[o][tr.obs[o]]
                    break
            if k is None or k in claimed:
                continue
            uv_pred, front = views[vi].project(tr.xyz.reshape(1, 3))
            if not front[0]:
                continue
            if np.linalg.norm(uv_pred[0] - views[vi].keypoints[k]) > \
                    cfg["pnp_reproj_px"] * 3:
                continue
            tr.obs[vi] = k
            claimed.add(k)
            extended += 1
            # A track observed in more views has a better constrained depth.
            # Re-triangulate from all of its observations rather than keeping
            # whatever the seed pair produced.
            obs_ids = [o for o in tr.obs if views[o].registered]
            if len(obs_ids) > 2:
                X = _triangulate_points(
                    [views[o].projection() for o in obs_ids],
                    [views[o].keypoints[tr.obs[o]][None, :] for o in obs_ids])
                if X is not None and np.all(np.isfinite(X)):
                    tr.xyz = X[0]
        if extended:
            print(f"    view {vi}: extended {extended} tracks", file=sys.stderr)

        # Create new tracks from unregistered-but-now-visible features.
        # NOTE: the returned next free id must be threaded back through the
        # loop; discarding it makes every call mint duplicate track ids.
        next_id = _extend_tracks_from_view(views, tracks, vi, registered,
                                           next_id, cfg)
        tracks = filter_tracks(views, tracks,
                               max_reproj_px=cfg["max_reproj_px"],
                               min_track_length=cfg["min_track_length"],
                               min_parallax_deg=cfg["min_parallax_deg"])

    if len(registered) < 2:
        raise RuntimeError("fewer than two views could be registered")

    pts = []
    ids = []
    for tr in tracks:
        if tr.xyz is None:
            continue
        pts.append(tr.xyz)
        ids.append(tr.point_id)
    if not pts:
        raise RuntimeError("structure-from-motion produced no 3D points")

    points = np.array(pts, dtype=np.float64)

    bundle = False
    if cfg["bundle_adjust"] and len(registered) >= 3:
        # Hold the seed camera fixed: a similarity of the whole reconstruction
        # leaves every residual unchanged, so the normal equations have a
        # seven-dimensional null space unless the gauge is pinned.
        bundle, _ba_err = ba.bundle_adjust(
            views, [tr for tr in tracks if tr.xyz is not None], registered,
            frozen={i0})
        # Now that the poses are refined, throw away every triangulated
        # point and rebuild it from all of its observations. Points seeded
        # from a two-view pair keep that pair's depth bias through the
        # bundle adjustment, which then has no incentive to remove it
        # because it is exactly what explains the measurements.
        retri = _retriangulate_all(views, tracks, registered) \
            if cfg.get("retriangulate", True) else 0
        if retri:
            _improved, _ba_err = ba.bundle_adjust(
                views, [tr for tr in tracks if tr.xyz is not None], registered,
                frozen={i0})
            bundle = bundle or _improved
        tracks = filter_tracks(views, tracks,
                               max_reproj_px=cfg["max_reproj_px"],
                               min_track_length=cfg["min_track_length"],
                               min_parallax_deg=cfg["min_parallax_deg"])
        print(f"  retriangulated {retri} tracks after bundle adjustment",
              file=sys.stderr)
        # `points` and `point_track_ids` are parallel arrays: rebuild BOTH
        # from the filtered track list. Rebuilding only `points` leaves the ids
        # one-per-pre-filter-track, so every downstream consumer that indexes
        # both with the same mask -- the outlier filter, colour assignment --
        # fails with a length mismatch.
        live = [tr for tr in tracks if tr.xyz is not None]
        points = np.array([tr.xyz for tr in live], dtype=np.float64)
        ids = [tr.point_id for tr in live]

    # Recompute statistics.
    all_errs: list[float] = []
    track_lengths: list[int] = []
    for tr in tracks:
        if tr.xyz is None or len(tr.obs) < 2:
            continue
        e = _reprojection_errors(views, tr)
        if len(e):
            all_errs.extend(e.tolist())
            track_lengths.append(len(tr.obs))

    ids_arr = np.array(ids, dtype=np.int64)
    if len(ids_arr) != len(points):
        raise RuntimeError(
            f"internal error: {len(points)} points but {len(ids_arr)} track "
            "ids; these arrays are indexed in parallel by every consumer")

    return SfMResult(
        views=views,
        tracks=tracks,
        points=points,
        point_track_ids=ids_arr,
        registered_indices=sorted(registered),
        gauge_index=i0,
        seed_indices=[int(i0), int(j0)],
        mean_reprojection_error=float(np.mean(all_errs)) if all_errs else float("nan"),
        median_track_length=float(np.median(track_lengths)) if track_lengths else 0.0,
        bundle_adjusted=bundle,
        best_edge_inliers=best_edge_inliers,
        best_edge_ratio=best_edge_ratio,
    )


def _median_parallax(P_list: list[np.ndarray], pts_list: list[np.ndarray],
                     Ks: list[np.ndarray]) -> float:
    """Median angle between the world-space viewing rays of the points.

    This is the quantity that decides how well depth is determined: a point
    seen from 1 degree of parallax has a depth uncertainty many times its own
    distance, no matter how many matches support it.
    """
    angles: list[float] = []
    for k in range(min(len(p) for p in pts_list)):
        rays = []
        for P, p, K in zip(P_list, pts_list, Ks):
            d = np.linalg.solve(np.asarray(K, dtype=np.float64),
                                np.array([p[k][0], p[k][1], 1.0]))
            ray = P[:, :3] @ d
            n = np.linalg.norm(ray)
            if n > 1e-12:
                rays.append(ray / n)
        for a in range(len(rays)):
            for b in range(a + 1, len(rays)):
                c = float(np.clip(rays[a] @ rays[b], -1.0, 1.0))
                angles.append(math.degrees(math.acos(c)))
    return float(np.median(angles)) if angles else 0.0


def _select_seed(graph: dict, views: list[View], cfg: dict
                 ) -> tuple[tuple[int, int], dict]:
    """Choose the pair that seeds the reconstruction.

    A seed pair has to satisfy two requirements that pull in opposite
    directions. Its median triangulation angle must be LARGE, because a small
    angle leaves depth unconstrained; but it must also be well below 180 deg.
    An edge whose rays are nearly antiparallel is looking at the object from
    opposite sides, and the two-view problem for such a pair has no
    well-conditioned cheiral solution -- measured on the fixture, forcing such
    an edge triangulated 0 of 492 inliers cheirally and aborted the whole
    reconstruction.

    So candidates are ranked by inlier count among pairs whose median angle
    clears ``seed_min_parallax_deg`` and stays under
    ``seed_max_parallax_deg``; the largest angle overall is used only when no
    pair qualifies, and the printed reason makes that visible. Which rule
    applies INSIDE the band is ``cfg["seed_selection"]`` -- see
    ``_pick_seed``; the default is the historical inlier ranking.
    """
    scored = []
    for (i, j), edge in graph.items():
        R = np.asarray(edge["R"], dtype=np.float64)
        t = np.asarray(edge["t"], dtype=np.float64).ravel()
        P_i = views[i].camera.K @ np.hstack([np.eye(3), np.zeros((3, 1))])
        P_j = views[j].camera.K @ np.hstack([R, t[:, None]])
        ia, ib = edge["inliers"]
        pts = [views[i].keypoints[ia], views[j].keypoints[ib]]
        angle = _median_parallax([P_i, P_j], pts,
                                 [views[i].camera.K, views[j].camera.K])
        scored.append(((i, j), edge, angle))
    scored.sort(key=lambda s: -s[2])

    (i0, j0), edge, angle = _pick_seed(scored, cfg)
    print(f"  seed candidates: best parallax {scored[0][2]:.2f} deg, "
          f"chosen ({i0},{j0}) at {angle:.2f} deg with "
          f"{int(edge['score'])} inliers", file=sys.stderr)
    return (i0, j0), edge


def _pick_seed(scored: list, cfg: dict) -> tuple:
    """Pure selection over pre-scored edges; only the parallax band survives.

    ``scored`` is ``[((i, j), edge, angle), ...]`` sorted by descending angle,
    as ``_select_seed`` builds it. The fallback when nothing qualifies reads
    ``scored[0]`` (the widest angle), so callers must keep that order.

    ``cfg["seed_selection"]`` picks inside the band: "parallax" (shipped) takes
    the most inliers, "widest" the largest angle (the seed pair's own coverage
    of the object on an orbit), "narrowest" the smallest -- a negative
    control. All three are restricted to the band, so none can walk into the
    antiparallel region where two-view triangulation has no cheiral solution.
    """
    lo = cfg.get("seed_min_parallax_deg", 3.0)
    hi = cfg.get("seed_max_parallax_deg", 90.0)
    good = [s for s in scored if lo <= s[2] <= hi]
    if not good:
        return scored[0]
    mode = cfg.get("seed_selection", "parallax")
    if mode == "widest":
        return max(good, key=lambda s: s[2])
    if mode == "narrowest":
        return min(good, key=lambda s: s[2])
    if mode == "wide-strong":
        # Measured middle course (6 October): pure "widest" picks a wide but
        # feature-poor edge (36 vs 117 inliers) and the reconstruction never
        # grows. Only edges at least `seed_wide_strong_frac` of the best
        # in-band inlier count compete, then the widest angle among THOSE.
        frac = float(cfg.get("seed_wide_strong_frac", 0.5))
        best_score = max(int(s[1]["score"]) for s in good)
        strong = [s for s in good if int(s[1]["score"]) >= frac * best_score]
        return max(strong, key=lambda s: s[2])
    return max(good, key=lambda s: s[1]["score"])


def _order_key(vi: int, n_in: int, registered: set[int], cfg: dict) -> tuple:
    """Comparison key for which PnP-passing view is registered this round.

    Default ("registration_order" not set or "inliers") is exactly the
    historical behaviour: most PnP inliers wins. "graph" ranks by the
    strongest verified view-graph edge from ``vi`` into the registered set
    (0 when no edge exists), tie-broken by inliers -- growing the structure
    through the most tightly connected chain rather than the best-solved view.
    """
    if cfg.get("registration_order", "inliers") != "graph":
        return (int(n_in),)
    graph = cfg.get("_view_graph") or {}
    gscore = 0
    for o in registered:
        if o == vi:
            continue
        e = graph.get((min(vi, o), max(vi, o)))
        if e is not None and int(e["score"]) > gscore:
            gscore = int(e["score"])
    return (gscore, int(n_in))


def _retriangulate_all(views: list[View], tracks: list[Track],
                       registered: set[int]) -> int:
    """Re-triangulate tracks from all of their observations.

    A track's position is replaced only when the replacement explains its own
    observations BETTER. Re-triangulating unconditionally is destructive: a
    track extended through one bad correspondence gets dragged by it, and
    because the bundle adjustment is not robust, the bad point then drags the
    cameras with it. Measured on the ground-truth fixture, unconditional
    re-triangulation moved camera poses from 1.2 deg to 21 deg.

    Returns the number of tracks whose position actually changed.
    """
    changed = 0
    for tr in tracks:
        obs_ids = [o for o in tr.obs if views[o].registered]
        if len(obs_ids) < 2 or tr.xyz is None:
            continue
        X = _triangulate_points(
            [views[o].projection() for o in obs_ids],
            [views[o].keypoints[tr.obs[o]][None, :] for o in obs_ids])
        if X is None or not np.all(np.isfinite(X)):
            continue
        old = tr.xyz
        old_err = float(np.mean(_reprojection_errors(views, tr)))
        tr.xyz = X[0]
        new_err = float(np.mean(_reprojection_errors(views, tr)))
        if not np.isfinite(new_err) or new_err > old_err:
            tr.xyz = old
            continue
        if float(np.linalg.norm(X[0] - old)) > 1e-9:
            changed += 1
    return changed


def _track_extension_anchors(views: list[View], vi: int, registered: set[int],
                             cfg: dict) -> list[int]:
    """Pick the views a newly registered view is extended against.

    "first3" keeps the historical behaviour (first three by index). "neighbors"
    ranks every other registered view by its verified edge inlier count against
    the newest view -- the view graph already measured that similarity -- and
    falls back to parity when two candidates are tied or the graph lacks the
    pair. The cap (cfg["anchor_match_budget"], 0 = unlimited) keeps the extra
    matches bounded: extension matching is the registration loop's cost.
    """
    others = [o for o in sorted(registered) if o != vi]
    if cfg.get("track_extension_anchors", "first3") != "neighbors":
        return others[:3]
    if not others:
        return others
    # View-graph inliers for pairs (vi, o). The graph is built once per
    # reconstruct() call and holds every pair that had >= min_matches.
    graph = cfg.get("_view_graph") or {}

    def score(o: int) -> tuple:
        e = graph.get((min(vi, o), max(vi, o)))
        if e is not None:
            return (-int(e["score"]), o)
        return (0, o)
    ranked = sorted(others, key=score)
    budget = int(cfg.get("anchor_match_budget", 0) or 0)
    if budget > 0:
        ranked = ranked[:budget]
    return ranked


def _extend_tracks_from_view(views: list[View], tracks: list[Track], vi: int,
                             registered: set[int], next_id: int,
                             cfg: dict) -> int:
    """Triangulate new tracks using view vi and the registered structure.

    Returns the next free track id.
    """
    others = sorted(o for o in registered if o != vi)
    if not others:
        return next_id

    # Which keypoints of vi are still unassigned?
    used = set()
    for tr in tracks:
        if vi in tr.obs:
            used.add(tr.obs[vi])
    free = [k for k in range(len(views[vi].keypoints)) if k not in used]
    if not free:
        return next_id

    # Track each free keypoint across the registered views by descriptor
    # match (not by nearest pixel): a fixed pixel radius silently links
    # unrelated features and corrupts the reconstruction. Match each
    # registered view ONCE and reuse the result, instead of re-matching the
    # whole pair inside the per-keypoint loop.
    Pi = views[vi].projection()
    per_view: list[list[int | None]] = []
    for o in others:
        ia_o, ib_o, _ = feat.match(
            feat.FeatureSet(views[vi].image_name, views[vi].keypoints,
                            views[vi].sizes, views[vi].angles,
                            views[vi].descriptors),
            feat.FeatureSet(views[o].image_name, views[o].keypoints,
                            views[o].sizes, views[o].angles, views[o].descriptors),
            ratio=cfg["matcher_ratio"], cross_check=False)
        lut: dict[int, int] = {}
        for a, b in zip(ia_o, ib_o):
            lut.setdefault(int(a), int(b))
        per_view.append([lut.get(k) for k in range(len(views[vi].keypoints))])

    n_new = 0
    for k in free:
        uv_i = views[vi].keypoints[k][None, :]
        matched = [(others[c], j) for c, col in enumerate(per_view)
                   for j in [col[k]] if j is not None]
        if not matched:
            continue
        # Pair each matched observation with ITS OWN view's projection matrix.
        # Reusing a fixed P_list while skipping views that did not match
        # silently triangulates a point from a correspondence that never
        # existed, and every such point is later discarded as an outlier.
        P_used = [Pi] + [views[o].projection() for o, _ in matched]
        pts = [uv_i] + [views[o].keypoints[j][None, :] for o, j in matched]
        X = _triangulate_points(P_used, pts)
        if X is None or not np.all(np.isfinite(X)):
            continue
        tr = Track(point_id=next_id)
        tr.xyz = X[0]
        tr.obs = {vi: k}
        for o, j in matched:
            tr.obs[o] = j
        tracks.append(tr)
        next_id += 1
    return next_id
