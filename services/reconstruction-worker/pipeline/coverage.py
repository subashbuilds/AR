"""How completely did the capture orbit the object?

A reconstruction can be geometrically excellent and still be wrong in the one
way the user cares about: a point cloud that covers only part of the object
produces a model whose width and depth are too small, and that error is
invisible in a reprojection error.

Measured on the ground-truth fixture, a 12-view capture reconstructs points
that are accurate to 5 cm of the true surface while covering only ~14% of the
object, and its worst principal-axis extent comes out 66% too small. A 24-view
orbit brings that to 30%. Both reconstructions have the same reprojection
error; only capture coverage separates them.

Why this measures the CAMERAS and not the points
-----------------------------------------------
An earlier version of this module tried to estimate coverage from the point
cloud: take the cloud's centroid, treat the object as a sphere, and ask what
fraction of that sphere some camera could see. It produced an "efficiency"
above 1.0, which is impossible, and the reason is instructive. The centroid of
a partially reconstructed object is NOT the object's centre -- it is the
centre of the visible cap, so it sits toward the cameras, which makes the
object look small and every viewing cone look narrow. The premise was wrong,
not the arithmetic.

So the measure here uses only the camera centres, which are known exactly and
depend on nothing about the object's shape:

  * `azimuth_spread` -- the angular range of the camera centres around their
    own centroid, in turns (1.0 = a full 360 deg orbit);
  * `max_gap_deg` -- the largest empty arc between consecutive cameras, which
    is what actually creates an unswept side of the object;
  * `elevation_range_deg` -- the vertical spread, so a capture that only ever
    looked at the equator is distinguishable from one that went over the top.

`max_gap_deg` is the honest headline: a gap is a direction the capture never
viewed, and any model built from it is missing whatever lay behind that gap.
A full orbit has a small maximum gap; a half orbit has one near 180 deg, and
the object's depth in that direction is simply not constrained by any
observation.

These are properties of the capture, not a claim about reconstruction
quality, and they are reported as measurements with no pass/fail attached.
The caller decides what an adequate orbit means for its purpose.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Optional, Sequence

import numpy as np

# The largest empty arc, in degrees, that still counts as a complete orbit.
# Half of this threshold is the natural boundary: a 60 degree hole in a
# turntable leaves the far side of the object unobserved.
_FULL_ORBIT_GAP_DEG = 60.0


@dataclass
class CaptureCoverage:
    """How completely the registered cameras swept around the object."""

    azimuth_spread: float      # in turns; 1.0 = a full 360 deg orbit
    max_gap_deg: float         # largest empty arc between cameras
    elevation_range_deg: float
    view_count: int
    point_count: int
    # Plain-language statement of what was measured, for display verbatim.
    # It must not claim more than the numbers support.
    note: str
    warnings: tuple[str, ...] = ()

    @property
    def full_orbit(self) -> bool:
        """True when no viewing direction was left unswept."""
        return self.max_gap_deg <= _FULL_ORBIT_GAP_DEG

    def to_dict(self) -> dict:
        d = asdict(self)
        d["warnings"] = list(self.warnings)
        d["full_orbit"] = self.full_orbit
        return d


def estimate(centers: Sequence[np.ndarray],
             point_count: int = 0) -> Optional[CaptureCoverage]:
    """Describe how completely `centers` swept around their own centroid.

    `centers` are world-space camera centres of the registered views. Returns
    None when there is too little to measure, so the caller omits the section
    rather than printing a meaningless number.
    """
    cam = np.asarray(centers, dtype=np.float64).reshape(-1, 3)
    if len(cam) < 2:
        return None
    cam = cam[np.isfinite(cam).all(axis=1)]
    if len(cam) < 2:
        return None

    origin = cam.mean(axis=0)
    rel = cam - origin
    dist = np.linalg.norm(rel, axis=1)
    ok = dist > 1e-9
    if ok.sum() < 2:
        return None
    rel = rel[ok]
    azimuth = np.arctan2(rel[:, 2], rel[:, 0])
    elevation = np.degrees(np.arcsin(np.clip(rel[:, 1]
                                           / np.maximum(dist[ok], 1e-12),
                                           -1.0, 1.0)))

    # Sort by azimuth and measure every gap, including the wrap-around one
    # from the last camera back to the first. A capture that covers 300 deg
    # but leaves a 60 deg hole is not a full orbit, and only the wrap-around
    # gap reveals that.
    order = np.argsort(azimuth)
    a = azimuth[order]
    gaps = np.diff(a)
    wrap = (a[0] + 2.0 * math.pi) - a[-1]
    max_gap_deg = float(np.degrees(max(float(gaps.max()) if len(gaps) else 0.0,
                                       wrap)))
    # The sweep is the ANGULAR RANGE actually covered, which is
    # 360 - max_gap: any capture spanning more than a full turn wraps onto
    # itself and the range saturates at 360. Reporting the raw last-minus-first
    # difference instead would read 360 deg for a capture that sampled only
    # three directions, which is the number a reader would trust.
    spread = float((360.0 - max_gap_deg) / 360.0)
    elev_range = float(elevation.max() - elevation.min())

    warnings: list[str] = []
    full_orbit_flag = max_gap_deg <= _FULL_ORBIT_GAP_DEG
    if not full_orbit_flag:
        warnings.append(
            f"the capture left a {max_gap_deg:.0f} degree gap in its orbit, so "
            f"anything facing that direction was never photographed")
    # Only warn about elevation when the capture actually went somewhere.
    # A deliberately flat ring at one height is a legitimate capture plan, not
    # a defect, and warning about it would train the reader to ignore the
    # warnings that matter.
    if elev_range < 20.0 and full_orbit_flag:
        warnings.append(
            f"the cameras stayed within {elev_range:.0f} degrees of the "
            f"equator, so the top and bottom of the object are poorly covered")
    if len(cam) < 6:
        warnings.append(
            f"only {len(cam)} views registered; a wider orbit gives a denser "
            f"and more complete reconstruction")

    # The note branches on `full_orbit`, NOT on whether there are warnings.
    # A capture can be a complete orbit and still raise a warning (a flat ring
    # sees every azimuth but neither pole), and branching on `warnings` made
    # that model announce an unswept gap that does not exist -- the UI would
    # then contradict the `full_orbit` field shown beside it.
    if full_orbit_flag:
        note = (f"the capture covered {spread * 360:.0f} degrees of orbit with "
                f"no gap larger than {max_gap_deg:.0f} degrees, so every "
                f"direction around the object was photographed and the model's "
                f"width and depth should be trustworthy.")
    else:
        note = (f"the capture covered {spread * 360:.0f} degrees of orbit and "
                f"left a gap of {max_gap_deg:.0f} degrees. Any direction inside "
                f"that gap was never photographed, so the model's width and "
                f"depth can be smaller than the real object's.")

    return CaptureCoverage(
        azimuth_spread=spread,
        max_gap_deg=max_gap_deg,
        elevation_range_deg=elev_range,
        view_count=int(len(cam)),
        point_count=int(point_count),
        note=note,
        warnings=tuple(warnings),
    )
