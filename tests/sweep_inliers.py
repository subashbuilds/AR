"""Sweep the PnP registration support threshold against real accuracy."""
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "services", "reconstruction-worker"))
sys.path.insert(0, HERE)
from pipeline import features as feat, incremental as inc
import make_fixture as mf
from scipy.spatial import cKDTree

fx = "/tmp/fx2"
gt = json.load(open(os.path.join(fx, "ground_truth.json")))
K = gt["intrinsics"]
gtv = {v["name"]: np.array(v["Twc"], float) for v in gt["views"]}
Ki = inc.Camera(K["width"], K["height"], K["fx"], K["fy"], K["cx"], K["cy"]).K
NAMES = sorted(gtv)[:12]
V_gt, _, _ = mf.build_object_mesh("blob")
tree = cKDTree(V_gt)

cached = []
for i, n in enumerate(NAMES):
    arr = np.asarray(Image.open(os.path.join(fx, "images", n)).convert("RGB"))
    cached.append(feat.detect_and_describe(arr, n, nfeatures=4000,
                                           contrast_threshold=0.01))


def run(m):
    views = []
    for i, n in enumerate(NAMES):
        fs = cached[i]
        cam = inc.Camera(K["width"], K["height"], K["fx"], K["fy"], K["cx"], K["cy"])
        views.append(inc.View(index=i, image_name=n, camera=cam,
                              keypoints=fs.keypoints.astype(np.float64),
                              descriptors=fs.descriptors, sizes=fs.sizes,
                              angles=fs.angles))
    res = inc.reconstruct(views, {"min_pnp_inliers": m})
    reg = sorted(res.registered_indices)
    if len(reg) < 2:
        return None

    # Scale from the depth maps, then the gauge.
    scales = []
    for tr in res.tracks:
        obs = [o for o in tr.obs if views[o].registered]
        if len(obs) < 3:
            continue
        gts, recs = [], []
        for o in obs:
            dm = np.load(os.path.join(fx, "depth", views[o].image_name.replace(".jpg", ".npy")))
            kx, ky = views[o].keypoints[tr.obs[o]]
            gz = float(dm[int(round(ky)), int(round(kx))])
            if not np.isfinite(gz) or gz <= 0:
                continue
            gts.append(gz)
            recs.append(float((views[o].R @ tr.xyz + views[o].t)[2]))
        if len(gts) >= 3 and all(r > 0 for r in recs):
            scales.append(float(np.median(gts) / np.median(recs)))
    if not scales:
        return None
    lam = float(np.median(scales))

    rots, ts, cl = [], [], []
    for i in reg:
        T = gtv[views[i].image_name]
        rots.append(lam * (T[:3, :3].T @ views[i].R))
        ts.append(lam * (T[:3, :3].T @ views[i].t) - T[:3, :3].T @ T[:3, 3])
        cl.append((views[i].center, -T[:3, :3].T @ T[:3, 3]))
    rn = [r / (np.linalg.norm(r) / np.sqrt(3)) for r in rots]
    spread = np.degrees(max(np.arccos(np.clip((np.trace(a @ rn[0].T) - 1) / 2, -1, 1))
                            for a in rn))
    Q = rots[0]   # full scale: required to map points into the world
    b = np.median(np.array(ts), axis=0)
    pw = res.points @ Q.T + b
    dist = tree.query(pw)[0]
    dst = np.array([g for _, g in cl])
    cerr = np.linalg.norm(np.array([c for c, _ in cl]) @ Q.T + b - dst, axis=1)
    base = np.linalg.norm(dst - dst.mean(axis=0), axis=1).mean()
    return (len(reg), spread, float(np.median(dist)),
            float(np.median(cerr) / base * 100), res.mean_reprojection_error)


print(f"{'min_inl':>8} {'views':>6} {'pose_spread':>12} {'surf_dist':>10} "
      f"{'cam_err%':>9} {'reproj':>7}")
for m in (8, 16, 30, 50):
    r = run(m)
    if r is None:
        print(f"{m:8d}   failed")
        continue
    print(f"{m:8d} {r[0]:6d} {r[1]:12.4f} {r[2]:10.4f} {r[3]:9.2f} "
          f"{r[4]:7.3f}")