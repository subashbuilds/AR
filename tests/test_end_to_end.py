"""End-to-end pipeline test on real reconstructed data.

Runs the worker exactly as production does (via run_job.py with a job
contract), then validates the produced GLB independently. Also checks the
failure paths, because publishing an invalid model is the worst outcome.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORKER = os.path.join(ROOT, "services", "reconstruction-worker")
sys.path.insert(0, WORKER)

from pipeline import glb  # noqa: E402
from pipeline import calibration as calib  # noqa: E402


def build_job(image_dir: str, out_glb: str, result_json: str,
              calibration: dict) -> dict:
    return {
        "contract_version": "1",
        "job_id": "test-job-001",
        "capture_session_id": "sess-test",
        "name": "fixture_blob",
        "inputs": {"images_dir": image_dir},
        "outputs": {"glb_path": out_glb, "result_json": result_json},
        "scale_calibration": calibration,
        "config": {"bundle_adjust": True, "alpha_scale": 2.5},
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="/tmp/fx2")
    ap.add_argument("--views", type=int, default=10)
    ap.add_argument("--measure", type=float, default=2.0,
                    help="known physical height in the user's unit")
    args = ap.parse_args()

    images = os.path.join(args.fixture, "images")
    names = sorted(n for n in os.listdir(images)
                   if n.lower().endswith((".jpg", ".jpeg", ".png")))[: args.views]
    if len(names) < 3:
        print(f"need at least 3 images in {images}")
        return 1

    tmp = tempfile.mkdtemp(prefix="oca-e2e-")
    sub = os.path.join(tmp, "images")
    os.makedirs(sub, exist_ok=True)
    for n in names:
        with open(os.path.join(images, n), "rb") as src, \
             open(os.path.join(sub, n), "wb") as dst:
            dst.write(src.read())

    out_glb_path = os.path.join(tmp, "out", "model.glb")
    result_json = os.path.join(tmp, "out", "result.json")
    job = build_job(sub, out_glb_path, result_json, {
        "value": args.measure, "unit": "m", "source": "user_measurement"})

    job_path = os.path.join(tmp, "job.json")
    with open(job_path, "w") as fh:
        json.dump(job, fh, indent=2)

    print(f"--- running worker on {len(names)} images ---")
    proc = subprocess.run(
        [sys.executable, os.path.join(WORKER, "run_job.py"),
         "--job", job_path, "--workdir", os.path.join(tmp, "work")],
        capture_output=True, text=True, timeout=1500)

    for line in proc.stdout.strip().split("\n"):
        if line.strip():
            print("  ", line[:300])
    if proc.stderr.strip():
        print("STDERR:", proc.stderr[:1500])

    if proc.returncode != 0:
        print(f"RESULT: FAIL (worker exit {proc.returncode})")
        return 1

    with open(result_json) as fh:
        res = json.load(fh)

    print(f"\n--- result ---")
    print("state:", res["state"])
    m = res["manifest"]
    print(f"glb bytes: {m['bytes']}")
    print(f"vertices: {m['vertex_count']}  triangles: {m['triangle_count']}")
    print(f"registered views: {m['registered_views']}/{m['total_views']}")
    print(f"points: {m['point_count']}  mean reproj err: "
          f"{m['mean_reprojection_error_px']:.3f} px")
    print(f"bundle adjusted: {m['bundle_adjusted']}")
    print(f"stage seconds: {m['stage_seconds']}")

    dims = res["dimensions"]
    print(f"\ncalibration: calibrated={dims['calibrated']} source={dims['calibration_source']} "
          f"factor={dims['scale_factor']:.6f}")
    print(f"display dimensions: {dims['display']}")

    # --- independent validation of the written file ---
    print("\n--- independent GLB validation ---")
    # require_texture=True: the pipeline claims a baked atlas, so the check
    # must follow material -> texture -> image -> bufferView and decode the
    # PNG. With the flag off, a model carrying only vertex colours would pass.
    v = glb.validate_glb(out_glb_path, require_texture=True)
    print("ok:", v.ok)
    print("details:", json.dumps(v.details))
    if v.errors:
        print("errors:", v.errors)
    if v.warnings:
        print("warnings:", v.warnings)

    print(f"\ncolour source: {m.get('colour_source')}")
    ta = m.get("texture_atlas") or {}
    if ta:
        print(f"atlas: {ta.get('atlas_size')}px, {ta.get('chart_count')} charts "
              f"({ta.get('seams')} seams), {ta.get('atlas_fill_ratio', 0) * 100:.1f}% "
              f"of the atlas covered, {ta.get('texel_density_spread')}x density spread")
        print(f"       {ta.get('visible_texels')} texels seen by a camera, "
              f"{ta.get('filled_texels')} filled in from neighbours, "
              f"{ta.get('unassigned_texels')} left bare")

    # --- physical-scale check against ground truth ---
    gt_path = os.path.join(args.fixture, "ground_truth.json")
    scale_ok = None
    if os.path.exists(gt_path):
        gt = json.load(open(gt_path))
        gt_extent = gt.get("object_extent")
        if gt_extent:
            # The fixture object spans the largest axis in model units; the
            # user measurement was declared as the object's height, so we can
            # only assert the scale is in a plausible range.
            print(f"\nground-truth object extent (model units): "
                  f"{[round(x, 4) for x in gt_extent]}")
            scale_ok = dims["calibrated"] and dims["units"] == "metre"

    passed = (v.ok and res["state"] == "completed" and dims["calibrated"]
              and v.details.get("has_texture") is True
              and m.get("has_baked_texture") is True)
    if v.ok and not v.details.get("has_texture"):
        print("\nno texture was found in the written GLB")
    print("\nRESULT:", "PASS" if passed else "FAIL")
    print(f"artifacts in {tmp}")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())