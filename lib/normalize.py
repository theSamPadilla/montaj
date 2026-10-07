#!/usr/bin/env python3
"""Normalize a video clip to project working color space + codec.

Probes the source with ffprobe. If it already matches the project's working
format (color transfer + bit depth, and keyframes no more than
MAX_KEYFRAME_INTERVAL_S apart), returns the input path unchanged — no
re-encode. Otherwise re-encodes to the project's working color space, using
libx264 yuv420p bt709 for SDR projects and libx265 yuv420p10le
bt2020/(HLG|PQ) for HDR projects.

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
from common import ffmpeg_error_tail, fail, require_file, progress, ffmpeg_bin, ffprobe_bin, ffmpeg_filter_path

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
from lib import proc

HDR_TO_SDR_DENOISE_VF = "hqdn3d=1.5:1.5:3:3"
"""Light source-domain denoise paired with the HDR→SDR Vivid LUT (decision
8b, SP6b Task T4): the curve brightens midtones, which measurably amplifies
iPhone shadow noise. Applied only in `_build_ffmpeg_cmd`'s master tonemap
arm — never in proxy encodes or the hable fallback arm. A module-level
constant (not inlined) so tests can isolate its effect without forking the
real filter-chain assembly."""

UNTAGGED_AS_BT709_VF = "setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709"
"""Read an untagged SDR source as BT.709, which is what it is underneath in
practice (web downloads such as X exports). Without it, ffmpeg reads the
untagged input as "unknown", i.e. BT.601, and converts it to the bt709 the
output args ask for: measured on an untagged 1080p download, cloth patch
158/50/102 came out 149/35/98. Mirrored by the segment encoder's untagged-video
tag (montaj_assets/render/encode-segment.js)."""

SDR_WHITE_NITS = 203
"""Where SDR reference white lands in an HDR output, per ITU-R BT.2408 (203 nits;
HLG Y10 721 and PQ Y10 572 for a white SDR frame). Twin: SDR_WHITE_NITS in
montaj_assets/render/encode-segment.js; keep the two equal."""

SDR_ORIGIN_MARKER = "montaj: converted from SDR source "
"""Written (as the container `comment`, followed by the original's basename)
into every SDR-to-HDR normalize output, so it can be told from camera HLG/PQ
and its original recovered. Trailing space is part of the string."""

UNTAGGED_MASTER_MARKER = "montaj: untagged source read as BT.709"
"""Written (as the container `comment`) into every SDR master of an untagged
source built with UNTAGGED_AS_BT709_VF. A master of an untagged source WITHOUT
it was built by an older montaj that converted it as BT.601, so render.js's
reuse check rebuilds it (montaj_assets/render/render.js, UNTAGGED_MASTER_MARKER
— keep the two strings identical). Masters of tagged or HDR sources carry no
marker and are never checked."""

KEYFRAME_PROBE_WINDOW_S = 10
"""How much of a source _probe_max_keyframe_interval reads. It cannot see an
interval longer than this (fewer than two keyframes: it returns 999)."""

MAX_KEYFRAME_INTERVAL_S = 10.0
"""The longest keyframe interval a source may have and still be used as is.

Not a correctness bound. Every consumer that cuts a source transcodes, and a
transcode's input seek (`-ss t -i`, -accurate_seek on by default) decodes from
the prior keyframe and drops every frame before `t`: frame-exact on any GOP,
closed or open (measured, montaj_assets/render/test/long-gop-seek.integration.test.mjs).
The rule used to be 2.0 s on the belief that the seek "lands on the prior
keyframe"; it re-encoded a 4K60 screen recording (4.17 s GOP) for 83 s at import.

What a long GOP does cost is decode: each seek decodes up to one interval from
its keyframe (4K60 H.264: about 850 frames/s in software on an M3 Pro, so under
a second here at this bound). Past it, or with fewer than two keyframes in the
probe window, the source is still re-encoded to ~1 s GOPs."""

SEEK_PREROLL_S = 2.0
"""Two-stage-seek preroll for windowed reads of a source that may be open-GOP
HEVC (libx265 default GOP — montaj's own SDR-to-HDR conversions, legacy
`*_compatible_hlg.mp4`, and montaj HDR render outputs, all ~1s GOP). A single
input-level `-ss t -i` into one of these can land inside a keyframe's
leading-picture window and start decoding AT that keyframe, dropping 1-3
leading frames — the re-encode then rebases PTS from the dropped-frame point,
so picture runs ahead of exactly-seeked audio for the rest of the window
(measured, PV48 T1). Fix: seek near = max(0, t - SEEK_PREROLL_S) at the input
(fast), then trim the remaining `t - near` seconds by decoding (PV48 T3).
Twin of THUMB_SEEK_PREROLL_S in lib/color_provenance.py — kept here, not
there, because color_provenance already imports from this module and a
reverse import would cycle. Also mirrored by SEEK_PREROLL_S in
montaj_assets/render/sample-frame.js — keep all three equal (2.0)."""


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

    # Max keyframe interval, which bounds how far back a seek decodes (see
    # MAX_KEYFRAME_INTERVAL_S). Packet inspection over the first
    # KEYFRAME_PROBE_WINDOW_S only, so it is fast.
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
    """Return the max gap (seconds) between keyframes in the first
    KEYFRAME_PROBE_WINDOW_S of the file. Returns 999 if probing fails or fewer
    than two keyframes fall in that window (treat as non-conformant)."""
    cmd = [
        ffprobe_bin(), "-v", "quiet", "-select_streams", "v:0",
        "-show_entries", "packet=pts_time,flags",
        "-read_intervals", f"%+{KEYFRAME_PROBE_WINDOW_S}",
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
      - keyframe interval ≤ MAX_KEYFRAME_INTERVAL_S (a bound on how far back
        each seek decodes, not on its accuracy: see that constant)

    Codec and audio sample rate are NOT checked — the segment encoder handles
    those at compose time (decode is codec-agnostic; audio is resampled per item).
    The keyframe interval used to be held to 2.0 s, on the belief that the
    segment encoder's input seek lands on the prior keyframe. It does not when
    ffmpeg transcodes (measured frame-exact on 5 s GOPs).

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
        and info.get("max_keyframe_interval", 999) <= MAX_KEYFRAME_INTERVAL_S
    )


def normalized_output_path(input_path: str, color_space: ColorSpaceKey, *, tonemapped: bool,
                           sdr_stretch: bool = False, look: str | None = None) -> str:
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
    `_build_color_conversion_vf` that actually applies the default look's LUT.
    Callers determine this from their own probe (`is_hdr(detect_from_transfer(
    info["color_transfer"])) and color_space == "sdr_bt709"`) and pass it in —
    this function does no probing itself.

    Tagging mirrors lib/proxy.py's PROXY_LOOK filename contract: bumping the
    look changes MASTER_LOOK, which changes this suffix, so a stale
    tone-mapped master becomes detectable (and cleanable — see
    cli/commands/clean.py's KNOWN_LOOKS) by filename alone, no re-probing or
    pixel inspection required. `look` names the master an EARLIER look made
    (lib/look.py's PREVIOUS_MASTER_LOOKS), which is how serve's look migration
    recognizes one; omitted, it is MASTER_LOOK.

    `tonemapped=False` masters (a source already SDR, or an HDR<->HDR /
    SDR->HDR conversion — no LUT involved) stay untagged: their pixels carry
    no look, so tagging them would only churn every existing SDR project's
    cache for nothing (SP6b decision 7). `is_normalized()` is unaffected by
    any of this — it checks probed content, never the filename.
    """
    stem = input_path.rsplit(".", 1)[0]
    look_suffix = f"_{look or MASTER_LOOK}" if tonemapped else ""
    if sdr_stretch:
        # SDR white moved from 100 to 203 nits (PV42): name apart from any old
        # 100-nit master so render's mtime cache never reuses one. Twin:
        # render.js buildNormalizedOutputPath.
        look_suffix += "_w203"
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
    """Check if ffmpeg has the lut3d filter (applies the look's .cube LUT).

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
    """HDR (HLG or PQ) → SDR Rec.709. Uses the default look's LUT chain (zscale +
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
            f"lut3d=file={ffmpeg_filter_path(lut_path())}:interp=tetrahedral,"
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
    return f"zscale=t={transfer}:p=bt2020:m=bt2020nc:npl={SDR_WHITE_NITS}"


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
    post_input_seek: str | None = None,
    video_trim: str = "",
    audio_trim: str | None = None,
) -> tuple[list, bool]:
    """Build the ffmpeg command list for a normalize encode.

    `pre_input_args`: optional list inserted immediately before ``["-i", input_path]``.
    Used by normalize_window() to add ``-ss``/``-t`` input-seek args; normalize()
    passes nothing (or an empty list) so its command is byte-identical to before.

    `post_input_seek`: optional accurate (decode-and-discard) seek, in seconds
    as a string, inserted as ``-ss <value>`` immediately after the primary
    input. This is an OUTPUT-side seek (ffmpeg semantics: `-ss` after the last
    `-i` applies to the output, decoding and discarding until that timestamp)
    that re-bases the output's timestamps close to 0. Used by
    normalize_window()'s two-stage seek (PV48 T3, see SEEK_PREROLL_S);
    normalize() passes None so its command is unchanged. When the video has no
    audio track, the anullsrc input spliced in below lands BEFORE this seek in
    the arg list (i.e. still after all `-i`s), so it stays a valid output
    option either way.

    `video_trim` / `audio_trim`: optional ``trim=start=<fine>:duration=<dur>``
    / ``atrim=start=<fine>:duration=<dur>`` filter heads (PV48 review, no
    trailing comma — `video_trim` is joined into `-vf` by the caller's own
    comma-joined `vf_parts` list). The
    `post_input_seek` above only re-bases where the output STARTS; it does not
    bound where it ENDS — that was left to `pre_input_args`'s own `-t`, which
    is measured from wherever decode actually began (`near`), not from the
    window's true start, so an open-GOP source whose `near` lands inside a
    leading-picture window produced more video than duration (PV48 review).
    `video_trim` is prepended to `-vf` (frame-accurate); `audio_trim` is
    passed as `-af`, only when the source has real audio — the anullsrc arm
    below relies on `-shortest` against the now-correct video length instead.
    Both default to "off" so normalize() (which passes neither) is unchanged.

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

    # An untagged source in an SDR project: see UNTAGGED_AS_BT709_VF. Keyed on
    # the probed transfer, the same field the rest of the pipeline reads colour
    # identity from (render.js stamps 'unknown' for an untagged file too).
    src_untagged = info.get("color_transfer", "unknown") == "unknown"
    sdr_to_hdr = (
        project_color_space in ("hdr_hlg", "hdr_pq")
        and not is_hdr(source_color_space)
    )
    # Read as BT.709 for an SDR target (marked) and for an HDR target (the
    # stretch's zscale needs a tagged input; the output is marked SDR_ORIGIN).
    untagged_as_bt709 = src_untagged and (project_color_space == "sdr_bt709" or sdr_to_hdr)
    untagged_master = src_untagged and project_color_space == "sdr_bt709"

    used_fallback_tonemap = False
    vf_parts: list[str] = []
    if video_trim:
        vf_parts.append(video_trim)
    if untagged_as_bt709:
        vf_parts.append(UNTAGGED_AS_BT709_VF)
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

    # Output keyframe every ~1 s (source fps from probe; default 30), well inside
    # MAX_KEYFRAME_INTERVAL_S, so a master's seeks decode little.
    source_fps = info.get("fps") or 30

    # Build encoder args from the spec.
    enc_args = ["-c:v", spec["encoder"]]
    for k, v in spec["encoder_params"].items():
        enc_args.extend([f"-{k}", v])

    cmd = [
        ffmpeg_bin(), "-y",
        *pre_input_args,
        "-i", input_path,
        *(["-ss", post_input_seek] if post_input_seek else []),
        "-vf", vf,
        # -af only when the source has a real audio track to trim; the
        # anullsrc arm below has no stream to bound here and instead matches
        # video's now-correct length via -shortest.
        *(["-af", audio_trim] if audio_trim and info["has_audio"] else []),
        # Stream-level color metadata flags — written to the container so
        # downstream consumers (segment encoder, players) read the right color.
        # These complement the per-frame setparams stamping that the segment
        # encoder applies on its outputs.
        *spec["output_color_args"],
        *enc_args,
        "-pix_fmt", spec["output_pix_fmt"],
        # IDR keyframes every ~1 s: short seeks (see the comment above).
        "-g", str(source_fps),
        "-keyint_min", str(source_fps),
        # Audio is always 48kHz AAC stereo. Segment encoder also resamples per item;
        # we still emit conformant audio here to match the working-format contract.
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart",
        # The reuse check's proof that this master was built reading its
        # untagged source as BT.709 (see UNTAGGED_MASTER_MARKER).
        *(["-metadata", f"comment={UNTAGGED_MASTER_MARKER}"] if untagged_master else []),
        # An SDR-to-HDR output is otherwise indistinguishable from camera HDR.
        *(["-metadata", f"comment={SDR_ORIGIN_MARKER}{os.path.basename(input_path)}"] if sdr_to_hdr else []),
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
    """True if a process with this pid currently exists (best-effort).

    Delegates to lib.proc.pid_alive, the Windows-safe probe (never
    os.kill(pid, 0) on win32 — see lib/proc.py's module docstring). Keeps
    this file's own extra handling of an ambiguous OSError that isn't
    ProcessLookupError/PermissionError, which lib.proc.pid_alive deliberately
    leaves uncaught.
    """
    try:
        return proc.pid_alive(pid)
    except OSError:
        return True  # be conservative — don't reap on an ambiguous error


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
            fail("encode_error", f"{label} failed:\n{ffmpeg_error_tail(r.stderr)}")
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
    if src_kf > MAX_KEYFRAME_INTERVAL_S:
        failures.append(f"max_keyframe_interval={src_kf:.2f}s > {MAX_KEYFRAME_INTERVAL_S}s")
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

    Uses a two-stage seek (PV48 T3, see SEEK_PREROLL_S) so the output starts
    at time 0 and is dense-keyframe (re-encode resets GOP via the same
    -g/-keyint_min args as normalize()). All conformance args (codec, pix_fmt,
    color, GOP) are identical to normalize().

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

    # Two-stage seek: fast input-level seek to `near`, then an accurate
    # output-side seek re-bases the output's timestamps past the remaining
    # `fine` seconds. A single input seek straight to in_point can land
    # inside an open-GOP source's leading-picture window and drop frames
    # (PV48 T1/T3). At in_point == 0, near == fine == 0.0 and this reduces to
    # exactly today's args (no post_input_seek/trim emitted), so unaffected
    # callers are unchanged.
    #
    # The output-side seek only bounds the START, though — the END was left
    # to pre_input_args's own -t, measured from wherever decode actually
    # began (`near`), not from in_point. On an open-GOP source where `near`
    # itself lands in a leading-picture window that drifts, and the window
    # ran long: in=4.75/out=5.75 produced 1.2s of video against 1.0s of exact
    # audio (PV48 review, measured). So input -t is now only a generous upper
    # bound (fine + duration + 1s) when the two-stage seek is active, and
    # trim=start=fine:duration=duration / atrim=... do the exact cut, same
    # shape as materialize_cut.py's fix. Guard duration > 0: a trim
    # `duration=0` means unlimited, not zero-length, and today's form (no
    # trim, no +1) already gives the right zero-duration encode.
    near = max(0.0, in_point - SEEK_PREROLL_S)
    fine = in_point - near
    has_trim = fine > 0 and duration > 0
    # Every seek time to 6 decimals (microseconds, ffmpeg's own resolution),
    # not 4: neither -ss is just a bound. ffmpeg shifts frames by
    # -round(seek / timebase), so a 4-decimal value that rounds UP by over
    # half a tick drops the frame at in_point: the input -ss near ("2.9667"
    # for 149/30) before the trim, the output -ss fine ("0.0667" for 2/30)
    # after it. The video then started a frame late, 0.033 s after the audio
    # (measured FQ54). With fine == 0, -t is the exact end bound and rounding
    # up admitted one extra frame the same way.
    pre_input_args = [
        "-ss", f"{near:.6f}",
        "-t", f"{fine + duration + 1:.6f}" if has_trim else f"{fine + duration:.6f}",
    ]
    post_input_seek = f"{fine:.6f}" if fine > 0 else None
    # 6 decimals for the trims too: a 4-decimal `duration=` can round UP past
    # a frame boundary for periodic fractions like 8/30s ("0.2667" vs the true
    # 0.266667), admitting one extra frame at the trim's own cut point —
    # measured, PV48 review. Same fix as materialize_cut.py's _vchain/_achain.
    video_trim = f"trim=start={fine:.6f}:duration={duration:.6f}" if has_trim else ""
    audio_trim = f"atrim=start={fine:.6f}:duration={duration:.6f}" if has_trim else None

    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    _sweep_stale_temps(out_path)
    tmp_path = _tmp_for(out_path)

    cmd, used_fallback_tonemap = _build_ffmpeg_cmd(
        input_path, tmp_path, project_color_space, info,
        pre_input_args=pre_input_args, post_input_seek=post_input_seek,
        video_trim=video_trim, audio_trim=audio_trim,
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
    sdr_stretch = (
        info is not None
        and not is_hdr(detect_from_transfer(info.get("color_transfer")))
        and is_hdr(args.color_space)
    )
    out = args.out or normalized_output_path(args.input, args.color_space,
                                             tonemapped=tonemapped, sdr_stretch=sdr_stretch)
    # CLI mode: print the result path so subprocess callers (e.g. render.js's
    # normalizeIfNeeded) can read it from stdout. The function itself returns
    # the path; only the CLI entry point prints, so library callers (init.py)
    # don't pollute their own stdout.
    result = normalize(args.input, out, args.color_space, info=info)
    print(result)


if __name__ == "__main__":
    main()
