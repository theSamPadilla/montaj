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

Projects made before PV42 had `src` swapped onto the converted file, with no
marker in it. ensure_color_provenance heals them: it switches `src` back to the
SDR original when that original is in the project folder (see "healing projects
made before PV42" below).
"""
import json
import math
import os
import re
import struct
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, NamedTuple, Optional

sys.path.insert(0, os.path.dirname(__file__))  # add lib/ so `from common` works in all invocation modes
from common import ffmpeg_bin, ffprobe_bin, progress

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))  # add repo root so `from lib.types...` works
from lib.normalize import SDR_ORIGIN_MARKER, UNTAGGED_AS_BT709_VF
from lib.types.colorspace import detect_from_transfer, is_hdr

__all__ = [
    "SDR_ORIGIN_MARKER", "Probe", "FAILED_PROBE", "Origin",
    "probe_media", "fps_value", "same_fingerprint", "origin_of", "proxy_source_for",
    "legacy_stretch_vf", "legacy_pool", "match_legacy_conversion",
    "plan_color_provenance", "write_color_provenance", "ensure_color_provenance",
]


class Probe(NamedTuple):
    """One ffprobe of a file's first video stream. width and height are display
    dims (after rotation); fps is the r_frame_rate string, e.g. '30000/1001'.
    encoder is the container's `encoder` tag ('Lavf62.12.102' for anything
    ffmpeg wrote, '' when absent); only the legacy matcher reads it, so the JS
    twin does not carry it. `duration` is the container's (`format=duration`),
    not the stream's: stream duration is N/A in Matroska/WebM, and normalize
    carries every stream, so container against container is like for like
    (ScreenRecording 36.652 vs 36.631, inside tolerance)."""
    transfer: str
    comment: str
    width: Optional[int]
    height: Optional[int]
    fps: Optional[str]
    duration: Optional[float]
    encoder: str = ""


FAILED_PROBE = Probe("unknown", "", None, None, None, None)


class Origin(NamedTuple):
    """color_space: 'sdr_bt709', 'hdr_hlg' or 'hdr_pq'. original: the SDR file a
    marked conversion was made from, when it is beside it and matches."""
    color_space: str
    original: Optional[str]


# ── probe ────────────────────────────────────────────────────────────────────

_PROBE_ENTRIES = (
    "stream=width,height,r_frame_rate,color_transfer"
    ":stream_side_data=rotation:format=duration:format_tags=comment,encoder"
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

    # Container duration on purpose (see Probe): stream duration is N/A in Matroska/WebM.
    try:
        duration = float(fmt.get("duration"))
    except (TypeError, ValueError):
        duration = None
    tags = fmt.get("tags") or {}
    comment = tags.get("comment")
    encoder = tags.get("encoder")
    fps = s.get("r_frame_rate")
    return Probe(
        transfer=s.get("color_transfer") or "unknown",
        comment=comment if isinstance(comment, str) else "",
        width=width,
        height=height,
        fps=fps if isinstance(fps, str) else None,
        duration=duration,
        encoder=encoder if isinstance(encoder, str) else "",
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
        if name and name not in (".", "..") and "/" not in name and "\\" not in name:
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


# ── healing projects made before PV42 ────────────────────────────────────────
#
# Before PV42 an SDR clip in an HDR project had `src` swapped onto its converted
# file, and that file carries no marker, so it probes as camera HLG and would be
# graded as camera footage. The file name proves nothing. A candidate is an HDR
# `src` with no SDR_ORIGIN_MARKER whose container `encoder` starts with
# LEGACY_ENCODER_PREFIX ('Lavf'; camera files carry none); it matches a pool
# file only by same_fingerprint and by pixel content under the legacy stretch.
# Names do two small jobs only: POOL_EXCLUDED_NAMES keeps montaj artifacts out
# of the pool, and the rank breaks ties between content matches.
# ensure_color_provenance runs two passes on HDR projects:
#
#   1. marker pass, every call: switch an item whose `src` is a marked
#      conversion (origin_of names its original) back to that original, and
#      drop a `normalizedSrc` that is missing on disk or whose marker names a
#      file other than the item's `src`.
#   2. legacy pass, once (until settings.colorProvenance is 1): match each
#      ffmpeg-written HDR `src` against the SDR files it could have been made
#      from, by fingerprint and by content under the legacy stretch.
#
# A converted clip whose original is gone keeps today's look and is logged (Q1,
# Sam). Items with `nobg_src` are skipped by both passes.

PROVENANCE_KEY = "colorProvenance"
PROVENANCE_VERSION = 1
BACKGROUND_NORMALIZE_KEY = "normalizeInBackground"
"""Twin of serve/routes/projects.py BACKGROUND_NORMALIZE_KEY (lib cannot import
serve). Set when an item was switched, so serve converts each original into its
`normalizedSrc` cache at 203 nits."""

SDR_TRANSFERS = ("bt709", "smpte170m", "bt470bg", "unknown")
POOL_EXTENSIONS = (".mp4", ".mov", ".m4v")
POOL_EXCLUDED_NAMES = ("_proxy_", "_nobg", "_audioclean", "_normalized_")
LEGACY_ENCODER_PREFIX = "Lavf"
"""A conversion is written by ffmpeg. Camera files carry no `encoder` tag
(measured 2026-09-28 on an iPhone IMG_0689.MOV); the real project's four
converted files carry Lavf62.12.102."""

THUMB_W, THUMB_H = 64, 36
THUMB_POINTS = (0.25, 0.5, 0.75)
THUMB_SEEK_PREROLL_S = 2.0
CONTENT_MAX_MEAN_ABS = 8
"""Mean abs difference, in limited-range Y10 codes, allowed at every point."""
CONTENT_MIN_STD = 24
CONTENT_MIN_STD_COUNT = 2
"""At least this many of the candidate's thumbnails need a Y10 standard
deviation of CONTENT_MIN_STD or more: a dark or flat frame matches anything.
The lowest measured on the real project's four legacy conversions was 36 (a
screen recording at 75 %, dark UI)."""


def _is_file(path) -> bool:
    return isinstance(path, str) and os.path.isabs(path) and os.path.isfile(path)


def _mtime_ns(path) -> Optional[int]:
    try:
        return os.stat(path).st_mtime_ns
    except (OSError, TypeError, ValueError):
        return None


def _prefetch(paths) -> None:
    """Warm the probe cache for `paths` a few at a time (one ffprobe each)."""
    paths = sorted({p for p in paths if isinstance(p, str)})
    if len(paths) < 2:
        for p in paths:
            probe_media(p)
        return
    with ThreadPoolExecutor(max_workers=min(8, len(paths))) as pool:
        list(pool.map(probe_media, paths))


def _video_items(project: dict):
    """Every video item across all tracks plus the `sources` mirror. Same walk
    as serve's _look_migration_items."""
    from lib.project_tracks import track_items

    for group in track_items(project) + [project.get("sources") or []]:
        for item in group or []:
            if isinstance(item, dict) and item.get("type") == "video" and item.get("src"):
                yield item


def legacy_stretch_vf(color_space: str, *, untagged: bool) -> str:
    """The pre-PV42 SDR-to-HDR stretch, which made every existing converted
    file: SDR white at zscale's default 100 nits (no npl=203), with the untagged
    source read as BT.709 first."""
    transfer = "arib-std-b67" if color_space == "hdr_hlg" else "smpte2084"
    vf = f"zscale=t={transfer}:p=bt2020:m=bt2020nc,format=yuv420p10le"
    return f"{UNTAGGED_AS_BT709_VF},{vf}" if untagged else vf


def _thumbnails(path: str, times, pre_vf: str = "") -> Optional[list]:
    """Limited-range Y10 planes (THUMB_W x THUMB_H) of `path` at `times`, or
    None on any failure. Each side is decoded with its own range: the scale
    converts whatever the file is tagged (a screen recording is full range) to
    limited, so the two sides compare code for code."""
    vf = (f"{pre_vf}," if pre_vf else "") + \
        f"scale={THUMB_W}:{THUMB_H}:flags=area:out_range=tv,format=yuv420p10le"
    n = THUMB_W * THUMB_H
    planes = []
    for t in times:
        # Two-stage seek. A single input seek is wrong on the ffmpeg-made libx265
        # conversions (open GOP, B-frames): the keyframe displayed at 5.0 s in
        # xtXouo5hHxM3LO46_compatible_hlg.mp4 has dts 4.4, its leading pictures
        # (4.6-4.9 s) belong to the previous GOP, and `-ss 4.65 -i` starts at that
        # keyframe, drops them and returns the 5.0 s frame instead of 4.7 s.
        # Seek near, then decode forward to the exact frame; 2 s of preroll
        # exceeds normalize's 1 s GOP. Same pattern as render/sample-frame.js.
        near = max(0.0, t - THUMB_SEEK_PREROLL_S)
        cmd = [ffmpeg_bin(), "-v", "error", "-nostdin",
               *(["-ss", f"{near:.3f}"] if near > 0 else []), "-i", path,
               "-ss", f"{t - near:.3f}", "-frames:v", "1", "-an", "-sn", "-dn", "-vf", vf, "-f", "rawvideo", "-"]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=120)
        except (OSError, subprocess.SubprocessError):
            return None
        if r.returncode != 0 or len(r.stdout) < n * 2:
            return None
        planes.append(struct.unpack(f"<{n}H", r.stdout[:n * 2]))
    return planes or None


def _std(plane) -> float:
    mean = sum(plane) / len(plane)
    return math.sqrt(sum((v - mean) ** 2 for v in plane) / len(plane))


def _mean_abs(a, b) -> float:
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def legacy_pool(project_dir, sources_srcs=(), *, exclude=(), probe: Optional[Callable] = None) -> list:
    """The SDR files a legacy conversion could have been made from: every
    `sources[].src`, then the top-level .mp4/.mov/.m4v files of the project
    folder (any case), minus montaj's own artifacts (proxies, nobg, audioclean,
    normalized) and `exclude` (the candidates), one entry per file (realpath),
    keeping only what probes SDR."""
    probe = probe or probe_media
    paths = [s for s in sources_srcs if _is_file(s)]
    try:
        names = sorted(e.name for e in os.scandir(project_dir) if e.is_file())
    except OSError:
        names = []
    paths += [os.path.join(str(project_dir), n) for n in names
              if os.path.splitext(n)[1].lower() in POOL_EXTENSIONS]
    seen = {os.path.realpath(p) for p in exclude}
    kept = []
    for path in paths:
        if any(frag in os.path.basename(path) for frag in POOL_EXCLUDED_NAMES):
            continue
        real = os.path.realpath(path)
        if real in seen:
            continue
        seen.add(real)
        kept.append(path)
    if probe is probe_media:
        _prefetch(kept)
    out = []
    for path in kept:
        p = probe(path)
        if p.width and p.transfer in SDR_TRANSFERS:
            out.append(path)
    return out


def match_legacy_conversion(candidate: str, pool, *, sources=(), probe: Optional[Callable] = None,
                            thumbnails: Optional[Callable] = None) -> dict:
    """Which file in `pool` `candidate` (an ffmpeg-written HDR file) was
    converted from, under the legacy stretch. `sources` holds the realpaths of
    the project's `sources[].src` (a tiebreak).

    Per pool file, the first guard that rejects it: `mtime` (newer than the
    candidate: a conversion is made from an original that already exists),
    `fingerprint` (same_fingerprint), `std-dev floor` (fewer than
    CONTENT_MIN_STD_COUNT candidate thumbnails reach CONTENT_MIN_STD), or
    `content` (a mean abs over CONTENT_MAX_MEAN_ABS at any point, or a
    thumbnail that could not be read). Returns
    {src, encoder, rejected, original, thumbStd, pool: [{path, rejected, meanAbs}]}."""
    probe = probe or probe_media
    thumbnails = thumbnails or _thumbnails
    c = probe(candidate)
    key = detect_from_transfer(c.transfer)
    entry = {"src": candidate, "encoder": c.encoder, "rejected": None, "original": None,
             "thumbStd": None, "pool": []}
    c_mtime = _mtime_ns(candidate)
    times = [c.duration * f for f in THUMB_POINTS] if c.duration else []
    cand = None  # candidate planes: read once, and only when a pool file gets that far
    stds: list = []
    matches = []
    for path in pool:
        row = {"path": path, "rejected": None, "meanAbs": None}
        entry["pool"].append(row)
        m = _mtime_ns(path)
        if c_mtime is None or m is None or m > c_mtime:
            row["rejected"] = "mtime"
            continue
        p = probe(path)
        if not same_fingerprint(c, p):
            row["rejected"] = "fingerprint"
            continue
        if cand is None:
            cand = thumbnails(candidate, times) or []
            stds = [_std(t) for t in cand]
            entry["thumbStd"] = [round(v, 1) for v in stds] if stds else None
        planes = thumbnails(path, times, legacy_stretch_vf(key, untagged=p.transfer == "unknown")) \
            if cand else None
        if not cand or not planes or len(planes) != len(cand):
            row["rejected"] = "content"
            continue
        mad = [_mean_abs(a, b) for a, b in zip(cand, planes)]
        row["meanAbs"] = [round(v, 2) for v in mad]
        if sum(v >= CONTENT_MIN_STD for v in stds) < CONTENT_MIN_STD_COUNT:
            row["rejected"] = "std-dev floor"
            continue
        if max(mad) > CONTENT_MAX_MEAN_ABS:
            row["rejected"] = "content"
            continue
        matches.append(path)

    if matches:
        stem_of = lambda p: os.path.splitext(os.path.basename(p))[0]  # noqa: E731
        cstem = stem_of(candidate)
        sources_real = set(sources)

        def rank(path):
            stem = stem_of(path)
            return (
                # 1. the candidate is named `<pool stem>_normalized_<cs>.mp4`
                os.path.basename(candidate) != f"{stem}_normalized_{key}.mp4",
                # 2. the shortest pool stem the candidate's stem starts with
                (0, len(stem)) if cstem.startswith(stem) else (1, 0),
                # 3. a pool file that is some sources[].src
                os.path.realpath(path) not in sources_real,
                # 4. the oldest mtime
                _mtime_ns(path) or 0,
                path,
            )

        entry["original"] = min(matches, key=rank)
    return entry


def _fresh_proxy(original: str) -> Optional[str]:
    from lib.proxy import is_proxy_fresh, proxy_path_for

    real = os.path.realpath(original)
    out = proxy_path_for(real)
    return out if is_proxy_fresh(out, real) else None


def _new_result(project_dir) -> dict:
    return {
        "projectDir": str(project_dir), "colorSpace": None, "skipped": None, "error": None,
        "legacyPass": False, "switched": [], "dropped": [], "candidates": [], "kept": [],
        "settings": {}, "edits": [], "proxiesOwed": [], "log": [], "written": False,
    }


def _plan(project_dir: Path, result: dict) -> None:
    try:
        project = json.loads((project_dir / "project.json").read_text())
    except (OSError, ValueError):
        project = None
    if not isinstance(project, dict):
        result["skipped"] = "unreadable project.json"
        return
    settings = project.get("settings") if isinstance(project.get("settings"), dict) else {}
    color_space = settings.get("colorSpace")
    result["colorSpace"] = color_space
    if not is_hdr(color_space):
        result["skipped"] = "not an HDR project"
        return

    items = [it for it in _video_items(project) if not it.get("nobg_src")]
    _prefetch({it["src"] for it in items if _is_file(it["src"])}
              | {it["normalizedSrc"] for it in items if _is_file(it.get("normalizedSrc"))})
    proxies_enabled = settings.get("proxy") is not False

    edits: dict = {}      # (id, src) -> {field: value}; `src` always last
    switched: dict = {}   # (id, src) -> original
    dropped: set = set()

    def switch(item: dict, original: str, how: str) -> None:
        key = (item.get("id"), item["src"])
        if key in switched:
            return
        switched[key] = original
        proxy = _fresh_proxy(original) if proxies_enabled else None
        fields = edits.setdefault(key, {})
        fields.pop("src", None)
        # proxySrc before src: _apply_project_edits matches each edit on the
        # item's current (id, src), so nothing after the src edit would land.
        fields["proxySrc"] = proxy
        fields["normalizedSrc"] = None
        fields["normalizedInPoint"] = None
        fields["src"] = original
        result["switched"].append({"id": key[0], "from": key[1], "to": original, "pass": how,
                                   "proxySrc": proxy})
        if proxy is None and proxies_enabled:
            from lib.proxy import proxy_path_for

            real = os.path.realpath(original)
            owed = {"id": key[0], "src": original, "input": real, "out": proxy_path_for(real)}
            if owed not in result["proxiesOwed"]:
                result["proxiesOwed"].append(owed)

    # 1. marker pass
    for item in items:
        src = item["src"]
        if _is_file(src) and is_hdr(detect_from_transfer(probe_media(src).transfer)):
            origin = origin_of(src)
            if origin.original:
                switch(item, origin.original, "marker")
    for item in items:
        key = (item.get("id"), item["src"])
        cache = item.get("normalizedSrc")
        if key in switched or key in dropped or not isinstance(cache, str) or not os.path.isabs(cache):
            continue
        reason = None
        if not os.path.exists(cache):
            reason = "missing"  # render's validateProjectFiles checks only src
        else:
            comment = probe_media(cache).comment
            if comment.startswith(SDR_ORIGIN_MARKER):
                named = comment[len(SDR_ORIGIN_MARKER):]
                if named != os.path.basename(item["src"]):
                    reason = f"made from {named}"
        if reason:
            dropped.add(key)
            fields = edits.setdefault(key, {})
            fields["normalizedSrc"] = None
            fields["normalizedInPoint"] = None
            result["dropped"].append({"id": key[0], "src": key[1], "normalizedSrc": cache, "reason": reason})

    # 2. legacy pass, once
    if settings.get(PROVENANCE_KEY) != PROVENANCE_VERSION:
        result["legacyPass"] = True
        by_real: dict = {}
        for item in items:
            if (item.get("id"), item["src"]) in switched or item.get("normalizedSrc") or not _is_file(item["src"]):
                continue
            by_real.setdefault(os.path.realpath(item["src"]), item["src"])
        candidates = []
        for src in by_real.values():
            p = probe_media(src)
            if not is_hdr(detect_from_transfer(p.transfer)):
                continue
            reject = None
            if p.comment.startswith(SDR_ORIGIN_MARKER):
                reject = "marker"  # made by PV42's normalize: the marker pass owns it
            elif not p.encoder.startswith(LEGACY_ENCODER_PREFIX):
                reject = "encoder"
            if reject:
                result["candidates"].append({"src": src, "encoder": p.encoder, "rejected": reject,
                                             "original": None, "thumbStd": None, "pool": []})
            else:
                candidates.append(src)
        if candidates:
            sources_srcs = [s["src"] for s in project.get("sources") or []
                            if isinstance(s, dict) and isinstance(s.get("src"), str)]
            pool = legacy_pool(project_dir, sources_srcs, exclude=candidates)
            sources_real = {os.path.realpath(s) for s in sources_srcs if _is_file(s)}
            for src in candidates:
                entry = match_legacy_conversion(src, pool, sources=sources_real)
                result["candidates"].append(entry)
                original = entry["original"]
                if not original:
                    result["kept"].append(os.path.basename(src))
                    continue
                # Keep the folder spelled the way the candidate spells it.
                if os.path.realpath(os.path.dirname(original)) == os.path.realpath(os.path.dirname(src)):
                    original = os.path.join(os.path.dirname(src), os.path.basename(original))
                real = os.path.realpath(src)
                for item in items:
                    if _is_file(item["src"]) and os.path.realpath(item["src"]) == real:
                        switch(item, original, "legacy")
        result["settings"][PROVENANCE_KEY] = PROVENANCE_VERSION
        if result["kept"]:
            line = (f"colour provenance: no SDR original matched {len(result['kept'])} "
                    f"ffmpeg-written HDR clip(s): {', '.join(result['kept'])}")
            result["log"].append(line)
            progress(line)

    if switched and settings.get(BACKGROUND_NORMALIZE_KEY) is not True:
        result["settings"][BACKGROUND_NORMALIZE_KEY] = True
    result["edits"] = [(key[0], key[1], field, value)
                       for key, fields in edits.items() for field, value in fields.items()]


def plan_color_provenance(project_dir) -> dict:
    """Read `project_dir`/project.json and decide what to heal, without writing
    anything. Returns the result dict (see ensure_color_provenance) with
    `edits`, `(item_id, item_src, field, value)` tuples in the shape serve's
    _apply_project_edits takes, and `settings`, the keys to set. Never raises:
    a failure is reported in `error`, with nothing to apply."""
    result = _new_result(project_dir)
    try:
        _plan(Path(project_dir), result)
    except Exception as e:  # a project must always open, and always render
        result.update(error=f"{type(e).__name__}: {e}", edits=[], settings={}, proxiesOwed=[])
    return result


def write_color_provenance(project_path, edits, settings) -> Optional[tuple]:
    """Apply `edits` and `settings` to project.json in one read-modify-write
    (tmp + os.replace). Items are matched by (id, src), so an item changed or
    removed since the plan is skipped; a None value deletes the field. Same
    contract as serve's _apply_project_edits. Returns (project, text), or None
    when nothing changed or the file cannot be read."""
    project_path = Path(project_path)
    try:
        project = json.loads(project_path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(project, dict):
        return None
    changed = False
    for item in _video_items(project):
        for item_id, item_src, field, value in edits:
            if item.get("src") != item_src or item.get("id") != item_id:
                continue
            if value is None:
                if field in item:
                    del item[field]
                    changed = True
            elif item.get(field) != value:
                item[field] = value
                changed = True
    current = project.get("settings")
    if settings and isinstance(current, dict):
        for k, v in settings.items():
            if current.get(k) != v:
                current[k] = v
                changed = True
    if not changed:
        return None
    text = json.dumps(project, indent=2)
    tmp = str(project_path) + ".tmp"
    Path(tmp).write_text(text)
    os.replace(tmp, project_path)
    return project, text


def ensure_color_provenance(project_dir) -> dict:
    """Heal an HDR project whose SDR clips were converted in place: plan
    (plan_color_provenance), then write project.json once. Synchronous and
    file-level: it queues nothing (serve's wrapper adds the git snapshot, SSE
    and the proxy encodes; outside serve, render normalizes inline). A no-op for
    an SDR project. Never raises.

    The result, printable as JSON:
      projectDir, colorSpace, skipped (why nothing was looked at), error,
      legacyPass (whether pass 2 ran),
      switched: [{id, from, to, pass: marker|legacy, proxySrc}],
      dropped: [{id, src, normalizedSrc, reason}],
      candidates: [{src, encoder, rejected (encoder|marker), original, thumbStd,
                    pool: [{path, rejected (mtime|fingerprint|std-dev floor|content), meanAbs}]}],
      kept: basenames left as they are (no original), log: lines logged,
      settings, edits, proxiesOwed: [{id, src, input, out}], written."""
    result = plan_color_provenance(project_dir)
    if result["edits"] or result["settings"]:
        try:
            result["written"] = write_color_provenance(
                Path(project_dir) / "project.json", result["edits"], result["settings"]) is not None
        except Exception as e:
            result["error"] = f"{type(e).__name__}: {e}"
    return result
