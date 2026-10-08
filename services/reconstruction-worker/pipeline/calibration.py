"""Physical scale calibration.

Monocular SfM recovers geometry only up to an arbitrary similarity: a model can
be perfectly self-consistent and still be 3x or 0.1x the real size. The product
therefore never claims a physical size unless the user supplies at least one
reliable real-world measurement.

Three calibration sources are supported, in descending order of trustworthiness:

``user_measurement``
    The user measures one dimension of the object (the MVP path). The user
    identifies a measurable feature and supplies its true length; the factor is
    that length divided by the model's current length along the same axis.

``reference_object``
    A reference object of known size is placed in the capture volume (a common
    photogrammetry trick). Same maths as ``user_measurement`` but the reference
    geometry is supplied by the capture session.

``uncalibrated``
    No measurement. The model is exported in arbitrary units and every
    consumer is told so. Nothing is stretched to a guessed size.

The factor is applied as a uniform scale on the world coordinate system. The
geometry is never rescaled to match an arbitrary bounding box: doing so would
destroy the very dimensions the calibration exists to establish.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

# Unit conversion factors to metres.
UNIT_TO_METRES = {
    "mm": 0.001,
    "cm": 0.01,
    "m": 1.0,
    "in": 0.0254,
    "ft": 0.3048,
}


@dataclass
class ScaleCalibration:
    """Result of applying a physical measurement to a reconstruction."""

    calibrated: bool
    source: str                     # 'user_measurement' | 'reference_object' | 'uncalibrated'
    factor: float                   # multiply model units by this to get metres
    units: str                      # 'metre' or 'uncalibrated'
    measured_value: Optional[float] = None
    measured_unit: Optional[str] = None
    measured_axis: Optional[str] = None
    model_extent_before: Optional[list[float]] = None
    model_extent_after: Optional[list[float]] = None
    uncertainty_ratio: Optional[float] = None   # relative dimension uncertainty
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "calibrated": self.calibrated,
            "source": self.source,
            "factor": self.factor,
            "units": self.units,
            "measured_value": self.measured_value,
            "measured_unit": self.measured_unit,
            "measured_axis": self.measured_axis,
            "model_extent_before": self.model_extent_before,
            "model_extent_after": self.model_extent_after,
            "uncertainty_ratio": self.uncertainty_ratio,
            "notes": self.notes,
        }


def normalize_unit(unit: str) -> tuple[float, str]:
    """Return (metres_per_unit, canonical_unit)."""
    u = (unit or "m").strip().lower()
    if u in UNIT_TO_METRES:
        return UNIT_TO_METRES[u], "metre"
    if u in ("meters", "metres", "meter"):
        return 1.0, "metre"
    raise ValueError(
        f"unsupported unit {unit!r}; expected one of {sorted(UNIT_TO_METRES)}")


def extent(vertices: np.ndarray) -> np.ndarray:
    v = np.asarray(vertices, dtype=np.float64)
    if len(v) == 0:
        return np.zeros(3)
    return v.max(axis=0) - v.min(axis=0)


def calibrate_from_measurement(vertices: np.ndarray,
                               measured_value: Optional[float],
                               measured_unit: str = "m",
                               source: str = "user_measurement",
                               model_value: Optional[float] = None,
                               measured_axis: Optional[str] = None,
                               uncertainty_ratio: Optional[float] = None
                               ) -> ScaleCalibration:
    """Derive a scale factor from a user-supplied physical measurement.

    ``model_value`` is the object's size in current model units along the same
    axis as the measurement. When omitted, the largest bounding-box dimension
    is used and the axis is recorded, so the choice is explicit rather than
    implied.
    """
    before = extent(vertices)
    before_list = [float(x) for x in before]

    if measured_value is None or not math.isfinite(measured_value) or measured_value <= 0:
        return ScaleCalibration(
            calibrated=False, source="uncalibrated", factor=1.0,
            units="uncalibrated", model_extent_before=before_list,
            notes=[
                "No physical measurement was supplied, so the model is in "
                "arbitrary units. Displayed dimensions are NOT physical.",
            ])

    metres_per_unit, _ = normalize_unit(measured_unit)
    target_metres = float(measured_value) * metres_per_unit

    if model_value is None:
        idx = int(np.argmax(before))
        axis_names = ["x", "y", "z"]
        model_value = float(before[idx])
        measured_axis = measured_axis or axis_names[idx]
        note = (f"Measurement applied to the model's largest bounding-box axis "
                f"({measured_axis}).")
    else:
        note = "Measurement applied to the explicitly supplied model axis."
        measured_axis = measured_axis or "unspecified"

    if not math.isfinite(model_value) or model_value <= 0:
        return ScaleCalibration(
            calibrated=False, source="uncalibrated", factor=1.0,
            units="uncalibrated", model_extent_before=before_list,
            notes=["The model dimension for calibration was degenerate; "
                   "no scale applied."])

    factor = target_metres / float(model_value)
    after = before * factor

    notes = [note]
    if uncertainty_ratio is not None:
        notes.append(
            f"Dimension uncertainty is +/-{uncertainty_ratio * 100:.1f}% from "
            "the user's measurement.")
    if source == "user_measurement":
        notes.append(
            "Scale derives from a single user measurement; absolute accuracy "
            "is limited by how precisely that dimension was measured.")

    return ScaleCalibration(
        calibrated=True,
        source=source,
        factor=float(factor),
        units="metre",
        measured_value=float(measured_value),
        measured_unit=measured_unit,
        measured_axis=measured_axis,
        model_extent_before=before_list,
        model_extent_after=[float(x) for x in after],
        uncertainty_ratio=uncertainty_ratio,
        notes=notes,
    )


def apply_scale(vertices: np.ndarray, calibration: ScaleCalibration
                ) -> np.ndarray:
    """Scale vertices into metres. Identity when uncalibrated."""
    v = np.asarray(vertices, dtype=np.float64)
    if not calibration.calibrated:
        return v.copy()
    return v * float(calibration.factor)


def format_dimension(metres: float) -> str:
    """Human-readable length, choosing a sensible unit for the magnitude."""
    m = abs(float(metres))
    if m < 0.01:
        return f"{metres * 1000.0:.1f} mm"
    if m < 1.0:
        return f"{metres * 100.0:.1f} cm"
    return f"{metres:.3f} m"


def dimension_record(vertices: np.ndarray, calibration: ScaleCalibration
                     ) -> dict:
    """The physical-dimension record attached to every published model."""
    ext = extent(vertices)
    axes = {"x": ext[0], "y": ext[1], "z": ext[2]}
    return {
        "units": calibration.units,
        "calibrated": calibration.calibrated,
        "calibration_source": calibration.source,
        "scale_factor": calibration.factor,
        "width_m": float(ext[0]),
        "height_m": float(ext[1]),
        "depth_m": float(ext[2]),
        "axes_metres": {k: float(v) for k, v in axes.items()},
        "diagonal_m": float(np.linalg.norm(ext)),
        "display": {
            "width": format_dimension(ext[0]),
            "height": format_dimension(ext[1]),
            "depth": format_dimension(ext[2]),
        },
        "uncertainty_ratio": calibration.uncertainty_ratio,
        "notes": calibration.notes,
    }