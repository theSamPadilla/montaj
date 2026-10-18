"""Make a binary glTF (.glb) loadable by Montaj: no WebP or AVIF textures, no
geometry compression the file requires, nothing outside the file.

Montaj's model import reads PNG and JPEG textures (a WebP, AVIF or KTX2 texture
falls back to the bare base colour) and refuses a file whose extensionsRequired
names Draco or meshopt geometry (one that only lists them in extensionsUsed
carries a fallback it can read). A GLB from any source goes through
`ensure_supported_textures(path)` after download:

  - Draco or meshopt geometry (KHR_draco_mesh_compression, EXT_meshopt_compression,
    KHR_meshopt_compression) named in extensionsRequired raises
    GlbTextureError(kind="compressed"); named only in extensionsUsed, it is kept.
  - A WebP or AVIF image (by mimeType, by an EXT_texture_webp/EXT_texture_avif
    texture extension, or by its bytes) is decoded with Pillow and re-encoded:
    PNG when it has an alpha channel with any pixel short of opaque, else JPEG
    at quality 92. The BIN chunk is re-packed (every bufferView 4-byte aligned,
    every byteOffset recomputed; accessors are relative to their view, so they
    are untouched), the texture extension is dropped (`texture.source` points at
    the image) and the extension leaves extensionsUsed/extensionsRequired.
  - A KTX2/Basis texture (KHR_texture_basisu, or KTX2 bytes) can't be re-encoded
    here; it is kept and counted (`ktx2` in the report) so the caller can warn
    that Montaj shows its base colour only.
  - An image or buffer stored outside the file (an external `uri`) raises
    (kind="external"); a `data:` URI image is handled like an embedded one.

The file is rewritten atomically (a temp file beside it, then a rename), and a
GLB that needs nothing is left byte-identical. Nothing here is vendor-specific.

GLB layout (glTF 2.0 spec, "Binary glTF Layout"): a 12-byte header (magic
"glTF", version 2, total length), then chunks of (length, type, data): the JSON
chunk first (padded with spaces to 4 bytes), then an optional BIN chunk (padded
with zeros). buffers[0] without a `uri` is the BIN chunk.
"""
import base64
import io
import json
import os
import struct
import tempfile

GLB_MAGIC = b"glTF"
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

COMPRESSION_EXTENSIONS = ("KHR_draco_mesh_compression", "EXT_meshopt_compression",
                          "KHR_meshopt_compression")
_REENCODE_EXTENSIONS = {"EXT_texture_webp": "image/webp", "EXT_texture_avif": "image/avif"}
_KTX2_EXTENSION = "KHR_texture_basisu"

JPEG_QUALITY = 92


class GlbTextureError(ValueError):
    """A GLB Montaj can't use and this module can't fix. `kind` says why:
    "invalid" (not a glTF 2.0 binary), "compressed" (Draco or meshopt geometry
    the file requires), "external" (an image or buffer outside the file) or
    "image" (an image Pillow could not decode)."""

    def __init__(self, message: str, kind: str):
        super().__init__(message)
        self.kind = kind


def _sniff(data: bytes) -> str | None:
    """The image type its bytes say, or None."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:12] == b"\xabKTX 20\xbb\r\n\x1a\n":
        return "image/ktx2"
    if data[4:8] == b"ftyp":
        # ISO-BMFF: the major brand, then the compatible brands to the box's end.
        size = int.from_bytes(data[:4], "big")
        brands = {data[i:i + 4] for i in range(8, min(max(size, 16), len(data)) - 3, 4)}
        if brands & {b"avif", b"avis"}:
            return "image/avif"
    return None


def _parse(raw: bytes) -> tuple[dict, bytes | None, list[tuple[int, bytes]]]:
    """(gltf JSON, BIN chunk data or None, any other chunks as (type, data))."""
    if len(raw) < 20 or raw[:4] != GLB_MAGIC:
        raise GlbTextureError("not a binary glTF file (no 'glTF' header)", "invalid")
    version, length = struct.unpack_from("<II", raw, 4)
    if version != 2:
        raise GlbTextureError(f"binary glTF version {version}; only version 2 is supported", "invalid")
    if length > len(raw):
        raise GlbTextureError(f"truncated: the header says {length} bytes, the file has {len(raw)}", "invalid")
    chunks, offset = [], 12
    while offset + 8 <= length:
        size, ctype = struct.unpack_from("<II", raw, offset)
        start, end = offset + 8, offset + 8 + size
        if end > length:
            raise GlbTextureError("truncated chunk", "invalid")
        chunks.append((ctype, raw[start:end]))
        offset = end
    if not chunks or chunks[0][0] != CHUNK_JSON:
        raise GlbTextureError("the first chunk is not JSON", "invalid")
    try:
        # Padding is spaces by the spec; some writers pad with zeros.
        gltf = json.loads(chunks[0][1].rstrip(b" \x00").decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise GlbTextureError(f"unreadable JSON chunk: {e}", "invalid") from e
    if not isinstance(gltf, dict):
        raise GlbTextureError("the JSON chunk is not an object", "invalid")
    rest = chunks[1:]
    bin_data = None
    if rest and rest[0][0] == CHUNK_BIN:
        bin_data, rest = rest[0][1], rest[1:]
    return gltf, bin_data, rest


def _pad(data: bytes, fill: bytes) -> bytes:
    return data + fill * (-len(data) % 4)


def _pack(gltf: dict, bin_data: bytes | None, rest: list[tuple[int, bytes]]) -> bytes:
    json_chunk = _pad(json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8"), b" ")
    chunks = [(CHUNK_JSON, json_chunk)]
    if bin_data is not None:
        chunks.append((CHUNK_BIN, _pad(bin_data, b"\x00")))
    chunks += [(t, _pad(d, b"\x00")) for t, d in rest]
    body = b"".join(struct.pack("<II", len(d), t) + d for t, d in chunks)
    return GLB_MAGIC + struct.pack("<II", 2, 12 + len(body)) + body


def _list(gltf: dict, key: str) -> list:
    value = gltf.get(key)
    return value if isinstance(value, list) else []


def _is_bin_buffer(gltf: dict, index) -> bool:
    buffers = _list(gltf, "buffers")
    return (index == 0 and bool(buffers) and isinstance(buffers[0], dict)
            and "uri" not in buffers[0])


def _reencode(data: bytes, what: str) -> tuple[bytes, str]:
    """(new bytes, new mime type): PNG when any pixel is short of opaque, else JPEG."""
    try:
        from PIL import Image
    except ImportError as e:  # pragma: no cover - Pillow is a montaj dependency
        raise GlbTextureError(f"Pillow is needed to re-encode {what}", "image") from e
    try:
        with Image.open(io.BytesIO(data)) as src:
            src.load()
            im = src
            if im.mode == "P" or (im.mode not in ("RGBA", "LA") and "transparency" in im.info):
                im = im.convert("RGBA")
            alpha = im.mode in ("RGBA", "LA", "PA") and im.getchannel("A").getextrema()[0] < 255
            buf = io.BytesIO()
            if alpha:
                (im if im.mode in ("RGBA", "LA") else im.convert("RGBA")).save(buf, format="PNG")
                return buf.getvalue(), "image/png"
            im.convert("RGB").save(buf, format="JPEG", quality=JPEG_QUALITY)
            return buf.getvalue(), "image/jpeg"
    except GlbTextureError:
        raise
    except Exception as e:
        raise GlbTextureError(f"could not decode {what}: {e}", "image") from e


def _data_uri(uri: str) -> tuple[str, bytes]:
    head, sep, payload = uri.partition(",")
    if not sep or not head.endswith(";base64"):
        raise GlbTextureError("an image data URI that is not base64", "external")
    try:
        return head[5:-7], base64.b64decode(payload, validate=True)
    except ValueError as e:
        raise GlbTextureError(f"an unreadable image data URI: {e}", "external") from e


def _check_extensions(gltf: dict) -> None:
    """Refuse geometry compression the file requires. Listed only in extensionsUsed,
    the extension is optional: the file carries data a loader without it can read."""
    required = set(_list(gltf, "extensionsRequired"))
    found = [x for x in COMPRESSION_EXTENSIONS if x in required]
    if found:
        raise GlbTextureError(f"compressed geometry the file requires ({', '.join(found)})", "compressed")


def _texture_sources(gltf: dict) -> tuple[set, set]:
    """(images a WebP/AVIF texture extension points at, images a KTX2 one does)."""
    reencode, ktx2 = set(), set()
    for tex in _list(gltf, "textures"):
        ext = tex.get("extensions") if isinstance(tex, dict) else None
        if not isinstance(ext, dict):
            continue
        for name in _REENCODE_EXTENSIONS:
            if isinstance(ext.get(name), dict) and isinstance(ext[name].get("source"), int):
                reencode.add(ext[name]["source"])
        if isinstance(ext.get(_KTX2_EXTENSION), dict):
            ktx2.add(ext[_KTX2_EXTENSION].get("source"))
    return reencode, ktx2


def _image_bytes(gltf: dict, bin_data: bytes | None, index: int, image: dict) -> tuple[bytes, str, str | None]:
    """(the image's bytes, where they live: "view" or "uri", the type a data URI declares)."""
    if "uri" in image:
        uri = image["uri"]
        if not isinstance(uri, str) or not uri.startswith("data:"):
            raise GlbTextureError(f"image {index} is stored outside the file ({str(uri)[:80]})", "external")
        mime, data = _data_uri(uri)
        return data, "uri", mime or None
    views = _list(gltf, "bufferViews")
    vi = image.get("bufferView")
    if not isinstance(vi, int) or not 0 <= vi < len(views):
        raise GlbTextureError(f"image {index} has no readable bufferView", "invalid")
    view = views[vi]
    if not _is_bin_buffer(gltf, view.get("buffer")) or bin_data is None:
        raise GlbTextureError(f"image {index} is in a buffer outside the GLB's binary chunk", "external")
    start = view.get("byteOffset", 0)
    end = start + view.get("byteLength", 0)
    if end > len(bin_data):
        raise GlbTextureError(f"image {index}'s bufferView runs past the binary chunk", "invalid")
    return bin_data[start:end], "view", None


def _repack(gltf: dict, bin_data: bytes, replaced: dict[int, bytes]) -> bytes:
    """The BIN chunk rebuilt from its bufferViews in their original order, each
    4-byte aligned, with `replaced` {view index: new bytes} swapped in. Every
    view's byteOffset and byteLength is rewritten; buffers[0].byteLength too."""
    views = _list(gltf, "bufferViews")
    ours = [i for i, v in enumerate(views) if isinstance(v, dict) and _is_bin_buffer(gltf, v.get("buffer"))]
    ours.sort(key=lambda i: (views[i].get("byteOffset", 0), i))
    out = bytearray()
    for i in ours:
        v = views[i]
        start = v.get("byteOffset", 0)
        data = replaced.get(i, bin_data[start:start + v.get("byteLength", 0)])
        out += b"\x00" * (-len(out) % 4)
        v["byteOffset"] = len(out)
        v["byteLength"] = len(data)
        out += data
    gltf["buffers"][0]["byteLength"] = len(out)
    return bytes(out)


def _drop_extensions(gltf: dict, names) -> None:
    for tex in _list(gltf, "textures"):
        ext = tex.get("extensions") if isinstance(tex, dict) else None
        if not isinstance(ext, dict):
            continue
        for name in names:
            if isinstance(ext.get(name), dict):
                source = ext.pop(name).get("source")
                if isinstance(source, int):
                    tex["source"] = source
        if not ext:
            del tex["extensions"]
    for key in ("extensionsUsed", "extensionsRequired"):
        if key in gltf and isinstance(gltf[key], list):
            gltf[key] = [x for x in gltf[key] if x not in names]
            if not gltf[key]:
                del gltf[key]


def _write_atomic(path: str, data: bytes) -> None:
    folder = os.path.dirname(os.path.abspath(path))
    mode = os.stat(path).st_mode & 0o777    # mkstemp makes 0600; keep the file's own mode
    fd, tmp = tempfile.mkstemp(prefix=".glb-", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def ensure_supported_textures(path: str) -> dict:
    """Check and, where needed, fix the GLB at `path` in place (see the module
    docstring). Returns {"reencoded": <images re-encoded>, "ktx2": <KTX2/Basis
    images kept as they are>, "formats": {<mime type>: <images of it before the
    fix>}} ("unknown" for bytes no sniffer names). Raises GlbTextureError for
    what can't be fixed, leaving the file as it was."""
    with open(path, "rb") as f:
        raw = f.read()
    gltf, bin_data, rest = _parse(raw)
    _check_extensions(gltf)

    ext_reencode, ext_ktx2 = _texture_sources(gltf)
    for buf_i, buf in enumerate(_list(gltf, "buffers")):
        uri = buf.get("uri") if isinstance(buf, dict) else None
        if isinstance(uri, str) and not uri.startswith("data:"):
            raise GlbTextureError(f"buffer {buf_i} is stored outside the file ({uri[:80]})", "external")

    formats: dict[str, int] = {}
    work = []   # (image index, bytes, where)
    ktx2 = 0
    for i, image in enumerate(_list(gltf, "images")):
        if not isinstance(image, dict):
            continue
        data, where, uri_mime = _image_bytes(gltf, bin_data, i, image)
        declared = image.get("mimeType") or uri_mime
        kind = _sniff(data) or declared or "unknown"
        formats[kind] = formats.get(kind, 0) + 1
        if kind == "image/ktx2" or declared == "image/ktx2" or i in ext_ktx2:
            ktx2 += 1     # kept: Montaj shows the base colour, and Pillow can't decode it
            continue
        if kind in ("image/webp", "image/avif") or declared in ("image/webp", "image/avif") or i in ext_reencode:
            work.append((i, data, where))

    required = set(_list(gltf, "extensionsRequired"))
    if not work and not any(x in required for x in _REENCODE_EXTENSIONS):
        return {"reencoded": 0, "ktx2": ktx2, "formats": formats}

    images, replaced = _list(gltf, "images"), {}
    for i, data, where in work:
        new, mime = _reencode(data, f"image {i}")
        image = images[i]
        if where == "uri":
            image["uri"] = f"data:{mime};base64,{base64.b64encode(new).decode('ascii')}"
            if "mimeType" in image:
                image["mimeType"] = mime
        else:
            replaced[image["bufferView"]] = new
            image["mimeType"] = mime
    if replaced:
        bin_data = _repack(gltf, bin_data, replaced)
    _drop_extensions(gltf, tuple(_REENCODE_EXTENSIONS))
    _write_atomic(path, _pack(gltf, bin_data, rest))
    return {"reencoded": len(work), "ktx2": ktx2, "formats": formats}
