"""Tests for lib/glb_textures.py: the GLB texture-format guard.

Every GLB here is a synthetic GLB built by the test, not a Tripo output: a
one-triangle mesh with its textures, laid out by hand so the guard's own
transform (re-encode, re-pack, drop the extension) can be checked byte by byte.
Nothing here is a claim about what Tripo's files look like.
"""
import base64
import io
import json
import struct

import pytest

from lib import glb_textures
from lib.glb_textures import GlbTextureError, ensure_supported_textures

PIL = pytest.importorskip("PIL")
from PIL import Image, features  # noqa: E402

needs_webp = pytest.mark.skipif(not features.check("webp"), reason="this Pillow can't encode WebP")
needs_avif = pytest.mark.skipif(not features.check("avif"), reason="this Pillow can't encode AVIF")

JSON_CHUNK, BIN_CHUNK = 0x4E4F534A, 0x004E4942


# ---------------------------------------------------------------------------
# Building and reading GLBs (synthetic GLB built by the test, not a Tripo output)
# ---------------------------------------------------------------------------

def _encode(mode, color, fmt, **kw):
    im = Image.new(mode, (8, 8), color)
    for x in range(8):                       # a diagonal, so the bytes are not trivial
        im.putpixel((x, x), (x * 30, *color[1:]))
    buf = io.BytesIO()
    im.save(buf, format=fmt, **kw)
    return buf.getvalue()


def webp_opaque():
    return _encode("RGB", (200, 40, 40), "WEBP", lossless=True)


def webp_alpha():
    return _encode("RGBA", (40, 200, 40, 128), "WEBP", lossless=True)


def png_bytes():
    return _encode("RGB", (10, 20, 200), "PNG")


def build_glb(gltf: dict, bin_data: bytes | None) -> bytes:
    js = json.dumps(gltf).encode("utf-8")
    js += b" " * (-len(js) % 4)
    body = struct.pack("<II", len(js), JSON_CHUNK) + js
    if bin_data is not None:
        bn = bin_data + b"\x00" * (-len(bin_data) % 4)
        body += struct.pack("<II", len(bn), BIN_CHUNK) + bn
    return b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body


def read_glb(raw: bytes):
    """(gltf, bin chunk data, bin chunk length), asserting the container is valid."""
    assert raw[:4] == b"glTF"
    version, length = struct.unpack_from("<II", raw, 4)
    assert version == 2 and length == len(raw)
    js_len, js_type = struct.unpack_from("<II", raw, 12)
    assert js_type == JSON_CHUNK and js_len % 4 == 0
    gltf = json.loads(raw[20:20 + js_len])
    offset = 20 + js_len
    bin_data = None
    if offset < length:
        bn_len, bn_type = struct.unpack_from("<II", raw, offset)
        assert bn_type == BIN_CHUNK and bn_len % 4 == 0
        bin_data = raw[offset + 8:offset + 8 + bn_len]
        assert offset + 8 + bn_len == length
    return gltf, bin_data


def view_bytes(gltf, bin_data, i):
    v = gltf["bufferViews"][i]
    start = v.get("byteOffset", 0)
    return bin_data[start:start + v["byteLength"]]


def scene(images, *, ext_required=True):
    """A one-triangle mesh with `images` [(bytes, mimeType, via_webp_extension)].
    Views are interleaved, image first, so a re-encode moves every later view:
    positions, image 0, indices (6 bytes: the next view is padded), uv, then the
    other images."""
    bin_data, views = bytearray(), []

    def add(data, **extra):
        bin_data.extend(b"\x00" * (-len(bin_data) % 4))
        views.append({"buffer": 0, "byteOffset": len(bin_data), "byteLength": len(data), **extra})
        bin_data.extend(data)
        return len(views) - 1

    gl_images, textures = [], []

    def add_image(data, mime, via_ext):
        gl_images.append({"bufferView": add(data), "mimeType": mime})
        i = len(gl_images) - 1
        textures.append({"sampler": 0, "extensions": {"EXT_texture_webp": {"source": i}}} if via_ext
                        else {"sampler": 0, "source": i})

    v_pos = add(struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0), target=34962)
    add_image(*images[0])
    v_idx = add(struct.pack("<3H", 0, 1, 2), target=34963)
    v_uv = add(struct.pack("<6f", 0, 0, 1, 0, 0, 1), target=34962)
    for img in images[1:]:
        add_image(*img)

    gltf = {
        "asset": {"version": "2.0", "generator": "synthetic GLB built by the test, not a Tripo output"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 2}, "indices": 1, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
        "accessors": [
            {"bufferView": v_pos, "componentType": 5126, "count": 3, "type": "VEC3",
             "min": [0, 0, 0], "max": [1, 1, 0]},
            {"bufferView": v_idx, "componentType": 5123, "count": 3, "type": "SCALAR"},
            {"bufferView": v_uv, "componentType": 5126, "count": 3, "type": "VEC2"},
        ],
        "samplers": [{"magFilter": 9729, "minFilter": 9987}],
        "textures": textures, "images": gl_images,
        "bufferViews": views, "buffers": [{"byteLength": len(bin_data)}],
    }
    if any(via for _, _, via in images):
        gltf["extensionsUsed"] = ["EXT_texture_webp"]
        if ext_required:
            gltf["extensionsRequired"] = ["EXT_texture_webp"]
    return gltf, bytes(bin_data)


def write(tmp_path, gltf, bin_data, name="m.glb"):
    path = tmp_path / name
    path.write_bytes(build_glb(gltf, bin_data))
    return path


# ---------------------------------------------------------------------------
# Re-encoding
# ---------------------------------------------------------------------------

@needs_webp
def test_a_webp_texture_becomes_jpeg_and_the_bin_chunk_is_repacked(tmp_path):
    gltf, bin_data = scene([(webp_opaque(), "image/webp", True)])
    path = write(tmp_path, gltf, bin_data)
    path.chmod(0o644)

    report = ensure_supported_textures(str(path))

    assert report == {"reencoded": 1, "formats": {"image/webp": 1}}
    out, out_bin = read_glb(path.read_bytes())
    image = out["images"][0]
    assert image["mimeType"] == "image/jpeg"
    jpeg = view_bytes(out, out_bin, image["bufferView"])
    assert jpeg[:3] == b"\xff\xd8\xff"
    with Image.open(io.BytesIO(jpeg)) as im:
        assert im.format == "JPEG" and im.size == (8, 8)
    # Every other view keeps its bytes; every view is 4-byte aligned and in the chunk.
    for i in range(len(gltf["bufferViews"])):
        if i != image["bufferView"]:
            assert view_bytes(out, out_bin, i) == view_bytes(gltf, bin_data, i), f"view {i} changed"
        assert out["bufferViews"][i]["byteOffset"] % 4 == 0
    assert out["buffers"][0]["byteLength"] <= len(out_bin) < out["buffers"][0]["byteLength"] + 4
    # The extension is gone and the texture points at the image itself.
    assert out["textures"][0] == {"sampler": 0, "source": 0}
    assert "extensionsUsed" not in out and "extensionsRequired" not in out
    # Accessors are relative to their view: untouched.
    assert out["accessors"] == gltf["accessors"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["m.glb"], "no temp file left behind"
    assert path.stat().st_mode & 0o777 == 0o644, "the rewrite keeps the file's mode"


@needs_webp
def test_two_images_and_several_views_keep_every_offset_right(tmp_path):
    gltf, bin_data = scene([(webp_opaque(), "image/webp", True), (png_bytes(), "image/png", False),
                            (webp_alpha(), "image/webp", False)])
    path = write(tmp_path, gltf, bin_data)
    png_view = gltf["images"][1]["bufferView"]

    report = ensure_supported_textures(str(path))

    assert report == {"reencoded": 2, "formats": {"image/webp": 2, "image/png": 1}}
    out, out_bin = read_glb(path.read_bytes())
    assert [im["mimeType"] for im in out["images"]] == ["image/jpeg", "image/png", "image/png"]
    # The alpha WebP became a PNG that still has its alpha.
    with Image.open(io.BytesIO(view_bytes(out, out_bin, out["images"][2]["bufferView"]))) as im:
        assert im.format == "PNG" and im.mode == "RGBA"
        assert im.getchannel("A").getextrema()[0] < 255
    # The untouched PNG and every geometry view are byte-identical, at new offsets.
    reencoded = {out["images"][0]["bufferView"], out["images"][2]["bufferView"]}
    moved = 0
    for i, v in enumerate(out["bufferViews"]):
        assert v["byteOffset"] % 4 == 0
        if i not in reencoded:
            assert view_bytes(out, out_bin, i) == view_bytes(gltf, bin_data, i), f"view {i} changed"
            moved += v["byteOffset"] != gltf["bufferViews"][i]["byteOffset"]
    assert moved >= 3, "the re-encode should have moved the views after it"
    assert view_bytes(out, out_bin, png_view) == png_bytes()
    # No two views overlap.
    spans = sorted((v["byteOffset"], v["byteOffset"] + v["byteLength"]) for v in out["bufferViews"])
    assert all(a[1] <= b[0] for a, b in zip(spans, spans[1:]))
    assert out["accessors"] == gltf["accessors"]
    assert out["textures"] == [{"sampler": 0, "source": 0}, {"sampler": 0, "source": 1},
                               {"sampler": 0, "source": 2}]


@needs_webp
def test_a_fully_opaque_alpha_channel_goes_to_jpeg(tmp_path):
    opaque_rgba = _encode("RGBA", (40, 200, 40, 255), "WEBP", lossless=True)
    gltf, bin_data = scene([(opaque_rgba, "image/webp", False)])
    path = write(tmp_path, gltf, bin_data)
    ensure_supported_textures(str(path))
    assert read_glb(path.read_bytes())[0]["images"][0]["mimeType"] == "image/jpeg"


@needs_webp
def test_webp_bytes_are_caught_whatever_the_mime_type_says(tmp_path):
    gltf, bin_data = scene([(webp_opaque(), "image/png", False)])
    path = write(tmp_path, gltf, bin_data)
    report = ensure_supported_textures(str(path))
    assert report["reencoded"] == 1 and report["formats"] == {"image/webp": 1}
    assert read_glb(path.read_bytes())[0]["images"][0]["mimeType"] == "image/jpeg"


@needs_webp
def test_a_webp_data_uri_image_is_reencoded_in_place(tmp_path):
    gltf, bin_data = scene([(png_bytes(), "image/png", False)])
    gltf["images"].append({"uri": "data:image/webp;base64," + base64.b64encode(webp_opaque()).decode()})
    gltf["textures"].append({"extensions": {"EXT_texture_webp": {"source": 1}}})
    gltf["extensionsUsed"] = ["EXT_texture_webp"]
    path = write(tmp_path, gltf, bin_data)

    assert ensure_supported_textures(str(path))["reencoded"] == 1

    out, out_bin = read_glb(path.read_bytes())
    uri = out["images"][1]["uri"]
    assert uri.startswith("data:image/jpeg;base64,")
    assert base64.b64decode(uri.split(",", 1)[1])[:3] == b"\xff\xd8\xff"
    assert out["textures"][1] == {"source": 1} and "extensionsUsed" not in out
    assert out_bin[:len(bin_data)] == bin_data, "nothing in the BIN chunk moved"


@needs_avif
def test_an_avif_texture_is_reencoded_too(tmp_path):
    avif = _encode("RGB", (200, 40, 40), "AVIF")
    gltf, bin_data = scene([(avif, "image/avif", False)])
    path = write(tmp_path, gltf, bin_data)
    report = ensure_supported_textures(str(path))
    assert report == {"reencoded": 1, "formats": {"image/avif": 1}}
    assert read_glb(path.read_bytes())[0]["images"][0]["mimeType"] == "image/jpeg"


# ---------------------------------------------------------------------------
# Nothing to do
# ---------------------------------------------------------------------------

def test_a_glb_that_needs_nothing_stays_byte_identical(tmp_path):
    gltf, bin_data = scene([(png_bytes(), "image/png", False)])
    path = write(tmp_path, gltf, bin_data)
    before, mtime = path.read_bytes(), path.stat().st_mtime_ns
    assert ensure_supported_textures(str(path)) == {"reencoded": 0, "formats": {"image/png": 1}}
    assert path.read_bytes() == before and path.stat().st_mtime_ns == mtime


def test_a_glb_without_images_or_bin_stays_byte_identical(tmp_path):
    path = write(tmp_path, {"asset": {"version": "2.0"}}, None)
    before = path.read_bytes()
    assert ensure_supported_textures(str(path)) == {"reencoded": 0, "formats": {}}
    assert path.read_bytes() == before


# ---------------------------------------------------------------------------
# What it refuses (the file is left as it was)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("ext", ["KHR_draco_mesh_compression", "EXT_meshopt_compression"])
@pytest.mark.parametrize("where", ["extensionsUsed", "extensionsRequired"])
def test_compressed_geometry_is_refused(tmp_path, ext, where):
    gltf, bin_data = scene([(png_bytes(), "image/png", False)])
    gltf[where] = [ext]
    path = write(tmp_path, gltf, bin_data)
    before = path.read_bytes()
    with pytest.raises(GlbTextureError, match=ext) as e:
        ensure_supported_textures(str(path))
    assert e.value.kind == "compressed" and isinstance(e.value, ValueError)
    assert path.read_bytes() == before


def test_a_ktx2_texture_is_refused(tmp_path):
    ktx2 = b"\xabKTX 20\xbb\r\n\x1a\n" + b"\x00" * 20
    gltf, bin_data = scene([(ktx2, "image/ktx2", False)])
    path = write(tmp_path, gltf, bin_data)
    with pytest.raises(GlbTextureError, match="KTX2") as e:
        ensure_supported_textures(str(path))
    assert e.value.kind == "ktx2"


def test_the_basisu_extension_is_refused(tmp_path):
    gltf, bin_data = scene([(png_bytes(), "image/png", False)])
    gltf["extensionsUsed"] = ["KHR_texture_basisu"]
    path = write(tmp_path, gltf, bin_data)
    with pytest.raises(GlbTextureError) as e:
        ensure_supported_textures(str(path))
    assert e.value.kind == "ktx2"


def test_an_image_outside_the_file_is_refused(tmp_path):
    gltf, bin_data = scene([(png_bytes(), "image/png", False)])
    gltf["images"].append({"uri": "textures/albedo.webp"})
    path = write(tmp_path, gltf, bin_data)
    with pytest.raises(GlbTextureError, match="outside the file") as e:
        ensure_supported_textures(str(path))
    assert e.value.kind == "external"


def test_a_buffer_outside_the_file_is_refused(tmp_path):
    gltf, bin_data = scene([(png_bytes(), "image/png", False)])
    gltf["buffers"].append({"uri": "extra.bin", "byteLength": 4})
    path = write(tmp_path, gltf, bin_data)
    with pytest.raises(GlbTextureError) as e:
        ensure_supported_textures(str(path))
    assert e.value.kind == "external"


@pytest.mark.parametrize("raw", [b"not a glb at all, just bytes",
                                 b"glTF" + struct.pack("<II", 1, 20) + b"\x00" * 8])
def test_a_file_that_is_not_a_glb_v2_is_refused(tmp_path, raw):
    path = tmp_path / "m.glb"
    path.write_bytes(raw)
    with pytest.raises(GlbTextureError) as e:
        ensure_supported_textures(str(path))
    assert e.value.kind == "invalid"


@needs_webp
def test_an_undecodable_webp_is_refused_and_the_file_kept(tmp_path):
    broken = b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"\x00" * 8
    gltf, bin_data = scene([(broken, "image/webp", True)])
    path = write(tmp_path, gltf, bin_data)
    before = path.read_bytes()
    with pytest.raises(GlbTextureError) as e:
        ensure_supported_textures(str(path))
    assert e.value.kind == "image"
    assert path.read_bytes() == before


def test_sniff_names_the_formats():
    assert glb_textures._sniff(b"\x89PNG\r\n\x1a\n....") == "image/png"
    assert glb_textures._sniff(b"\xff\xd8\xff\xe0") == "image/jpeg"
    assert glb_textures._sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert glb_textures._sniff(b"\xabKTX 20\xbb\r\n\x1a\n") == "image/ktx2"
    assert glb_textures._sniff(b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1") == "image/avif"
    assert glb_textures._sniff(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42") is None
    assert glb_textures._sniff(b"GIF89a") is None
