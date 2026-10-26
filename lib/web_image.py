"""HEIC, HEIF and TIFF as an image a browser can draw, with the source's colour profile kept (§568).

The editor and the render are Chromium, which draws neither format: a dropped one would land as an empty square. An
upload of one is stored as a JPEG instead, or as a PNG when the image is not fully opaque (a TIFF logo with
transparency), beside where the upload landed.

Colour: the source's own ICC profile bytes are embedded in what is written, so a Display P3 photo shows as it did, but
only when the profile's colour space is the pixels' own (an RGB profile on RGB, a gray one on gray). A CMYK TIFF is
converted to sRGB through its profile (ImageCms, which matched macOS ColorSync within one level on the test fixture),
and a gray one stays gray, so an RGB output never carries a CMYK or gray profile. The
bundled ffmpeg opens an iPhone HEIC (its tile grid, its rotation) but drops the profile: measured 2026-10-24 with
ffmpeg 8.1.2, a P3 HEIC's mid-blue came out untagged and visibly duller. So a HEIC is decoded by ffmpeg and its
profile is read here, from the primary item's `colr` box ('prof' or 'rICC'); a HEIC whose colour is only an `nclx`
box (no ICC) is written untagged, which reads as sRGB. A TIFF is read by Pillow (its orientation, its profile, an
associated alpha unpremultiplied), and by ffmpeg only when Pillow cannot decode it. A HEIC's auxiliary alpha image is
not read: it becomes a JPEG.

Nothing of the source's metadata is copied but the profile: the rotation is applied to the pixels, and the EXIF
(camera, place, time) is left out.
"""
import io
import os
import struct
import subprocess
import threading
from pathlib import Path

from PIL import Image, ImageOps

HEIF_SUFFIXES = frozenset({".heic", ".heif"})
TIFF_SUFFIXES = frozenset({".tif", ".tiff"})
SUFFIXES = HEIF_SUFFIXES | TIFF_SUFFIXES

JPEG_QUALITY = 92
DECODE_TIMEOUT_S = 120
# The most of a HEIC read to find its profile: the `meta` box comes first in an iPhone file and is a few KB.
META_READ_MAX = 16 * 1024 * 1024
# The most an ffmpeg frame may be: a PAM/PPM of Pillow's own pixel cap at 4 bytes a pixel, plus its header. A crafted
# grid HEIC can declare far more than that, and the decoded frame is held in memory.
MAX_FRAME_BYTES = Image.MAX_IMAGE_PIXELS * 4 + 65536


class WebImageError(Exception):
    """The image could not be read or written. `code` says which."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def needs_conversion(path) -> bool:
    return Path(path).suffix.lower() in SUFFIXES


# ── the HEIF profile ────────────────────────────────────────────────────────────────────────────────────────────────

def _boxes(buf: bytes, start: int, end: int):
    """ISO BMFF boxes in buf[start:end]: (type, content start, box end). Stops at the first malformed one."""
    i = start
    while i + 8 <= end:
        size, typ = struct.unpack(">I4s", buf[i:i + 8])
        hdr = 8
        if size == 1:
            if i + 16 > end:
                return
            size = struct.unpack(">Q", buf[i + 8:i + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - i
        if size < hdr or i + size > end:
            return
        yield typ.decode("latin-1"), i + hdr, i + size
        i += size


def _ipma(buf: bytes, s: int, e: int) -> dict:
    """item id -> [1-based property index], from an `ipma` box's content."""
    version, flags = buf[s], int.from_bytes(buf[s + 1:s + 4], "big")
    p = s + 4
    count = struct.unpack(">I", buf[p:p + 4])[0]
    p += 4
    out = {}
    for _ in range(count):
        if version < 1:
            item = struct.unpack(">H", buf[p:p + 2])[0]
            p += 2
        else:
            item = struct.unpack(">I", buf[p:p + 4])[0]
            p += 4
        n = buf[p]
        p += 1
        idx = []
        for _ in range(n):
            if flags & 1:
                idx.append(struct.unpack(">H", buf[p:p + 2])[0] & 0x7FFF)
                p += 2
            else:
                idx.append(buf[p] & 0x7F)
                p += 1
        out[item] = idx
        if p > e:
            raise ValueError("ipma overruns its box")
    return out


def heif_icc(data: bytes):
    """The ICC profile of a HEIF's primary item (its `colr` 'prof' or 'rICC' box), or None: no `meta`, no primary
    item, a colour given only as `nclx`, or a file this cannot read. Never raises."""
    try:
        meta = next(((s, e) for t, s, e in _boxes(data, 0, len(data)) if t == "meta"), None)
        if meta is None:
            return None
        s, e = meta[0] + 4, meta[1]  # a full box: version and flags first
        primary, props, assoc = None, [], {}
        for t, bs, be in _boxes(data, s, e):
            if t == "pitm":
                primary = struct.unpack(">H", data[bs + 4:bs + 6])[0] if data[bs] == 0 else struct.unpack(">I", data[bs + 4:bs + 8])[0]
            elif t == "iprp":
                for t2, cs, ce in _boxes(data, bs, be):
                    if t2 == "ipco":
                        props = list(_boxes(data, cs, ce))
                    elif t2 == "ipma":
                        assoc = _ipma(data, cs, ce)
        for i in assoc.get(primary, []):
            if 1 <= i <= len(props):
                t, ps, pe = props[i - 1]
                if t == "colr" and data[ps:ps + 4] in (b"prof", b"rICC") and pe > ps + 4:
                    return bytes(data[ps + 4:pe])
        return None
    except (struct.error, ValueError, IndexError):
        return None


# ── decode ──────────────────────────────────────────────────────────────────────────────────────────────────────────

def _ffmpeg_frame(ffmpeg: str, src: Path, alpha: bool) -> Image.Image:
    """The first frame of `src`, rotation applied, as ffmpeg decodes it: RGB, or RGBA with `alpha` (a PAM). Its output
    is read in chunks up to MAX_FRAME_BYTES: past that ffmpeg is killed and the image is too_large."""
    codec, fmt = ("pam", "rgba") if alpha else ("ppm", "rgb24")
    # Only local files; a HEIF is forced to the mov demuxer (it is ISO BMFF) so content probing cannot pick another.
    force = ["-f", "mov"] if src.suffix.lower() in HEIF_SUFFIXES else []
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-protocol_whitelist", "file", *force, "-i", str(src),
           "-frames:v", "1", "-pix_fmt", fmt, "-f", "image2pipe", "-c:v", codec, "-"]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    except OSError as e:
        raise WebImageError("unreadable", f"ffmpeg could not read the image ({type(e).__name__})") from e
    timed_out = threading.Event()

    def _deadline():
        timed_out.set()
        proc.kill()

    timer = threading.Timer(DECODE_TIMEOUT_S, _deadline)
    timer.start()
    chunks, total, too_big = [], 0, False
    try:
        while True:
            chunk = proc.stdout.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_FRAME_BYTES:
                too_big = True
                break
            chunks.append(chunk)
    except OSError:
        pass
    finally:
        timer.cancel()
        if too_big or proc.poll() is None and timed_out.is_set():
            proc.kill()
        proc.stdout.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    if too_big:
        raise WebImageError("too_large", "The image is too large to convert")
    data = b"".join(chunks)
    if timed_out.is_set():
        raise WebImageError("unreadable", "ffmpeg could not read the image (TimeoutExpired)")
    if proc.returncode != 0 or not data:
        raise WebImageError("unreadable", "ffmpeg could not read the image")
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except MemoryError as e:
        raise WebImageError("too_large", "The image is too large to convert") from e
    except Exception as e:  # noqa: BLE001 — Pillow raises many kinds for a bad image
        raise WebImageError("unreadable", "ffmpeg's frame could not be read") from e
    return im


def _decode(src: Path, ffmpeg: str):
    """(an RGB or RGBA image as shown, the source's ICC profile or None)."""
    if src.suffix.lower() in HEIF_SUFFIXES:
        with open(src, "rb") as f:
            head = f.read(META_READ_MAX)
        return _ffmpeg_frame(ffmpeg, src, alpha=False), heif_icc(head)
    icc = None
    try:
        with Image.open(src) as im:
            if im.size[0] * im.size[1] > Image.MAX_IMAGE_PIXELS:  # Pillow only warns between 1x and 2x its cap
                raise WebImageError("too_large", "The image is too large to convert")
            icc = im.info.get("icc_profile")
            out = _pixels(ImageOps.exif_transpose(im))
            out.load()
            return out, icc
    except WebImageError:
        raise
    except (Image.DecompressionBombError, MemoryError) as e:
        raise WebImageError("too_large", "The image is too large to convert") from e
    except Exception:  # noqa: BLE001 — a TIFF Pillow cannot decode (a compression it lacks): ffmpeg's turn
        return _ffmpeg_frame(ffmpeg, src, alpha=True), icc


def _pixels(im: Image.Image) -> Image.Image:
    """A TIFF's pixels in a mode written as they are: RGB, RGBA, L, LA, or CMYK (converted by _fit). An associated
    (premultiplied) alpha, "RGBa" or "La", is unpremultiplied by convert(); a 16-bit gray is scaled to 8 bits, never
    clipped (convert("L") of "I;16" clips every value over 255)."""
    if im.mode in ("RGB", "RGBA", "L", "LA", "CMYK"):
        return im
    if im.mode.startswith("I;16") or im.mode == "I":
        top = 65535 if im.mode.startswith("I;16") else max(im.convert("I").getextrema()[1], 1)
        return im.convert("I").point(lambda v: v * 255 / top).convert("L")
    if im.mode in ("1", "F"):
        return im.convert("L")
    if im.mode == "La":
        return im.convert("LA")
    bands = im.getbands()
    return im.convert("RGBA" if "A" in bands or "a" in bands or "transparency" in im.info else "RGB")


_SRGB = None


def _fit(im: Image.Image, icc):
    """(image, profile to embed): the profile only when its colour space (ICC bytes 16:20) is the pixels' own. CMYK is
    converted to sRGB through its own profile when it has one (the result is sRGB, so nothing is embedded), else
    plainly."""
    global _SRGB
    space = bytes(icc[16:20]) if icc and len(icc) >= 20 else None
    if im.mode == "CMYK":
        try:  # here, not at import: serve loads this at start and a Pillow without littlecms must not stop it
            from PIL import ImageCms
        except ImportError:
            ImageCms = None
        if space == b"CMYK" and ImageCms is not None:
            try:
                if _SRGB is None:
                    _SRGB = ImageCms.createProfile("sRGB")
                return ImageCms.profileToProfile(im, ImageCms.ImageCmsProfile(io.BytesIO(icc)), _SRGB, outputMode="RGB"), None
            except (ImageCms.PyCMSError, OSError, ValueError):
                pass
        return im.convert("RGB"), None
    if im.mode in ("L", "LA"):
        return im, (icc if space == b"GRAY" else None)
    return im, (icc if space == b"RGB " else None)


# ── write ───────────────────────────────────────────────────────────────────────────────────────────────────────────

def _new_file(dest_dir: Path, stem: str, suffix: str):
    """A new file in dest_dir, `<stem><suffix>` or `<stem>_<n><suffix>` (save_upload's convention), opened O_EXCL."""
    dest = dest_dir / f"{stem}{suffix}"
    n = 1
    while True:
        try:
            return dest, open(dest, "xb")
        except FileExistsError:
            dest = dest_dir / f"{stem}_{n}{suffix}"
            n += 1


def to_web_image(src, ffmpeg: str) -> Path:
    """Write `src` (a HEIC, HEIF or TIFF) beside itself as `<stem>.jpg`, or `<stem>.png` when any pixel is not fully
    opaque, with the source's ICC profile, and answer its path. The source is left as it is. A new file, never one
    that exists (de-duplicated as an upload is). Raises WebImageError, or OSError for a write that fails (a full
    disk): what it wrote is removed first."""
    src = Path(src)
    im, icc = _fit(*_decode(src, ffmpeg))
    opaque = im.mode in ("RGB", "L") or im.getchannel("A").getextrema()[0] == 255
    kw = {"icc_profile": icc} if icc else {}
    dest, f = _new_file(src.parent, src.stem, ".jpg" if opaque else ".png")
    try:
        with f:
            if opaque:
                im.convert("L" if im.mode in ("L", "LA") else "RGB").save(f, "JPEG", quality=JPEG_QUALITY, subsampling=0, **kw)
            else:
                im.save(f, "PNG", **kw)
    except BaseException:
        try:
            os.unlink(dest)
        except OSError:
            pass
        raise
    return dest
