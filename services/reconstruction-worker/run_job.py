#!/usr/bin/env python3
"""Reconstruction worker entrypoint.

Consumes a versioned job contract (JSON) and produces a validated GLB plus a
result manifest. Intended to run inside the container image or on a VPS.

Usage:
    python3 run_job.py --job job.json --workdir /tmp/job123

The job contract is the shared interface documented in
docs/architecture/data-flow.md. Unknown fields are ignored; missing required
fields fail with a clear message rather than a traceback.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from pipeline import glb  # noqa: E402
from pipeline import run as pipeline_run  # noqa: E402


def log(obj: dict) -> None:
    """Structured single-line JSON logging for worker runtimes."""
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    ap = argparse.ArgumentParser(description="ObjectCapture AR reconstruction worker")
    ap.add_argument("--job", required=True, help="path to the job contract JSON")
    ap.add_argument("--workdir", help="working directory (created if absent)")
    ap.add_argument("--keep-workdir", action="store_true",
                    help="retain intermediate files for troubleshooting")
    args = ap.parse_args()

    started = time.time()
    try:
        with open(args.job) as fh:
            job = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        log({"level": "error", "event": "job_read_failed", "error": str(exc)})
        return 2

    job_id = job.get("job_id") or job.get("id") or "unknown"
    contract_version = job.get("contract_version", "1")
    inputs = job.get("inputs", {}).get("images_dir")
    calibration = job.get("scale_calibration") or {}
    out_path = job.get("outputs", {}).get("glb_path")
    config_overrides = job.get("config") or {}

    if not inputs:
        log({"level": "error", "job_id": job_id,
             "event": "invalid_job", "error": "inputs.images_dir is required"})
        return 2
    if not out_path:
        log({"level": "error", "job_id": job_id,
             "event": "invalid_job", "error": "outputs.glb_path is required"})
        return 2

    workdir = args.workdir
    created_here = False
    if workdir:
        os.makedirs(workdir, exist_ok=True)
    else:
        workdir = tempfile.mkdtemp(prefix=f"job-{job_id}-")
        created_here = True

    log({"level": "info", "job_id": job_id, "contract_version": contract_version,
         "event": "job_started", "workdir": workdir})

    cfg = pipeline_run.PipelineConfig()
    for key in cfg.to_dict():
        if key in config_overrides:
            setattr(cfg, key, config_overrides[key])

    def progress(stage: str, frac: Optional[float], note: str) -> None:
        log({"level": "info", "job_id": job_id, "event": "stage",
             "stage": stage, "progress": frac, "note": note})

    try:
        os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".",
                    exist_ok=True)
        result = pipeline_run.run(
            inputs, out_path, cfg=cfg,
            scale_measurement=calibration if calibration else None,
            progress=progress, name=job.get("name", "captured_object"))

        summary = {
            "job_id": job_id,
            "state": "completed" if result.ok else "failed",
            "output_glb": result.output_glb if result.ok else None,
            "manifest": result.manifest,
            "validation": result.validation,
            "dimensions": result.dimensions,
            "calibration": result.calibration,
            "stages": result.stages,
            "error": result.error,
            "elapsed_seconds": round(time.time() - started, 3),
        }
        log({"level": "info" if result.ok else "error", "job_id": job_id,
             "event": "job_finished", "state": summary["state"],
             "elapsed_seconds": summary["elapsed_seconds"]})

        result_json = job.get("outputs", {}).get("result_json")
        if result_json:
            with open(result_json, "w") as fh:
                json.dump(summary, fh, indent=2)

        return 0 if result.ok else 1

    except Exception as exc:                                   # noqa: BLE001
        log({"level": "error", "job_id": job_id, "event": "job_crashed",
             "error": f"{type(exc).__name__}: {exc}",
             "traceback": traceback.format_exc()[:4000]})
        return 1
    finally:
        # Temporary job directories must not accumulate on a long-running VPS.
        if created_here and not args.keep_workdir:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())