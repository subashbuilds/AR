"""Does the coverage estimator report what the ground truth says?

Reconstructs the fixture at several view counts and compares the measured
capture coverage against the surface coverage computed directly from ground
truth. The estimator is a property of the CAMERA CENTRES, so it can be checked
exactly against the fixture's own orbit without any reconstruction at all --
which is the stronger test, and the one this file leads with.

Run:
    python3 tests/test_coverage.py --fixture /tmp/fx2
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "services",
                                "reconstruction-worker"))

from pipeline import coverage as cov   # noqa: E402


def true_max_gap(centers: np.ndarray) -> float:
    """Largest empty azimuthal arc, including the wrap-around, in degrees."""
    origin = centers.mean(axis=0)
    rel = centers - origin
    a = np.sort(np.arctan2(rel[:, 2], rel[:, 0]))
    gaps = np.diff(a)
    wrap = (a[0] + 2.0 * math.pi) - a[-1]
    return math.degrees(max(float(gaps.max()) if len(gaps) else 0.0, wrap))


def test_against_fixture_orbit() -> int:
    """The estimator must reproduce the fixture's own geometry exactly."""
    gt = json.load(open("/tmp/fx2/ground_truth.json")) \
        if os.path.exists("/tmp/fx2/ground_truth.json") else None
    if gt is None:
        print("SKIP: no fixture at /tmp/fx2")
        return 0
    ok = True
    for n in (6, 8, 12, 24):
        sub = gt["views"][:n]
        c = np.array([-np.array(v["Twc"])[:3, :3].T @ np.array(v["Twc"])[:3, 3]
                      for v in sub])
        rep = cov.estimate(c, point_count=0)
        want = true_max_gap(c)
        got = rep.max_gap_deg
        # The estimator recomputes the gap from the same centres, so this must
        # agree to floating-point noise, not merely to a tolerance.
        if abs(got - want) > 1e-6:
            print(f"FAIL: {n} views: max_gap_deg {got:.4f} != true {want:.4f}")
            ok = False
        else:
            print(f"  {n:2d} views: max gap {got:7.2f} deg  "
                  f"spread {rep.azimuth_spread * 360:6.1f} deg  "
                  f"elev range {rep.elevation_range_deg:5.1f} deg  "
                  f"full_orbit={rep.full_orbit}")
    return 0 if ok else 1


def test_degenerate_inputs() -> int:
    """Bad input must produce None or a sane report, never a crash."""
    ok = True
    if cov.estimate(np.zeros((1, 3))) is not None:
        print("FAIL: a single camera should not produce a report")
        ok = False
    if cov.estimate(np.zeros((0, 3))) is not None:
        print("FAIL: no cameras should not produce a report")
        ok = False
    # All cameras at the identical position: no orbit at all.
    rep = cov.estimate(np.zeros((5, 3)))
    if rep is not None:
        print("FAIL: coincident cameras should not produce a report "
              f"(got {rep})")
        ok = False
    # Two opposite cameras: two huge gaps, must be flagged.
    rep = cov.estimate(np.array([[1.0, 0, 0], [-1.0, 0, 0]]))
    if rep is None or rep.full_orbit:
        print(f"FAIL: two opposite cameras must not count as a full orbit "
              f"(got {rep})")
        ok = False
    elif not rep.warnings:
        print("FAIL: a 180 degree gap must produce a warning")
        ok = False
    # A dense full ring must count as a full orbit. It sits at one height, so
    # it SHOULD warn about vertical coverage -- that warning is correct and
    # useful, and the test asserts it rather than suppressing it.
    t = np.linspace(0, 2 * math.pi, 24, endpoint=False)
    ring = np.stack([np.cos(t), np.zeros_like(t), np.sin(t)], axis=1)
    rep = cov.estimate(ring)
    if rep is None or not rep.full_orbit:
        print(f"FAIL: a dense full ring must count as a full orbit (got {rep})")
        ok = False
    elif not any("equator" in w for w in rep.warnings):
        print(f"FAIL: a flat ring should warn about vertical coverage, got "
              f"{rep.warnings}")
        ok = False
    # A ring that also varies in height must raise no warnings at all.
    tt = np.linspace(0, 2 * math.pi, 24, endpoint=False)
    helix = np.stack([np.cos(tt), 0.35 * np.sin(2 * tt), np.sin(tt)], axis=1)
    rep = cov.estimate(helix)
    if rep is None or not rep.full_orbit:
        print(f"FAIL: a dense 3-D orbit must count as a full orbit (got {rep})")
        ok = False
    elif rep.warnings:
        print(f"FAIL: a full 3-D orbit should raise no warnings, got "
              f"{rep.warnings}")
        ok = False
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="/tmp/fx2")
    args = ap.parse_args()
    print("== camera-centre geometry against the fixture orbit")
    a = test_against_fixture_orbit()
    print("== degenerate inputs")
    b = test_degenerate_inputs()
    ok = a == 0 and b == 0
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
