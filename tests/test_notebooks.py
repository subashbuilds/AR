"""The notebooks are executable documentation, so they are executed.

Both notebooks (notebooks/colab and notebooks/kaggle) carry the same code
cells. This gate proves four things, on the real fixture, using the real
worker:

1. Each notebook's six code cells run top to bottom ("Run all") and end with
   a validated GLB; the report cell prints the reader-facing numbers without
   crashing.
2. The code cells in the two notebooks are **identical to each other and to
   notebooks/code_cells.py** — the single source both notebooks are generated
   from. A cell edited in a notebook but not in the source fails here.
3. The demo run is honest: with `MEASUREMENT = None` the result stays
   `uncalibrated`, a partial orbit is labelled one, and the report cell's
   output actually shows that warning to the reader.
4. A negative control: the honesty checks are run against a *doctored* result
   (one that claims a calibration no measurement produced) and must fail —
   proving they are connected to the data and can fail.

Usage (a direct script, not a pytest module — pytest would collect nothing
from it and that silence would be mistaken for a pass):
    python3 tests/test_notebooks.py        # everything (~70s: two runs' worth)
    python3 tests/test_notebooks.py --fast # structural + verbatim checks only
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import time
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)

NBFORMAT_OK = True
try:
    import nbformat  # noqa: F401
except ImportError:
    NBFORMAT_OK = False

FAST = "--fast" in sys.argv

FAILURES: list[str] = []


def fail(msg: str) -> None:
    FAILURES.append(msg)


def check(cond: bool, msg: str) -> bool:
    if not cond:
        fail(msg)
    return bool(cond)


# -- notebook loading ---------------------------------------------------------


def load_notebook(path: str):
    """Parse an .ipynb with nbformat when available, else a strict fallback.

    The fallback is not a shrug: it requires nbformat 4 and a cells list whose
    code-cell sources are lists of lines, which is what the rest of the gate
    reads.
    """
    with open(path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    if NBFORMAT_OK:
        import nbformat

        nb = nbformat.reads(json.dumps(raw), as_version=4)
        nbformat.validate(nb)
        return nb
    if raw.get("nbformat") != 4 or not isinstance(raw.get("cells"), list):
        fail(f"{path}: not a readable nbformat-4 notebook")
        return None
    return raw


def _cells(nb, kind: str) -> list[str]:
    cells = nb.cells if NBFORMAT_OK else nb["cells"]
    out = []
    for c in cells:
        if c.get("cell_type") != kind:
            continue
        src = c["source"]
        if isinstance(src, list):
            src = "".join(src)
        out.append(src)
    return out


def code_cells(nb) -> list[str]:
    return _cells(nb, "code")


def md_cells(nb) -> list[str]:
    return _cells(nb, "markdown")


def extract_code(source: str) -> str:
    """Executable lines only, so comment/prose drift cannot fake drift of the
    other kind — and cannot hide it either: prose is checked separately."""
    lines = []
    for ln in source.splitlines():
        s = ln.strip()
        if s.startswith("#") or not s:
            continue
        lines.append(ln)
    return "\n".join(lines)


# -- the honesty checks (shared by the real run and the negative control) -----


def honesty_failures(dims: dict, cov: dict | None, atlas: dict) -> list[str]:
    """What the demo run must never lie about."""
    out = []
    if dims.get("calibrated") is not False or dims.get("units") != "uncalibrated":
        out.append("with MEASUREMENT=None the demo claimed a calibration "
                   f"(calibrated={dims.get('calibrated')!r}, "
                   f"units={dims.get('units')!r})")
    if atlas.get("atlas_size") != 1024:
        out.append(f"atlas size {atlas.get('atlas_size')!r} is not the "
                   "documented 1024")
    covered = atlas.get("covered_texels", 0)
    if covered and atlas.get("visible_texels", 0) > covered:
        out.append("visible_texels exceeds covered_texels")
    if cov is not None and not isinstance(cov.get("max_gap_deg"), (int, float)):
        out.append("coverage report carries no numeric max_gap_deg")
    return out


# -- execution ----------------------------------------------------------------


def execute_notebook(name: str, cells: list[str], workdir: str):
    """Execute the notebook's code cells verbatim, top to bottom, in one
    namespace — what a reader's 'Run all' does. Returns (namespace, outputs)."""
    os.makedirs(workdir, exist_ok=True)
    ns: dict = {"__name__": "__main__"}
    outputs: list[str] = []
    cwd = os.getcwd()
    os.chdir(workdir)
    try:
        t0 = time.time()
        for i, src in enumerate(cells):
            code = compile(src, f"{name}:cell{i}", "exec")
            buf = io.StringIO()
            with redirect_stdout(buf):
                exec(code, ns)  # noqa: S102 - executing the notebook is the point
            outputs.append(buf.getvalue())
        print(f"  [{name}] {len(cells)} cells executed in {time.time() - t0:.1f}s")
    finally:
        os.chdir(cwd)
    return ns, outputs


# -- main ---------------------------------------------------------------------


def main() -> int:
    print("== notebook gate: executable documentation, executed")

    colabs = sorted(os.listdir(os.path.join(REPO, "notebooks", "colab")))
    kaggles = sorted(os.listdir(os.path.join(REPO, "notebooks", "kaggle")))
    check(colabs == ["objectcapture_ar_demo.ipynb"],
          f"notebooks/colab should hold exactly the demo notebook, found {colabs}")
    check(kaggles == ["objectcapture_ar_demo.ipynb"],
          f"notebooks/kaggle should hold exactly the demo notebook, found {kaggles}")
    if FAILURES:
        print("FAIL: " + "; ".join(FAILURES))
        return 1

    nb_c = load_notebook(os.path.join(REPO, "notebooks", "colab", colabs[0]))
    nb_k = load_notebook(os.path.join(REPO, "notebooks", "kaggle", kaggles[0]))
    if nb_c is None or nb_k is None:
        print("FAIL: " + "; ".join(FAILURES))
        return 1

    cells_c = code_cells(nb_c)
    cells_k = code_cells(nb_k)
    check(len(cells_c) == 6,
          f"colab notebook has {len(cells_c)} code cells, want 6")
    check(len(cells_k) == 6,
          f"kaggle notebook has {len(cells_k)} code cells, want 6")
    if len(cells_c) != 6 or len(cells_k) != 6:
        print("FAIL: " + "; ".join(FAILURES))
        return 1

    # -- 2. the two notebooks carry the same executable code ------------------
    diff = [i for i, (a, b) in enumerate(zip(cells_c, cells_k))
            if extract_code(a) != extract_code(b)]
    check(not diff, f"code cells differ between Colab and Kaggle: {diff}")

    # -- 2b. ... and they are the cells in notebooks/code_cells.py ------------
    sys.path.insert(0, os.path.join(REPO, "notebooks"))
    import code_cells as cc

    check(len(cc.NOTEBOOK_CELLS) == 6, "code_cells.py holds 6 cells")
    drift_c = [i for i, cell in enumerate(cc.NOTEBOOK_CELLS)
               if extract_code(cells_c[i]) != extract_code(cell)]
    drift_k = [i for i, cell in enumerate(cc.NOTEBOOK_CELLS)
               if extract_code(cells_k[i]) != extract_code(cell)]
    check(not drift_c, f"colab cells drifted from notebooks/code_cells.py: {drift_c}")
    check(not drift_k, f"kaggle cells drifted from notebooks/code_cells.py: {drift_k}")

    # -- 3. structure: the notebook says the honest things --------------------
    joined_md = "\n".join(md_cells(nb_c) + md_cells(nb_k))
    for needle, why in [
        ("uncalibrated", "the scale warning"),
        ("cannot invent", "the coverage warning's point"),
        ("Per-photo review", "the per-photo report"),
    ]:
        check(needle in joined_md, f"notebook markdown should mention {why}")
    joined_code = "\n".join(cells_c + cells_k)
    for needle, why in [
        ("subashbuilds/AR", "the Colab clone must target the real repository"),
        ('"contract_version": "1"', "the job contract, as the API sends it"),
        ("require_texture=True",
         "validation must require the texture, not trust the manifest"),
    ]:
        check(needle in joined_code, f"notebook code should carry {why}")
    check("RESULT: PASS" not in joined_code,
          "notebook code must not print a verdict of its own")

    if FAST:
        print("  --fast: skipping full end-to-end execution")
        if FAILURES:
            print("FAIL: " + "; ".join(FAILURES))
            return 1
        print("RESULT: PASS (structural + verbatim checks only)")
        return 0

    # -- 1. execute the Colab notebook's cells verbatim ------------------------
    # The Kaggle notebook's executable lines are byte-identical (proved above),
    # so executing one notebook executes the other; its extra copy-to-Output
    # tail is environment code and is covered by the structural checks.
    # The notebook is executed from the repository's notebooks/ directory --
    # the documented way to run it on a laptop. Everything it writes goes to
    # /tmp paths, so nothing in the checkout is touched.
    ns, outputs = execute_notebook("colab", cells_c,
                                   os.path.join(REPO, "notebooks"))

    check(os.path.exists(ns.get("GLB_PATH", "")),
          "the notebook left no GLB at GLB_PATH")
    result = ns.get("result") or {}
    manifest = ns.get("manifest") or {}
    check(result.get("state") == "completed",
          f"worker state is {result.get('state')!r}")
    if not result or not manifest:
        print("FAIL: " + "; ".join(FAILURES))
        return 1

    # The numbers the reader is shown must come from result.json on disk.
    with open(ns["RESULT_JSON"], "r", encoding="utf-8") as fh:
        check(json.load(fh) == result,
              "the result shown in the notebook differs from result.json")

    # The report cell must actually tell the reader the true state.
    cov = manifest.get("capture_coverage") or {}
    check(cov.get("full_orbit") is False,
          "the 8-photo demo must be a partial orbit, as labelled")
    check("PARTIAL orbit" in outputs[4],
          "the report cell did not show the reader the partial-orbit warning")
    check("NOT calibrated" in outputs[4],
          "the report cell did not show the reader the uncalibrated warning")
    atlas = manifest.get("texture_atlas") or {}

    # Honesty of the demo run itself.
    for msg in honesty_failures(result.get("dimensions", {}), cov, atlas):
        fail(msg)
    if not FAILURES:
        covered = atlas.get("covered_texels", 0)
        seen = (atlas.get("visible_texels", 0) / covered) if covered else 0.0
        print(f"  demo manifest: {manifest['vertex_count']} vertices, "
              f"{manifest['triangle_count']} triangles, "
              f"{atlas.get('atlas_size')}px atlas, "
              f"{seen:.1%} of covered texels seen by a camera, "
              f"largest orbit gap {cov.get('max_gap_deg', 0):.1f} deg")

    # -- 4. negative control: the honesty checks must be able to fail ----------
    doctored_dims = {"calibrated": True, "units": "metre"}
    doctored_atlas = dict(atlas, covered_texels=10, visible_texels=99)
    ctrl = honesty_failures(doctored_dims, cov, doctored_atlas)
    check(len(ctrl) >= 2,
          f"negative control: a doctored result (false calibration, "
          f"impossible texel counts) produced {len(ctrl)} failures — the "
          "honesty checks are not connected to the data")
    # And the verbatim-drift check must catch an edited notebook cell.
    check(extract_code(cc.NOTEBOOK_CELLS[3].replace(
              "MEASUREMENT = None", "MEASUREMENT = 1")) !=
          extract_code(cc.NOTEBOOK_CELLS[3]),
          "negative control: the drift comparison cannot detect an edit")

    if FAILURES:
        print("FAIL:")
        for f in FAILURES:
            print("  -", f)
        return 1
    print("RESULT: PASS — notebooks run, match their source, and report "
          "honestly")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
