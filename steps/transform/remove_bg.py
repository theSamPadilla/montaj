#!/usr/bin/env python3
"""Remove video background using RVM (Robust Video Matting) on onnxruntime's CPU provider.

Outputs ProRes 4444 .mov with alpha channel.
"""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run, ffmpeg_bin, ffprobe_bin, get_duration
import models
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
    import onnxruntime
except ImportError:
    _missing.append("onnxruntime")
try:
    import av
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
            "-of", "json", input_path,
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

                zeros = np.zeros((1, 1, 1, 1), dtype=np.float32)
                rec = [zeros, zeros, zeros, zeros]
                downsample_ratio = np.array([downsample], dtype=np.float32)
                frames_done = 0

                for packet in in_container.demux(video_stream):
                    for frame in packet.decode():
                        # Frame → H×W×3 uint8 → [1, 3, H, W] float32 in [0, 1]
                        if scaled:
                            img = frame.reformat(
                                width=out_width, height=out_height,
                                format="rgb24", interpolation="AREA",
                            ).to_ndarray()
                        else:
                            img = frame.to_ndarray(format="rgb24")
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
            "-i", input_path,
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
        description="Remove video background using RVM. Outputs ProRes 4444 .mov with alpha"
    )

    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--input", help="Single source video file")
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

    # One session serves every clip, sequentially.
    session = _load_session()

    if args.input:
        # Single file mode
        stem = os.path.splitext(args.input)[0]
        out = args.out or f"{stem}_nobg.mov"
        mov_path = _process_one(args.input, out, session, args.downsample, args.max_height, args.progress)
        webm_path = _make_webm_preview(mov_path, emit_progress=args.progress)
        print(json.dumps({"nobg_src": mov_path, "nobg_preview_src": webm_path}))

    else:
        # Multiple files mode
        mov_paths = []
        for path in args.inputs:
            stem = os.path.splitext(path)[0]
            out = f"{stem}_nobg.mov"
            mov_paths.append(
                _process_one(path, out, session, args.downsample, args.max_height, args.progress))

        results = []
        for mov_path in mov_paths:
            webm_path = _make_webm_preview(mov_path, emit_progress=args.progress)
            results.append({"nobg_src": mov_path, "nobg_preview_src": webm_path})

        print(json.dumps(results))


if __name__ == "__main__":
    main()
