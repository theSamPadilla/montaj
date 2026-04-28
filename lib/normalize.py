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
        "r_frame_rate": fps_str,
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


def is_normalized(path, info, target_w=0, target_h=0, force_probe=False):
    """Returns True if the file already matches the project working format.

    Deprecated: `target_w` and `target_h` are inert. Kept for API compatibility.
    Source resolution is preserved through the pipeline — see Task 3 of
    docs/plans/2026-04-28-init-normalize-perf.md and the `scale=` filter in
    montaj_assets/render/encode-segment.js which handles per-item scaling at
    compose time.

    Shortcut: files ending in _normalized.mp4 are assumed conformant (we produced
    them). Pass `force_probe=True` to bypass the suffix shortcut and verify the
    actual stream — needed by the contract regression test, which would otherwise
    pass purely on filename and never catch a future regression that produces
    a misnamed-but-non-conformant output.

    Otherwise probes codec, pix_fmt, color, audio sample rate, and keyframe
    interval. FPS and resolution are NOT checked — both are handled at render time.
    """
    if not force_probe and path.endswith("_normalized.mp4"):
        return True
    return (
        info["codec"] == "h264"
        and info["pix_fmt"] == "yuv420p"
        and info["color_transfer"] not in ("arib-std-b67", "smpte2084")
        and info["has_audio"]
        and info.get("audio_sample_rate") == 48000
        and info.get("max_keyframe_interval", 999) <= 2.0
    )


def _can_use_audio_fast_path(info):
    """Returns True if the video stream is fully conformant (codec, pix_fmt, color,
    keyframes) and the ONLY non-conformance is audio (missing or wrong sample rate).
    In this case we can `-c:v copy` and only re-encode audio — ~20-40x faster.

    NOTE: this does not verify IDR vs non-IDR keyframes. In rare cases (open-GOP
    sources, professional intermediates), the fast path could produce sub-optimal
    seek behavior in the segment encoder. Consumer sources (phone, screen recording,
    OBS) effectively always use IDR keyframes. If a user reports seek glitches on a
    fast-path-normalized clip, add an `is_idr_keyframe` check here.
    """
    video_ok = (
        info["codec"] == "h264"
        and info["pix_fmt"] == "yuv420p"
        and info["color_transfer"] not in ("arib-std-b67", "smpte2084")
        and info.get("max_keyframe_interval", 999) <= 2.0
    )
    audio_bad = (not info["has_audio"]) or info.get("audio_sample_rate") != 48000
    return video_ok and audio_bad


def needs_tonemap(info):
    return info["color_transfer"] in ("arib-std-b67", "smpte2084")


def _has_zscale():
    """Check if ffmpeg has the zscale filter (requires libzimg)."""
    r = subprocess.run(["ffmpeg", "-filters"], capture_output=True, text=True, timeout=5)
    return "zscale" in (r.stdout or "")


def _build_tonemap_vf(width, height, use_zscale):
    """Build the HDR→SDR tonemap filter chain. Source resolution is preserved.

    Deprecated: `width` and `height` are inert. Kept for API compatibility.
    Source resolution flows through; the segment encoder scales per-item at
    compose time.

    With zscale (preferred): proper colorspace conversion through linear light.
    Without zscale (fallback): bare tonemap on p010le — colors are less accurate
    but the output is usable. Logs a warning recommending montaj doctor.
    """
    if use_zscale:
        return ("zscale=t=linear:npl=100,format=gbrpf32le,"
                "zscale=p=bt709,tonemap=hable:desat=0,"
                "zscale=t=bt709:m=bt709:r=tv,format=yuv420p")
    else:
        return ("format=p010le,"
                "tonemap=hable:desat=0,"
                "format=yuv420p")


def normalize(input_path, out_path, width, height, crf=16, info=None):
    """Normalize a video clip to the project working format. Returns the output
    path on success.

    Deprecated: `width` and `height` are inert. Kept for API compatibility.
    Source resolution is preserved; the segment encoder scales per-item at
    compose time.

    Optional `info` parameter accepts a pre-probed dict (from probe_video). When
    provided, skips the internal probe — important for callers like init.py that
    have already probed during smart-resolution detection. Without this, normalize
    would re-probe every clip (2 redundant ffprobe calls per clip on heavy footage).
    """
    if info is None:
        info = probe_video(input_path)
    if info is None:
        fail("probe_error", f"Cannot probe {input_path}")

    if is_normalized(input_path, info, width, height):
        progress("Already conformant, skipping normalize")
        return input_path

    if _can_use_audio_fast_path(info):
        progress(f"Audio-only fast path: copying video stream, re-encoding audio "
                 f"({info.get('audio_sample_rate') or 'no audio'} → 48kHz AAC)")
        # NOTE on input ordering: -fflags +genpts+igndts and -ignore_editlist 1 are
        # positioned before the FIRST -i, applying only to the source video input.
        # The anullsrc input (when used) doesn't need any of these flags. If you
        # ever swap input order or add another input, re-check this still applies
        # to the right stream.
        #
        # Why -ignore_editlist 1: iPhone/iOS sources commonly carry edit list (elst)
        # atoms with negative PTS / CTTS offsets (sub-frame stabilization padding,
        # etc). Without ignore_editlist + igndts, -c:v copy preserves the edit list
        # and downstream consumers that don't expect it produce wrong durations,
        # off-by-frames seeks, and audio drift.
        cmd = [
            "ffmpeg", "-y",
            "-fflags", "+genpts+igndts",
            "-ignore_editlist", "1",
            "-i", input_path,
        ]
        if not info["has_audio"]:
            # Generate silent stereo to match the contract (downstream concat assumes audio)
            cmd += ["-f", "lavfi", "-i", "anullsrc=cl=stereo:r=48000",
                    "-shortest", "-map", "0:v:0", "-map", "1:a:0"]
        else:
            cmd += ["-map", "0:v:0", "-map", "0:a:0"]
        cmd += [
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-movflags", "+faststart",
            out_path,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            # Fall through to full re-encode below — the fast path is a best-effort
            # optimization. In practice failures are nearly all <1s (container probe
            # error, output disk error), so worst-case "failed fast path then full
            # re-encode" wastes a negligible amount of time vs. the full re-encode
            # it falls back to. Acceptable.
            progress(f"Audio fast path failed, falling back to full re-encode: "
                     f"{(r.stderr or '')[-200:]}")
        else:
            return out_path

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
        vf = "format=yuv420p"

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

    return out_path


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
    # CLI mode: print the result path so subprocess callers (e.g. render.js's
    # normalizeIfNeeded) can read it from stdout. The function itself returns
    # the path; only the CLI entry point prints, so library callers (init.py)
    # don't pollute their own stdout.
    result = normalize(args.input, out, args.width, args.height, args.crf)
    print(result)


if __name__ == "__main__":
    main()
