"""End-to-end reconstruction pipeline.

Runs the stages in order, reporting honest progress. Stages that cannot report
a real percentage report an indeterminate progress instead of inventing one.

    validate_input -> feature -> sfm -> filter -> review -> surface -> texture
    -> calibrate -> export_glb -> validate_output

That list is the one the pipeline actually emits, checked against
`result.stages`. There is deliberately no separate `match` stage: feature
matching is expensive and is done where it is needed -- once over all pairs to
build the view graph, then again per view during PnP registration -- so giving
it its own stage would have reported a boundary that does not exist.

The pipeline never fabricates success: if a stage fails, the caller receives a
structured failure with a stage name and message, and no model is published.
"""

from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np
from PIL import Image

from . import atlas as atlasmod
from . import calibration as calib
from . import coverage as covmod
from . import features as feat
from . import glb
from . import incremental as inc
from . import mesh as meshlib
from . import view_quality as vq

ProgressFn = Callable[[str, Optional[float], str], None]


class PipelineError(RuntimeError):
    """Raised when a pipeline stage fails. Carries the failing stage."""

    def __init__(self, stage: str, message: str, detail: Optional[dict] = None):
        super().__init__(f"{stage}: {message}")
        self.stage = stage
        self.message = message
        self.detail = detail or {}


@dataclass
class PipelineConfig:
    """All tunables in one validated place, not scattered constants."""

    max_images: int = 200
    max_corners_per_image: int = 4000
    contrast_threshold: float = 0.01
    matcher_ratio: float = 0.8
    essential_threshold_px: float = 1.5
    min_matches: int = 15
    min_inlier_ratio: float = 0.35
    pnp_reproj_px: float = 2.0
    max_reproj_px: float = 2.0
    min_track_length: int = 2
    min_parallax_deg: float = 1.5
    bundle_adjust: bool = True
    alpha_scale: float = 2.5
    assume_hfov_deg: float = 60.0
    # Texture atlas. `atlas_size` is the square edge in texels; 1024 is enough
    # that a texel is well below one pixel of the source photograph at the
    # resolution this pipeline is handed.
    texture_atlas: bool = True
    atlas_size: int = 1024
    # Charts split where the surface bends by more than this. 135 degrees is
    # measured, not chosen: see `atlas.segment_charts` for the curve. 874 seams
    # on a 1260-face mesh is a lot, and it is the honest cost of a bumpy
    # alpha-shape surface -- the alternatives are fewer seams or a texel
    # density that varies sevenfold across the model.
    chart_max_normal_angle_deg: float = 135.0

    def to_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class PipelineResult:
    ok: bool
    output_glb: Optional[str] = None
    manifest: dict = field(default_factory=dict)
    validation: Optional[dict] = None
    dimensions: Optional[dict] = None
    calibration: Optional[dict] = None
    stages: list[dict] = field(default_factory=list)
    error: Optional[dict] = None

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "output_glb": self.output_glb,
            "manifest": self.manifest,
            "validation": self.validation,
            "dimensions": self.dimensions,
            "calibration": self.calibration,
            "stages": self.stages,
            "error": self.error,
        }


def load_images(image_dir: str, cfg: PipelineConfig) -> list[tuple[str, np.ndarray]]:
    """Load and validate the input images. Fails early and explicitly."""
    if not os.path.isdir(image_dir):
        raise PipelineError("validate_input", f"image directory not found: {image_dir}")
    names = sorted(n for n in os.listdir(image_dir)
                   if n.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
    if len(names) < 2:
        raise PipelineError(
            "validate_input",
            f"need at least 2 images to reconstruct, found {len(names)}")
    if len(names) > cfg.max_images:
        raise PipelineError(
            "validate_input",
            f"{len(names)} images exceeds the configured maximum of {cfg.max_images}")

    out: list[tuple[str, np.ndarray]] = []
    h0 = w0 = None
    for n in names:
        p = os.path.join(image_dir, n)
        try:
            im = Image.open(p)
            im.load()
            arr = np.asarray(im.convert("RGB"))
        except Exception as exc:
            raise PipelineError("validate_input", f"unreadable image {n}: {exc}") from exc
        if arr.ndim != 3 or arr.shape[2] != 3:
            raise PipelineError("validate_input", f"unexpected image shape for {n}")
        if h0 is None:
            h0, w0 = arr.shape[:2]
        elif arr.shape[:2] != (h0, w0):
            raise PipelineError(
                "validate_input",
                f"inconsistent resolution: {n} is {arr.shape[1]}x{arr.shape[0]}, "
                f"expected {w0}x{h0}")
        out.append((n, arr))
    return out


def run(image_dir: str, output_glb_path: str, cfg: Optional[PipelineConfig] = None,
        scale_measurement: Optional[dict] = None,
        progress: Optional[ProgressFn] = None,
        name: str = "captured_object") -> PipelineResult:
    """Run the full pipeline. Never raises PipelineError to the caller."""
    cfg = cfg or PipelineConfig()
    report = progress or (lambda *_: None)
    stages: list[dict] = []
    timings: dict[str, float] = {}

    def stage(name_: str, fn, *, determinate: bool = False):
        t0 = time.time()
        report(name_, None if not determinate else 0.0, "running")
        try:
            result = fn()
        except PipelineError as exc:
            stages.append({"stage": name_, "status": "failed",
                           "error": exc.message, "detail": exc.detail})
            return PipelineResult(False, stages=stages, error={
                "stage": exc.stage, "message": exc.message, "detail": exc.detail})
        except Exception as exc:                      # noqa: BLE001
            stages.append({"stage": name_, "status": "failed",
                           "error": f"{type(exc).__name__}: {exc}"})
            return PipelineResult(False, stages=stages, error={
                "stage": name_, "message": f"{type(exc).__name__}: {exc}"})
        dt = time.time() - t0
        timings[name_] = dt
        stages.append({"stage": name_, "status": "ok", "seconds": round(dt, 3)})
        report(name_, 1.0 if determinate else None, "done")
        return result

    # ---------------- validate_input ----------------
    images = stage("validate_input",
                   lambda: load_images(image_dir, cfg), determinate=True)
    if isinstance(images, PipelineResult):
        return images
    report("validate_input", 1.0, f"{len(images)} images accepted")

    height, width = images[0][1].shape[:2]

    # ---------------- feature ----------------
    def _features():
        views = []
        for i, (nm, arr) in enumerate(images):
            fs = feat.detect_and_describe(
                arr, nm, nfeatures=cfg.max_corners_per_image,
                contrast_threshold=cfg.contrast_threshold)
            views.append(inc.View(
                index=i, image_name=nm,
                camera=inc.Camera.from_hfov(width, height,
                                           hfov_deg=cfg.assume_hfov_deg),
                keypoints=fs.keypoints.astype(np.float64),
                descriptors=fs.descriptors, sizes=fs.sizes, angles=fs.angles,
            ))
        # Reject captures where the detector found almost nothing, which
        # usually means blur, severe under-exposure or a blank scene.
        thin = [v.image_name for v in views if len(v.keypoints) < cfg.min_matches]
        if len(thin) > len(views) / 2:
            raise PipelineError(
                "feature",
                f"{len(thin)} of {len(views)} images yielded too few keypoints; "
                "the capture may be blurred, too dark, or lack texture")
        return views
    views = stage("feature", _features)
    if isinstance(views, PipelineResult):
        return views

    # ---------------- sfm ----------------
    def _sfm():
        return inc.reconstruct(views, {
            "min_matches": cfg.min_matches,
            "essential_threshold_px": cfg.essential_threshold_px,
            "matcher_ratio": cfg.matcher_ratio,
            "min_inlier_ratio": cfg.min_inlier_ratio,
            "pnp_reproj_px": cfg.pnp_reproj_px,
            "pnp_confidence": 0.9999,
            "pnp_iters": 20000,
            "max_reproj_px": cfg.max_reproj_px,
            "min_track_length": cfg.min_track_length,
            "min_parallax_deg": cfg.min_parallax_deg,
            "bundle_adjust": cfg.bundle_adjust,
        })
    result = stage("sfm", _sfm)
    if isinstance(result, PipelineResult):
        return result
    if len(result.points) < 10:
        return PipelineResult(False, stages=stages, error={
            "stage": "sfm",
            "message": (f"only {len(result.points)} 3D points were reconstructed; "
                        "the capture has too little overlap or texture")})

    # Drop statistical outliers before meshing: a handful of badly triangulated
    # points would otherwise stretch the surface enormously.
    def _filter():
        pts = result.points
        if len(pts) < 20:
            return result
        centroid = np.median(pts, axis=0)
        d = np.linalg.norm(pts - centroid, axis=1)
        med = float(np.median(d))
        mad = float(np.median(np.abs(d - med)))
        if mad <= 1e-12:
            return result
        limit = med + 4.0 * 1.4826 * mad
        keep = d <= limit
        if keep.sum() >= 10 and keep.sum() < len(pts):
            stages[-1]["outliers_removed"] = int((~keep).sum())
            result.points = pts[keep]
            result.point_track_ids = result.point_track_ids[keep]
        return result
    result = stage("filter", _filter)
    if isinstance(result, PipelineResult):
        return result

    # ---------------- review ----------------
    # Which photos the reconstruction actually used, and why any were dropped.
    # This is a stage of its own so a failure here is attributed to "review"
    # rather than to whichever stage happened to call it.
    def _review():
        return vq.build_report(result, views)
    view_quality = stage("review", _review)
    if isinstance(view_quality, PipelineResult):
        return view_quality

    # ---------------- surface ----------------
    def _surface():
        return meshlib.reconstruct_surface(result.points, alpha_scale=cfg.alpha_scale)
    mesh = stage("surface", _surface)
    if isinstance(mesh, PipelineResult):
        return mesh
    if mesh.face_count < 4:
        return PipelineResult(False, stages=stages, error={
            "stage": "surface",
            "message": f"surface reconstruction produced only {mesh.face_count} triangles"})

    # ---------------- texture ----------------
    # Unwrap the surface into UV charts and bake the photographs into a single
    # texture atlas. This replaces the old per-vertex colours: a ~500-vertex
    # mesh cannot carry photographic detail, and the atlas is also what a
    # renderer or a WebXR runtime expects to sample.
    baked: dict = {}

    def _texture():
        for v in result.views:
            v.image = images[v.index][1]
        if not cfg.texture_atlas:
            cols = meshlib.color_from_views(mesh, result.views, width, height)
            baked["vertex_colour_fallback"] = True
            return meshlib.Mesh(mesh.vertices, cols, mesh.faces), None, None
        unwrapped, bake_result = atlasmod.bake_texture(
            mesh, result.views, width, height, atlas_size=cfg.atlas_size,
            max_normal_angle_deg=cfg.chart_max_normal_angle_deg)
        baked.update(bake_result.to_dict())
        baked["chart_count"] = unwrapped.chart_count
        baked["seams"] = unwrapped.chart_count - 1
        baked["texels_per_unit"] = round(unwrapped.texels_per_unit, 2)
        baked["texel_density_spread"] = round(
            float(math.exp(unwrapped.planar_distortion_p95)), 3)
        # Vertices are duplicated per chart, so the unwrapped mesh is a
        # different, larger vertex set than the surface stage produced. Keep the
        # vertex colours aligned with it so anything reading them still agrees.
        return (meshlib.Mesh(unwrapped.vertices, unwrapped.colors,
                             unwrapped.faces), unwrapped, bake_result)
    textured = stage("texture", _texture)
    if isinstance(textured, PipelineResult):
        return textured
    mesh, unwrapped, bake_result = textured

    # ---------------- calibrate ----------------
    def _calibrate():
        meas = scale_measurement or {}
        return calib.calibrate_from_measurement(
            mesh.vertices,
            measured_value=meas.get("value"),
            measured_unit=meas.get("unit", "m"),
            source=meas.get("source", "user_measurement"),
            model_value=meas.get("model_value"),
            measured_axis=meas.get("axis"),
            uncertainty_ratio=meas.get("uncertainty"),
        )
    calibration = stage("calibrate", _calibrate)
    if isinstance(calibration, PipelineResult):
        return calibration

    # Apply scale to the mesh; uncalibrated models stay in arbitrary units.
    scaled_verts = calib.apply_scale(mesh.vertices.astype(np.float64), calibration)

    # ---------------- export_glb ----------------
    def _export():
        md = glb.MeshData(
            vertices=scaled_verts.astype(np.float32),
            normals=glb.compute_normals(scaled_verts, mesh.faces),
            colors=np.clip(
                np.hstack([mesh.colors, np.ones((len(mesh.colors), 1), np.float32)]),
                0.0, 1.0).astype(np.float32),
            faces=mesh.faces.astype(np.uint32),
            uvs=(unwrapped.uvs.astype(np.float32) if unwrapped is not None
                 else None),
            texture=(bake_result.texture if bake_result is not None else None),
        )
        return glb.write_glb(md, output_glb_path, name=name)
    manifest = stage("export_glb", _export)
    if isinstance(manifest, PipelineResult):
        return manifest

    # ---------------- validate_output ----------------
    def _validate():
        # With the atlas on, `require_texture=True` is the real check: the
        # validator follows material -> texture -> image -> bufferView and
        # decodes the PNG, so a model that merely *declares* a texture cannot
        # pass. With the atlas off it is vertex colours only.
        res = glb.validate_glb(output_glb_path, require_texture=cfg.texture_atlas)
        if not res.ok:
            raise PipelineError("validate_output",
                                "output GLB failed validation",
                                {"errors": res.errors})
        return res
    validation = stage("validate_output", _validate)
    if isinstance(validation, PipelineResult):
        return validation

    dimensions = calib.dimension_record(scaled_verts, calibration)

    # How completely did the capture orbit the object? Reported because it is
    # the one thing that makes an otherwise-accurate reconstruction wrong in
    # the way the user notices: a capture with a gap in its orbit produces a
    # model whose width and depth are smaller than the real object's, with no
    # other number in this manifest hinting at it. Measured on the ground
    # truth fixture, a 12-view capture and a 24-view capture have the same
    # reprojection error but worst-axis extent errors of 66% and 30%.
    capture_coverage = covmod.estimate(
        [result.views[i].center for i in sorted(result.registered_indices)],
        point_count=int(len(result.points)))

    manifest_full = dict(manifest)
    manifest_full.update({
        "registered_views": len(result.registered_indices),
        "total_views": len(views),
        "point_count": int(len(result.points)),
        "mean_reprojection_error_px": result.mean_reprojection_error,
        "median_track_length": result.median_track_length,
        "bundle_adjusted": result.bundle_adjusted,
        "surface_area": mesh.surface_area(),
        "stage_seconds": {k: round(v, 3) for k, v in timings.items()},
        "pipeline_version": "1.1.0",
        "colour_source": ("baked_texture_atlas" if cfg.texture_atlas
                          else "vertex_colours_from_best_view"),
        "view_quality": view_quality.to_dict(),
        "has_baked_texture": bool(cfg.texture_atlas),
        "texture_atlas": baked,
        "capture_coverage": (capture_coverage.to_dict()
                             if capture_coverage is not None else None),
    })

    return PipelineResult(
        ok=True,
        output_glb=output_glb_path,
        manifest=manifest_full,
        validation=validation.to_dict(),
        dimensions=dimensions,
        calibration=calibration.to_dict(),
        stages=stages,
    )