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

A file that exists and cannot be probed raises ProbeError (PV57, the twin of
PV51 in sdr-layer.js): every answer this module could give for it picks a
grade, and the heal would write that grade to disk.
"""
import errno
import json
import math
import os
import re
import signal
import struct
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, NamedTuple, Optional

sys.path.insert(0, os.path.dirname(__file__))  # add lib/ so `from common` works in all invocation modes
from common import ffmpeg_bin, ffprobe_bin, progress

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))  # add repo root so `from lib.types...` works
from lib.normalize import SDR_ORIGIN_MARKER, UNTAGGED_AS_BT709_VF
from lib.types.colorspace import detect_from_transfer, is_hdr

__all__ = [
    "SDR_ORIGIN_MARKER", "Probe", "FAILED_PROBE", "Origin", "ProbeError", "PROBE_TIMEOUT_S",
    "TRANSIENT_PROBE_REASONS", "PERMANENT_PROBE_REASONS", "is_probe_retryable",
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
"""The probe of a file that is not there (or of no path). It means only that:
a file that exists and cannot be probed raises ProbeError instead."""


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

PROBE_TIMEOUT_S = 30
"""Per try. The probe reads headers only: under 50 ms on 4K HEVC masters under
heavy swap (measured for PV51, 2026-09-29). It stays bounded, because an
unbounded probe of a stalled volume would hang an import, a proxy or a render
with no error at all."""
_PROBE_ATTEMPTS = 2
_RETRY_BACKOFF_S = 0.25
_STDERR_CAP = 400
_TRANSIENT_SPAWN = frozenset({errno.EAGAIN, errno.ENOMEM, errno.EMFILE, errno.ENFILE})
"""spawn errnos that mean "the machine is short right now", not "cannot ever work"."""


class ProbeError(Exception):
    """A file that exists and that ffprobe could not read. `reason`: 'timeout'
    (no answer in PROBE_TIMEOUT_S), 'killed' (a signal: jetsam, a crash),
    'spawn' (ffprobe never started: EAGAIN/ENOMEM under load, ENOENT when there
    is no ffprobe), 'exit' (non-zero, with its stderr), 'parse' (not JSON) or
    'no-stream' (no video stream). `errno` is the OSError's, for 'spawn' only
    (None otherwise): is_probe_retryable reads it to carve ENOENT (no ffprobe
    binary at all) out of an otherwise-retryable reason. Twin of ProbeError in
    sdr-layer.js."""

    code = "MONTAJ_PROBE_FAILED"

    def __init__(self, path, reason, detail, errno=None):
        super().__init__(f"ffprobe could not read {path} ({reason}): {detail}. "
                         "Its colour, and so its grade, is unknown")
        self.path = path
        self.reason = reason
        self.detail = detail
        self.errno = errno

    def __reduce__(self):
        return (type(self), (self.path, self.reason, self.detail, self.errno))


TRANSIENT_PROBE_REASONS = frozenset({"timeout", "killed", "spawn"})
"""Reasons _probe_once already retries once for (PROBE_TIMEOUT_S,
_RETRY_BACKOFF_S): the machine was briefly unable to answer, not the file
itself. A provenance decision that depends on such a failure stays open
(blocking): the next look may read the file."""

PERMANENT_PROBE_REASONS = frozenset({"exit", "parse", "no-stream"})
"""Reasons _probe_once never retries: what ffprobe found is about the file's
own content (a real error, output that is not JSON, or no video stream at
all), so the next look gives the same answer. A provenance decision never
stays open for one — a music bed that can never be a video's original, or a
corrupt candidate, must not stall the legacy pass forever (PV57 review) — but
the failure is still reported, always with blocking=False.

Every site in this module that decides whether a ProbeError blocks a
provenance decision, or is worth a retry, reads these two sets (or
is_probe_retryable, which reads them); there is no other reason-name check."""


def is_probe_retryable(e: "ProbeError") -> bool:
    """Whether asking ffprobe again might get a different answer without the
    file changing: yes for a TRANSIENT_PROBE_REASONS reason, except 'spawn'
    with ENOENT (no ffprobe binary at all — an operator problem that will not
    resolve on its own, unlike EAGAIN/ENOMEM/EMFILE/ENFILE under momentary
    load). serve.routes.steps reuses this for its 503-vs-422 choice and for
    the probe-failed event payload, so there is one place that decides
    retryability (PV57 review)."""
    if e.reason == "spawn" and e.errno == errno.ENOENT:
        return False
    return e.reason in TRANSIENT_PROBE_REASONS


class _Failure(NamedTuple):
    reason: str
    detail: str
    transient: bool = False
    hard: bool = False  # raise whatever the path: there is no ffprobe to ask
    errno: Optional[int] = None


def _probe_once(path: str, run: Callable, timeout: float):
    """One ffprobe run: the parsed JSON, or a _Failure."""
    binary = ffprobe_bin()
    cmd = [binary, "-v", "error", "-select_streams", "v:0",
           "-show_entries", _PROBE_ENTRIES, "-of", "json", path]
    try:
        r = run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return _Failure("timeout", f"no answer in {timeout:g} s", transient=True)
    except OSError as e:
        name = errno.errorcode.get(e.errno) or type(e).__name__
        transient = e.errno in _TRANSIENT_SPAWN
        return _Failure("spawn", f"{binary} did not start ({name})", transient=transient, hard=not transient,
                        errno=e.errno)
    except subprocess.SubprocessError as e:
        return _Failure("spawn", f"{binary} did not run ({type(e).__name__}: {e})")
    if r.returncode is not None and r.returncode < 0:
        try:
            sig = signal.Signals(-r.returncode).name
        except ValueError:
            sig = f"signal {-r.returncode}"
        return _Failure("killed", f"killed by {sig}", transient=True)
    if r.returncode != 0:
        err = r.stderr.decode("utf-8", "replace") if isinstance(r.stderr, bytes) else str(r.stderr or "")
        err = err.strip()
        said = f"{err[:_STDERR_CAP]}..." if len(err) > _STDERR_CAP else err
        return _Failure("exit", f"exit {r.returncode}" + (f": {said}" if said else ""))
    try:
        data = json.loads(r.stdout)
    except (TypeError, ValueError):
        return _Failure("parse", "its output is not JSON")
    if not isinstance(data, dict) or not (data.get("streams") or []):
        return _Failure("no-stream", "no video stream")
    return data


def _ffprobe(path: str, *, run: Optional[Callable] = None, sleep: Optional[Callable] = None,
             exists: Optional[Callable] = None, timeout: Optional[float] = None) -> Probe:
    """One ffprobe of the first video stream, uncached. A file that is not
    there gives FAILED_PROBE. A file that IS there and cannot be probed raises
    ProbeError; a timeout, a kill or a spawn failure under load (EAGAIN, ENOMEM,
    EMFILE, ENFILE) is tried once more first, after a short backoff. No ffprobe
    at all (ENOENT) raises at once, whatever the path: otherwise every clip
    would probe as "not there". `run` (subprocess.run), `sleep` (time.sleep),
    `exists` (os.path.exists) and `timeout` (PROBE_TIMEOUT_S) are for tests.
    Twin of probeMedia in sdr-layer.js."""
    run = run or subprocess.run
    sleep = sleep or time.sleep
    exists = exists or os.path.exists
    timeout = PROBE_TIMEOUT_S if timeout is None else timeout
    attempt = 1
    while True:
        data = _probe_once(path, run, timeout)
        if not isinstance(data, _Failure):
            break
        if data.hard:
            raise ProbeError(path, data.reason, data.detail, errno=data.errno)
        # Re-checked after the failure: a file can vanish while it is probed.
        if not exists(path):
            return FAILED_PROBE
        if not data.transient or attempt >= _PROBE_ATTEMPTS:
            raise ProbeError(path, data.reason,
                             f"{data.detail}, {attempt} tries" if attempt > 1 else data.detail,
                             errno=data.errno)
        sleep(_RETRY_BACKOFF_S)
        attempt += 1

    s = data["streams"][0]
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


def probe_media(path, *, run: Optional[Callable] = None, sleep: Optional[Callable] = None,
                exists: Optional[Callable] = None, timeout: Optional[float] = None) -> Probe:
    """The real probe, cached in-process by (realpath, mtime). A missing path
    (or None) is FAILED_PROBE; an existing file that cannot be probed raises
    ProbeError (see _ffprobe, which the keyword arguments go to), and is
    probed afresh next time."""
    try:
        real = os.path.realpath(path)
        mtime = os.stat(real).st_mtime_ns
    except (OSError, TypeError, ValueError):
        return FAILED_PROBE
    key = (real, mtime)
    hit = _CACHE.get(key)
    if hit is not None:
        return hit
    opts = {k: v for k, v in (("run", run), ("sleep", sleep), ("exists", exists), ("timeout", timeout))
            if v is not None}
    # The caller's spelling, so a ProbeError names the file the caller asked about.
    result = _ffprobe(os.fspath(path), **opts)
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
    default to probe_media and os.path.exists; tests inject fakes.

    A ProbeError, of `path` or of the original, propagates: any Origin returned
    for a file that could not be read would be a guess, and it picks a grade
    (an unreadable SDR original falls through to "HDR, graded")."""
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
    original with no tonemap; otherwise `src`, tonemapped when its origin is HDR.
    A ProbeError propagates (see origin_of): a proxy graded on a guess is kept
    until its source changes, because proxies are fresh by mtime alone."""
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
#
# A file that exists and cannot be read (ProbeError, or a thumbnail ffmpeg could
# not decode) is an unknown, never an answer (PV57). Neither pass acts on it: it
# is left as it is, listed in `probeFailed`, and looked at again on the next
# call. The legacy pass is not recorded as done while a file that could change
# its answer could not be read, or a transient failure would keep that clip
# wrong for good. An unreadable pool file that cannot change it (newer than the
# candidate, or ranked below the match found) is listed and does not hold the
# pass back, or one damaged file would stop the heal for good.

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


def _warm(path) -> None:
    try:
        probe_media(path)
    except ProbeError:
        pass  # only a cache warmer: the real call probes again and decides what a failure means


def _prefetch(paths) -> None:
    """Warm the probe cache for `paths` a few at a time (one ffprobe each).
    Never raises ProbeError."""
    paths = sorted({p for p in paths if isinstance(p, str)})
    if len(paths) < 2:
        for p in paths:
            _warm(p)
        return
    with ThreadPoolExecutor(max_workers=min(8, len(paths))) as pool:
        list(pool.map(_warm, paths))


class _HealProbe:
    """probe_media for one heal. A file whose probe raised is not probed again
    in the same call (a stalled volume costs two 30 s tries per look); the next
    call starts afresh, because failures are never cached."""

    def __init__(self):
        self.failed: dict = {}  # realpath -> ProbeError

    def __call__(self, path) -> Probe:
        key = os.path.realpath(path) if isinstance(path, str) else path
        if key in self.failed:
            raise self.failed[key]
        try:
            return probe_media(path)
        except ProbeError as e:
            self.failed[key] = e
            raise

    def warm(self, paths) -> None:
        """Prefetch through `self`, not probe_media directly (PV57 review):
        each failure lands in self.failed here, so the real probe that
        follows later in this same heal finds it cached and does not try
        again. Warming through probe_media instead (the old bug) filled the
        process cache without recording the failure anywhere this heal could
        see, so the first real call paid for the retry a second time — 4
        ffprobe attempts per unreadable file per heal instead of 2."""
        def _try(path) -> None:
            try:
                self(path)
            except ProbeError:
                pass  # recorded in self.failed; nothing else to do here

        paths = [p for p in paths if isinstance(p, str) and os.path.realpath(p) not in self.failed]
        if len(paths) < 2:
            for p in paths:
                _try(p)
            return
        with ThreadPoolExecutor(max_workers=min(8, len(paths))) as pool:
            list(pool.map(_try, paths))


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


def legacy_pool(project_dir, sources_srcs=(), *, exclude=(), probe: Optional[Callable] = None,
                on_probe_error: Optional[Callable] = None) -> list:
    """The SDR files a legacy conversion could have been made from: every
    `sources[].src`, then the top-level .mp4/.mov/.m4v files of the project
    folder (any case), minus montaj's own artifacts (proxies, nobg, audioclean,
    normalized) and `exclude` (the candidates), one entry per file (realpath),
    keeping only what probes SDR.

    A file whose probe raises ProbeError may be the original, so a pool without
    it is incomplete: the error propagates, unless `on_probe_error(path, error)`
    is given, in which case the file is left out and the caller owns knowing
    that the pool is incomplete (_plan hands those files to
    match_legacy_conversion as `unread`)."""
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
    elif isinstance(probe, _HealProbe):
        probe.warm(kept)
    out = []
    for path in kept:
        try:
            p = probe(path)
        except ProbeError as e:
            if on_probe_error is None:
                raise
            on_probe_error(path, e)
            continue
        if p.width and p.transfer in SDR_TRANSFERS:
            out.append(path)
    return out


def match_legacy_conversion(candidate: str, pool, *, sources=(), probe: Optional[Callable] = None,
                            thumbnails: Optional[Callable] = None, unread: Optional[dict] = None) -> dict:
    """Which file in `pool` `candidate` (an ffmpeg-written HDR file) was
    converted from, under the legacy stretch. `sources` holds the realpaths of
    the project's `sources[].src` (a tiebreak). `unread` maps pool files that
    legacy_pool could not probe to their ProbeError.

    Per pool file, the first guard that rejects it: `mtime` (newer than the
    candidate: a conversion is made from an original that already exists),
    `fingerprint` (same_fingerprint), `unreadable` (its probe raised
    ProbeError, or ffmpeg could not read a thumbnail of it or of the candidate),
    `std-dev floor` (fewer than CONTENT_MIN_STD_COUNT candidate thumbnails reach
    CONTENT_MIN_STD), or `content` (a mean abs over CONTENT_MAX_MEAN_ABS at any
    point). Returns {src, encoder, rejected, original, deferred, thumbStd,
    pool: [{path, rejected, meanAbs}], unreadable: [{path, reason, detail, blocking}]}.

    Every file that could not be read is in `unreadable`; `blocking` says
    whether it could change the answer (see _legacy_rank). `original` is the
    match only when none could; otherwise the match is in `deferred`, and with
    no match at all a blocking file means "no match" is not final either.

    A ProbeError of the candidate itself propagates: there is nothing to match."""
    probe = probe or probe_media
    thumbnails = thumbnails or _thumbnails
    c = probe(candidate)
    key = detect_from_transfer(c.transfer)
    entry = {"src": candidate, "encoder": c.encoder, "rejected": None, "original": None, "deferred": None,
             "thumbStd": None, "pool": [], "unreadable": []}
    c_mtime = _mtime_ns(candidate)
    times = [c.duration * f for f in THUMB_POINTS] if c.duration else []
    cand = None  # candidate planes: read once, and only when a pool file gets that far
    stds: list = []
    matches = []
    rows_unread: list = []  # (row, {path, reason, detail}): rows that passed the mtime guard

    def too_new(path) -> bool:
        m = _mtime_ns(path)
        return c_mtime is None or m is None or m > c_mtime

    def unreadable(row, path, reason, detail, probe_errno=None):
        # Not a mismatch: the pool file may be the original. Neither matched nor ruled out.
        row["rejected"] = "unreadable"
        rows_unread.append((row, {"path": path, "reason": reason, "detail": detail, "errno": probe_errno}))

    for path, e in (unread or {}).items():
        row = {"path": path, "rejected": None, "meanAbs": None}
        entry["pool"].append(row)
        if too_new(path):
            # Stat-only: a file newer than the candidate is never its original,
            # so not being able to read it changes nothing.
            row["rejected"] = "mtime"
            entry["unreadable"].append({"path": path, "reason": e.reason, "detail": e.detail,
                                        "errno": e.errno, "blocking": False})
        else:
            unreadable(row, path, e.reason, e.detail, e.errno)

    for path in pool:
        row = {"path": path, "rejected": None, "meanAbs": None}
        entry["pool"].append(row)
        if too_new(path):
            row["rejected"] = "mtime"
            continue
        try:
            p = probe(path)
        except ProbeError as e:
            unreadable(row, path, e.reason, e.detail, e.errno)
            continue
        if not same_fingerprint(c, p):
            row["rejected"] = "fingerprint"
            continue
        if cand is None:
            cand = (thumbnails(candidate, times) or []) if times else []
            stds = [_std(t) for t in cand]
            entry["thumbStd"] = [round(v, 1) for v in stds] if stds else None
        if times and not cand:
            unreadable(row, candidate, "thumbnail", "ffmpeg could not read a frame")
            continue
        planes = thumbnails(path, times, legacy_stretch_vf(key, untagged=p.transfer == "unknown")) \
            if cand else None
        if cand and not planes:
            unreadable(row, path, "thumbnail", "ffmpeg could not read a frame")
            continue
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

    sources_real = set(sources)
    best = min(matches, key=lambda p: _legacy_rank(candidate, key, sources_real, p)) if matches else None
    for row, u in rows_unread:
        # An unreadable pool file can change the answer only when its reason
        # is worth waiting on (not PERMANENT_PROBE_REASONS — the file may read
        # differently next time; this also covers 'thumbnail', a decode
        # failure from below, which is not one of ProbeError's six reasons and
        # so is never PERMANENT) AND it passes the mtime guard (every row here
        # did) AND outranks the match. mtime and rank are stat-only, so this is
        # decided without reading the file. A PERMANENT reason (no-stream,
        # exit, parse) never blocks: the next look gives the same unreadable
        # answer, so deferring on one — a music bed that can never be a
        # video's original, or a corrupt file — would stall the heal for as
        # long as it stays that way, which is forever (PV57 review). With no
        # match, any non-PERMANENT-reason file may be the match.
        blocking = u["reason"] not in PERMANENT_PROBE_REASONS and (
            best is None or
            _legacy_rank(candidate, key, sources_real, row["path"]) < _legacy_rank(candidate, key, sources_real, best)
        )
        seen = next((x for x in entry["unreadable"] if (x["path"], x["reason"]) == (u["path"], u["reason"])), None)
        if seen is None:
            entry["unreadable"].append({**u, "blocking": blocking})
        else:
            seen["blocking"] = seen["blocking"] or blocking
    if best is not None:
        if any(u["blocking"] for u in entry["unreadable"]):
            entry["deferred"] = best  # what a full read may yet overturn; the caller retries
        else:
            entry["original"] = best  # provably what a full read would give
    return entry


def _stem(path: str) -> str:
    return os.path.splitext(os.path.basename(path))[0]


def _legacy_rank(candidate: str, color_space: str, sources_real, path: str) -> tuple:
    """Where `path` ranks as the original of `candidate` among its content
    matches, lowest first. `color_space` is the candidate's; `sources_real` the
    realpaths of the project's `sources[].src`.

    Stat-only on purpose: names, sources membership and mtime, never a probe or
    a frame. So a pool file that cannot be read can still be ranked, and
    whether it could change the answer is decided without reading it (PV57)."""
    stem = _stem(path)
    return (
        # 1. the candidate is named `<pool stem>_normalized_<cs>.mp4`
        os.path.basename(candidate) != f"{stem}_normalized_{color_space}.mp4",
        # 2. the shortest pool stem the candidate's stem starts with
        (0, len(stem)) if _stem(candidate).startswith(stem) else (1, 0),
        # 3. a pool file that is some sources[].src
        os.path.realpath(path) not in sources_real,
        # 4. the oldest mtime
        _mtime_ns(path) or 0,
        path,
    )


def _fresh_proxy(original: str) -> Optional[str]:
    from lib.proxy import is_proxy_fresh, proxy_path_for

    real = os.path.realpath(original)
    out = proxy_path_for(real)
    return out if is_proxy_fresh(out, real) else None


def _new_result(project_dir) -> dict:
    return {
        "projectDir": str(project_dir), "colorSpace": None, "skipped": None, "error": None,
        "legacyPass": False, "switched": [], "dropped": [], "candidates": [], "kept": [],
        "probeFailed": [], "settings": {}, "edits": [], "proxiesOwed": [], "log": [], "written": False,
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
    probe = _HealProbe()
    probe.warm({it["src"] for it in items if _is_file(it["src"])}
              | {it["normalizedSrc"] for it in items if _is_file(it.get("normalizedSrc"))})
    proxies_enabled = settings.get("proxy") is not False

    edits: dict = {}      # (id, src) -> {field: value}; `src` always last
    switched: dict = {}   # (id, src) -> original
    dropped: set = set()
    unread: set = set()   # (id, src) the marker pass could not read: left as they are

    def failed(pass_name: str, path: str, reason: str, detail: str, item=None, src=None,
               blocking: bool = True, probe_errno: Optional[int] = None) -> None:
        # blocking: whether something was left as it is because of this file.
        # message/retryable (PV57 review): the same shape serve.routes.steps's
        # probe_failed_body gives the "proxies" entries under the same
        # `event: probe-failed`, so a listener sees one payload shape
        # whichever pass reported it. Rebuilding a ProbeError here (never
        # raised) is the one place that reuses its message text and
        # is_probe_retryable, rather than a second, drifting copy of either.
        e = ProbeError(path, reason, detail, probe_errno)
        f = {"pass": pass_name, "id": item.get("id") if item else None,
             "src": item["src"] if item else src, "path": path, "reason": reason, "detail": detail,
             "message": str(e), "retryable": is_probe_retryable(e), "blocking": blocking}
        if f not in result["probeFailed"]:
            result["probeFailed"].append(f)

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
        if not _is_file(src):
            continue
        try:
            if is_hdr(detect_from_transfer(probe(src).transfer)):
                origin = origin_of(src, probe=probe)
                if origin.original:
                    switch(item, origin.original, "marker")
        except ProbeError as e:
            # Unknown (the clip or its original): switching and keeping would
            # each pick a grade. Leave the item as it is; the next call retries.
            unread.add((item.get("id"), src))
            failed("marker", e.path, e.reason, e.detail, item, probe_errno=e.errno)
    for item in items:
        key = (item.get("id"), item["src"])
        cache = item.get("normalizedSrc")
        if key in switched or key in dropped or key in unread \
                or not isinstance(cache, str) or not os.path.isabs(cache):
            continue
        reason = None
        if not os.path.exists(cache):
            reason = "missing"  # render's validateProjectFiles checks only src
        else:
            try:
                comment = probe(cache).comment
            except ProbeError as e:
                # Unknown: its marker may or may not name `src`, so it is not
                # dropped on a guess. Kept as it is; the next call looks again.
                failed("normalizedSrc", e.path, e.reason, e.detail, item, probe_errno=e.errno)
                continue
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
        # Set when a file that could change the pass's answer could not be read.
        # The pass is then not recorded as done, so it runs again on the next
        # call: recording it would leave a clip that failed a transient probe
        # unhealed for good.
        unfinished = False
        by_real: dict = {}
        for item in items:
            if (item.get("id"), item["src"]) in switched or item.get("normalizedSrc") or not _is_file(item["src"]):
                continue
            by_real.setdefault(os.path.realpath(item["src"]), item["src"])
        candidates = []
        for src in by_real.values():
            try:
                p = probe(src)
            except ProbeError as e:
                # TRANSIENT: unknown, it may be a legacy conversion — skipped
                # this call, and the pass stays unfinished so the next call
                # looks again. PERMANENT (no video stream, ffprobe's own
                # error, or unparseable output): the file's own content is
                # what's wrong, so it can never be a legacy-converted video
                # either — not a candidate, and the heal is final for it, not
                # unfinished (PV57 review).
                if e.reason in TRANSIENT_PROBE_REASONS:
                    unfinished = True
                failed("legacy", e.path, e.reason, e.detail, src=src,
                      blocking=e.reason in TRANSIENT_PROBE_REASONS, probe_errno=e.errno)
                continue
            if not is_hdr(detect_from_transfer(p.transfer)):
                continue
            reject = None
            if p.comment.startswith(SDR_ORIGIN_MARKER):
                reject = "marker"  # made by PV42's normalize: the marker pass owns it
            elif not p.encoder.startswith(LEGACY_ENCODER_PREFIX):
                reject = "encoder"
            if reject:
                result["candidates"].append({"src": src, "encoder": p.encoder, "rejected": reject,
                                             "original": None, "deferred": None, "thumbStd": None,
                                             "pool": [], "unreadable": []})
            else:
                candidates.append(src)
        if candidates:
            sources_srcs = [s["src"] for s in project.get("sources") or []
                            if isinstance(s, dict) and isinstance(s.get("src"), str)]
            # Pool files that could not be probed: whether each one matters is
            # per candidate (match_legacy_conversion's `blocking`).
            pool_unread: dict = {}
            pool = legacy_pool(project_dir, sources_srcs, exclude=candidates, probe=probe,
                               on_probe_error=pool_unread.__setitem__)
            sources_real = {os.path.realpath(s) for s in sources_srcs if _is_file(s)}
            for src in candidates:
                try:
                    entry = match_legacy_conversion(src, pool, sources=sources_real, probe=probe,
                                                    unread=pool_unread)
                except ProbeError as e:
                    # The candidate itself (not a pool file) could not be
                    # read. TRANSIENT keeps the pass open for a retry;
                    # PERMANENT (its own content is what's wrong) makes the
                    # heal final for this candidate, not unfinished (PV57
                    # review): the next call would read the same failure.
                    if e.reason in TRANSIENT_PROBE_REASONS:
                        unfinished = True
                    failed("legacy", e.path, e.reason, e.detail, src=src,
                          blocking=e.reason in TRANSIENT_PROBE_REASONS, probe_errno=e.errno)
                    continue
                result["candidates"].append(entry)
                for u in entry["unreadable"]:
                    failed("legacy", u["path"], u["reason"], u["detail"], src=src, blocking=u["blocking"],
                          probe_errno=u.get("errno"))
                original = entry["original"]
                if not original:
                    # Deferred (a better-ranked file could not be read), or no
                    # match while a file that could have matched was unread: not
                    # final, so the pass runs again. Otherwise "no match" is final.
                    if any(u["blocking"] for u in entry["unreadable"]):
                        unfinished = True
                    else:
                        result["kept"].append(os.path.basename(src))
                    continue
                # Keep the folder spelled the way the candidate spells it.
                if os.path.realpath(os.path.dirname(original)) == os.path.realpath(os.path.dirname(src)):
                    original = os.path.join(os.path.dirname(src), os.path.basename(original))
                real = os.path.realpath(src)
                for item in items:
                    if _is_file(item["src"]) and os.path.realpath(item["src"]) == real:
                        switch(item, original, "legacy")
            listed = {f["path"] for f in result["probeFailed"]}
            for path, e in pool_unread.items():
                # Reached only when every candidate's own probe ALSO failed
                # (so none of them ever got to attribute this pool file's
                # failure to itself, above): which candidate this pool file
                # would have mattered for is genuinely unknown, so `src` is
                # null here — the one place a probeFailed entry's `src` can
                # be (PV57 review nit: documented, not just left null).
                if path not in listed:
                    failed("legacy", e.path, e.reason, e.detail, blocking=False, probe_errno=e.errno)
        if not unfinished:
            result["settings"][PROVENANCE_KEY] = PROVENANCE_VERSION
        if result["kept"]:
            line = (f"colour provenance: no SDR original matched {len(result['kept'])} "
                    f"ffmpeg-written HDR clip(s): {', '.join(result['kept'])}")
            result["log"].append(line)
            progress(line)

    if result["probeFailed"]:
        named = list(dict.fromkeys(f"{os.path.basename(f['path'])} ({f['reason']})"
                                   for f in result["probeFailed"]))
        line = f"colour provenance: could not read {len(named)} file(s): {', '.join(named)}"
        if any(f["blocking"] for f in result["probeFailed"]):
            line += ". What depends on them is left as it is until the next look"
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
      legacyPass (whether pass 2 ran; it is recorded as done in `settings`
      only when no file that could change its answer was unreadable),
      switched: [{id, from, to, pass: marker|legacy, proxySrc}],
      dropped: [{id, src, normalizedSrc, reason}],
      candidates: [{src, encoder, rejected (encoder|marker), original, deferred, thumbStd,
                    pool: [{path, rejected (mtime|fingerprint|unreadable|std-dev floor|content),
                            meanAbs}],
                    unreadable: [{path, reason, detail, errno, blocking}]}],
      kept: basenames left as they are (no original), log: lines logged,
      probeFailed: [{pass: marker|normalizedSrc|legacy, id, src, path, reason,
                     detail, message, retryable, blocking}], files that could
                     not be read (ProbeError's reason, or `thumbnail`);
                     `message`/`retryable` are ProbeError's own text and
                     is_probe_retryable, the same shape serve.routes.steps
                     gives a `probe_failed` HTTP error (PV57 review, so
                     `event: probe-failed` is one payload shape whichever pass
                     reported it); `blocking` when something was left as it is
                     because of it — never for a PERMANENT_PROBE_REASONS
                     reason, which the next look would read the same way,
      settings, edits, proxiesOwed: [{id, src, input, out}], written."""
    result = plan_color_provenance(project_dir)
    if result["edits"] or result["settings"]:
        try:
            result["written"] = write_color_provenance(
                Path(project_dir) / "project.json", result["edits"], result["settings"]) is not None
        except Exception as e:
            result["error"] = f"{type(e).__name__}: {e}"
    return result
