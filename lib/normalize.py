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
import sys, os, json, subprocess, argparse, glob, re, functools

sys.path.insert(0, os.path.dirname(__file__))  # add lib/ so `from common` works in all invocation modes
from common import fail, require_file, progress, ffmpeg_bin, ffprobe_bin

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))  # add repo root so `from lib.types.colorspace` works
from lib.types.colorspace import (
    ALL_COLOR_SPACES,
    DEFAULT_COLOR_SPACE,
    SPECS,
    ColorSpaceKey,
    detect_from_transfer,
    is_hdr,
    require_valid_key,
)
from lib.look import MASTER_LOOK, lut_path

HDR_TO_SDR_DENOISE_VF = "hqdn3d=1.5:1.5:3:3"
"""Light source-domain denoise paired with the HDR→SDR Vivid LUT (decision
8b, SP6b Task T4): the curve brightens midtones, which measurably amplifies
iPhone shadow noise. Applied only in `_build_ffmpeg_cmd`'s master tonemap
arm — never in proxy encodes or the hable fallback arm. A module-level
constant (not inlined) so tests can isolate its effect without forking the
real filter-chain assembly."""


def probe_video(path):
    """Return dict with codec, width, height, pix_fmt, color_transfer, fps, has_audio,
    audio_sample_rate, max_keyframe_interval, rotation, display_width, display_height,
    creation_time.

    Rotation: degrees from the displaymatrix side_data (-180, -90, 0, 90, 180, 270, etc.).
    iPhone vertical recordings have rotation=-90 (sensor outputs landscape, displays
    portrait). 0 when no rotation is tagged.

    Display dimensions: width/height after applying rotation. For a 1920×1080 source
    with rotation=±90 or ±270, display_width=1080, display_height=1920. Use these
    when reasoning about output orientation (e.g., picking project canvas size).

    Creation time: the container's `format.tags.creation_time` (ISO 8601, e.g.
    `2023-05-14T18:32:10.000000Z`) — the recording timestamp for camera/phone
    footage. None when absent or a zeroed placeholder (some encoders write
    `0000-00-00T00:00:00...`, which is not a real date).
    """
    cmd = [
        ffprobe_bin(), "-v", "quiet",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,pix_fmt,color_transfer,r_frame_rate,sample_rate:format_tags=creation_time",
        "-of", "json", path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        return None
    probed = json.loads(r.stdout)
    streams = probed.get("streams", [])
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

    # Container recording timestamp. Drop the zeroed placeholder some encoders
    # emit — it is not a real capture time and would sort as the epoch.
    creation_time = ((probed.get("format") or {}).get("tags") or {}).get("creation_time")
    if not creation_time or creation_time.startswith("0000"):
        creation_time = None

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
        "creation_time": creation_time,
    }


def _probe_rotation(path):
    """Return rotation in degrees from the video stream's displaymatrix side_data.

    Possible values: 0 (no tag or rotation=0), ±90, ±180, ±270. iPhone vertical
    recordings come in as -90 — sensor stores landscape, the rotation tag tells
    players to rotate -90° clockwise (= 90° CCW) for display. Players honor this
    by default, so the file appears portrait. Returns 0 on failure or absence.
    """
    cmd = [
        ffprobe_bin(), "-v", "quiet", "-select_streams", "v:0",
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
        ffprobe_bin(), "-v", "quiet", "-select_streams", "v:0",
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


def normalized_output_path(input_path: str, color_space: ColorSpaceKey, *, tonemapped: bool) -> str:
    """Build the deterministic normalized-master output path for `input_path`.

    Base name is ``<stem>_normalized_<color_space>.mp4`` — namespaced per color
    space so SDR-then-HDR re-normalize doesn't collide. Every call site used to
    build this string independently; this is the one place left that does it
    (SP6b Task T3).

    When `tonemapped` is True, the current master look (MASTER_LOOK, see
    lib/look.py) is appended: ``..._<color_space>_<look>.mp4``. `tonemapped`
    means this encode ran (or will run) the HDR→SDR
    `_build_tonemap_vf_to_sdr` LUT chain — i.e. the source's detected color
    space is HDR (hlg/pq) and `color_space` is "sdr_bt709", the one branch of
    `_build_color_conversion_vf` that actually applies the Montaj Vivid LUT.
    Callers determine this from their own probe (`is_hdr(detect_from_transfer(
    info["color_transfer"])) and color_space == "sdr_bt709"`) and pass it in —
    this function does no probing itself.

    Tagging mirrors lib/proxy.py's PROXY_LOOK filename contract: bumping the
    look changes MASTER_LOOK, which changes this suffix, so a stale
    tone-mapped master becomes detectable (and cleanable — see
    cli/commands/clean.py's KNOWN_LOOKS) by filename alone, no re-probing or
    pixel inspection required.

    `tonemapped=False` masters (a source already SDR, or an HDR<->HDR /
    SDR->HDR conversion — no LUT involved) stay untagged: their pixels carry
    no look, so tagging them would only churn every existing SDR project's
    cache for nothing (SP6b decision 7). `is_normalized()` is unaffected by
    any of this — it checks probed content, never the filename.
    """
    stem = input_path.rsplit(".", 1)[0]
    look_suffix = f"_{MASTER_LOOK}" if tonemapped else ""
    return f"{stem}_normalized_{color_space}{look_suffix}.mp4"


@functools.lru_cache(maxsize=None)
def _has_zscale():
    """Check if ffmpeg has the zscale filter (requires libzimg).

    Memoized — ffmpeg's capability set doesn't change mid-process, and this
    used to re-spawn ffmpeg -filters on every call (every clip, every HDR
    conversion decision).
    """
    r = subprocess.run([ffmpeg_bin(), "-filters"], capture_output=True, text=True, timeout=5)
    return "zscale" in (r.stdout or "")


@functools.lru_cache(maxsize=None)
def _has_lut3d():
    """Check if ffmpeg has the lut3d filter (applies the Montaj Vivid .cube LUT).

    Memoized for the same reason as _has_zscale().
    """
    r = subprocess.run([ffmpeg_bin(), "-filters"], capture_output=True, text=True, timeout=5)
    return "lut3d" in (r.stdout or "")


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
    """HDR (HLG or PQ) → SDR Rec.709. Uses the Montaj Vivid LUT chain (zscale +
    lut3d, see montaj_assets/luts/ and lib/look.py) when available; falls back
    to a bare Hable tonemap otherwise.

    The LUT is graded for full-range HLG-encoded BT.2020 RGB input (SP6a
    decision). PQ sources get a zscale PQ→HLG pre-step — at the LUT's design
    white of 1000 nit, the same parameter SP6a's generator OOTF used — before
    the shared chain runs.

    Chain (decision 8a, SP6a/SP6b — verbatim, do not reorder): the
    `format=rgb48le` pin BEFORE `lut3d` is load-bearing. Without it ffmpeg
    feeds 8-bit into the LUT and quantizes. After the LUT the pixels are
    full-range RGB; the trailing zscale tags them back to limited-range
    Rec.709 YUV for the encoder (RGB→YUV709 tagging is ours to add, on top of
    the LUT vendor's chain).

    The trailing zscale explicitly sets t=/m=/p= (not just r=/rin=) —
    verified against the managed ffmpeg 8.1.2: zscale only overrides an axis
    it's explicitly given; an omitted axis passes the frame's existing tag
    through, and that explicit frame tag wins over the blanket
    `-color_trc`/`-color_primaries`/`-colorspace` output flags in
    output_color_args below. Without t=/p= here the encoded file kept
    reporting the HDR source's transfer/primaries (arib-std-b67/bt2020)
    despite those output flags asking for bt709 — caught by this task's
    ffprobe-based functional tests.

    `tin=`/`pin=` are just as load-bearing, and for the opposite reason.
    zscale does not merely relabel an axis it is given — it *converts* to it,
    from whatever the frame is currently tagged. The frame arriving here is
    still tagged with the source's HDR transfer/primaries (the LUT changes
    pixels, not tags), so `t=bt709:p=bt709` alone made zscale run a real
    HLG→709 transfer conversion and a real BT.2020→709 gamut map over pixels
    the LUT had *already* tone-mapped to display-referred Rec.709. Highlights
    then clipped per channel and shifted hue — a warm white wall went pure
    yellow, a window went cyan. Pinning `tin=bt709:pin=bt709` declares the
    post-LUT truth, which collapses both conversions to no-ops and leaves
    exactly the retag this step was added for. Measured on real HLG footage:
    SSIM against the LUT's own output was 0.785 without the pins, 0.990 with
    them.

    Falls back to the pre-LUT bare-tonemap path (degraded: washed-out
    highlights, shifted colors) when zscale OR lut3d is missing from the
    ffmpeg build. Callers are expected to emit a loud warning when
    used_fallback=True. This preserves the v1 _used_fallback_tonemap UX.
    """
    if _has_zscale() and _has_lut3d():
        prestep = ""
        if src == "hdr_pq":
            # PQ → HLG at the LUT's design white (1000 nit) before the LUT's
            # native HLG input chain — the LUT itself is only graded for HLG.
            prestep = "zscale=tin=smpte2084:t=arib-std-b67:npl=1000,"
        return (
            f"{prestep}"
            "zscale=matrixin=2020_ncl:rangein=limited:range=full,"
            "format=rgb48le,"
            f"lut3d=file={lut_path()}:interp=tetrahedral,"
            "zscale=tin=bt709:t=bt709:pin=bt709:p=bt709:m=bt709:rin=full:r=tv",
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

    # HDR→SDR only: the Vivid LUT brightens midtones, which measurably
    # amplifies iPhone shadow noise (decision 8b). Pair the curve with a
    # light source-domain denoise, prepended ahead of the conversion chain
    # (pre-LUT — denoising before the curve amplifies is the point). The
    # hable fallback arm (used_fallback_tonemap) is a degraded-capability
    # path with no curve of its own to amplify anything — it stays exactly
    # as today, no denoise. Proxy encodes and SDR-source conformance runs
    # never go through this branch (proxy has its own _build_proxy_cmd;
    # SDR sources hit no color conversion at all, or the SDR→HDR/HDR↔HDR
    # arms, none of which apply the curve).
    is_hdr_to_sdr = source_color_space in ("hdr_hlg", "hdr_pq") and project_color_space == "sdr_bt709"

    used_fallback_tonemap = False
    vf_parts: list[str] = []
    if needs_color_conversion:
        conv_filter, used_fallback_tonemap = _build_color_conversion_vf(
            source_color_space, project_color_space
        )
        # Guarded on truthiness (not just is_hdr_to_sdr/used_fallback_tonemap) so
        # a test can monkeypatch HDR_TO_SDR_DENOISE_VF to "" to isolate the
        # denoise's effect without leaving a dangling empty vf_parts entry.
        if is_hdr_to_sdr and not used_fallback_tonemap and HDR_TO_SDR_DENOISE_VF:
            vf_parts.append(HDR_TO_SDR_DENOISE_VF)
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
        ffmpeg_bin(), "-y",
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
        # The anullsrc INPUT must sit with the inputs (right after the primary
        # -i), not on the output side — every option between an -i and the next
        # -i/output binds to what follows, so splicing a new input after `-vf`
        # made ffmpeg try to apply -vf to the lavfi source and reject the whole
        # command ("Option vf ... cannot be applied to input url anullsrc").
        # `-shortest` stays output-side so the silent track ends with the video.
        idx = cmd.index("-i")
        assert cmd[idx + 1] == input_path
        cmd[idx + 2:idx + 2] = ["-f", "lavfi", "-i", "anullsrc=cl=stereo:r=48000"]
        idx = cmd.index(out_path)
        cmd[idx:idx] = ["-shortest"]

    return cmd, used_fallback_tonemap


def _tmp_for(out_path: str) -> str:
    """Per-pid sibling temp path for an atomic encode.

    Keeps a ``.mp4`` extension so ffmpeg infers the mp4 muxer — a bare
    ``.tmp.<pid>`` suffix has no recognised extension and the encode (with
    ``+faststart``) would fail to choose a muxer.
    """
    return f"{out_path}.tmp.{os.getpid()}.mp4"


def _pid_alive(pid: int) -> bool:
    """True if a process with this pid currently exists (best-effort)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists but owned by another user
    except OSError:
        return True  # be conservative — don't reap on an ambiguous error
    return True


def _sweep_stale_temps(out_path: str) -> None:
    """Remove orphaned ``{out_path}.tmp.<pid>.mp4`` files left by dead encodes.

    Concurrency-safe: only reaps temps whose owning pid is no longer alive (and
    never our own), so a sibling encode writing the same cache path concurrently
    is left untouched. Orphans come from killed / timed-out / crashed runs.
    """
    mypid = os.getpid()
    for stale in glob.glob(f"{glob.escape(out_path)}.tmp.*"):
        m = re.search(r"\.tmp\.(\d+)\.mp4$", stale)
        if not m:
            continue
        pid = int(m.group(1))
        if pid == mypid or _pid_alive(pid):
            continue
        try:
            os.unlink(stale)
        except OSError:
            pass


def _run_atomic_encode(cmd, tmp_path: str, out_path: str, *, label: str, timeout: float = 600) -> None:
    """Run an ffmpeg encode that writes ``tmp_path`` then atomically renames it
    onto ``out_path``.

    Guarantees ``out_path`` is only ever the previous good file or absent: a
    killed, timed-out, or non-zero-exit encode leaves at most the orphaned temp,
    never a half-written file at the cache path that downstream consumers trust.
    On the same filesystem ``os.replace`` is atomic, so concurrent encoders of
    the same path serialise on the rename (last writer wins) instead of
    interleaving bytes into one corrupt file.

    ``timeout`` (seconds, default 600): callers with longer expected encodes
    (e.g. lib/proxy.py's full-source proxy pass) pass a larger, duration-scaled
    value. Default is unchanged from the original hardcoded 600s.
    """
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            fail("encode_error", f"{label} failed:\n{(r.stderr or '')[-500:]}")
        os.replace(tmp_path, out_path)
    finally:
        # On success the temp was renamed away (FileNotFoundError); on any
        # failure path (non-zero exit raises SystemExit, timeout raises
        # TimeoutExpired) this drops the partial temp before propagating.
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass


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

    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    _sweep_stale_temps(out_path)
    tmp_path = _tmp_for(out_path)

    cmd, used_fallback_tonemap = _build_ffmpeg_cmd(
        input_path, tmp_path, project_color_space, info, pre_input_args=[]
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
    _run_atomic_encode(cmd, tmp_path, out_path, label="ffmpeg normalize")

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

    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    _sweep_stale_temps(out_path)
    tmp_path = _tmp_for(out_path)

    cmd, used_fallback_tonemap = _build_ffmpeg_cmd(
        input_path, tmp_path, project_color_space, info, pre_input_args=pre_input_args
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
    _run_atomic_encode(cmd, tmp_path, out_path, label="ffmpeg normalize_window")

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
    # Probe up front (not just inside normalize()) so the default output path
    # can carry the look tag when this encode will tone-map HDR → SDR.
    # normalize() accepts the pre-probed info below, so this isn't a second
    # ffprobe on the success path. render.js's normalizeIfNeeded always passes
    # --out explicitly (built by its own buildNormalizedOutputPath using
    # render/look.js's MASTER_LOOK), so this default-out branch only matters
    # for direct/bare CLI invocations.
    info = probe_video(args.input)
    tonemapped = (
        info is not None
        and is_hdr(detect_from_transfer(info.get("color_transfer")))
        and args.color_space == "sdr_bt709"
    )
    out = args.out or normalized_output_path(args.input, args.color_space, tonemapped=tonemapped)
    # CLI mode: print the result path so subprocess callers (e.g. render.js's
    # normalizeIfNeeded) can read it from stdout. The function itself returns
    # the path; only the CLI entry point prints, so library callers (init.py)
    # don't pollute their own stdout.
    result = normalize(args.input, out, args.color_space, info=info)
    print(result)


if __name__ == "__main__":
    main()
