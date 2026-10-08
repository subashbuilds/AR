"""Does the per-view review find the bad photo, and stay quiet about the good ones?

    python3 -m tests.eval_view_quality [--fixture /tmp/fx2] [--views 12]

The question
------------
The worker knows which photos it could not place and why, but that evidence
never reached the user, who only saw "4 of 12 photos were not registered". The
review in `pipeline/view_quality.py` now reports a verdict per photo. A review
that flags everything is as useless as no review at all, so both directions are
measured here, against photos whose quality this script knows because it
damaged them itself.

Why this is measured **against a baseline**, not in absolute terms
------------------------------------------------------------------
This reconstruction already leaves several genuinely good photos unplaced -- on
the 12-view fixture it solves 8 of 12 and stops. So "photo X was flagged" says
nothing on its own: some of those flags are the solver's limit, not the photo's
fault. An absolute false-positive count could therefore never fail, which would
make the check theatre.

So the measurement is differential. The clean capture is reviewed first, and
that verdict for every photo is the baseline. Damaging one photo must then:

  1. flag **that** photo  (recall),
  2. leave every **other** photo's verdict exactly as the baseline had it
     (the false-positive control, which can actually fail), and
  3. make the reported **evidence** distinguishable between the two damage
     modes, because they fail differently and a user needs to know which.

Two damage modes:

  ``blur``      Gaussian blur. Kills distinctiveness: few keypoints survive and
                matching against any neighbour collapses.
  ``unrelated`` A photograph of a different scene. Keeps plenty of features but
                none of them correspond to anything in the real capture.

Exit status: 0 when all three hold for both modes, 1 otherwise.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "services", "reconstruction-worker"))
sys.path.insert(0, HERE)

from pipeline import features as feat, incremental as inc  # noqa: E402
from pipeline import view_quality as vq  # noqa: E402

# Deliberately far past the edge of "slightly soft". The question is whether
# the review can spot a photo that is plainly wrong, not whether it can grade
# near-misses.
BLUR_SIGMA = 7.0


def damage_blur(img: np.ndarray) -> np.ndarray:
    return cv2.GaussianBlur(img, (0, 0), BLUR_SIGMA)


def damage_unrelated(img: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """A photo of a different scene: band-limited noise, no correspondence.

    Band-limited rather than white noise on purpose. White noise has energy at
    every frequency and produces thousands of features, which is a different
    failure again; blurring it slightly models a real out-of-context photo.
    """
    h, w = img.shape[:2]
    noise = rng.normal(0.5, 0.18, (h, w)).astype(np.float32)
    noise = cv2.blur(noise, (9, 9))
    out = np.repeat(noise[:, :, None], 3, axis=2)
    return np.clip(out * 255.0, 0, 255).astype(np.uint8)


def run_review(image_dir: str, n_views: int, intrinsics: dict) -> dict:
    """Run the SfM stage over a directory and review it, as the pipeline does."""
    names = sorted(n for n in os.listdir(image_dir)
                   if n.lower().endswith((".jpg", ".jpeg", ".png")))[:n_views]
    views = []
    for i, n in enumerate(names):
        arr = np.asarray(Image.open(os.path.join(image_dir, n)).convert("RGB"))
        fs = feat.detect_and_describe(arr, n, nfeatures=4000,
                                      contrast_threshold=0.01)
        # True intrinsics: this is a measurement of photo review, not of focal
        # length estimation.
        cam = inc.Camera(intrinsics["width"], intrinsics["height"],
                         intrinsics["fx"], intrinsics["fy"],
                         intrinsics["cx"], intrinsics["cy"])
        views.append(inc.View(index=i, image_name=n, camera=cam,
                              keypoints=fs.keypoints.astype(np.float64),
                              descriptors=fs.descriptors,
                              sizes=fs.sizes, angles=fs.angles))
    res = inc.reconstruct(views)
    return vq.build_report(res, views).to_dict()


def _by_name(report: dict) -> dict:
    return {v["image_name"]: v for v in report["views"]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="/tmp/fx2")
    ap.add_argument("--views", type=int, default=12)
    args = ap.parse_args()

    src = os.path.join(args.fixture, "images")
    if not os.path.isdir(src):
        print(f"no fixture at {src}", file=sys.stderr)
        return 2
    intrinsics = json.load(open(os.path.join(args.fixture,
                                             "ground_truth.json")))["intrinsics"]

    tmp = tempfile.mkdtemp(prefix="vq-")
    work = os.path.join(tmp, "images")
    rng = np.random.default_rng(20251006)
    failures: list[str] = []

    try:
        # ---- baseline: the clean capture --------------------------------
        shutil.copytree(src, work)
        baseline = run_review(work, args.views, intrinsics)
        base_by_name = _by_name(baseline)
        names = sorted(n for n in os.listdir(work) if n.endswith(".jpg"))[:args.views]
        victim = names[len(names) // 2]

        print(f"baseline (clean capture, {args.views} photos)")
        print(f"  {baseline['note']}")
        print(f"  counts: {baseline['counts']}   "
              f"relative thresholds used: {baseline['relative_thresholds_used']}")
        pre_flagged = [v["image_name"] for v in baseline["views"]
                       if v["verdict"] != "ok"]
        print(f"  already flagged before any damage: {len(pre_flagged)}")
        for n in pre_flagged:
            v = base_by_name[n]
            print(f"    {n}: {v['verdict']} (best_edge_inliers="
                  f"{v['best_edge_inliers']})")

        # ---- each damage mode --------------------------------------------
        evidence = {}
        for mode in ("blur", "unrelated"):
            shutil.rmtree(work)
            shutil.copytree(src, work)
            arr = np.asarray(Image.open(os.path.join(src, victim))
                             .convert("RGB"))
            bad = damage_blur(arr) if mode == "blur" else damage_unrelated(arr, rng)
            Image.fromarray(bad).save(os.path.join(work, victim), quality=97,
                                      subsampling=0)

            report = run_review(work, args.views, intrinsics)
            got = _by_name(report)
            v = got.get(victim)
            if v is None:
                # A review that drops a photo has not reviewed the capture.
                # That is a failure, not an excuse to stop with a traceback.
                failures.append(
                    f"{mode}: the review's report does not contain the damaged "
                    f"photo {victim} at all")
                evidence[mode] = None
                print(f"\n=== damaged: {victim} ({mode})")
                print("  the review did not report this photo at all")
                continue
            evidence[mode] = v

            print(f"\n=== damaged: {victim} ({mode})")
            print(f"  {report['note']}")
            print(f"  verdict={v['verdict']} registered={v['registered']} "
                  f"keypoints={v['keypoints']} "
                  f"best_edge_inliers={v['best_edge_inliers']}")
            for note in v["notes"]:
                print(f"    - {note}")

            # (1) recall
            if v["verdict"] == "ok":
                failures.append(f"{mode}: the damaged photo {victim} was "
                                f"reported OK")
            # (2) the false-positive control, measured against the baseline
            changed = []
            for name, other in got.items():
                if name == victim:
                    continue
                before = base_by_name[name]
                if other["verdict"] != before["verdict"]:
                    changed.append(f"{name}: {before['verdict']} -> {other['verdict']}")
            if changed:
                failures.append(
                    f"{mode}: damaging one photo changed the verdict of "
                    f"photos that were not damaged: {'; '.join(changed)}")
            else:
                print(f"  every other photo's verdict is unchanged from the "
                      f"baseline ({len(got) - 1} photos checked)")

        # (3) the evidence must distinguish the two failure modes
        if evidence.get("blur") and evidence.get("unrelated"):
            blur_kp = evidence["blur"]["keypoints"]
            unrel_kp = evidence["unrelated"]["keypoints"]
            print(f"\nevidence for each damage mode")
            print(f"  blur      : {blur_kp} keypoints, "
                  f"best pair inliers={evidence['blur']['best_edge_inliers']}")
            print(f"  unrelated : {unrel_kp} keypoints, "
                  f"best pair inliers={evidence['unrelated']['best_edge_inliers']}")
            if blur_kp >= unrel_kp:
                failures.append(
                    f"the two damage modes are indistinguishable in the report: "
                    f"the blurred photo has {blur_kp} keypoints and the "
                    f"unrelated one {unrel_kp}, so the evidence cannot tell "
                    f"them apart")
            else:
                print("  a blurred photo and a photo of the wrong scene are "
                      "told apart by the feature count, as they should be")
        else:
            failures.append(
                "the review did not report a damaged photo in at least one "
                "mode, so the evidence cannot be compared")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if failures:
        for f in failures:
            print(f"RESULT: FAIL -- {f}")
        return 1
    print("RESULT: PASS -- both damage modes were caught, no undamaged photo's "
          "verdict moved, and the reported evidence tells the two failures apart.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
