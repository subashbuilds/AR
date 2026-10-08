"""The one definition of "put this reconstruction into ground truth's frame".

Three separate evaluation scripts compare a reconstruction against ground
truth, and each of them needs the same similarity transform. Getting it wrong
is not hypothetical in this repository: `eval_densify.py` originally fitted the
Umeyama similarity over camera centres -- the transform `eval_accuracy.py` uses
for *poses*, deliberately, to isolate pose error from shape error -- and then
applied it to points. It reported 0.0% surface coverage for the very cloud
`eval_accuracy` measures at 11.4%. So there is now exactly one place that
computes this, and the two are not interchangeable:

    POSES   Q = R_gt^T R_rec,  b = R_gt^T t_rec - R_gt^T t_gt
            A proper rotation with no scale and no translation freedom: it
            isolates pose error, so a stretched reconstruction is still
            penalised for being stretched.

    POINTS  X_true = s * (Q X_rec) + b,  Q = R_gt^T R_rec,
            s = the gauge-determined scale, b the median translation.
            `s` comes from the fixtures' exact per-pixel depth maps: the ratio
            of true to reconstructed camera-space z, taken as the median over
            tracks observed by at least three views. Nothing here is fitted to
            the object, so a collapsed or stretched cloud cannot hide behind
            the alignment.

`eval_accuracy.py` keeps its own pose-side maths because it also reports
camera-centre error; `eval_densify.py` and `eval_texture.py` both call
`point_gauge` here.
"""

from __future__ import annotations

import json
import os

import numpy as np


def depth_scale(res, views, fixture: str) -> float:
    """Median ratio of true to reconstructed camera-space z, per track."""
    scales = []
    for tr in res.tracks:
        obs_ids = [o for o in tr.obs if views[o].registered and tr.xyz is not None]
        if len(obs_ids) < 3:
            continue
        gts, recs = [], []
        for o in obs_ids:
            dp = os.path.join(fixture, "depth",
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
        g, r = np.array(gts), np.array(recs)
        if not np.all(r > 0):
            continue
        scales.append(float(np.median(g) / np.median(r)))
    return float(np.median(scales)) if scales else 1.0


def point_gauge(res, views, fixture: str, gt_by_name: dict) -> tuple[np.ndarray, np.ndarray, float]:
    """(Q, b, scale) mapping reconstruction points to ground-truth points.

    `X_true = X_rec @ Q.T + b`.
    """
    gt_path = os.path.join(fixture, "ground_truth.json")
    if not gt_by_name:
        with open(gt_path) as fh:
            gt_by_name = {v["name"]: v for v in json.load(fh)["views"]}
    scale = depth_scale(res, views, fixture)

    qs, bs = [], []
    for i in sorted(res.registered_indices):
        T_gt = np.array(gt_by_name[views[i].image_name]["Twc"], dtype=float)
        R_gt, t_gt = T_gt[:3, :3], T_gt[:3, 3]
        qs.append(scale * (R_gt.T @ views[i].R))
        bs.append(scale * (R_gt.T @ views[i].t) - R_gt.T @ t_gt)
    if not qs:
        raise ValueError("no registered views: cannot fix a gauge")
    Q = qs[0]
    b = np.median(np.array(bs), axis=0)
    return Q, b, scale


def apply(points: np.ndarray, Q: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Map (N, 3) reconstruction points into ground truth's frame."""
    return np.asarray(points) @ Q.T + b
