#!/usr/bin/env python3
"""Normalize a video clip to project working format.

Probes the source with ffprobe. If it already matches the target format
(H.264, yuv420p, bt709, target res/fps, 48kHz audio), returns the input
path unchanged — no re-encode. Otherwise re-encodes to the working format.

HDR tonemap: uses zscale (from zimg) for proper colorspace conversion before
tonemap. Requires ffmpeg built with --enable-libzimg (standard on Homebrew/apt).

Invocation modes:
  - Direct import: init.py, ai_video.py (step scripts that add lib/ to sys.path)
  - Module: python3 -m lib.normalize (Node subprocess — project root on sys.path)
The sys.path.insert below adds lib/ itself so `from common import ...` works in both.
"""
import sys, os, json, subprocess, argparse

sys.path.insert(0, os.path.dirname(__file__))  # add lib/ so `from common` works in all invocation modes
from common import fail, require_file, progress


def probe_video(path):
    """Return dict with codec, width, height, pix_fmt, color_transfer, fps, has_audio,
    audio_sample_rate, and max_keyframe_interval."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,color_transfer,r_frame_rate,sample_rate",
        "-of", "json", path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        return None
    streams = json.loads(r.stdout).get("streams", [])
    if not streams:
        return None
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not video:
        return None
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    has_audio = audio is not None
    audio_sample_rate = int(audio["sample_rate"]) if audio and audio.get("sample_rate") else None
    fps_str = video.get("r_frame_rate", "0/1")
    num, den = fps_str.split("/")
    fps = round(int(num) / max(int(den), 1))

    # Check max keyframe interval (segment encoding relies on -ss with keyframes).
    # Use ffprobe packet inspection — fast, reads only the first 10s of the file.
    max_kf_interval = _probe_max_keyframe_interval(path)

    return {
        "codec": video.get("codec_name"),
        "width": video.get("width"),
        "height": video.get("height"),
        "pix_fmt": video.get("pix_fmt"),
        "color_transfer": video.get("color_transfer", "unknown"),
        "fps": fps,
        "has_audio": has_audio,
        "audio_sample_rate": audio_sample_rate,
        "max_keyframe_interval": max_kf_interval,
    }


def _probe_max_keyframe_interval(path):
    """Return the max gap (seconds) between keyframes in the first 10s of the file.
    Returns 999 if probing fails (treat as non-conformant)."""
    cmd = [
        "ffprobe", "-v", "quiet", "-select_streams", "v:0",
        "-show_entries", "packet=pts_time,flags",
        "-read_intervals", "%+10",
        "-of", "csv=p=0", path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        return 999
    kf_times = []
    for line in r.stdout.strip().split("\n"):
        parts = line.split(",")
        if len(parts) >= 2 and "K" in parts[1]:
            try:
                kf_times.append(float(parts[0]))
            except ValueError:
                pass
    if len(kf_times) < 2:
        return 999
    max_gap = max(kf_times[i+1] - kf_times[i] for i in range(len(kf_times) - 1))
    return max_gap


def is_normalized(path, info, target_w, target_h):
    """Returns True if the file already matches the project working format.
    Shortcut: files ending in _normalized.mp4 are assumed conformant (we produced them).
    Otherwise probes codec, resolution, pix_fmt, color, audio sample rate,
    and keyframe interval. FPS is NOT checked — the segment encoder handles
    fps conversion at render time, preserving source duration."""
    if path.endswith("_normalized.mp4"):
        return True
    return (
        info["codec"] == "h264"
        and info["width"] == target_w
        and info["height"] == target_h
        and info["pix_fmt"] == "yuv420p"
        and info["color_transfer"] not in ("arib-std-b67", "smpte2084")
        and info["has_audio"]
        and info.get("audio_sample_rate") == 48000
        and info.get("max_keyframe_interval", 999) <= 2.0
    )


def needs_tonemap(info):
    return info["color_transfer"] in ("arib-std-b67", "smpte2084")


def _has_zscale():
    """Check if ffmpeg has the zscale filter (requires libzimg)."""
    r = subprocess.run(["ffmpeg", "-filters"], capture_output=True, text=True, timeout=5)
    return "zscale" in (r.stdout or "")


def _build_tonemap_vf(width, height, use_zscale):
    """Build the HDR→SDR tonemap filter chain.

    With zscale (preferred): proper colorspace conversion through linear light.
    Without zscale (fallback): bare tonemap on p010le — colors are less accurate
    but the output is usable. Logs a warning recommending montaj doctor.
    """
    if use_zscale:
        return (f"zscale=t=linear:npl=100,format=gbrpf32le,"
                f"zscale=p=bt709,tonemap=hable:desat=0,"
                f"zscale=t=bt709:m=bt709:r=tv,format=yuv420p,"
                f"scale={width}:{height}")
    else:
        return (f"scale={width}:{height},"
                f"format=p010le,"
                f"tonemap=hable:desat=0,"
                f"format=yuv420p")


def normalize(input_path, out_path, width, height, crf=16):
    info = probe_video(input_path)
    if info is None:
        fail("probe_error", f"Cannot probe {input_path}")

    if is_normalized(input_path, info, width, height):
        progress("Already conformant, skipping normalize")
        print(input_path)
        return

    source_fps = info["fps"] or 30  # use source fps for keyframe interval

    # Build video filter chain
    _used_fallback_tonemap = False
    if needs_tonemap(info):
        use_zscale = _has_zscale()
        if not use_zscale:
            _used_fallback_tonemap = True
            progress("⚠⚠⚠ WARNING: zscale filter NOT AVAILABLE — falling back to bare tonemap ⚠⚠⚠")
            progress("HDR→SDR colors WILL be less accurate (washed out highlights, shifted colors).")
            progress("To fix: run `montaj doctor` for instructions on installing libzimg.")
        vf = _build_tonemap_vf(width, height, use_zscale)
    else:
        vf = f"scale={width}:{height},format=yuv420p"

    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-vf", vf,
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-c:v", "libx264", "-crf", str(crf), "-preset", "slow",
        "-g", str(source_fps), "-keyint_min", str(source_fps),
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart",
        out_path,
    ]
    # If source has no audio, skip audio encoding and generate silent track
    if not info["has_audio"]:
        cmd = [x for x in cmd if x not in ("-c:a", "aac", "-b:a", "192k", "-ar", "48000")]
        # Generate a silent audio track so all normalized files have uniform audio
        # (needed for concat -c copy to work)
        idx = cmd.index(out_path)
        cmd[idx:idx] = ["-f", "lavfi", "-i", f"anullsrc=cl=stereo:r=48000",
                        "-shortest", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]

    progress(f"Normalizing: {info['codec']} {info['width']}x{info['height']} "
             f"{info['pix_fmt']} {info['color_transfer']} {info['fps']}fps → "
             f"h264 {width}x{height} yuv420p bt709 {source_fps}fps 48kHz")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        fail("encode_error", f"ffmpeg normalize failed:\n{(r.stderr or '')[-500:]}")

    if _used_fallback_tonemap:
        progress("⚠⚠⚠ FALLBACK TONEMAP WAS USED — OUTPUT COLORS ARE DEGRADED ⚠⚠⚠")
        progress(f"File: {out_path}")
        progress("The HDR→SDR conversion used a bare tonemap without proper colorspace conversion.")
        progress("Re-normalize after installing zscale for accurate colors.")
        progress("Fix: run `montaj doctor` → follow zscale installation instructions.")

    print(out_path)


def main():
    p = argparse.ArgumentParser(description="Normalize video to project format")
    p.add_argument("--input", required=True)
    p.add_argument("--width", type=int, default=1920)
    p.add_argument("--height", type=int, default=1080)
    p.add_argument("--crf", type=int, default=16)
    p.add_argument("--out", default=None)
    args = p.parse_args()

    require_file(args.input)
    out = args.out or args.input.rsplit(".", 1)[0] + "_normalized.mp4"
    normalize(args.input, out, args.width, args.height, args.crf)


if __name__ == "__main__":
    main()
