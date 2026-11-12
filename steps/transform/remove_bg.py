#!/usr/bin/env python3
"""Remove video background using RVM (Robust Video Matting) on onnxruntime's CPU provider.

Outputs ProRes 4444 .mov with alpha channel; an image input, a PNG with alpha.
"""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run, ffmpeg_bin, ffprobe_bin, get_duration, ff_input
import models
import onnx_runtime
import rvm_model

# ---------------------------------------------------------------------------
# Dependency check at import time (not inside main)
# ---------------------------------------------------------------------------
_missing = []
try:
    import numpy as np
except ImportError:
    _missing.append("numpy")
try:
    onnxruntime = onnx_runtime.load()
except ImportError:
    _missing.append("onnxruntime")
try:
    import av
    from av.video.reformatter import Colorspace
except ImportError:
    _missing.append("av")

if _missing:
    fail("missing_dependency",
         f"Background removal is missing part of its runtime ({', '.join(_missing)}). Reinstall Montaj.")

# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

# CPU only, on every OS: CoreML's provider produced wrong mattes (measured, PL2).
_PROVIDERS = ["CPUExecutionProvider"]
# libavutil AVCOL_SPC values: a frame with no matrix tag, and BT.601 (what the writer produces)
_AVCOL_SPC_UNSPECIFIED = 2
_AVCOL_SPC_SMPTE170M = 6
_OUTPUT_NAMES = ["fgr", "pha", "r1o", "r2o", "r3o", "r4o"]


def _load_session():
    """Open the pinned RVM model. It is never downloaded here: the app stages it
    on start, the CLI with its installer."""
    model_file = models.model_path("rvm", rvm_model.FILENAME)
    if not os.path.isfile(model_file):
        fail("missing_model",
             "The background removal model is missing. Montaj restores it the next time it starts.")
    return onnxruntime.InferenceSession(model_file, providers=_PROVIDERS)


# ---------------------------------------------------------------------------
# ffmpeg time limits
# ---------------------------------------------------------------------------

# The VP9 alpha preview encodes at about 22 fps at 1080x1920 and 5 fps at 4K,
# so a fixed limit cuts off long 4K clips. 10 s per second of footage covers a
# 4K clip at 30 fps with room to spare.
_FFMPEG_FLOOR_S = 300
_FFMPEG_S_PER_CLIP_S = 10


def _ffmpeg_timeout(path: str) -> int:
    """Time limit for an ffmpeg pass over this clip. A clip whose duration cannot
    be probed gets the floor."""
    try:
        duration = get_duration(path)
    except (Exception, SystemExit):
        duration = 0.0
    return max(_FFMPEG_FLOOR_S, int(duration * _FFMPEG_S_PER_CLIP_S))


def _run_ffmpeg(cmd: list[str], clip_path: str) -> None:
    """common.run with a limit scaled to the clip. A run that outlives it fails
    with error JSON rather than escaping as a TimeoutExpired traceback."""
    try:
        run(cmd, timeout=_ffmpeg_timeout(clip_path))
    except subprocess.TimeoutExpired:
        fail("unexpected_error", "Writing the cutout video took too long and was stopped. "
                                 "Try a shorter clip or a smaller size.")


# ---------------------------------------------------------------------------
# Output size
# ---------------------------------------------------------------------------

def _check_max_height(max_height: int | None) -> None:
    if max_height is not None and (max_height <= 0 or max_height % 2):
        fail("invalid_args", f"--max-height must be a positive even number, got {max_height}")


def _target_size(width: int, height: int, rotation: int, max_height: int | None) -> tuple[int, int]:
    """Stored (width, height) to decode at so the cutout's display height is at
    most max_height. Never scales up; the other side follows the aspect ratio,
    rounded to even. A +-90 rotation displays the stored width as the height.
    """
    _check_max_height(max_height)
    if max_height is None:
        return width, height
    quarter_turn = abs(((rotation + 180) % 360) - 180) == 90
    display_height = width if quarter_turn else height
    if display_height <= max_height:
        return width, height
    scale = max_height / display_height

    def _even(x: float) -> int:
        return max(2, int(x / 2 + 0.5) * 2)

    if quarter_turn:
        return max_height, _even(height * scale)
    return _even(width * scale), max_height


# ---------------------------------------------------------------------------
# Core inference for a single file
# ---------------------------------------------------------------------------

def _probe_source_rotation(input_path: str) -> int:
    """Read source video rotation (degrees) from displaymatrix side_data.

    Mirrors lib/normalize._probe_rotation but kept local so this step doesn't
    take a dependency on the normalize module just for the probe.

    Returns 0 when no rotation tag is present (most non-iPhone footage). iPhone
    vertical recordings come in as -90; landscape iPhone clips have 0.
    """
    try:
        r = subprocess.run([
            ffprobe_bin(), "-v", "quiet", "-select_streams", "v:0",
            "-show_entries", "stream_side_data=rotation",
            "-of", "json", ff_input(input_path),
        ], capture_output=True, text=True, timeout=10)
        if r.returncode != 0:
            return 0
        streams = json.loads(r.stdout).get("streams", [])
        if not streams:
            return 0
        for entry in streams[0].get("side_data_list", []) or []:
            if "rotation" in entry:
                return int(entry["rotation"])
        return 0
    except (json.JSONDecodeError, ValueError, TypeError, subprocess.TimeoutExpired):
        return 0


def _rotation_to_transpose_filter(rotation: int) -> str | None:
    """Map a source displaymatrix rotation (degrees) to the ffmpeg filter chain
    that physically rotates the pixels by the same amount.

    Why physical rotation, not metadata: ffmpeg 8.x silently drops
    '-metadata:s:v:0 rotate=N' on fresh writes (the flag only survives '-c copy'
    of an already-tagged source). There's no 'setdisplaymatrix' filter and no
    other CLI-accessible way to write displaymatrix side_data on a fresh
    encode. The reliable fix is to physically rotate the pixels — ProRes 4444
    is intra-frame, so re-encoding is fast and lossless.

    Maps:
      rotation=0   → None (caller uses -c:v copy fast path)
      rotation=-90 → transpose=1  (90° CW; iPhone vertical default)
      rotation=+90 → transpose=2  (90° CCW)
      rotation=180 → transpose=1,transpose=1  (180° via two CW quarter turns)
      ±270         → equivalent to ∓90

    Returns None for rotation=0 OR for unsupported (e.g. fractional) values.
    """
    r = ((rotation + 180) % 360) - 180  # normalize to (-180, 180]
    if r == 0:
        return None
    if r == -90:
        return "transpose=1"
    if r == 90:
        return "transpose=2"
    if abs(r) == 180:
        return "transpose=1,transpose=1"
    return None  # arbitrary angles not supported (rare; player will see no rotation)


def _process_one(
    input_path: str,
    output_path: str,
    session,
    downsample: float,
    max_height: int | None,
    emit_progress: bool,
) -> str:
    """Process one video file through RVM. Returns output_path.

    The session is shared across clips; the recurrent state starts fresh per clip.
    """
    # Source rotation must be reflected in the output's pixel orientation.
    # iPhone vertical clips store landscape pixels with rotation=-90 in their
    # displaymatrix; players auto-rotate to portrait. PyAV's prores_ks encoder
    # doesn't copy side_data, and ffmpeg 8.x can't write displaymatrix on a
    # fresh encode (the 'rotate=N' legacy flag silently no-ops), so we
    # physically rotate the pixels at audio-mux time instead. See
    # _rotation_to_transpose_filter() for the filter mapping. Without this fix,
    # the bg-removed clip plays at native landscape orientation while its
    # source plays portrait — the cutout appears 90° rotated relative to
    # surrounding clips.
    source_rotation = _probe_source_rotation(input_path)

    # Use a temp file for the video-only pass, then mux audio
    tmp_video_fd, tmp_video_path = tempfile.mkstemp(suffix="_novg.mov")
    os.close(tmp_video_fd)

    try:
        in_container = av.open(input_path)
        try:
            video_stream = in_container.streams.video[0]
            fps = video_stream.average_rate  # keep as Fraction for PyAV
            width = video_stream.width
            height = video_stream.height
            total_frames = video_stream.frames  # may be 0 if unknown
            out_width, out_height = _target_size(width, height, source_rotation, max_height)
            scaled = (out_width, out_height) != (width, height)

            out_container = av.open(tmp_video_path, mode="w", format="mov")
            try:
                out_stream = out_container.add_stream("prores_ks", rate=fps)
                out_stream.width = out_width
                out_stream.height = out_height
                out_stream.pix_fmt = "yuva444p10le"
                out_stream.options = {"profile": "4"}  # profile 4 = ProRes 4444
                # PyAV's writer converts RGB to BT.601 limited YUV (measured: red
                # 230/25/75 gives YUV 381/478/859, BT.601 predicts 380/478/858).
                # Each frame says so in its matrix tag alone (the codec context's
                # own colorspace does not reach the file); transfer and primaries stay unset,
                # so render's probed transfer for a cut-out stays 'unknown' (§625).

                zeros = np.zeros((1, 1, 1, 1), dtype=np.float32)
                rec = [zeros, zeros, zeros, zeros]
                downsample_ratio = np.array([downsample], dtype=np.float32)
                frames_done = 0

                for packet in in_container.demux(video_stream):
                    for frame in packet.decode():
                        # Frame → H×W×3 uint8 → [1, 3, H, W] float32 in [0, 1]
                        # An untagged source is BT.709 by render's rule, but PyAV reads
                        # it through BT.601 (H.264 holding BT.709 YUV for red
                        # 230/25/74 decodes to 213/0/74). Tagged frames are left alone.
                        cs = {"src_colorspace": Colorspace.ITU709} if int(frame.colorspace) == _AVCOL_SPC_UNSPECIFIED else {}
                        if scaled:
                            img = frame.reformat(
                                width=out_width, height=out_height,
                                format="rgb24", interpolation="AREA", **cs,
                            ).to_ndarray()
                        else:
                            img = frame.to_ndarray(format="rgb24", **cs)
                        src = img.transpose(2, 0, 1)[None].astype(np.float32) / 255.0

                        fgr, pha, *rec = session.run(_OUTPUT_NAMES, {
                            "src": src,
                            "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3],
                            "downsample_ratio": downsample_ratio,
                        })

                        # fgr: [1,3,H,W] float  pha: [1,1,H,W] float → H×W×4
                        rgba = np.concatenate([fgr, pha], axis=1)[0].transpose(1, 2, 0).astype(np.float32)

                        # Scale to uint16 and write as rgba64be
                        rgba_np = (rgba * 65535).clip(0, 65535).astype(np.uint16)
                        out_frame = av.VideoFrame.from_ndarray(rgba_np, format="rgba64be")
                        out_frame.colorspace = _AVCOL_SPC_SMPTE170M
                        out_frame.pts = frame.pts
                        out_frame.time_base = frame.time_base

                        for pkt in out_stream.encode(out_frame):
                            out_container.mux(pkt)

                        frames_done += 1
                        if emit_progress:
                            prog = (frames_done / total_frames) if total_frames else 0.0
                            print(
                                json.dumps({
                                    "file": input_path,
                                    "progress": round(prog, 4),
                                    "frames_done": frames_done,
                                    "frames_total": total_frames,
                                }),
                                file=sys.stderr,
                            )

                # Flush encoder
                for pkt in out_stream.encode(None):
                    out_container.mux(pkt)
            finally:
                out_container.close()
        finally:
            in_container.close()

        # Mux original audio into the output. If the source had displaymatrix
        # rotation (e.g. iPhone vertical recording), physically rotate the
        # bg-removed pixels by the same amount during the mux so the output's
        # display orientation matches the source's. We can't write displaymatrix
        # side_data on a fresh encode in ffmpeg 8.x — '-metadata:s:v:0 rotate=N'
        # only survives '-c copy' of a tagged source, and there's no
        # setdisplaymatrix filter — so physical rotation is the reliable path.
        # ProRes 4444 is intra-frame; re-encoding adds ~real-time per minute of
        # footage and is lossless. When source has no rotation, '-c:v copy'
        # keeps the mux trivially fast.
        rotation_filter = _rotation_to_transpose_filter(source_rotation)
        if rotation_filter:
            video_args = [
                "-vf", rotation_filter,
                "-c:v", "prores_ks",
                "-profile:v", "4",          # ProRes 4444 (alpha-supporting)
                "-pix_fmt", "yuva444p10le", # match the temp file's pix_fmt
            ]
        else:
            video_args = ["-c:v", "copy"]

        _run_ffmpeg([
            ffmpeg_bin(), "-y",
            "-i", tmp_video_path,
            "-i", ff_input(input_path),
            *video_args,
            "-c:a", "copy",
            "-map", "0:v:0",
            "-map", "1:a?",
            output_path,
        ], input_path)

    finally:
        if os.path.exists(tmp_video_path):
            os.unlink(tmp_video_path)

    check_output(output_path)
    return output_path


# ---------------------------------------------------------------------------
# A still image: one frame, a PNG with alpha
# ---------------------------------------------------------------------------

# RVM's own pass mattes a still best near this long side (measured on the
# fixture portrait: a 1536 px pass left holes in the helmet).
_IMAGE_PASS_PX = 512
# The matting pass runs on a copy no longer than this on its long side: RVM's
# refiner works at the full size it is given, so a 48 MP photo peaked at several GB.
_IMAGE_MATTE_MAX_PX = 4096
# Names that claim to be a still: a file Pillow cannot open under one of these
# fails as an invalid image, not as a video.
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp", ".gif"}


def _is_image(path: str) -> bool:
    """A still is whatever Pillow opens, not what the extension says (.avif, .apng,
    .ico). An .svg is not a still we can matte: it fails with JSON."""
    if os.path.splitext(path)[1].lower() == ".svg":
        fail("invalid_image", f"{os.path.basename(path)} is a vector image; remove_bg needs a photo or video")
    try:
        from PIL import Image
    except ImportError:
        return False
    try:
        with Image.open(path):
            return True
    except Image.DecompressionBombError:
        return True  # it is an image, a huge one: _process_image reports it
    except Exception:
        return os.path.splitext(path)[1].lower() in _IMAGE_EXTS


def _image_out(input_path: str, out: str | None) -> str:
    """<stem>-cutout.png beside the input, or out as a .png: serve's
    _project names the step's .mov when out is left off. A name this swaps the
    extension of is checked for a collision here, as nothing else has seen it."""
    if not out:
        return f"{os.path.splitext(input_path)[0]}-cutout.png"
    root, ext = os.path.splitext(out)
    if ext.lower() == ".png":
        return out
    cand, n = root + ".png", 2
    while os.path.lexists(cand):
        cand = f"{root}-{n}.png"
        n += 1
    return cand


def _image_ratio(width: int, height: int) -> float:
    return round(min(1.0, _IMAGE_PASS_PX / max(width, height)), 4)


def _up(plane: np.ndarray, width: int, height: int) -> np.ndarray:
    """One float plane resized to the source size (bilinear)."""
    from PIL import Image
    return np.asarray(Image.fromarray(np.ascontiguousarray(plane, dtype=np.float32), "F").resize((width, height), Image.BILINEAR))


def _process_image(input_path: str, output_path: str, session, max_height: int | None) -> dict:
    """Matte one still: EXIF orientation applied, the recurrent state at its
    start. Opaque pixels keep the photo's own colour, edges take RVM's
    foreground, and the photo's own transparency stays. The colour profile is
    kept for an RGB photo."""
    from PIL import Image, ImageOps

    try:
        with Image.open(input_path) as im:
            icc = im.info.get("icc_profile") if im.mode in ("RGB", "RGBA", "P") else None
            im = ImageOps.exif_transpose(im)
            rgba = im.convert("RGBA")
    except Exception as e:  # also DecompressionBombError, truncated data
        fail("invalid_image", f"Could not read {os.path.basename(input_path)} as an image: {e}")

    width, height = _target_size(rgba.width, rgba.height, 0, max_height)
    if (width, height) != rgba.size:
        rgba = rgba.resize((width, height), Image.LANCZOS)
    arr = np.asarray(rgba)
    long_side = max(width, height)
    if long_side > _IMAGE_MATTE_MAX_PX:
        k = _IMAGE_MATTE_MAX_PX / long_side
        mw, mh = max(2, round(width * k)), max(2, round(height * k))
        small = np.asarray(rgba.convert("RGB").resize((mw, mh), Image.LANCZOS))
    else:
        mw, mh, small = width, height, arr[..., :3]
    src = small.transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    del small
    zeros = np.zeros((1, 1, 1, 1), dtype=np.float32)
    fgr, pha, *_ = session.run(_OUTPUT_NAMES, {
        "src": src, "r1i": zeros, "r2i": zeros, "r3i": zeros, "r4i": zeros,
        "downsample_ratio": np.array([_image_ratio(mw, mh)], dtype=np.float32),
    })
    del src
    scaled = (mw, mh) != (width, height)

    def plane(x):  # one float plane at source size
        return _up(x, width, height) if scaled else x

    # Plane by plane in float32, so a large photo never holds several float64 copies.
    alpha = plane(pha[0, 0]).astype(np.float32, copy=True)
    alpha *= arr[..., 3]
    np.rint(alpha, out=alpha)
    alpha = alpha.clip(0, 255).astype(np.uint8)
    del pha
    solid = alpha == 255
    rgba_out = np.empty((height, width, 4), dtype=np.uint8)
    rgba_out[..., 3] = alpha
    for c in range(3):
        f = plane(fgr[0, c]).astype(np.float32, copy=True)
        f *= 255
        np.rint(f, out=f)
        rgba_out[..., c] = np.where(solid, arr[..., c], f.clip(0, 255).astype(np.uint8))
        del f
    del fgr
    out = Image.fromarray(rgba_out, "RGBA")
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    out.save(output_path, format="PNG", **({"icc_profile": icc} if icc else {}))
    check_output(output_path)
    return {"out": output_path, "width": width, "height": height}


# ---------------------------------------------------------------------------
# Flat-background cutout (a logo on a solid square): no model, numpy only
# ---------------------------------------------------------------------------

# RGB distance (0-441) from the background colour: at or under _FLAT_LO a pixel is
# background (noise, JPEG ringing); up to _FLAT_HI it can still join the background
# region; past it, it is the logo.
_FLAT_LO, _FLAT_HI = 6.0, 20.0
_FLAT_EDGE = 3   # px either side of the background/logo boundary that get a soft matte


def _border_connected(mask: "np.ndarray") -> "np.ndarray":
    """The part of *mask* connected (4-way) to the image border. Frontier BFS in
    numpy, so no scipy: an enclosed pocket the border cannot reach is left out."""
    h, w = mask.shape
    flat = mask.ravel()
    reach = np.zeros(h * w, dtype=bool)
    edge = np.zeros((h, w), dtype=bool)
    edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
    frontier = np.flatnonzero(edge.ravel() & flat)
    reach[frontier] = True
    while frontier.size:
        y, x = np.divmod(frontier, w)
        found = []
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            ok = (ny >= 0) & (ny < h) & (nx >= 0) & (nx < w)
            idx = ny[ok] * w + nx[ok]
            found.append(idx[flat[idx] & ~reach[idx]])
        frontier = np.unique(np.concatenate(found))
        reach[frontier] = True
    return reach.reshape(h, w)


def _dilate(mask: "np.ndarray", steps: int) -> "np.ndarray":
    """*mask* grown by *steps* px (4-way)."""
    m = mask.copy()
    for _ in range(steps):
        g = m.copy()
        g[1:] |= m[:-1]
        g[:-1] |= m[1:]
        g[:, 1:] |= m[:, :-1]
        g[:, :-1] |= m[:, 1:]
        m = g
    return m


# A pixel on the logo side of the boundary this far (RGB) from the line background -> nearest solid colour is a
# different colour (a red outline round a blue fill), not a blend of the two, so it is solid.
_FLAT_OFF_LINE = 30.0
_FLAT_MAX_PIXELS = 16_000_000   # above this the matte is made on a 16 MP copy and its alpha scaled back up


def _flat_matte(rgb: "np.ndarray") -> tuple:
    """The soft matte of a flat-background image: (alpha float32 0..1, bg float32 (3,), faint_idx, faint_rgb).

    Dense work is the distance map and boolean masks only; the edge zone (a few px along the boundary, sparse)
    carries the rest, so the cost follows the outline, not the pixel count."""
    h, w = rgb.shape[:2]
    ring = np.zeros((h, w), dtype=bool)
    ring[:2, :] = ring[-2:, :] = ring[:, :2] = ring[:, -2:] = True
    bg = np.median(rgb[ring], axis=0).astype(np.float32)
    del ring
    dist = np.empty((h, w), dtype=np.float32)
    for r0 in range(0, h, 256):   # a float copy of the whole image would be 12 bytes a pixel
        blk = rgb[r0:r0 + 256].astype(np.float32)
        blk -= bg
        blk *= blk
        dist[r0:r0 + 256] = np.sqrt(blk.sum(axis=2))
    back = _border_connected(dist <= _FLAT_HI)
    fore = ~back
    zone = (fore & _dilate(back, _FLAT_EDGE)) | (back & _dilate(fore, _FLAT_EDGE))
    core = (fore & ~zone).ravel()
    zi = np.flatnonzero(zone.ravel())   # sorted flat indices of the edge zone
    del zone
    px = rgb.reshape(-1, 3)
    m = zi.size

    # The nearest solid colour, grown out through the zone one px a round (table: one row per zone pixel).
    table = np.zeros((m, 3), dtype=np.float32)
    have = np.zeros(m, dtype=bool)
    for _ in range(2 * _FLAT_EDGE + 1):
        cand = np.flatnonzero(~have)
        if not cand.size:
            break
        ci = zi[cand]
        y, x = np.divmod(ci, w)
        acc = np.zeros((cand.size, 3), dtype=np.float32)
        cnt = np.zeros(cand.size, dtype=np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            ok = (ny >= 0) & (ny < h) & (nx >= 0) & (nx < w)
            n = np.where(ok, ny * w + nx, 0)
            solid = ok & core[n]
            p = np.minimum(np.searchsorted(zi, n), m - 1)
            grown = ok & ~solid & (zi[p] == n) & have[p]
            acc[solid] += px[n[solid]]
            acc[grown] += table[p[grown]]
            cnt += solid
            cnt += grown
        grow = cnt > 0
        if not grow.any():
            break
        table[cand[grow]] = acc[grow] / cnt[grow][:, None]
        have[cand[grow]] = True

    alpha = fore.astype(np.float32)
    back_z = back.ravel()[zi]
    del back, fore
    col = px[zi].astype(np.float32)
    dz = dist.ravel()[zi]
    del dist
    span = table - bg
    span2 = (span ** 2).sum(axis=1)
    matte = have & (span2 >= 40.0 ** 2)
    # a = how much of the solid colour the pixel holds, along bg -> colour.
    t = ((col - bg) * span).sum(axis=1) / np.maximum(span2, 1.0)
    a = np.clip(t, 0.0, 1.0)
    # A logo-side pixel far off that line is another colour, not a blend: solid.
    off = np.sqrt(((col - bg - span * a[:, None]) ** 2).sum(axis=1)) > _FLAT_OFF_LINE
    matte &= ~(~back_z & off)
    flat_a = alpha.reshape(-1)
    flat_a[zi[matte]] = a[matte]
    # Where there is no solid colour to measure against: ramp on the distance.
    ramp = back_z & ~matte
    flat_a[zi[ramp]] = np.clip((dz[ramp] - _FLAT_LO) / (_FLAT_HI - _FLAT_LO), 0.0, 1.0)
    flat_a[zi[back_z & (dz <= _FLAT_LO)]] = 0.0
    # A pixel too faint to carry colour takes the solid colour (matte) or stays as it is.
    faint = matte & (flat_a[zi] < 0.02)
    return alpha, bg, zi[faint], table[faint]


def _process_flat(input_path: str, output_path: str) -> dict:
    """Key out the flat background an image sits on.

    The background colour is the median of the outer 2 px ring. Only background
    CONNECTED to the border goes: pixels within _FLAT_HI of that colour, flood-filled
    from the border. A hole the border cannot reach (the counter of an "O") is part of
    the logo and keeps its colour, so a logo with dark details survives a black key.

    The edge is a soft two-colour matte, not a threshold: within _FLAT_EDGE px of the
    boundary each pixel is a mix of the background and the nearest solid logo colour,
    its alpha is how much of that colour it holds, and its colour is un-premultiplied
    against the background, so the logo carries no halo of the old background. A logo
    pixel that is not on that blend (a different colour, an outline round a fill) is
    solid. Where no solid colour is near (a stroke thinner than the edge zone) alpha
    ramps over _FLAT_LO.._FLAT_HI of distance instead.

    An image that is already transparent round its border keeps its own alpha: its
    background is the transparency, and the RGB under it (often black) is not a colour
    to key. Above _FLAT_MAX_PIXELS the matte is made on a smaller copy (a note says so)."""
    from PIL import Image, ImageOps

    try:
        with Image.open(input_path) as im:
            icc = im.info.get("icc_profile") if im.mode in ("RGB", "RGBA", "P") else None
            im = ImageOps.exif_transpose(im)
            rgba = np.array(im.convert("RGBA"))
    except Exception as e:
        fail("invalid_image", f"Could not read {os.path.basename(input_path)} as an image: {e}")
    h, w = rgba.shape[:2]
    save_kw = {"icc_profile": icc} if icc else {}
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    border = np.concatenate([rgba[:2, :, 3].ravel(), rgba[-2:, :, 3].ravel(), rgba[:, :2, 3].ravel(), rgba[:, -2:, 3].ravel()])
    if (border < 16).mean() > 0.5:
        Image.fromarray(rgba, "RGBA").save(output_path, format="PNG", **save_kw)
        check_output(output_path)
        return {"out": output_path, "width": w, "height": h, "keyed": None,
                "transparent": round(float((rgba[..., 3] == 0).mean()), 4),
                "note": "already transparent: the image's own alpha is kept, nothing keyed"}

    note = None
    if h * w > _FLAT_MAX_PIXELS:
        s = (_FLAT_MAX_PIXELS / (h * w)) ** 0.5
        sw, sh = max(1, int(w * s)), max(1, int(h * s))
        small = np.asarray(Image.fromarray(rgba[..., :3], "RGB").resize((sw, sh), Image.BOX))
        alpha_s, bg, _, _ = _flat_matte(small)
        del small
        alpha = np.asarray(Image.fromarray(alpha_s, "F").resize((w, h), Image.BILINEAR), dtype=np.float32).copy()
        del alpha_s
        faint_i = np.zeros(0, dtype=np.int64)
        faint_c = np.zeros((0, 3), dtype=np.float32)
        note = f"matte made at {sw}x{sh} (the image is over 16 MP) and scaled back up"
    else:
        alpha, bg, faint_i, faint_c = _flat_matte(rgba[..., :3])

    flat_a = alpha.reshape(-1)
    res = rgba.reshape(-1, 4)   # in place: only the soft pixels change colour
    # Un-premultiply against the background: c = a*fg + (1-a)*bg.
    pi = np.flatnonzero((flat_a > 0.0) & (flat_a < 1.0))
    sa = np.maximum(flat_a[pi], 0.02)[:, None]
    res[pi, :3] = np.rint(np.clip((res[pi, :3].astype(np.float32) - (1.0 - sa) * bg) / sa, 0.0, 255.0)).astype(np.uint8)
    res[faint_i, :3] = np.rint(faint_c).clip(0, 255).astype(np.uint8)
    np.multiply(alpha, rgba[..., 3], out=alpha)   # the image's own transparency stays
    np.rint(alpha, out=alpha)
    rgba[..., 3] = alpha
    Image.fromarray(rgba, "RGBA").save(output_path, format="PNG", **save_kw)
    check_output(output_path)
    keyed = "#" + "".join(f"{int(round(v)):02x}" for v in bg)
    out = {"out": output_path, "width": w, "height": h, "keyed": keyed,
           "transparent": round(float((rgba[..., 3] == 0).mean()), 4)}
    if note:
        out["note"] = note
    return out


# ---------------------------------------------------------------------------
# WebM preview generation (VP9 with alpha — browser-compatible)
# ---------------------------------------------------------------------------

def _make_webm_preview(mov_path: str, emit_progress: bool = False) -> str:
    """Convert a ProRes 4444 .mov with alpha to a VP9 WebM for browser preview."""
    import subprocess as _sp
    stem = os.path.splitext(mov_path)[0]
    webm_path = f"{stem}_preview.webm"

    cmd = [
        ffmpeg_bin(), "-y",
        "-i", mov_path,
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-b:v", "0", "-crf", "33",
        "-cpu-used", "4",
        "-deadline", "good",
        "-c:a", "libopus", "-b:a", "128k",
        webm_path,
    ]

    if not emit_progress:
        _run_ffmpeg(cmd, mov_path)
        return webm_path

    # Probe total frames for progress percentage
    total_frames = 0
    try:
        r = _sp.run(
            [ffprobe_bin(), "-v", "quiet", "-select_streams", "v:0",
             "-show_entries", "stream=nb_frames", "-of", "csv=p=0", mov_path],
            capture_output=True, text=True,
        )
        val = r.stdout.strip()
        if val.isdigit():
            total_frames = int(val)
    except Exception:
        pass

    # -progress pipe:2 streams key=value progress blocks to stderr
    prog_cmd = cmd[:-1] + ["-progress", "pipe:2", webm_path]
    proc = _sp.Popen(prog_cmd, stderr=_sp.PIPE, stdout=_sp.DEVNULL, text=True)
    for line in proc.stderr:
        line = line.strip()
        if line.startswith("frame="):
            try:
                frames_done = int(line.split("=", 1)[1])
                prog = (frames_done / total_frames) if total_frames else 0.0
                print(json.dumps({
                    "file": mov_path,
                    "phase": "webm",
                    "progress": round(prog, 4),
                    "frames_done": frames_done,
                    "frames_total": total_frames,
                }), file=sys.stderr, flush=True)
            except (ValueError, IndexError):
                pass
    proc.wait()
    if proc.returncode != 0:
        fail("unexpected_error", f"WebM encoding failed for {mov_path}")

    return webm_path


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Remove video or image background using RVM. Outputs ProRes 4444 .mov or PNG with alpha"
    )

    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--input", help="Single source video or image file")
    input_group.add_argument("--inputs", nargs="+", help="Multiple source video files")

    parser.add_argument("--out", help="Output path (only valid with --input, default: {stem}_nobg.mov)")
    parser.add_argument(
        "--downsample",
        type=float,
        default=0.5,
        help="Inference resolution ratio, relative to the frame RVM is given (0.25-1.0)",
    )
    parser.add_argument(
        "--max-height",
        type=int,
        default=None,
        help="Scale the cutout down so its display height is at most this (a positive even "
             "number). Never scales up; width follows the aspect ratio.",
    )
    parser.add_argument("--flat", action="store_true",
                        help="Image on a flat background (a logo on a solid square): key out the border-connected "
                             "background colour, no model. Images only")
    parser.add_argument("--progress", action="store_true", help="Emit JSON progress lines to stderr")

    args = parser.parse_args()

    # Validate --out only used with --input
    if args.out and args.inputs:
        fail("invalid_args", "--out is only valid with --input, not --inputs")

    # Validate downsample range
    if not (0.25 <= args.downsample <= 1.0):
        fail("invalid_args", f"--downsample must be between 0.25 and 1.0, got {args.downsample}")

    _check_max_height(args.max_height)

    paths = [args.input] if args.input else args.inputs
    for path in paths:
        require_file(path)

    if args.flat:
        # Images only: a video has no single flat backdrop to sample, and a per-frame key would flicker.
        done = []
        for path in paths:
            if not _is_image(path):
                fail("invalid_args", f"--flat works on images only; {os.path.basename(path)} is not one")
            done.append(_process_flat(path, _image_out(path, args.out if args.input else None)))
        print(json.dumps(done[0] if args.input else done))
        return

    # One session serves every clip, sequentially.
    session = _load_session()

    if args.input and _is_image(args.input):
        print(json.dumps(_process_image(args.input, _image_out(args.input, args.out), session, args.max_height)))

    elif args.input:
        # Single file mode
        stem = os.path.splitext(args.input)[0]
        out = args.out or f"{stem}_nobg.mov"
        mov_path = _process_one(args.input, out, session, args.downsample, args.max_height, args.progress)
        webm_path = _make_webm_preview(mov_path, emit_progress=args.progress)
        print(json.dumps({"nobg_src": mov_path, "nobg_preview_src": webm_path}))

    else:
        # Multiple files mode: every matte first, then the previews. A still is done in the first pass.
        done = []
        for path in args.inputs:
            if _is_image(path):
                done.append(_process_image(path, _image_out(path, None), session, args.max_height))
                continue
            stem = os.path.splitext(path)[0]
            out = f"{stem}_nobg.mov"
            done.append(_process_one(path, out, session, args.downsample, args.max_height, args.progress))

        results = []
        for item in done:
            if isinstance(item, dict):
                results.append(item)
                continue
            webm_path = _make_webm_preview(item, emit_progress=args.progress)
            results.append({"nobg_src": item, "nobg_preview_src": webm_path})

        print(json.dumps(results))


if __name__ == "__main__":
    main()
