"""Unit tests for the reconstruction pipeline.

These lock in behaviour that was verified against ground truth, and cover the
failure paths that must never produce a published model.

Run:
    python3 -m pytest tests/test_pipeline.py -v
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORKER = os.path.join(ROOT, "services", "reconstruction-worker")
sys.path.insert(0, WORKER)

from pipeline import atlas as atlasmod              # noqa: E402
from pipeline import calibration as calib           # noqa: E402
from pipeline import coverage as covmod            # noqa: E402
from pipeline import features as feat               # noqa: E402
from pipeline import glb                            # noqa: E402
from pipeline import mesh as meshlib                # noqa: E402
from pipeline import run as pipeline_run            # noqa: E402
from pipeline import view_quality as vq              # noqa: E402
from pipeline.incremental import Camera             # noqa: E402
from pipeline import incremental as inc             # noqa: E402


# ---------------------------------------------------------------- calibration

def test_calibration_applies_user_measurement():
    verts = np.array([[0, 0, 0], [2, 4, 6]], dtype=float)
    cal = calib.calibrate_from_measurement(verts, measured_value=10.0,
                                          measured_unit="m")
    assert cal.calibrated
    assert cal.units == "metre"
    # The largest axis was 6 units and is declared to be 10 m.
    assert cal.factor == pytest.approx(10.0 / 6.0)
    assert cal.model_extent_after[2] == pytest.approx(10.0)


def test_calibration_converts_units():
    verts = np.array([[0, 0, 0], [0, 0, 100]], dtype=float)
    cal = calib.calibrate_from_measurement(verts, measured_value=50.0,
                                          measured_unit="cm")
    assert cal.calibrated
    # 50 cm = 0.5 m over a 100-unit model => factor 0.005
    assert cal.factor == pytest.approx(0.005)
    assert cal.model_extent_after[2] == pytest.approx(0.5)


def test_uncalibrated_is_explicitly_labelled():
    verts = np.array([[0, 0, 0], [1, 1, 1]], dtype=float)
    cal = calib.calibrate_from_measurement(verts, measured_value=None)
    assert not cal.calibrated
    assert cal.units == "uncalibrated"
    assert cal.notes, "an uncalibrated model must explain itself"
    dims = calib.dimension_record(verts, cal)
    assert dims["units"] == "uncalibrated"
    assert dims["calibrated"] is False


@pytest.mark.parametrize("bad", [0.0, -1.0, float("nan"), float("inf")])
def test_invalid_measurements_do_not_calibrate(bad):
    verts = np.array([[0, 0, 0], [1, 2, 3]], dtype=float)
    cal = calib.calibrate_from_measurement(verts, measured_value=bad)
    assert not cal.calibrated


def test_unknown_unit_rejected():
    verts = np.array([[0, 0, 0], [1, 2, 3]], dtype=float)
    with pytest.raises(ValueError):
        calib.calibrate_from_measurement(verts, measured_value=1.0,
                                         measured_unit="furlong")


def test_apply_scale_is_identity_when_uncalibrated():
    verts = np.array([[1.0, 2.0, 3.0]])
    cal = calib.calibrate_from_measurement(verts, measured_value=None)
    assert np.allclose(calib.apply_scale(verts, cal), verts)


# ---------------------------------------------------------------------- GLB

def _sample_mesh():
    v = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float32)
    n = glb.compute_normals(v.astype(np.float64),
                            np.array([[0, 1, 2], [0, 1, 3]]))
    c = np.ones((4, 4), dtype=np.float32)
    f = np.array([[0, 1, 2], [0, 1, 3]], dtype=np.uint32)
    return glb.MeshData(vertices=v, normals=n, colors=c, faces=f)


def test_glb_roundtrip_validates(tmp_path):
    p = str(tmp_path / "m.glb")
    manifest = glb.write_glb(_sample_mesh(), p)
    assert manifest["triangle_count"] == 2
    res = glb.validate_glb(p, min_vertices=4, min_triangles=2)
    assert res.ok, res.errors
    assert res.details["vertex_count"] == 4
    assert res.details["triangle_count"] == 2
    assert res.details["has_vertex_colors"] is True


def test_glb_has_valid_container_magic(tmp_path):
    p = str(tmp_path / "m.glb")
    glb.write_glb(_sample_mesh(), p)
    raw = open(p, "rb").read()
    assert raw[:4] == b"glTF"
    import struct
    magic, version, total = struct.unpack_from("<III", raw, 0)
    assert magic == 0x46546C67
    assert version == 2
    assert total == len(raw)


def test_glb_validator_rejects_truncated_file(tmp_path):
    p = str(tmp_path / "m.glb")
    glb.write_glb(_sample_mesh(), p)
    raw = open(p, "rb").read()
    open(p, "wb").write(raw[: len(raw) // 2])
    res = glb.validate_glb(p)
    assert not res.ok


def test_glb_validator_rejects_corrupt_magic(tmp_path):
    p = str(tmp_path / "m.glb")
    glb.write_glb(_sample_mesh(), p)
    raw = bytearray(open(p, "rb").read())
    raw[0:4] = b"XXXX"
    open(p, "wb").write(bytes(raw))
    res = glb.validate_glb(p)
    assert not res.ok
    assert any("magic" in e.lower() for e in res.errors)


def test_glb_validator_detects_nan_positions(tmp_path):
    md = _sample_mesh()
    md.vertices = md.vertices.copy()
    md.vertices[0, 0] = np.nan
    p = str(tmp_path / "m.glb")
    glb.write_glb(md, p)
    res = glb.validate_glb(p, min_vertices=4, min_triangles=2)
    assert not res.ok


def test_glb_rejects_out_of_range_indices(tmp_path):
    md = _sample_mesh()
    md.faces = np.array([[0, 1, 99]], dtype=np.uint32)
    p = str(tmp_path / "m.glb")
    with pytest.raises(glb.GltfError):
        glb.write_glb(md, p)


def test_glb_rejects_empty_mesh(tmp_path):
    md = _sample_mesh()
    md.faces = np.zeros((0, 3), dtype=np.uint32)
    with pytest.raises(glb.GltfError):
        glb.write_glb(md, str(tmp_path / "m.glb"))


def test_extent_sanity_limit_is_enforced(tmp_path):
    md = _sample_mesh()
    md.vertices = (md.vertices * 1000.0).astype(np.float32)
    p = str(tmp_path / "m.glb")
    glb.write_glb(md, p)
    res = glb.validate_glb(p, max_extent_metres=10.0)
    assert not res.ok
    assert any("sanity limit" in e for e in res.errors)


def test_require_texture_flag_rejects_vertex_colour_only(tmp_path):
    p = str(tmp_path / "m.glb")
    glb.write_glb(_sample_mesh(), p)
    res = glb.validate_glb(p, require_texture=True)
    assert not res.ok
    assert any("texture" in e for e in res.errors)


def _textured_sample(atlas=8):
    """The sample mesh with a UV set and a small baked-looking atlas."""
    tex = np.zeros((atlas, atlas, 3), dtype=np.uint8)
    tex[:, :] = (10, 220, 30)
    tex[:atlas // 2, :] = (200, 5, 90)
    uv = np.array([[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]],
                  dtype=np.float32)
    return glb.MeshData(vertices=_sample_mesh().vertices,
                        normals=_sample_mesh().normals,
                        colors=_sample_mesh().colors,
                        faces=_sample_mesh().faces,
                        uvs=uv, texture=tex)


def test_textured_glb_roundtrip_validates_as_textured(tmp_path):
    p = str(tmp_path / "m.glb")
    manifest = glb.write_glb(_textured_sample(), p)
    assert manifest["has_baked_texture"] is True
    # COLOR_0 is deliberately dropped: glTF multiplies a vertex colour by the
    # base colour texture, so shipping both would darken every texel twice.
    assert manifest["has_vertex_colors"] is False
    res = glb.validate_glb(p, min_triangles=2, require_texture=True)
    assert res.ok, res.errors
    assert res.details["has_texture"] is True
    assert res.details["has_vertex_colors"] is False
    assert res.details["texture_size"] == [8, 8]


def test_textured_glb_has_no_color_0_accessor(tmp_path):
    import struct as _struct

    p = str(tmp_path / "m.glb")
    glb.write_glb(_textured_sample(), p)
    raw = open(p, "rb").read()
    _magic, _ver, total = _struct.unpack_from("<III", raw, 0)
    clen, _ctype = _struct.unpack_from("<II", raw, 12)
    doc = json.loads(raw[20:20 + clen].decode("utf-8"))
    prim = doc["meshes"][0]["primitives"][0]
    assert "TEXCOORD_0" in prim["attributes"]
    assert "COLOR_0" not in prim["attributes"]
    assert doc["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"] == \
        {"index": 0}
    assert doc["images"][0]["mimeType"] == "image/png"
    assert total == len(raw)


def test_write_glb_rejects_a_texture_with_no_uvs(tmp_path):
    md = _textured_sample()
    md.uvs = None
    with pytest.raises(glb.GltfError):
        glb.write_glb(md, str(tmp_path / "m.glb"))


def test_write_glb_rejects_uvs_from_a_different_atlas_size(tmp_path):
    """A UV outside [0, 1] can only mean the mesh was unwrapped at one size
    and baked at another, which would sample the wrong photograph."""
    md = _textured_sample()
    md.uvs = md.uvs.copy()
    md.uvs[0, 0] = 1.4
    with pytest.raises(glb.GltfError) as exc:
        glb.write_glb(md, str(tmp_path / "m.glb"))
    assert "atlas size" in str(exc.value)


def test_write_glb_rejects_a_texture_of_the_wrong_shape(tmp_path):
    md = _textured_sample()
    md.texture = np.zeros((8, 8, 4), dtype=np.uint8)
    with pytest.raises(glb.GltfError):
        glb.write_glb(md, str(tmp_path / "m.glb"))


def _corrupt_texture_image(src, dst):
    """Rewrite a GLB with the first 16 bytes of the embedded PNG clobbered."""
    import struct as _struct

    raw = bytearray(open(src, "rb").read())
    _magic, _ver, total = _struct.unpack_from("<III", raw, 0)
    clen, _ctype = _struct.unpack_from("<II", raw, 12)
    doc = json.loads(bytes(raw[20:20 + clen]).decode("utf-8"))
    bv = doc["bufferViews"][doc["images"][0]["bufferView"]]
    off = 12 + 8 + clen + 8 + bv["byteOffset"]
    raw[off:off + 16] = b"not a png at all"
    open(dst, "wb").write(bytes(raw))


def test_validator_catches_a_texture_that_does_not_decode(tmp_path):
    """A declared-but-broken texture must not validate.

    The previous check was `bool(gltf["textures"] + gltf["images"])`, which any
    entry satisfies; the validator now follows material -> texture -> image ->
    bufferView and actually decodes the bytes.
    """
    good = str(tmp_path / "good.glb")
    bad = str(tmp_path / "bad.glb")
    glb.write_glb(_textured_sample(), good)
    _corrupt_texture_image(good, bad)
    assert glb.validate_glb(good, min_triangles=2, require_texture=True).ok
    res = glb.validate_glb(bad, min_triangles=2, require_texture=True)
    assert not res.ok
    assert res.details["has_texture"] is False
    assert any("decode" in e for e in res.errors), res.errors


def test_validator_requires_texcoords_when_a_texture_is_present(tmp_path):
    """A base colour texture with no UVs is unusable, not merely untidy."""
    import struct as _struct

    p = str(tmp_path / "m.glb")
    glb.write_glb(_textured_sample(), p)
    raw = bytearray(open(p, "rb").read())
    _m, _v, _t = _struct.unpack_from("<III", raw, 0)
    clen, _c = _struct.unpack_from("<II", raw, 12)
    doc = json.loads(bytes(raw[20:20 + clen]).decode("utf-8"))
    doc["meshes"][0]["primitives"][0]["attributes"].pop("TEXCOORD_0")
    new_json = glb._pad4(json.dumps(doc, separators=(",", ":")).encode("utf-8"))
    tail = bytes(raw[12 + 8 + clen:])
    out = bytearray()
    out += _struct.pack("<III", 0x46546C67, 2,
                        12 + 8 + len(new_json) + len(tail))
    out += _struct.pack("<II", len(new_json), glb.CHUNK_JSON)
    out += new_json
    out += tail
    open(p, "wb").write(bytes(out))
    res = glb.validate_glb(p, require_texture=True)
    assert not res.ok
    assert any("TEXCOORD_0" in e for e in res.errors), res.errors


def test_compute_normals_are_unit_length():
    v = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float64)
    n = glb.compute_normals(v, np.array([[0, 1, 2]]))
    assert np.allclose(np.linalg.norm(n, axis=1), 1.0, atol=1e-6)


# ------------------------------------------------------------------- atlas


def _grid_mesh(n=6):
    """A flat n-by-n grid of triangles in the z=0 plane, plus vertex colours.

    Flat and axis-aligned on purpose: an unwrap of it should be near-isometric,
    which is the property several tests below are asserting.
    """
    g = np.linspace(0.0, 1.0, n)
    xs, ys = np.meshgrid(g, g, indexing="ij")
    v = np.stack([xs.ravel(), ys.ravel(), np.zeros(n * n)], axis=1)
    cols = np.stack([xs.ravel(), ys.ravel(), np.zeros(n * n)], axis=1)
    faces = []
    for i in range(n - 1):
        for j in range(n - 1):
            a = i * n + j
            b = (i + 1) * n + j
            c = (i + 1) * n + j + 1
            d = i * n + j + 1
            faces.append([a, b, c])
            faces.append([a, c, d])
    return meshlib.Mesh(v.astype(np.float32), cols.astype(np.float32),
                        np.array(faces, dtype=np.int64))


def test_unwrap_keeps_uvs_inside_the_unit_square():
    u = atlasmod.unwrap(_grid_mesh(), atlas_size=512)
    assert u.uvs.min() >= 0.0 and u.uvs.max() <= 1.0
    assert len(u.uvs) == u.vertex_count == len(u.vertices)
    assert u.chart_count >= 1
    assert u.atlas_size == 512


def test_unwrap_preserves_the_surface_metric():
    """A planar chart must not distort area: the whole point of the density.

    If this fails, every triangle in the atlas is being squashed or stretched
    and the texture resolution varies across the model for no reason.
    """
    u = atlasmod.unwrap(_grid_mesh(), atlas_size=512)
    v = u.vertices.astype(np.float64)
    ua = u.uvs.astype(np.float64) * u.atlas_size
    a, b, c = v[u.faces[:, 0]], v[u.faces[:, 1]], v[u.faces[:, 2]]
    area3d = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    p, q, r = ua[u.faces[:, 0]], ua[u.faces[:, 1]], ua[u.faces[:, 2]]
    area_texel = 0.5 * np.abs((q[:, 0] - p[:, 0]) * (r[:, 1] - p[:, 1])
                              - (r[:, 0] - p[:, 0]) * (q[:, 1] - p[:, 1]))
    area_world = area_texel / (u.texels_per_unit ** 2)
    np.testing.assert_allclose(area3d, area_world, rtol=1e-6)


def test_unwrap_duplicates_a_shared_vertex_rather_than_choosing_one_chart():
    """A vertex on a chart boundary needs one copy per chart, not one winner.

    Giving it a single UV would silently put the neighbouring chart's geometry
    in the wrong place -- a tear that looks fine until you rotate the model.
    """
    m = _grid_mesh(4)
    u = atlasmod.unwrap(m, atlas_size=256, max_normal_angle_deg=180.0)
    assert u.chart_count > 1, "this mesh should split into several charts"
    # Every chart's corner vertex has its own copy, so the unwrapped vertex
    # count is strictly larger than the source mesh's.
    assert u.vertex_count > m.vertex_count
    # And every emitted face maps back to a real source face.
    assert set(u.source_face.tolist()) == set(range(m.face_count))
    assert np.array_equal(np.sort(u.source_face), np.arange(m.face_count))


def test_source_face_lines_the_two_meshes_up():
    """`source_face` is the map from an emitted triangle back to the input mesh.

    Charts are emitted grouped and largest-first, so the output order is not
    the input order in general; without this map nothing downstream can line a
    mesh triangle up with its unwrapped twin.
    """
    m = _grid_mesh(5)
    u = atlasmod.unwrap(m, atlas_size=256, max_normal_angle_deg=45.0)
    assert u.chart_count > 1
    # A permutation of every input face: no face dropped, none duplicated.
    np.testing.assert_array_equal(np.sort(u.source_face), np.arange(m.face_count))
    lut = np.empty(m.face_count, dtype=np.int64)
    lut[u.source_face] = np.arange(len(u.faces))
    np.testing.assert_array_equal(np.sort(lut), np.arange(len(u.faces)))
    # Each emitted triangle carries the positions of its source triangle.
    for k, src in enumerate(u.source_face):
        emitted_positions = u.vertices[u.faces[k]]
        source_positions = m.vertices[m.faces[src]]
        for p in emitted_positions:
            assert np.min(np.linalg.norm(source_positions - p, axis=1)) < 1e-6


def test_uv_v_axis_points_down_as_gltf_requires():
    """glTF puts TEXCOORD_0 (0,0) at the TOP-LEFT of the image, v increasing down.

    So the texel in image row r must be the one UV v = (r + 0.5) / H names. If
    the rasteriser and the sampler disagree about that, every model is textured
    upside down, and no range check can see it. This builds the triangle by
    hand so the UVs are known exactly rather than inferred from a plane fit.
    """
    size = 128
    u = atlasmod.UnwrappedMesh(
        vertices=np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float32),
        colors=np.zeros((3, 3), dtype=np.float32),
        faces=np.array([[0, 1, 2]], dtype=np.int64),
        # A right triangle whose bottom edge sits at v=0.2 and whose apex is at
        # v=0.7: in image terms, low v must be the TOP of the atlas.
        uvs=np.array([[0.2, 0.2], [0.8, 0.2], [0.2, 0.7]], dtype=np.float32),
        chart_of_face=np.zeros(1, dtype=np.int64),
        source_face=np.zeros(1, dtype=np.int64),
        chart_count=1, atlas_size=size, texels_per_unit=1.0,
        planar_distortion_p95=0.0)
    pos, _nrm, mask = atlasmod.rasterize_texels(u)
    rows = np.nonzero(mask.any(axis=1))[0]
    assert len(rows) > 20
    top, bottom = int(rows.min()), int(rows.max())
    # The apex (v=0.7, y=1 in the mesh) must sit BELOW the base (v=0.2).
    apex = pos[bottom, int(np.nonzero(mask[bottom])[0].mean())]
    base = pos[top, int(np.nonzero(mask[top])[0].mean())]
    assert apex[1] > base[1], (top, bottom, base, apex)
    # And the occupied band must match the declared v range, to a texel.
    assert top == pytest.approx(0.2 * size, abs=2)
    assert bottom == pytest.approx(0.7 * size, abs=2)


def test_unwrap_rejects_a_mesh_it_cannot_handle():
    m = _grid_mesh(4)
    tiny = meshlib.Mesh(m.vertices[:3], m.colors[:3], m.faces[:1])
    with pytest.raises(atlasmod.AtlasError):
        atlasmod.unwrap(tiny)


def test_bake_without_views_reports_nothing_seen_rather_than_inventing():
    u = atlasmod.unwrap(_grid_mesh(), atlas_size=128)
    r = atlasmod.bake(u, [], 64, 48)
    assert r.visible_texels == 0
    assert r.filled_texels == 0
    assert r.views_used == 0
    assert r.covered_texels > 0
    # Every covered texel is still the declared background, not a guess.
    assert (r.texture[r.texture.shape[0] // 2] == 127).all()


def test_bake_refuses_a_size_that_disagrees_with_the_unwrap():
    u = atlasmod.unwrap(_grid_mesh(), atlas_size=128)
    with pytest.raises(atlasmod.AtlasError):
        atlasmod.bake(u, [], 64, 48, atlas_size=256)


def test_bake_samples_the_photograph_colour_not_its_channels_reversed():
    """`View.image` is RGB; reversing it swaps red and blue on the model.

    This is a regression test for a bug that was really shipped once: the
    vertex-colour path named its sample `bgr` and reversed the channels of an
    image the pipeline had loaded through PIL's `convert("RGB")`.
    """
    from pipeline.incremental import View

    m = _grid_mesh(4)
    u = atlasmod.unwrap(m, atlas_size=128, max_normal_angle_deg=180.0)
    # A camera looking straight down at the z=0 plane from z=+5.
    cam = Camera.from_hfov(64, 48, hfov_deg=90.0)
    view = View(index=0, image_name="v", camera=cam,
                keypoints=np.zeros((1, 2)), descriptors=np.zeros((1, 128)),
                sizes=np.ones(1), angles=np.zeros(1),
                R=np.eye(3), t=np.array([0.0, 0.0, 5.0]))
    view.image = np.zeros((48, 64, 3), dtype=np.uint8)
    view.image[:, :] = (200, 40, 90)          # R, G, B
    r = atlasmod.bake(u, [view], 64, 48)
    assert r.visible_texels > 0
    # Only the texels a camera actually saw may be checked: the rest are
    # covered-but-unseen and legitimately hold the declared background. The
    # image is uniform, so a filled texel is indistinguishable from an observed
    # one by colour -- which is exactly why the RGB triple is the thing under
    # test and the counts are checked separately.
    _pos, _nrm, mask = atlasmod.rasterize_texels(u)
    px = r.texture[mask]
    uniq = {tuple(int(c) for c in row) for row in np.unique(px, axis=0)}
    assert uniq <= {(200, 40, 90), (127, 127, 127)}, uniq
    bare = sum(1 for p in px if tuple(int(c) for c in p) == (127, 127, 127))
    assert bare == r.unassigned_texels, (bare, r.unassigned_texels)


def test_bake_result_dict_is_json_serialisable_and_adds_up():
    import json as _json

    u = atlasmod.unwrap(_grid_mesh(), atlas_size=128)
    r = atlasmod.bake(u, [], 64, 48)
    d = r.to_dict()
    _json.loads(_json.dumps(d))
    assert d["atlas_size"] == 128
    assert (d["covered_texels"] + d["background_texels"]
            == 128 * 128), "every texel is either covered or unused"
    # The three covered counts partition the covered texels exactly. If they
    # do not, some covered texel is carrying colour nobody accounted for.
    assert (d["visible_texels"] + d["filled_texels"] + d["unassigned_texels"]
            == d["covered_texels"]), d


def test_unwrap_is_deterministic():
    m = _grid_mesh(7)
    a = atlasmod.unwrap(m, atlas_size=256)
    b = atlasmod.unwrap(m, atlas_size=256)
    assert a.chart_count == b.chart_count
    np.testing.assert_array_equal(a.uvs, b.uvs)


def test_unwrap_does_not_move_geometry():
    """Unwrapping assigns coordinates; it must never reshape the model."""
    m = _grid_mesh(6)
    u = atlasmod.unwrap(m, atlas_size=512)
    for k, src in enumerate(u.source_face):
        assert u.faces[k].max() < u.vertex_count
        assert src < m.face_count
    # Total surface area is preserved exactly.
    assert u.vertices.dtype == np.float32
    v = u.vertices.astype(np.float64)
    a, b, c = v[u.faces[:, 0]], v[u.faces[:, 1]], v[u.faces[:, 2]]
    assert 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1).sum() == \
        pytest.approx(m.surface_area(), rel=1e-5)


# ------------------------------------------------------------- view quality


def _vq_view(index, *, registered=True, n_keypoints=200):
    """A view posed above the origin looking at the z=0 plane."""
    cam = Camera.from_hfov(200, 200, hfov_deg=90.0)
    kp = np.zeros((n_keypoints, 2))
    kp[:, 0] = np.linspace(10, 190, n_keypoints)
    kp[:, 1] = 100.0
    v = inc.View(index=index, image_name=f"photo_{index:02d}.jpg", camera=cam,
                 keypoints=kp, descriptors=np.zeros((n_keypoints, 128), np.float32),
                 sizes=np.ones(n_keypoints), angles=np.zeros(n_keypoints))
    if registered:
        v.R = np.eye(3)
        v.t = np.array([0.0, 0.0, 5.0])
    return v


def _track(point_id, obs):
    return inc.Track(point_id=point_id, obs=dict(obs),
                     xyz=np.array([0.1 * point_id, 0.0, 0.0]))


def _vq_result(views, tracks, registered, seeds=(0,)):
    return inc.SfMResult(
        views=views, tracks=tracks,
        points=np.zeros((len(tracks), 3)), point_track_ids=np.arange(len(tracks)),
        registered_indices=sorted(registered), gauge_index=seeds[0],
        seed_indices=list(seeds), mean_reprojection_error=0.5,
        median_track_length=2.0, bundle_adjusted=False)


def test_view_review_flags_an_unregistered_photo():
    views = [_vq_view(i, registered=(i != 2)) for i in range(4)]
    tracks = [_track(t, {i: t for i in range(4) if i != 2}) for t in range(20)]
    rep = vq.build_report(_vq_result(views, tracks, [0, 1, 3]))
    by = {v.index: v for v in rep.views}
    assert by[2].verdict == vq.VERDICT_UNUSABLE
    assert by[2].registered is False
    assert by[2].role == "unregistered"
    # Every photo gets a verdict; nothing is silently omitted.
    assert len(rep.views) == 4


def test_view_review_explains_an_unplaced_photo_that_matched_fine():
    """The common failure in this product, and it must not be silent.

    This photo is sharp, well textured and verified against its neighbours --
    the solver just could not place it. Reporting only "not used" would be
    true and useless.
    """
    views = [_vq_view(i, registered=(i != 2)) for i in range(4)]
    tracks = [_track(t, {i: t for i in range(4) if i != 2}) for t in range(20)]
    res = _vq_result(views, tracks, [0, 1, 3])
    res.best_edge_inliers = {0: 90, 1: 90, 2: 64, 3: 90}
    res.best_edge_ratio = {0: 0.9, 1: 0.9, 2: 0.8, 3: 0.9}
    by = {v.index: v for v in vq.build_report(res).views}
    assert by[2].verdict == vq.VERDICT_UNUSABLE
    assert any("64 verified features" in n for n in by[2].notes), by[2].notes
    assert "could not place it" in " ".join(by[2].notes)


def test_view_review_says_so_when_a_photo_matched_nothing():
    views = [_vq_view(i, registered=(i != 2)) for i in range(4)]
    tracks = [_track(t, {i: t for i in range(4) if i != 2}) for t in range(20)]
    res = _vq_result(views, tracks, [0, 1, 3])       # no best_edge_inliers at all
    by = {v.index: v for v in vq.build_report(res).views}
    assert any("no other photo" in n for n in by[2].notes), by[2].notes


def test_view_review_calls_a_starved_photo_weak():
    views = [_vq_view(i) for i in range(4)]
    # Views 0-2 see plenty of tracks; view 3 is seen by only two of its own.
    tracks = [_track(t, {i: t for i in range(3)}) for t in range(20)]
    tracks += [_track(100 + t, {3: 0}) for t in range(2)]
    res = _vq_result(views, tracks, [0, 1, 2, 3])
    rep = vq.build_report(res)
    by = {v.index: v for v in rep.views}
    assert by[3].tracks_observed == 2
    assert by[0].tracks_observed == 20
    assert by[3].verdict == vq.VERDICT_WEAK
    assert any("3-D points" in n for n in by[3].notes), by[3].notes
    assert by[0].verdict == vq.VERDICT_OK


def test_view_review_flags_a_photo_with_no_observations_at_all():
    views = [_vq_view(i) for i in range(4)]
    tracks = [_track(t, {i: t for i in range(4) if i != 3}) for t in range(20)]
    res = _vq_result(views, tracks, [0, 1, 2, 3])
    by = {v.index: v for v in vq.build_report(res).views}
    assert by[3].tracks_observed == 0
    assert by[3].verdict == vq.VERDICT_WEAK
    assert any("no reconstructed 3-D point" in n for n in by[3].notes)


def test_view_review_refuses_relative_comparison_on_too_few_views():
    """With two registered views, 'half the median' is not a comparison.

    It must say so rather than inventing a threshold judgement.
    """
    views = [_vq_view(i) for i in range(3)]
    tracks = [_track(t, {i: t for i in range(3)}) for t in range(20)]
    rep = vq.build_report(_vq_result(views, tracks, [0, 1]))
    d = rep.to_dict()
    assert d["relative_thresholds_used"] is False
    assert d["compared_views"] == 2
    assert "without comparing them to each other" in d["note"]
    # The honest fallback is registered/unregistered only: it must not demote
    # anyone on a comparison it could not make. The unregistered view is still
    # reported as unusable, because that needs no comparison.
    by = {v["index"]: v for v in d["views"]}
    assert by[0]["verdict"] == vq.VERDICT_OK and by[1]["verdict"] == vq.VERDICT_OK
    assert by[2]["verdict"] == vq.VERDICT_UNUSABLE
    assert d["counts"]["weak"] == 0


def test_view_review_counts_add_up_and_serialise():
    import json as _json

    views = [_vq_view(i, registered=(i % 2 == 0)) for i in range(6)]
    tracks = [_track(t, {i: t for i in range(6) if i % 2 == 0}) for t in range(20)]
    d = vq.build_report(_vq_result(views, tracks, [0, 2, 4])).to_dict()
    _json.loads(_json.dumps(d))
    counts = d["counts"]
    assert counts["ok"] + counts["weak"] + counts["unusable"] == counts["total"]
    assert counts["total"] == 6
    assert len(d["flagged"]) == counts["weak"] + counts["unusable"]
    assert len(d["views"]) == counts["total"]


def test_view_review_note_names_the_photos_it_flagged():
    views = [_vq_view(i, registered=(i != 5)) for i in range(6)]
    tracks = [_track(t, {i: t for i in range(6) if i != 5}) for t in range(20)]
    d = vq.build_report(_vq_result(views, tracks, [0, 1, 2, 3, 4])).to_dict()
    assert "photo_05.jpg" in d["note"], d["note"]
    # With nothing wrong, the note must not claim a problem.
    views2 = [_vq_view(i) for i in range(6)]
    tracks2 = [_track(t, {i: t for i in range(6)}) for t in range(20)]
    d2 = vq.build_report(_vq_result(views2, tracks2, [0, 1, 2, 3, 4, 5])).to_dict()
    assert d2["flagged"] == []
    assert "All 6 photos contributed" in d2["note"]


def test_view_review_labels_both_seed_views_as_seeds():
    """A seed view is not a PnP placement; saying so would be wrong."""
    views = [_vq_view(i) for i in range(4)]
    tracks = [_track(t, {i: t for i in range(4)}) for t in range(20)]
    res = _vq_result(views, tracks, [0, 1, 2, 3], seeds=(1, 2))
    by = {v.index: v for v in vq.build_report(res).views}
    assert by[1].role == "seed" and by[2].role == "seed"
    assert by[0].role == "pnp" and by[3].role == "pnp"


def test_view_review_never_claims_a_photo_is_better_than_measured():
    """The report must carry the numbers, not just a verdict."""
    views = [_vq_view(i) for i in range(4)]
    tracks = [_track(t, {i: t for i in range(4)}) for t in range(20)]
    d = vq.build_report(_vq_result(views, tracks, [0, 1, 2, 3])).to_dict()
    v = d["views"][0]
    for key in ("keypoints", "tracks_observed", "mean_reprojection_error_px",
                "best_edge_inliers", "median_track_length", "role", "verdict"):
        assert key in v, key
    assert v["keypoints"] == 200
    assert v["tracks_observed"] == 20


# --------------------------------------------------------------------- mesh

def test_surface_reconstruction_is_closed_and_bounded():
    rng = np.random.default_rng(0)
    # Points on a sphere shell.
    dirs = rng.normal(size=(400, 3))
    dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
    pts = dirs * 1.0
    m = meshlib.reconstruct_surface(pts, alpha_scale=3.0)
    assert m.vertex_count > 10
    assert m.face_count > 10
    ext = m.extent()
    assert np.all(ext > 0)
    assert m.surface_area() > 0


def test_surface_rejects_too_few_points():
    with pytest.raises(ValueError):
        meshlib.reconstruct_surface(np.zeros((2, 3)))


def test_outlier_radius_is_finite():
    rng = np.random.default_rng(1)
    pts = rng.normal(size=(120, 3))
    assert np.isfinite(meshlib.estimate_outlier_radius(pts))


# ----------------------------------------------------------------- coverage


def _ring(n, radius=7.0, tilt=0.0):
    """`n` camera centres spread evenly around a circle."""
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return np.stack([radius * np.cos(a), tilt * np.sin(2 * a),
                     radius * np.sin(a)], axis=1)


def test_coverage_detects_a_full_orbit():
    rep = covmod.estimate(_ring(24), point_count=500)
    assert rep is not None
    assert rep.max_gap_deg == pytest.approx(15.0, abs=1e-6)
    assert rep.full_orbit


def test_coverage_flags_a_gap_in_the_orbit():
    # Half an orbit: the wrap-around gap is 180 degrees.
    half = _ring(12)[:6]
    rep = covmod.estimate(half, point_count=500)
    assert rep is not None
    assert not rep.full_orbit
    assert rep.max_gap_deg > 120.0
    assert any("gap" in w for w in rep.warnings)


def test_coverage_report_is_serialisable():
    import json
    rep = covmod.estimate(_ring(24, tilt=0.4), point_count=500)
    d = rep.to_dict()
    assert json.loads(json.dumps(d))["full_orbit"] is True
    assert isinstance(d["warnings"], list)


def test_coverage_needs_enough_evidence():
    assert covmod.estimate(np.zeros((1, 3))) is None
    assert covmod.estimate(np.zeros((0, 3))) is None
    # Coincident cameras describe no orbit at all.
    assert covmod.estimate(np.zeros((5, 3))) is None


def test_coverage_is_invariant_to_where_the_world_origin_sits():
    """Coverage is a property of the capture, not of the coordinate frame.

    An earlier version of the report carried a `centroid_offset` field
    described as how far the orbit sits from the cameras. It was computed as
    `|origin - rel.mean()|` where `rel = centres - origin`, so `rel.mean()`
    is zero BY CONSTRUCTION and the field silently reduced to the distance
    from the cameras to the world origin divided by the orbit radius. Moving
    the same capture 100 units away changed the number; changing the orbit did
    not. It measured the coordinate frame, not the capture.

    This asserts the remaining fields are frame-invariant, which is the
    property the removed field violated.
    """
    ring = _ring(16)
    a = covmod.estimate(ring, point_count=500)
    b = covmod.estimate(ring + np.array([100.0, -50.0, 25.0]), point_count=500)
    assert a is not None and b is not None
    assert a.max_gap_deg == pytest.approx(b.max_gap_deg, abs=1e-6)
    assert a.azimuth_spread == pytest.approx(b.azimuth_spread, abs=1e-9)
    assert a.elevation_range_deg == pytest.approx(b.elevation_range_deg,
                                                  abs=1e-6)
    assert a.full_orbit == b.full_orbit
    # And no field may reintroduce a frame-dependent quantity.
    assert set(a.to_dict()) >= {"max_gap_deg", "azimuth_spread",
                                "elevation_range_deg", "full_orbit", "note",
                                "warnings"}


def test_coverage_note_does_not_overstate():
    """The note shown to users must not claim a full orbit when there is a gap."""
    gapped = covmod.estimate(_ring(12)[:6], point_count=500)
    assert "can be smaller" in gapped.note
    # A genuinely complete capture -- dense enough that the largest gap falls
    # under the threshold -- must make the opposite claim.
    dense = np.linspace(0, 2 * np.pi, 120, endpoint=False)
    ring = np.stack([7.0 * np.cos(dense), 0.4 * np.sin(2 * dense),
                     7.0 * np.sin(dense)], axis=1)
    full = covmod.estimate(ring, point_count=500)
    assert full.full_orbit, full.note
    # A complete orbit makes the opposite claim about width and depth. It may
    # still warn about vertical coverage -- these cameras sit near the
    # equator -- but the note must not contradict `full_orbit`.
    assert "can be smaller" not in full.note
    assert not any("gap" in w for w in full.warnings)


# ----------------------------------------------------------------- features

def test_feature_set_matches_nothing_when_too_small():
    tiny = feat.FeatureSet("x", np.zeros((1, 2), np.float32),
                           np.zeros((1,), np.float32),
                           np.zeros((1,), np.float32),
                           np.zeros((1, 128), np.float32))
    ia, ib, d = feat.match(tiny, tiny)
    assert len(ia) == 0 and len(ib) == 0


def test_detect_and_describe_on_synthetic_texture():
    img = np.zeros((120, 160, 3), dtype=np.uint8)
    img[:] = 30
    rng = np.random.default_rng(3)
    for _ in range(200):
        x, y = rng.integers(5, 155), rng.integers(5, 115)
        img[y - 4:y + 5, x - 4:x + 5] = 230
    fs = feat.detect_and_describe(img, "synthetic", nfeatures=500)
    assert len(fs) > 0, "expected keypoints on a high-contrast pattern"
    assert fs.descriptors.shape[1] == 128


# ------------------------------------------------------------ pipeline gates

def test_missing_image_dir_fails_cleanly(tmp_path):
    with pytest.raises(pipeline_run.PipelineError) as exc:
        pipeline_run.load_images(str(tmp_path / "nope"), pipeline_run.PipelineConfig())
    assert exc.value.stage == "validate_input"


def test_single_image_is_rejected(tmp_path):
    d = tmp_path / "images"
    d.mkdir()
    from PIL import Image
    Image.fromarray(np.zeros((40, 40, 3), np.uint8)).save(d / "a.jpg")
    with pytest.raises(pipeline_run.PipelineError) as exc:
        pipeline_run.load_images(str(d), pipeline_run.PipelineConfig())
    assert "at least 2" in exc.value.message


def test_mixed_resolution_is_rejected(tmp_path):
    from PIL import Image
    d = tmp_path / "images"
    d.mkdir()
    Image.fromarray(np.zeros((40, 40, 3), np.uint8)).save(d / "a.jpg")
    Image.fromarray(np.zeros((60, 60, 3), np.uint8)).save(d / "b.jpg")
    with pytest.raises(pipeline_run.PipelineError) as exc:
        pipeline_run.load_images(str(d), pipeline_run.PipelineConfig())
    assert "inconsistent resolution" in exc.value.message


def test_corrupt_image_is_rejected(tmp_path):
    d = tmp_path / "images"
    d.mkdir()
    (d / "a.jpg").write_bytes(b"not an image at all")
    with pytest.raises(pipeline_run.PipelineError) as exc:
        pipeline_run.load_images(str(d), pipeline_run.PipelineConfig())
    assert exc.value.stage == "validate_input"


def test_image_count_limit_is_enforced(tmp_path):
    from PIL import Image
    d = tmp_path / "images"
    d.mkdir()
    for i in range(5):
        Image.fromarray(np.zeros((20, 20, 3), np.uint8)).save(d / f"{i}.jpg")
    cfg = pipeline_run.PipelineConfig()
    cfg.max_images = 3
    with pytest.raises(pipeline_run.PipelineError) as exc:
        pipeline_run.load_images(str(d), cfg)
    assert "exceeds" in exc.value.message


def test_pipeline_returns_failure_not_exception(tmp_path):
    d = tmp_path / "images"
    d.mkdir()
    from PIL import Image
    for i in range(3):
        Image.fromarray((np.random.default_rng(i).random((64, 64, 3)) * 255
                         ).astype(np.uint8)).save(d / f"{i}.jpg")
    res = pipeline_run.run(str(d), str(tmp_path / "m.glb"))
    assert isinstance(res, pipeline_run.PipelineResult)
    # Random noise has no multi-view consistency; the pipeline must fail
    # explicitly rather than emit a plausible-looking model.
    if not res.ok:
        assert res.error and res.error.get("stage")
        assert res.output_glb is None


# ------------------------------------------------------------------- camera

def test_camera_from_hfov_is_consistent():
    c = Camera.from_hfov(1000, 800, hfov_deg=60.0)
    K = c.K
    assert K[0, 0] == pytest.approx(K[1, 1])
    assert K[0, 2] == pytest.approx(500.0)
    assert K[1, 2] == pytest.approx(400.0)

# ------------------------------------------------------- registration levers

def test_anchor_selection_matches_shipped_default():
    from pipeline.incremental import _track_extension_anchors

    # The shipped configuration must remain exactly the historical behaviour:
    # the first three registered views by index.
    others = [7, 3, 5, 1]
    got = _track_extension_anchors(
        views=None, vi=9, registered=set(others) | {9},
        cfg={"track_extension_anchors": "first3"})
    assert got == [1, 3, 5, 7][:3]


def test_anchor_neighbors_ranking_uses_graph_and_budget():
    from pipeline.incremental import _track_extension_anchors

    def _edge(n):
        return {"score": float(n)}

    graph = {
        (2, 9): _edge(80),   # strongest verified edge for view 9
        (4, 9): _edge(55),
        (1, 9): _edge(80),   # ties 2 on score; parity must break the tie
    }
    cfg = {"track_extension_anchors": "neighbors", "_view_graph": graph}
    got = _track_extension_anchors(
        views=None, vi=9, registered={1, 2, 3, 4}, cfg=cfg)
    # 1 and 2 tie on 80 (parity breaks the tie); a verified 55-inlier edge (4)
    # outranks a view with no verified edge at all (3).
    assert got == [1, 2, 4, 3]

    cfg["anchor_match_budget"] = 2
    got = _track_extension_anchors(
        views=None, vi=9, registered={1, 2, 3, 4}, cfg=cfg)
    assert got == [1, 2]


def test_seed_selection_matches_shipped_default():
    """Shipped rule: most inliers INSIDE the parallax band, never outside."""
    from pipeline.incremental import _pick_seed

    def e(score):
        return {"score": score}

    # Sorted by descending angle, as _select_seed builds it.
    scored = [
        ((0, 9), e(70), 95.0),   # outside the band (hi 90): antiparallel risk
        ((0, 6), e(40), 60.0),   # in band
        ((0, 4), e(90), 30.0),   # in band
        ((0, 1), e(99), 2.0),    # outside the band (lo 3): depth unconstrained
    ]
    assert _pick_seed(scored, {})[0] == (0, 4)
    assert _pick_seed(scored, {"seed_selection": "parallax"})[0] == (0, 4)


def test_seed_selection_modes_stay_inside_the_parallax_band():
    """"widest"/"narrowest" pick by angle but may never leave the band."""
    from pipeline.incremental import _pick_seed

    def e(score):
        return {"score": score}

    scored = [
        ((0, 9), e(70), 95.0),
        ((0, 6), e(40), 60.0),
        ((0, 4), e(90), 30.0),
        ((0, 1), e(99), 2.0),
    ]
    assert _pick_seed(scored, {"seed_selection": "widest"})[0] == (0, 6)
    assert _pick_seed(scored, {"seed_selection": "narrowest"})[0] == (0, 4)
    # A band that excludes everything keeps the documented cheiral fallback
    # (widest angle overall) in EVERY mode -- the fallback is not levered.
    outside = [((0, 9), e(70), 95.0), ((0, 1), e(99), 2.0)]
    for mode in ("parallax", "widest", "narrowest"):
        assert _pick_seed(outside, {"seed_selection": mode})[0] == (0, 9), mode


def test_seed_wide_strong_only_considers_well_supported_edges():
    """Pure "widest" picked a feature-poor edge and the run died at 2/12.

    "wide-strong" must restrict the angle contest to edges with at least
    `seed_wide_strong_frac` of the best in-band inlier count, so a wide seed
    still carries a real 2D-3D supply.
    """
    from pipeline.incremental import _pick_seed

    def e(score):
        return {"score": score}

    scored = [
        ((0, 6), e(40), 60.0),    # wide but weak: 40 < 0.5 * 120
        ((0, 4), e(120), 30.0),   # strong
        ((0, 5), e(80), 45.0),    # 80 >= 0.5 * 120: the widest STRONG edge
    ]
    cfg = {"seed_selection": "wide-strong", "seed_wide_strong_frac": 0.5}
    assert _pick_seed(scored, cfg)[0] == (0, 5)
    # Tighten the support floor: at 0.6 the 120- and 80-inlier edges still
    # qualify (0.6 * 120 = 72), so the widest of those two wins.
    cfg["seed_wide_strong_frac"] = 0.6
    assert _pick_seed(scored, cfg)[0] == (0, 5)
    # At 1.0 only the best-supported edge remains -- the contest degrades to
    # in-band inlier ranking rather than aborting.
    cfg["seed_wide_strong_frac"] = 1.0
    assert _pick_seed(scored, cfg)[0] == (0, 4)


def test_registration_order_defaults_to_pnp_inliers():
    """Shipped behaviour: the view with the most PnP inliers goes next."""
    from pipeline.incremental import _order_key

    assert _order_key(5, 40, {1, 2}, {}) == (40,)
    assert _order_key(5, 40, {1, 2}, {"registration_order": "inliers"}) \
        == (40,)
    # A weaker edge never outranks a stronger one regardless of inliers.
    assert _order_key(5, 40, {1}, {}) > _order_key(7, 10, {1}, {})


def test_registration_order_graph_ranks_edges_and_ties_break_on_inliers():
    from pipeline.incremental import _order_key

    graph = {
        (2, 5): {"score": 80},
        (1, 5): {"score": 10},
        (1, 7): {"score": 50},
    }
    cfg = {"registration_order": "graph", "_view_graph": graph}
    # Strongest edge into the registered set wins, even against more inliers.
    assert _order_key(5, 40, {1, 2, 3}, cfg) == (80, 40)
    assert _order_key(7, 60, {1}, cfg) < _order_key(5, 40, {1, 2, 3}, cfg)
    # No verified edge to any registered view: score 0, inliers break the tie.
    assert _order_key(6, 40, {1, 2, 3}, cfg) == (0, 40)
    assert _order_key(6, 55, {1, 2, 3}, cfg) > _order_key(6, 40, {1, 2, 3}, cfg)
