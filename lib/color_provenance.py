"""Where a video layer's colour came from: its provenance, resolved from `src`.

Twin of montaj_assets/render/sdr-layer.js. The two are one rule in two
languages, and tests/fixtures/color_provenance_cases.json keeps them equal:
tests/test_color_provenance.py and montaj_assets/render/test/sdr-layer.test.mjs
both run every case in it. Change a rule here and it must change there too.

Provenance is data, and the datum is `src`: the file the user brought in. An
SDR clip converted into the HDR working space is a cache in `normalizedSrc`,
never a new `src`. When a converted file ends up in `src` anyway, the container
comment lib/normalize.py writes into it (SDR_ORIGIN_MARKER + the original's
basename) still names where it came from. That marker counts only when the
named original sits beside it, is SDR, and matches its fingerprint
(same_fingerprint): ffmpeg copies `comment` onto anything derived from a marked
file, so a trimmed or scaled copy inherits the marker without being a
conversion of the original.

Whether a layer is graded is provenance, so every Python consumer choosing a
grade asks proxy_source_for rather than re-deriving it from the file it decodes
(a converted file probes as HLG).
"""
import json
import os
import re
import subprocess
import sys
from typing import Callable, NamedTuple, Optional

sys.path.insert(0, os.path.dirname(__file__))  # add lib/ so `from common` works in all invocation modes
from common import ffprobe_bin

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))  # add repo root so `from lib.types...` works
from lib.normalize import SDR_ORIGIN_MARKER
from lib.types.colorspace import detect_from_transfer, is_hdr

__all__ = [
    "SDR_ORIGIN_MARKER", "Probe", "FAILED_PROBE", "Origin",
    "probe_media", "fps_value", "same_fingerprint", "origin_of", "proxy_source_for",
]


class Probe(NamedTuple):
    """One ffprobe of a file's first video stream. width and height are display
    dims (after rotation); fps is the r_frame_rate string, e.g. '30000/1001'."""
    transfer: str
    comment: str
    width: Optional[int]
    height: Optional[int]
    fps: Optional[str]
    duration: Optional[float]


FAILED_PROBE = Probe("unknown", "", None, None, None, None)


class Origin(NamedTuple):
    """color_space: 'sdr_bt709', 'hdr_hlg' or 'hdr_pq'. original: the SDR file a
    marked conversion was made from, when it is beside it and matches."""
    color_space: str
    original: Optional[str]


# ── probe ────────────────────────────────────────────────────────────────────

_PROBE_ENTRIES = (
    "stream=width,height,r_frame_rate,color_transfer"
    ":stream_side_data=rotation:format=duration:format_tags=comment"
)

_CACHE: dict = {}
"""(realpath, mtime_ns) -> Probe. Failed probes are not cached."""
_CACHE_MAX = 4096


def _ffprobe(path: str) -> Probe:
    """One ffprobe, uncached. Never raises: any failure returns FAILED_PROBE."""
    cmd = [ffprobe_bin(), "-v", "quiet", "-select_streams", "v:0",
           "-show_entries", _PROBE_ENTRIES, "-of", "json", path]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return FAILED_PROBE
    if r.returncode != 0:
        return FAILED_PROBE
    try:
        data = json.loads(r.stdout)
    except ValueError:
        return FAILED_PROBE
    streams = data.get("streams") or []
    if not streams:
        return FAILED_PROBE
    s = streams[0]
    fmt = data.get("format") or {}

    width = s.get("width") if isinstance(s.get("width"), int) else None
    height = s.get("height") if isinstance(s.get("height"), int) else None
    rot = next((d.get("rotation") for d in (s.get("side_data_list") or [])
                if isinstance(d, dict) and d.get("rotation") is not None), 0)
    try:
        rot = int(round(float(rot)))
    except (TypeError, ValueError):
        rot = 0
    if abs(rot) % 180 == 90:
        width, height = height, width

    try:
        duration = float(fmt.get("duration"))
    except (TypeError, ValueError):
        duration = None
    comment = (fmt.get("tags") or {}).get("comment")
    fps = s.get("r_frame_rate")
    return Probe(
        transfer=s.get("color_transfer") or "unknown",
        comment=comment if isinstance(comment, str) else "",
        width=width,
        height=height,
        fps=fps if isinstance(fps, str) else None,
        duration=duration,
    )


def probe_media(path) -> Probe:
    """The real probe, cached in-process by (realpath, mtime). A missing path
    (or None) is FAILED_PROBE."""
    try:
        real = os.path.realpath(path)
        mtime = os.stat(real).st_mtime_ns
    except (OSError, TypeError, ValueError):
        return FAILED_PROBE
    key = (real, mtime)
    hit = _CACHE.get(key)
    if hit is not None:
        return hit
    result = _ffprobe(real)
    if result != FAILED_PROBE:
        if len(_CACHE) >= _CACHE_MAX:
            _CACHE.clear()
        _CACHE[key] = result
    return result


# ── the rule ─────────────────────────────────────────────────────────────────

_FPS_RE = re.compile(r"(\d+)/(\d+)")


def fps_value(fps) -> float:
    """An r_frame_rate string ('30000/1001') as a number; 0 for missing, '0/0' or junk."""
    m = _FPS_RE.fullmatch(fps) if isinstance(fps, str) else None
    if not m:
        return 0
    num, den = int(m.group(1)), int(m.group(2))
    return num / den if num > 0 and den > 0 else 0


def same_fingerprint(a: Probe, b: Probe) -> bool:
    """Whether `b` (the original a marker names) has `a`'s display size, frame
    rate and duration (within two frames, and never tighter than 50 ms). A
    trimmed or scaled copy that inherited the marker fails here. Twin:
    sameFingerprint in sdr-layer.js."""
    rate = fps_value(a.fps)
    if not a.width or not a.height or not rate or a.duration is None or b.duration is None:
        return False
    return (a.width == b.width and a.height == b.height and a.fps == b.fps
            and abs(a.duration - b.duration) <= max(2 / rate, 0.05))


def origin_of(path, *, probe: Optional[Callable] = None, exists: Optional[Callable] = None) -> Origin:
    """Where `path`'s colour came from. A converted clip whose original is gone
    or does not match is HDR and graded as today (Q1, Sam). `probe` and `exists`
    default to probe_media and os.path.exists; tests inject fakes."""
    probe = probe or probe_media
    exists = exists or os.path.exists
    p = probe(path)
    key = detect_from_transfer(p.transfer)
    if not is_hdr(key):
        return Origin("sdr_bt709", None)
    comment = p.comment if isinstance(p.comment, str) else ""
    if comment.startswith(SDR_ORIGIN_MARKER):
        name = comment[len(SDR_ORIGIN_MARKER):]
        # normalize writes a basename; anything else was not written by montaj.
        if name and "/" not in name and "\\" not in name:
            original = os.path.join(os.path.dirname(path), name)
            if exists(original):
                o = probe(original)
                if not is_hdr(detect_from_transfer(o.transfer)) and same_fingerprint(p, o):
                    return Origin("sdr_bt709", original)
    return Origin(key, None)


def proxy_source_for(src, *, probe: Optional[Callable] = None,
                     exists: Optional[Callable] = None) -> tuple:
    """(input, tonemap) for an SDR proxy of `src`: a marked SDR-origin file's
    original with no tonemap; otherwise `src`, tonemapped when its origin is HDR."""
    origin = origin_of(src, probe=probe, exists=exists)
    if origin.original:
        return origin.original, False
    return src, is_hdr(origin.color_space)
