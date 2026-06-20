#!/usr/bin/env python3
"""Normalize a video clip to project working color space + codec.

Probes the source with ffprobe. If it already matches the project's working
format (color transfer + bit depth + keyframe interval), returns the input
path unchanged — no re-encode. Otherwise re-encodes to the project's working
color space, using libx264 yuv420p bt709 for SDR projects and libx265
yuv420p10le bt2020/(HLG|PQ) for HDR projects.

HDR/SDR conversions: uses zscale (from zimg) for proper colorspace conversion.
HDR→SDR has a non-zscale fallback (degraded; loud warning). SDR→HDR and
HDR↔HDR require zscale and fail loudly without it.

Invocation modes:
  - Direct import: init.py, ai_video.py (step scripts that add lib/ to sys.path)
  - Module: python3 -m lib.normalize (Node subprocess — project root on sys.path)
The sys.path.insert below adds lib/ itself so `from common import ...` works in both.
"""
import sys, os, json, subprocess, argparse

sys.path.insert(0, os.path.dirname(__file__))  # add lib/ so `from common` works in all invocation modes
from common import fail, require_file, progress

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))  # add repo root so `from lib.types.colorspace` works
from lib.types.colorspace import (
    ALL_COLOR_SPACES,
    DEFAULT_COLOR_SPACE,
    SPECS,
    ColorSpaceKey,
    detect_from_transfer,
    require_valid_key,
)


def probe_video(path):
    """Return dict with codec, width, height, pix_fmt, color_transfer, fps, has_audio,
    audio_sample_rate, max_keyframe_interval, rotation, display_width, display_height.

    Rotation: degrees from the displaymatrix side_data (-180, -90, 0, 90, 180, 270, etc.).
    iPhone vertical recordings have rotation=-90 (sensor outputs landscape, displays
    portrait). 0 when no rotation is tagged.

    Display dimensions: width/height after applying rotation. For a 1920×1080 source
    with rotation=±90 or ±270, display_width=1080, display_height=1920. Use these
    when reasoning about output orientation (e.g., picking project canvas size).
    """
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

    rotation = _probe_rotation(path)
    width = video.get("width")
    height = video.get("height")
    # Display dims = post-rotation dims. ±90 / ±270 swap W↔H.
    if width and height and abs(rotation) % 180 == 90:
        display_width, display_height = height, width
    else:
        display_width, display_height = width, height

    return {
        "codec": video.get("codec_name"),
        "width": width,
        "height": height,
        "pix_fmt": video.get("pix_fmt"),
        "color_transfer": video.get("color_transfer", "unknown"),
        "fps": fps,
        "r_frame_rate": fps_str,
        "has_audio": has_audio,
        "audio_sample_rate": audio_sample_rate,
        "max_keyframe_interval": max_kf_interval,
        "rotation": rotation,
        "display_width": display_width,
        "display_height": display_height,
    }


def _probe_rotation(path):
    """Return rotation in degrees from the video stream's displaymatrix side_data.

    Possible values: 0 (no tag or rotation=0), ±90, ±180, ±270. iPhone vertical
    recordings come in as -90 — sensor stores landscape, the rotation tag tells
    players to rotate -90° clockwise (= 90° CCW) for display. Players honor this
    by default, so the file appears portrait. Returns 0 on failure or absence.
    """
    cmd = [
        "ffprobe", "-v", "quiet", "-select_streams", "v:0",
        "-show_entries", "stream_side_data=rotation",
        "-of", "json", path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        return 0
    try:
        streams = json.loads(r.stdout).get("streams", [])
        if not streams:
            return 0
        for entry in streams[0].get("side_data_list", []) or []:
            if "rotation" in entry:
                return int(entry["rotation"])
        return 0
    except (json.JSONDecodeError, ValueError, TypeError):
        return 0


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


def is_normalized(path, info, project_color_space: ColorSpaceKey) -> bool:
    """Returns True if the file already matches the project working format.

    A source is conformant when:
      - color_transfer is valid for the project's color space
      - pix_fmt matches the project's bit depth requirement
      - keyframe interval ≤ 2.0s (load-bearing for segment-encoder fast seek)

    Codec and audio sample rate are NOT checked — the segment encoder handles
    those at compose time (decode is codec-agnostic; audio is resampled per item).
    Keyframe interval IS still checked because the segment encoder uses input-level
    fast seek (-ss before -i), which lands on the prior keyframe — re-encoding
    from there does not fix the wrong start time. See Task 2 of
    docs/plans/2026-04-28-color-space-aware-pipeline.md for the full rationale.

    The previous (target_w, target_h) parameters have been removed entirely —
    source resolution is preserved through the pipeline (see the prior plan
    docs/plans/2026-04-28-init-normalize-perf.md), and resolution checks were
    already inert.

    The previous filename-suffix shortcut (`_normalized.mp4`) is also removed.
    Reason: namespacing it per color space would create a migration headache for
    existing projects, and the shortcut saved zero ffprobe calls in practice
    because callers already cache the probe in probe_cache (per the prior plan).

    Raises ValueError with a clear message if `project_color_space` is invalid
    (e.g., a hand-edited project.json with `"colorSpace": "hdr_xyz"`). Without
    this guard, the SPECS lookup below would raise KeyError, which is harder
    to diagnose.
    """
    require_valid_key(project_color_space)
    spec = SPECS[project_color_space]
    return (
        info.get("color_transfer", "unknown") in spec["transfer_values"]
        and info.get("pix_fmt") in spec["pix_fmts"]
        and info.get("max_keyframe_interval", 999) <= 2.0
    )


def _has_zscale():
    """Check if ffmpeg has the zscale filter (requires libzimg)."""
    r = subprocess.run(["ffmpeg", "-filters"], capture_output=True, text=True, timeout=5)
    return "zscale" in (r.stdout or "")


def _build_color_conversion_vf(
    src: ColorSpaceKey, dst: ColorSpaceKey
) -> tuple[str, bool]:
    """Build the ffmpeg filter chain to convert from src color space to dst.

    Six possible pairs; identity (src == dst) is excluded (caller checks).
    Returns (filter_string, used_fallback) — used_fallback is True only when
    HDR→SDR ran without zscale (degraded color path; caller emits warnings).
    """
    # HDR → SDR: tonemap (the existing zscale chain). Used today; well-tested.
    if src in ("hdr_hlg", "hdr_pq") and dst == "sdr_bt709":
        return _build_tonemap_vf_to_sdr(src)
    # SDR → HDR: stretch SDR into the HDR container with no creative inverse-tonemap.
    if src == "sdr_bt709" and dst in ("hdr_hlg", "hdr_pq"):
        return (_build_sdr_to_hdr_stretch(dst), False)
    # HDR → HDR: HLG <-> PQ are well-defined zscale conversions.
    if src in ("hdr_hlg", "hdr_pq") and dst in ("hdr_hlg", "hdr_pq") and src != dst:
        return (_build_hdr_cross(src, dst), False)
    raise ValueError(f"unsupported color conversion: {src} -> {dst}")


def _build_tonemap_vf_to_sdr(src: ColorSpaceKey) -> tuple[str, bool]:
    """HDR (HLG or PQ) → SDR Rec.709. Uses zscale + Hable tonemap.

    Falls back to a non-zscale path on systems without libzimg. The fallback
    path is degraded (washed-out highlights, shifted colors); callers are
    expected to emit a loud warning when used_fallback=True. This preserves
    the v1 _used_fallback_tonemap UX.
    """
    if _has_zscale():
        return (
            "zscale=t=linear:npl=100,format=gbrpf32le,"
            "zscale=p=bt709,tonemap=hable:desat=0,"
            "zscale=t=bt709:m=bt709:r=tv",
            False,
        )
    # Fallback: scale to p010le first, then bare tonemap. Less accurate; caller warns.
    return ("format=p010le,tonemap=hable:desat=0", True)


def _build_sdr_to_hdr_stretch(dst: ColorSpaceKey) -> str:
    """SDR → HDR. Stretches SDR into the HDR container; does NOT enhance.

    No "AI inverse-tonemap" here. The output is technically valid HDR but contains
    no real HDR data. This is the same behavior FCP uses when SDR clips land in
    an HDR library: they're treated as SDR-graded content shown on an HDR canvas.

    Requires zscale (libzimg). HDR projects without zscale fail loudly — there is
    no clean SDR→HDR conversion path without proper colorspace transforms, and
    silently degrading would produce unwatchable output. `montaj doctor` should
    point users at libzimg installation if they hit this.
    """
    if not _has_zscale():
        fail("zscale_required",
             f"Cannot convert SDR source into {dst} project: zscale (libzimg) is "
             f"required for HDR output. Run `montaj doctor` for installation steps.")
    transfer = "arib-std-b67" if dst == "hdr_hlg" else "smpte2084"
    return f"zscale=t={transfer}:p=bt2020:m=bt2020nc"


def _build_hdr_cross(src: ColorSpaceKey, dst: ColorSpaceKey) -> str:
    """HLG <-> PQ. Both are bt2020; just transfer-curve conversion. Requires zscale."""
    if not _has_zscale():
        fail("zscale_required",
             f"Cannot convert {src} → {dst}: zscale (libzimg) is required. "
             f"Run `montaj doctor` for installation steps.")
    dst_t = "arib-std-b67" if dst == "hdr_hlg" else "smpte2084"
    return f"zscale=t={dst_t}"


def _build_ffmpeg_cmd(
    input_path,
    out_path,
    project_color_space: ColorSpaceKey,
    info: dict,
    pre_input_args: list | None = None,
) -> tuple[list, bool]:
    """Build the ffmpeg command list for a normalize encode.

    `pre_input_args`: optional list inserted immediately before ``["-i", input_path]``.
    Used by normalize_window() to add ``-ss``/``-t`` input-seek args; normalize()
    passes nothing (or an empty list) so its command is byte-identical to before.

    Returns (cmd, used_fallback_tonemap).  Callers that don't need the flag can
    ignore the second element.
    """
    if pre_input_args is None:
        pre_input_args = []

    spec = SPECS[project_color_space]

    # Determine source color space to know what conversion is needed.
    source_color_space = detect_from_transfer(info.get("color_transfer"))
    needs_color_conversion = source_color_space != project_color_space

    used_fallback_tonemap = False
    vf_parts: list[str] = []
    if needs_color_conversion:
        conv_filter, used_fallback_tonemap = _build_color_conversion_vf(
            source_color_space, project_color_space
        )
        vf_parts.append(conv_filter)
    vf_parts.append(f"format={spec['output_pix_fmt']}")
    vf = ",".join(vf_parts)

    # GOP enforcement — load-bearing for the segment encoder's input-level fast
    # seek (-ss before -i). Source fps from probe; default 30. Output keyframe
    # every ~1s. This is the same contract is_normalized() checks for at intake.
    source_fps = info.get("fps") or 30

    # Build encoder args from the spec.
    enc_args = ["-c:v", spec["encoder"]]
    for k, v in spec["encoder_params"].items():
        enc_args.extend([f"-{k}", v])

    cmd = [
        "ffmpeg", "-y",
        *pre_input_args,
        "-i", input_path,
        "-vf", vf,
        # Stream-level color metadata flags — written to the container so
        # downstream consumers (segment encoder, players) read the right color.
        # These complement the per-frame setparams stamping that the segment
        # encoder applies on its outputs.
        *spec["output_color_args"],
        *enc_args,
        "-pix_fmt", spec["output_pix_fmt"],
        # Force IDR keyframes every ~1s so segment encoder fast seek lands accurately.
        "-g", str(source_fps),
        "-keyint_min", str(source_fps),
        # Audio is always 48kHz AAC stereo. Segment encoder also resamples per item;
        # we still emit conformant audio here to match the working-format contract.
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart",
        out_path,
    ]
    if not info["has_audio"]:
        cmd = [x for x in cmd if x not in ("-c:a", "aac", "-b:a", "192k", "-ar", "48000")]
        idx = cmd.index(out_path)
        cmd[idx:idx] = ["-f", "lavfi", "-i", "anullsrc=cl=stereo:r=48000",
                        "-shortest", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]

    return cmd, used_fallback_tonemap


def normalize(input_path, out_path, project_color_space: ColorSpaceKey, info=None):
    """Normalize a video clip to the project's working color space + codec.

    `info` (optional): pre-probed dict from probe_video(). When provided, skips
    the internal probe — important for callers like init.py that have already
    probed during smart-detection. Without this, normalize would re-probe every
    clip (2 redundant ffprobe calls per clip on heavy footage).

    Returns the output path on success; raises SystemExit (via fail()) on error.
    Raises ValueError if project_color_space is unknown (clear message; see
    is_normalized() docstring for rationale).
    """
    require_valid_key(project_color_space)
    spec = SPECS[project_color_space]
    if info is None:
        info = probe_video(input_path)
    if info is None:
        fail("probe_error", f"Cannot probe {input_path}")

    if is_normalized(input_path, info, project_color_space):
        progress("Already conformant for project color space, skipping normalize")
        return input_path

    # Debug: surface WHY is_normalized returned False so the user can see which
    # of (color_transfer / pix_fmt / GOP) the source actually failed. Without
    # this, the bare "normalized X → Y" log gives no signal on whether the
    # re-encode was load-bearing or could have been avoided by relaxing a check.
    failures = []
    src_transfer = info.get("color_transfer", "unknown")
    src_pix_fmt = info.get("pix_fmt")
    src_kf = info.get("max_keyframe_interval", 999)
    if src_transfer not in spec["transfer_values"]:
        failures.append(f"color_transfer={src_transfer!r} not in {spec['transfer_values']}")
    if src_pix_fmt not in spec["pix_fmts"]:
        failures.append(f"pix_fmt={src_pix_fmt!r} not in {spec['pix_fmts']}")
    if src_kf > 2.0:
        failures.append(f"max_keyframe_interval={src_kf:.2f}s > 2.0s")
    progress(f"normalize triggered: {'; '.join(failures) if failures else 'unknown reason'}")

    cmd, used_fallback_tonemap = _build_ffmpeg_cmd(
        input_path, out_path, project_color_space, info, pre_input_args=[]
    )

    if used_fallback_tonemap:
        progress("⚠⚠⚠ WARNING: zscale filter NOT AVAILABLE — falling back to bare tonemap ⚠⚠⚠")
        progress("HDR→SDR colors WILL be less accurate (washed out highlights, shifted colors).")
        progress("To fix: run `montaj doctor` for instructions on installing libzimg.")

    progress(
        f"Normalizing {input_path}: "
        f"{info['codec']} {info.get('color_transfer', '?')} {info['pix_fmt']} "
        f"→ {spec['encoder']} {spec['output_pix_fmt']} ({project_color_space})"
    )
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        fail("encode_error", f"ffmpeg normalize failed:\n{(r.stderr or '')[-500:]}")

    if used_fallback_tonemap:
        progress("⚠⚠⚠ FALLBACK TONEMAP WAS USED — OUTPUT COLORS ARE DEGRADED ⚠⚠⚠")
        progress(f"File: {out_path}")
        progress("The HDR→SDR conversion used a bare tonemap without proper colorspace conversion.")
        progress("Re-normalize after installing zscale for accurate colors.")
        progress("Fix: run `montaj doctor` → follow zscale installation instructions.")

    return out_path


def normalize_window(
    input_path,
    out_path,
    project_color_space: ColorSpaceKey,
    in_point: float,
    out_point: float,
    info=None,
):
    """Normalize a windowed segment [in_point, out_point) of a video clip.

    Uses input-level fast seek (-ss before -i) so the output starts at time 0
    and is dense-keyframe (re-encode resets GOP via the same -g/-keyint_min args
    as normalize()). All conformance args (codec, pix_fmt, color, GOP) are
    identical to normalize().

    `in_point` / `out_point`: seconds into the source. Duration is clamped to
    max(0.0, out_point - in_point) — reversed windows produce a zero-duration
    encode rather than an error.

    Returns the output path on success; raises SystemExit (via fail()) on error.
    """
    require_valid_key(project_color_space)
    if info is None:
        info = probe_video(input_path)
    if info is None:
        fail("probe_error", f"Cannot probe {input_path}")

    duration = max(0.0, out_point - in_point)
    pre_input_args = [
        "-ss", f"{in_point:.4f}",
        "-t", f"{duration:.4f}",
    ]

    cmd, used_fallback_tonemap = _build_ffmpeg_cmd(
        input_path, out_path, project_color_space, info, pre_input_args=pre_input_args
    )

    if used_fallback_tonemap:
        progress("⚠⚠⚠ WARNING: zscale filter NOT AVAILABLE — falling back to bare tonemap ⚠⚠⚠")
        progress("HDR→SDR colors WILL be less accurate (washed out highlights, shifted colors).")
        progress("To fix: run `montaj doctor` for instructions on installing libzimg.")

    progress(
        f"normalize_window {input_path} [{in_point:.4f}s → {out_point:.4f}s]: "
        f"{info['codec']} {info.get('color_transfer', '?')} {info['pix_fmt']} "
        f"→ {SPECS[project_color_space]['encoder']} {SPECS[project_color_space]['output_pix_fmt']} "
        f"({project_color_space})"
    )
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        fail("encode_error", f"ffmpeg normalize_window failed:\n{(r.stderr or '')[-500:]}")

    if used_fallback_tonemap:
        progress("⚠⚠⚠ FALLBACK TONEMAP WAS USED — OUTPUT COLORS ARE DEGRADED ⚠⚠⚠")
        progress(f"File: {out_path}")

    return out_path


def main():
    p = argparse.ArgumentParser(description="Normalize video to project format")
    p.add_argument("--input", required=True)
    p.add_argument("--color-space", choices=ALL_COLOR_SPACES, default=DEFAULT_COLOR_SPACE)
    p.add_argument("--out", default=None)
    args = p.parse_args()

    require_file(args.input)
    # Default output filename is namespaced per color space so SDR-then-HDR
    # re-normalize doesn't collide. Matches the suffix render.js's
    # normalizeIfNeeded uses (Task 5 Step 2).
    out = args.out or f"{args.input.rsplit('.', 1)[0]}_normalized_{args.color_space}.mp4"
    # CLI mode: print the result path so subprocess callers (e.g. render.js's
    # normalizeIfNeeded) can read it from stdout. The function itself returns
    # the path; only the CLI entry point prints, so library callers (init.py)
    # don't pollute their own stdout.
    result = normalize(args.input, out, args.color_space)
    print(result)


if __name__ == "__main__":
    main()
