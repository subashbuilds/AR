"""GLB (binary glTF 2.0) writer and validator.

Written directly against the glTF 2.0 specification rather than pulled from a
library, so the exact byte layout, accessor bounds and unit conventions are
under our control and auditable.

GLB container layout (glTF 2.0 spec, section 4.4):

    bytes 0..3   magic  'glTF'
    bytes 4..7   version (2)
    bytes 8..11  total length
    bytes 12..15 chunk 0 length
    bytes 16..19 chunk 0 type (0x4E4F534A = 'JSON')
    ...         chunk 0 payload, space-padded to 4 bytes
    bytes ..     chunk 1 length
    bytes ..     chunk 1 type (0x004E4942 = 'BIN')
    ...         chunk 1 payload, space-padded to 4 bytes

Units: glTF is defined in **metres**. If the reconstruction is in an arbitrary
unit, `apply_scale` converts to metres using the calibration factor; the model
is never stretched to a target bounding box, because that would silently
destroy the physical dimensions.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Optional

import numpy as np

GLB_MAGIC = 0x46546C67          # 'glTF'
CHUNK_JSON = 0x4E4F534A         # 'JSON'
CHUNK_BIN = 0x004E4942          # 'BIN\0'

# glTF component types
FLOAT = 5126
UNSIGNED_INT = 5125
UNSIGNED_SHORT = 5123

# glTF target arrays
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963


class GltfError(RuntimeError):
    """Raised when a GLB is malformed or fails validation."""


@dataclass
class MeshData:
    vertices: np.ndarray        # (V, 3) float32
    normals: np.ndarray         # (V, 3) float32
    colors: np.ndarray          # (V, 4) float32, RGBA
    faces: np.ndarray           # (F, 3) uint32
    # Optional baked texture. When `texture` is given, `uvs` is required and
    # COLOR_0 is NOT written: glTF multiplies a vertex colour by the base
    # colour texture, so shipping both would darken every texel by its own
    # colour a second time. See `write_glb`.
    uvs: Optional[np.ndarray] = None      # (V, 2) float32, v downwards
    texture: Optional[np.ndarray] = None  # (H, W, 3) uint8 RGB


def compute_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Area-weighted vertex normals, normalised."""
    v = np.asarray(vertices, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64)
    normals = np.zeros_like(v)
    if len(f) == 0:
        return normals.astype(np.float32)
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    # Un-normalised face normal = cross product, magnitude = 2 * area.
    face_n = np.cross(b - a, c - a)
    for k in range(3):
        np.add.at(normals, f[:, k], face_n)
    norms = np.linalg.norm(normals, axis=1, keepdims=True)
    norms[norms < 1e-12] = 1.0
    return (normals / norms).astype(np.float32)


def encode_png(texture: np.ndarray) -> bytes:
    """Encode an (H, W, 3) uint8 RGB array as PNG bytes.

    PNG rather than JPEG: a baked atlas is mostly flat colour next to hairline
    seams, and JPEG's ringing around those seams is exactly the artefact a
    texture atlas should not have.
    """
    import io

    from PIL import Image

    arr = np.asarray(texture)
    if arr.dtype != np.uint8 or arr.ndim != 3 or arr.shape[2] != 3:
        raise GltfError(
            f"texture must be (H, W, 3) uint8, got {arr.shape} {arr.dtype}")
    buf = io.BytesIO()
    Image.fromarray(arr, mode="RGB").save(buf, format="PNG", compress_level=6)
    return buf.getvalue()


def build_gltf_json(mesh: MeshData, buffer_byte_length: int,
                    generator: str = "objectcapture-ar reconstruction worker",
                    name: str = "captured_object",
                    textured: bool = False,
                    image_bytes: int = 0) -> dict:
    """Build the glTF JSON describing a single indexed triangle mesh.

    Buffer layout, in order: POSITION, NORMAL, TEXCOORD_0 or COLOR_0, indices,
    and -- when textured -- the encoded PNG. Each block is 4-byte aligned
    because the sizes above are all multiples of 4; the PNG is not, so it is
    padded and `image_bytes` is the *unpadded* length.
    """
    v_count = int(len(mesh.vertices))
    attributes = {"POSITION": 0, "NORMAL": 1,
                  "TEXCOORD_0" if textured else "COLOR_0": 2}
    pbr = {
        # White, so the texture is not darkened by a second multiply.
        "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
        "metallicFactor": 0.0,
        "roughnessFactor": 0.85,
    }
    if textured:
        pbr["baseColorTexture"] = {"index": 0}

    attr_nbytes = (int(mesh.uvs.nbytes) if textured else int(mesh.colors.nbytes))
    views = []
    offset = 0
    for nbytes, target in ((int(mesh.vertices.nbytes), ARRAY_BUFFER),
                           (int(mesh.normals.nbytes), ARRAY_BUFFER),
                           (attr_nbytes, ARRAY_BUFFER),
                           (int(mesh.faces.nbytes), ELEMENT_ARRAY_BUFFER)):
        views.append({"buffer": 0, "byteOffset": offset,
                      "byteLength": nbytes, "target": target})
        offset += nbytes
    if textured:
        views.append({"buffer": 0, "byteOffset": offset,
                      "byteLength": int(image_bytes)})

    doc: dict = {
        "asset": {
            "version": "2.0",
            "generator": generator,
            "copyright": "Captured by the object owner.",
        },
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{
            "name": name,
            "primitives": [{
                "attributes": attributes,
                "indices": 3,
                "mode": 4,          # TRIANGLES
                "material": 0,
            }],
        }],
        "materials": [{
            "name": f"{name}_material",
            "pbrMetallicRoughness": pbr,
            "doubleSided": True,
        }],
        "accessors": [
            {   # 0 POSITION
                "bufferView": 0,
                "componentType": FLOAT,
                "count": v_count,
                "type": "VEC3",
                "min": [float(x) for x in mesh.vertices.min(axis=0)],
                "max": [float(x) for x in mesh.vertices.max(axis=0)],
            },
            {   # 1 NORMAL
                "bufferView": 1,
                "componentType": FLOAT,
                "count": v_count,
                "type": "VEC3",
            },
            {   # 2 TEXCOORD_0, or COLOR_0
                "bufferView": 2,
                "componentType": FLOAT,
                "count": v_count,
                "type": "VEC2" if textured else "VEC4",
            },
            {   # 3 indices
                "bufferView": 3,
                "componentType": UNSIGNED_INT,
                "count": int(mesh.faces.size),
                "type": "SCALAR",
            },
        ],
        "bufferViews": views,
        "buffers": [{"byteLength": int(buffer_byte_length)}],
    }
    if textured:
        # No mipmaps: the GLB carries one PNG and generating mip levels would
        # need a sampler convention most viewers do not agree on. Nearest
        # mipmap-free sampling is also the honest choice for a baked atlas,
        # where a wrong mip level bleeds another chart's colour across a seam.
        doc["images"] = [{"bufferView": len(views) - 1, "mimeType": "image/png"}]
        doc["samplers"] = [{
            "magFilter": 9729,       # LINEAR
            "minFilter": 9729,       # LINEAR
            "wrapS": 33071,          # CLAMP_TO_EDGE
            "wrapT": 33071,
        }]
        doc["textures"] = [{"sampler": 0, "source": 0}]
    return doc


def _pad4(data: bytes) -> bytes:
    """Pad with spaces (JSON) per the spec's alignment rule."""
    rem = len(data) % 4
    return data if rem == 0 else data + b" " * (4 - rem)


def write_glb(mesh: MeshData, path: str, name: str = "captured_object") -> dict:
    """Serialise a mesh to a binary glTF file.

    Returns a manifest describing what was written, for downstream validation
    and for recording alongside the model.
    """
    if len(mesh.vertices) == 0:
        raise GltfError("cannot write a GLB with no vertices")
    if len(mesh.faces) == 0:
        raise GltfError("cannot write a GLB with no triangles")
    if mesh.faces.max() >= len(mesh.vertices):
        raise GltfError(
            f"face index {int(mesh.faces.max())} out of range for "
            f"{len(mesh.vertices)} vertices")

    textured = mesh.texture is not None
    if textured and mesh.uvs is None:
        raise GltfError("a texture was supplied without UVs")
    if mesh.uvs is not None and len(mesh.uvs) != len(mesh.vertices):
        raise GltfError(
            f"{len(mesh.uvs)} UVs for {len(mesh.vertices)} vertices")
    if textured:
        u = np.asarray(mesh.uvs, dtype="<f4")
        if not np.all(np.isfinite(u)):
            raise GltfError("TEXCOORD_0 contains NaN or infinite values")
        if u.min() < -1e-6 or u.max() > 1.0 + 1e-6:
            # A UV outside [0, 1] is not an error in glTF -- it wraps or clamps
            # -- but here it can only mean the atlas was unwrapped at a
            # different size than it was baked at, which is a real defect and
            # would sample the wrong photograph.
            raise GltfError(
                f"UVs fall outside [0, 1]: [{float(u.min()):.4f}, "
                f"{float(u.max()):.4f}]; the atlas size disagrees with the bake")
        png = encode_png(mesh.texture)

    # glTF requires little-endian buffers.
    v = np.asarray(mesh.vertices, dtype="<f4")
    n = np.asarray(mesh.normals, dtype="<f4")
    f = np.asarray(mesh.faces, dtype="<u4").reshape(-1)

    blocks = [v.tobytes(), n.tobytes()]
    if textured:
        blocks.append(np.asarray(mesh.uvs, dtype="<f4").tobytes())
    else:
        blocks.append(np.asarray(mesh.colors, dtype="<f4").tobytes())
    blocks.append(f.tobytes())
    if textured:
        blocks.append(png)
    binary = b"".join(blocks)
    # Buffer offsets must respect 4-byte alignment; only the PNG can need it.
    if len(binary) % 4:
        binary += b"\x00" * (4 - len(binary) % 4)

    gltf = build_gltf_json(mesh, len(binary), name=name, textured=textured,
                           image_bytes=len(png) if textured else 0)
    json_bytes = _pad4(json.dumps(gltf, separators=(",", ":")).encode("utf-8"))
    bin_bytes = _pad4(binary)

    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    out = bytearray()
    out += struct.pack("<III", GLB_MAGIC, 2, total)
    out += struct.pack("<II", len(json_bytes), CHUNK_JSON)
    out += json_bytes
    out += struct.pack("<II", len(bin_bytes), CHUNK_BIN)
    out += bin_bytes

    with open(path, "wb") as fh:
        fh.write(out)

    lo = mesh.vertices.min(axis=0)
    hi = mesh.vertices.max(axis=0)
    return {
        "path": path,
        "bytes": len(out),
        "vertex_count": int(len(mesh.vertices)),
        "triangle_count": int(len(mesh.faces)),
        "bbox_min": [float(x) for x in lo],
        "bbox_max": [float(x) for x in hi],
        "extent": [float(x) for x in (hi - lo)],
        "has_vertex_colors": not textured,
        "has_baked_texture": textured,
        "texture_size": int(mesh.texture.shape[0]) if textured else None,
        "units": "metre",
    }


@dataclass
class ValidationResult:
    ok: bool
    errors: list[str]
    warnings: list[str]
    details: dict

    def to_dict(self) -> dict:
        return {"ok": self.ok, "errors": self.errors,
                "warnings": self.warnings, "details": self.details}


def validate_glb(path: str, min_vertices: int = 4,
                 min_triangles: int = 4,
                 max_extent_metres: float = 100.0,
                 require_texture: bool = False) -> ValidationResult:
    """Re-parse a GLB from disk and validate it.

    This is an independent check: it reads the written bytes back rather than
    trusting the writer, so a malformed file cannot be published. It verifies
    the container header, chunk structure, accessor/bufferView bounds, index
    ranges, finiteness, and that the model has plausible size in metres.
    """
    errors: list[str] = []
    warnings: list[str] = []

    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        return ValidationResult(False, [f"cannot read GLB: {exc}"], [], {})

    if len(data) < 12:
        return ValidationResult(False, ["file shorter than a GLB header"], [], {})

    magic, version, total = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        errors.append(f"bad magic 0x{magic:08x}, expected 0x{GLB_MAGIC:08x} ('glTF')")
    if version != 2:
        errors.append(f"unsupported glTF version {version}, expected 2")
    if total != len(data):
        errors.append(f"header length {total} != actual file size {len(data)}")
    if errors:
        return ValidationResult(False, errors, warnings, {})

    # --- chunk walk ---
    chunks: list[tuple[int, int, int]] = []   # (offset, length, type)
    offset = 12
    while offset < len(data):
        if offset + 8 > len(data):
            errors.append("truncated chunk header")
            break
        clen, ctype = struct.unpack_from("<II", data, offset)
        payload = offset + 8
        if payload + clen > len(data):
            errors.append(
                f"chunk at {offset} declares {clen} bytes but only "
                f"{len(data) - payload} remain")
            break
        chunks.append((payload, clen, ctype))
        offset = payload + clen

    json_chunk = next((c for c in chunks if c[2] == CHUNK_JSON), None)
    bin_chunk = next((c for c in chunks if c[2] == CHUNK_BIN), None)
    if json_chunk is None:
        errors.append("missing JSON chunk")
    if bin_chunk is None:
        errors.append("missing BIN chunk")
    if errors:
        return ValidationResult(False, errors, warnings, {})

    # Chunk payloads must be 4-byte aligned per the spec.
    for payload, clen, ctype in chunks:
        if payload % 4 != 0:
            errors.append(f"chunk type 0x{ctype:08x} payload is not 4-byte aligned")

    try:
        gltf = json.loads(data[json_chunk[0]:json_chunk[0] + json_chunk[1]]
                          .decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return ValidationResult(False, [f"invalid JSON chunk: {exc}"], warnings, {})

    asset = gltf.get("asset", {})
    if asset.get("version") != "2.0":
        errors.append(f"asset.version is {asset.get('version')!r}, expected '2.0'")

    buffers = gltf.get("buffers", [])
    if not buffers:
        errors.append("no buffers declared")
        return ValidationResult(False, errors, warnings, {})
    declared_len = int(buffers[0].get("byteLength", -1))
    actual_len = bin_chunk[1]
    if declared_len > actual_len:
        errors.append(
            f"buffer byteLength {declared_len} exceeds BIN chunk size {actual_len}")
    elif declared_len < actual_len:
        warnings.append(
            f"BIN chunk has {actual_len - declared_len} trailing pad bytes "
            "beyond the declared buffer length")

    views = gltf.get("bufferViews", [])
    accessors = gltf.get("accessors", [])
    if not accessors:
        errors.append("no accessors declared")

    component_size = {5126: 4, 5125: 4, 5123: 2, 5121: 1, 5126: 4}
    type_count = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

    details: dict = {"accessors": len(accessors), "buffer_views": len(views)}

    # --- accessor bounds ---
    vmin = vmax = None
    vcount = 0
    icount = 0
    for ai, acc in enumerate(accessors):
        bv_idx = acc.get("bufferView")
        if bv_idx is None:
            continue
        if bv_idx >= len(views):
            errors.append(f"accessor {ai} references missing bufferView {bv_idx}")
            continue
        bv = views[bv_idx]
        ctype = acc.get("componentType")
        ncomp = type_count.get(acc.get("type"), 0)
        if ctype not in component_size or ncomp == 0:
            errors.append(
                f"accessor {ai} has unsupported componentType/type "
                f"{ctype}/{acc.get('type')}")
            continue
        need = component_size[ctype] * ncomp * int(acc.get("count", 0))
        # Per the glTF spec an accessor's byteOffset is relative to the start
        # of its bufferView, not to the start of the buffer. The bufferView's
        # own byteOffset must separately stay inside the buffer.
        acc_off = int(acc.get("byteOffset", 0))
        view_len = int(bv.get("byteLength", 0))
        if acc_off + need > view_len:
            errors.append(
                f"accessor {ai} needs {need} bytes at offset {acc_off} but "
                f"bufferView {bv_idx} is only {view_len} bytes")
        view_off = int(bv.get("byteOffset", 0))
        if view_off + view_len > declared_len:
            errors.append(
                f"bufferView {bv_idx} spans {view_off}..{view_off + view_len} "
                f"which exceeds the {declared_len}-byte buffer")
        if ai == 0:
            vcount = int(acc.get("count", 0))
            vmin = acc.get("min")
            vmax = acc.get("max")
        if acc.get("type") == "SCALAR" and ctype in (UNSIGNED_INT, UNSIGNED_SHORT):
            icount = int(acc.get("count", 0))

    details.update({"vertex_count": vcount, "index_count": icount})

    # --- index range check ---
    # Read the index accessor out of the primitive rather than assuming it is
    # accessor 3: the attribute set differs between the vertex-colour and the
    # textured layouts, and a validator that assumes a position is not a
    # validator.
    prim = {}
    for m in gltf.get("meshes", []):
        prims = m.get("primitives") or []
        if prims:
            prim = prims[0]
            break
    idx_accessor = None
    if isinstance(prim.get("indices"), int):
        ai = prim["indices"]
        if 0 <= ai < len(accessors):
            idx_accessor = accessors[ai]
        else:
            errors.append(f"primitive references missing index accessor {ai}")
    if icount and idx_accessor is not None:
        bv = views[idx_accessor.get("bufferView", 0)]
        off = int(bv.get("byteOffset", 0)) + int(idx_accessor.get("byteOffset", 0))
        idx_dtype = ("<u4" if idx_accessor.get("componentType") == UNSIGNED_INT
                     else "<u2")
        try:
            idx = np.frombuffer(data[bin_chunk[0] + off:
                                     bin_chunk[0] + off + icount *
                                     np.dtype(idx_dtype).itemsize],
                                dtype=idx_dtype)
            details["max_index"] = int(idx.max()) if len(idx) else 0
            if len(idx) and int(idx.max()) >= vcount:
                errors.append(
                    f"index {int(idx.max())} exceeds vertex count {vcount}")
            if len(idx) % 3 != 0:
                errors.append(
                    f"index count {len(idx)} is not a multiple of 3 (TRIANGLES)")
            details["triangle_count"] = len(idx) // 3
        except (ValueError, TypeError) as exc:
            errors.append(f"cannot read index buffer: {exc}")

    # --- position values must be finite ---
    if vcount and vmin is not None:
        if not (len(vmin) == 3 and len(vmax) == 3):
            errors.append("POSITION accessor min/max must have 3 components")
        else:
            extent = [vmax[i] - vmin[i] for i in range(3)]
            details["extent"] = extent
            if any((not np.isfinite(e)) or e <= 0 for e in extent):
                errors.append(
                    f"degenerate bounding box extent {extent}: the mesh has "
                    "zero size on at least one axis")
            if any(e > max_extent_metres for e in extent):
                errors.append(
                    f"model extent {max(extent):.3f} m exceeds the "
                    f"{max_extent_metres} m sanity limit; scale calibration is "
                    "probably wrong")
            try:
                off = int(views[0].get("byteOffset", 0))
                pos = np.frombuffer(data[bin_chunk[0] + off:
                                          bin_chunk[0] + off + vcount * 12],
                                    dtype="<f4").reshape(-1, 3)
                if not np.all(np.isfinite(pos)):
                    errors.append("POSITION contains NaN or infinite values")
                else:
                    actual_lo = pos.min(axis=0)
                    actual_hi = pos.max(axis=0)
                    if (np.abs(actual_lo - np.array(vmin)) > 1e-3).any() or \
                       (np.abs(actual_hi - np.array(vmax)) > 1e-3).any():
                        errors.append(
                            "accessor min/max do not match the actual vertex data")
            except (ValueError, TypeError) as exc:
                warnings.append(f"could not verify position buffer: {exc}")

    if vcount < min_vertices:
        errors.append(f"only {vcount} vertices, expected at least {min_vertices}")
    triangles = details.get("triangle_count", 0)
    if triangles < min_triangles:
        errors.append(
            f"only {triangles} triangles, expected at least {min_triangles}")

    materials = gltf.get("materials", [])
    attrs = prim.get("attributes", {}) if prim else {}
    details["has_vertex_colors"] = "COLOR_0" in attrs

    # --- the texture, if there is one -------------------------------------
    # The previous check was `bool(gltf.get("textures", []) + gltf.get("images", []))`,
    # which is satisfied by an entry that references nothing. A texture is only
    # real if a material reaches it and the bytes behind it decode.
    textures = gltf.get("textures", [])
    images = gltf.get("images", [])
    texture_ok = False
    texture_detail: dict = {}

    mat_idx = prim.get("material") if isinstance(prim.get("material"), int) else None
    if mat_idx is not None and 0 <= mat_idx < len(materials):
        pbr = materials[mat_idx].get("pbrMetallicRoughness", {})
        bct = pbr.get("baseColorTexture", {})
        ti = bct.get("index")
        if isinstance(ti, int) and 0 <= ti < len(textures):
            src = textures[ti].get("source")
            if isinstance(src, int) and 0 <= src < len(images):
                img = images[src]
                bvi = img.get("bufferView")
                uri = img.get("uri")
                if isinstance(bvi, int) and 0 <= bvi < len(views):
                    bv = views[bvi]
                    start = int(bv.get("byteOffset", 0))
                    length = int(bv.get("byteLength", 0))
                    if start + length > declared_len:
                        errors.append(
                            f"texture image spans {start}..{start + length} "
                            f"which exceeds the {declared_len}-byte buffer")
                    else:
                        raw = data[bin_chunk[0] + start:
                                   bin_chunk[0] + start + length]
                        try:
                            import io

                            from PIL import Image
                            with Image.open(io.BytesIO(raw)) as im:
                                im.load()
                                w, h = im.size
                            texture_ok = w > 0 and h > 0
                            texture_detail = {
                                "texture_size": [int(w), int(h)],
                                "texture_bytes": int(length),
                            }
                            if not texture_ok:
                                errors.append("texture image decoded to zero size")
                        except Exception as exc:       # noqa: BLE001
                            errors.append(
                                f"texture image bytes do not decode as an "
                                f"image: {type(exc).__name__}: {exc}")
                elif uri is not None:
                    # An external image is legal glTF but this writer never
                    # produces one, and a GLB that needs a side-car file is not
                    # a shareable model.
                    errors.append(
                        "texture is an external URI; a GLB must embed its image")
                else:
                    errors.append("texture image has neither bufferView nor uri")
            else:
                errors.append(f"texture references missing image {src}")
        elif ti is not None:
            errors.append(f"material references missing texture {ti}")

    if texture_ok:
        tex_acc = attrs.get("TEXCOORD_0")
        if not isinstance(tex_acc, int) or not (0 <= tex_acc < len(accessors)):
            errors.append(
                "the model has a base colour texture but no TEXCOORD_0 attribute")
        else:
            acc = accessors[tex_acc]
            if acc.get("type") != "VEC2":
                errors.append(
                    f"TEXCOORD_0 must be VEC2, found {acc.get('type')!r}")
            if int(acc.get("count", -1)) != vcount:
                errors.append(
                    f"TEXCOORD_0 has {acc.get('count')} entries for "
                    f"{vcount} vertices")
            else:
                try:
                    off = (int(views[acc.get("bufferView", 0)].get("byteOffset", 0))
                           + int(acc.get("byteOffset", 0)))
                    uv = np.frombuffer(
                        data[bin_chunk[0] + off:
                             bin_chunk[0] + off + vcount * 8],
                        dtype="<f4").reshape(-1, 2)
                    if not np.all(np.isfinite(uv)):
                        errors.append("TEXCOORD_0 contains NaN or infinite values")
                    elif uv.min() < -1e-6 or uv.max() > 1.0 + 1e-6:
                        errors.append(
                            f"TEXCOORD_0 falls outside [0, 1] "
                            f"([{float(uv.min()):.4f}, {float(uv.max()):.4f}])")
                except (ValueError, TypeError) as exc:
                    warnings.append(f"could not verify the UV buffer: {exc}")

    if require_texture and not texture_ok:
        errors.append(
            "a texture is required but the model only has vertex colours")
    details["has_texture"] = texture_ok
    details.update(texture_detail)
    details["material_count"] = len(materials)

    return ValidationResult(not errors, errors, warnings, details)