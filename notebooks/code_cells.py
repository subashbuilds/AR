"""The notebook code cells, in one place.

The Colab and Kaggle notebooks carry the same code cells. They are stored
here as strings so that `tests/test_notebooks.py` can execute them **verbatim**
in a temporary clone of this repository: what the gate runs is exactly what a
reader of the notebook runs. A notebook whose cell was edited without the
gate noticing would otherwise drift into shipping code that has never run.

Environment differences (Colab vs Kaggle vs a laptop) are isolated in
CELL_SETUP, which probes its surroundings rather than assuming.
"""

# ---------------------------------------------------------------------------
# CELL 1 -- install dependencies
# ---------------------------------------------------------------------------
CELL_INSTALL = r'''
# Reconstruction dependencies: OpenCV (SIFT + robust geometry), numpy, scipy,
# Pillow. No GPU, no COLMAP, no pretrained weights of any kind.
import sys, subprocess

def pip(*args):
    """Run pip inside the active interpreter, surfacing real failures."""
    cmd = [sys.executable, "-m", "pip", "install", "--quiet", *args]
    subprocess.run(cmd, check=True)

pip("opencv-python-headless==5.0.0.93", "numpy==2.2.6", "scipy==1.15.3",
    "Pillow==12.3.0")
'''

# ---------------------------------------------------------------------------
# CELL 2 -- get the repository and locate it
# ---------------------------------------------------------------------------
CELL_SETUP = r'''
# Get the repository and locate the worker inside it. The three settings:
#   * Colab: clone the repo from GitHub (the cell below does it).
#   * Kaggle: attach the repo as a dataset (say "objectcapture-ar"); the code
#     finds it under /kaggle/input/<dataset>.
#   * A laptop: run the notebook from the checkout and nothing is downloaded.
import os, glob, sys, subprocess

if os.path.exists("/content/"):                     # Google Colab
    if not os.path.exists("/content/objectcapture-ar/requirements.txt"):
        subprocess.run(
            ["git", "clone", "--depth", "1",
             "https://github.com/subashbuilds/AR.git",
             "/content/objectcapture-ar"],
            check=True)

def find_repo_root():
    candidates = ["/content/objectcapture-ar",       # Colab clone target
                  *[p for p in glob.glob("/kaggle/input/*")
                    if os.path.exists(os.path.join(p, "requirements.txt"))]]
    # A local checkout: walk up from the notebook's own directory, wherever
    # inside the repository it was launched from.
    d = os.path.abspath("")
    for _ in range(6):
        candidates.append(d)
        d = os.path.dirname(d)
    for c in candidates:
        # The worker package is what the notebook actually needs.
        if os.path.exists(os.path.join(
                c, "services", "reconstruction-worker", "pipeline", "run.py")):
            return c
    raise FileNotFoundError(
        "Could not find the objectcapture-ar checkout. On Kaggle, attach the "
        "repository as an input dataset; on Colab re-run the clone above.")

REPO_ROOT = find_repo_root()
WORKER_DIR = os.path.join(REPO_ROOT, "services", "reconstruction-worker")
sys.path.insert(0, WORKER_DIR)
print("repository:", REPO_ROOT)
'''

# ---------------------------------------------------------------------------
# CELL 3 -- choose the photographs
# ---------------------------------------------------------------------------
CELL_PHOTOS = r'''
# The demonstration capture: the ground-truth fixture that every number in
# docs/status.md is measured against -- a procedurally rendered orbit of a
# textured object with exact camera poses and per-pixel depth. It carries no
# licence encumbrance and no real-world photograph.
#
# To reconstruct YOUR object instead, skip this cell and fill `IMAGES_DIR`
# in the next cell with a folder of 8-24 overlapping JPEG/PNG photos taken
# walking a full circle around the object, camera level, ~15-30 degrees apart.
import subprocess

FIXTURE_SCRIPT = os.path.join(REPO_ROOT, "tests", "make_fixture.py")
DEMO_DIR = "/tmp/objectcapture-demo"

if not os.path.exists(os.path.join(DEMO_DIR, "images")):
    subprocess.run(
        [sys.executable, FIXTURE_SCRIPT, "--out", DEMO_DIR,
         "--views", "8", "--radius", "7.0"],
        check=True, capture_output=True, text=True)

IMAGES_DIR = os.path.join(DEMO_DIR, "images")
photos = sorted(f for f in os.listdir(IMAGES_DIR)
                if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
print(f"{len(photos)} demo photographs at {IMAGES_DIR}")
'''

# ---------------------------------------------------------------------------
# CELL 4 -- run the reconstruction
# ---------------------------------------------------------------------------
CELL_RUN = r'''
# Run the real worker over the photographs, through the same job contract the
# API service uses.
#
# MEASUREMENT: one real dimension of the object fixes the model's absolute
# scale -- and only that dimension's axis. The pipeline labels an
# uncalibrated model `units: "uncalibrated"` rather than inventing metres.
# The demo leaves it None (the fixture is synthetic and has no "real"
# dimension to measure). For your own photos pass a dict:
#   MEASUREMENT = {"value": 0.31, "unit": "m", "source": "user_measurement"}
MEASUREMENT = None

OUT_DIR = "/tmp/objectcapture-out"
os.makedirs(OUT_DIR, exist_ok=True)
GLB_PATH = os.path.join(OUT_DIR, "model.glb")
RESULT_JSON = os.path.join(OUT_DIR, "result.json")

job = {
    "contract_version": "1",
    "job_id": "notebook-demo",
    "inputs": {"images_dir": IMAGES_DIR},
    "outputs": {"glb_path": GLB_PATH, "result_json": RESULT_JSON},
}
if MEASUREMENT:
    job["scale_calibration"] = MEASUREMENT

import io, json, tempfile
from contextlib import redirect_stdout

with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
    json.dump(job, fh)
    job_path = fh.name

from run_job import main as run_job_main
sys.argv = ["run_job.py", "--job", job_path]
buf = io.StringIO()
with redirect_stdout(buf):
    exit_code = run_job_main()
for line in buf.getvalue().strip().splitlines()[-12:]:
    print(line)
if exit_code != 0:
    raise RuntimeError("the reconstruction failed -- the stage lines above "
                       "name the failing stage")

result = json.load(open(RESULT_JSON))
manifest = result["manifest"]
assert result["state"] == "completed", result
print("\nmodel written to", GLB_PATH)
'''

# ---------------------------------------------------------------------------
# CELL 5 -- read the manifest honestly
# ---------------------------------------------------------------------------
CELL_REPORT = r'''
# What the worker measured. Nothing here is a score out of ten: every number
# is a fact about the capture and the reconstruction, including the bad news.
print("== model")
print(f"  GLB: {manifest['bytes']:,} bytes, "
      f"{manifest['vertex_count']:,} vertices, "
      f"{manifest['triangle_count']:,} triangles, "
      f"texture atlas {manifest['texture_size']}px")
print(f"  colour source: {manifest['colour_source']}")

dims = result["dimensions"]
print("\n== dimensions")
if dims["calibrated"]:
    print(f"  calibrated from a {dims['calibration_source']}: "
          f"width {dims['width_m']:.3f} / height {dims['height_m']:.3f} "
          f"/ depth {dims['depth_m']:.3f} {dims['units']}")
else:
    print("  NOT calibrated -- units are arbitrary. Give the pipeline one "
          "real measurement (MEASUREMENT above) to fix the scale.")

cov = manifest.get("capture_coverage")
print("\n== capture coverage")
if cov is None:
    print("  too few registered cameras to describe an orbit")
elif cov["full_orbit"]:
    print(f"  full orbit; largest gap {cov['max_gap_deg']:.1f} degrees")
else:
    print(f"  PARTIAL orbit -- largest gap {cov['max_gap_deg']:.1f} degrees. "
          "Width and depth can be smaller than the real object's; the "
          "unphotographed side does not exist in this model. Recapture "
          "covering the whole circle.")

atlas = manifest.get("texture_atlas") or {}
if atlas:
    covered = atlas["covered_texels"]
    if covered:
        seen = atlas["visible_texels"] / covered
        print("\n== texture atlas")
        print(f"  {atlas['atlas_size']}px atlas, "
              f"{atlas['atlas_fill_ratio']:.1%} covered by charts; "
              f"{seen:.1%} of covered texels were seen by a camera, "
              f"{atlas['filled_texels']} grown in, "
              f"{atlas['unassigned_texels']} left bare")
        if seen < 0.8:
            print("  (texels no camera saw are interpolation over an "
                  "incomplete capture, not evidence)")

review = manifest.get("view_quality") or {}
flagged_idx = review.get("flagged") or []
by_index = {v["index"]: v for v in review.get("views", [])}
print("\n== per-photo review")
for i in flagged_idx:
    v = by_index.get(i, {})
    reason = "; ".join(v.get("notes") or []) or "no reason recorded"
    print(f"  {v.get('image_name', f'photo_{i:02d}')}: "
          f"{v.get('verdict', '?')} -- {reason}")
if not flagged_idx:
    print(f"  all {review.get('counts', {}).get('total', '?')} photos "
          "contributed")

print("\n== stages")
for s in result["stages"]:
    secs = s.get("seconds")
    print(f"  {s['stage']:<16} {s['status']}"
          + (f" ({secs:.1f}s)" if isinstance(secs, (int, float)) else ""))
'''

# ---------------------------------------------------------------------------
# CELL 6 -- validate the GLB independently
# ---------------------------------------------------------------------------
CELL_VALIDATE = r'''
# Re-parse the written GLB with the pipeline's independent validator: it does
# not trust the writer. It checks the container header, chunk structure,
# accessor/bufferView bounds, index ranges, finiteness, plausible size in
# metres, and -- because the atlas is on -- follows material -> texture ->
# image -> bufferView and decodes the embedded PNG.
from pipeline import glb

validation = glb.validate_glb(GLB_PATH, require_texture=True)
assert validation.ok, validation.errors
details = validation.details
print("GLB validated:",
      f"{details.get('triangle_count', '?')} triangles, "
      f"max index {details.get('max_index', '?')}, "
      f"{details.get('material_count', '?')} material(s), "
      f"texture bound: {bool(details.get('has_texture'))}")

# Take the model with you. In Colab this starts a download; elsewhere the
# file is at GLB_PATH, ready for any glTF viewer.
try:
    from google.colab import files  # type: ignore
    files.download(GLB_PATH)
    print("download started:", GLB_PATH)
except ImportError:
    print(f"GLB at {GLB_PATH} -- download it or open it in any glTF viewer.")

# Kaggle: /kaggle/working is the only directory that survives the session.
import shutil
if os.path.isdir("/kaggle/working"):
    shutil.copy(GLB_PATH, "/kaggle/working/model.glb")
    shutil.copy(RESULT_JSON, "/kaggle/working/result.json")
    print("copied to /kaggle/working/model.glb (see the Output tab)")
'''

# The notebook proper executes these cells in order.
NOTEBOOK_CELLS = [CELL_INSTALL, CELL_SETUP, CELL_PHOTOS, CELL_RUN,
                  CELL_REPORT, CELL_VALIDATE]
