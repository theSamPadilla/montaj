#!/usr/bin/env python3
"""Editing proxy encode primitive — full-source, all-intra, 720p AV1+Opus.

Every imported video gets a lightweight "editing copy" for instant scrubbing
in the editor preview: hardware-decoded, scaled to 720p on its short side,
encoded all-intra (GOP=1) so any frame seeks instantly, AV1+Opus for size.
Render never touches proxies — this module only ever produces a preview-track
artifact (``proxySrc`` on the project item), never anything render reads.

Two arms, selected by the caller via `tonemap`:
  - Eager (``tonemap=False``): source is already an SDR master (post-
    normalize.py conform pass) — plain scale, no color conversion.
  - Lazy (``tonemap=True``): source is the original HDR file — scale is
    composed AHEAD of the HDR→SDR tonemap chain (SP1's scale-first finding:
    tonemapping a smaller frame is faster and produces the same result).

Reuses lib/normalize.py's tonemap filter builder and atomic-write/temp-file
machinery rather than reinventing either.
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))  # add lib/ so `from common` works in all invocation modes
from common import ffmpeg_bin, get_duration, progress

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))  # add repo root so `from lib.types.colorspace` works
from lib.normalize import _build_tonemap_vf_to_sdr, _run_atomic_encode, _sweep_stale_temps, _tmp_for
from lib.types.colorspace import detect_from_transfer

PROXY_LOOK = "hable1"
"""Look-version tag stamped into every proxy filename. Bumping this (e.g. when
Montaj Vivid ships) changes the filename, so is_proxy_fresh() naturally treats
every existing proxy as stale and regenerates it under the new look — no
migration step needed. When bumping: APPEND the old tag to
cli/commands/clean.py's KNOWN_LOOKS so the previous look's files stay
cleanable (clean only deletes known-tagged files, SP3 fix S5)."""


def _workspace_root() -> str:
    """Global workspace root: MONTAJ_WORKSPACE_DIR env var > ~/.montaj/config.json's
    workspaceDir > ~/Montaj. Mirrors project/init.py / cli/commands/clean.py's
    resolution (duplicated per existing precedent — no shared helper importable
    from lib/ without a circular pull)."""
    env = os.environ.get("MONTAJ_WORKSPACE_DIR")
    if env:
        return env
    config_path = os.path.join(os.path.expanduser("~"), ".montaj", "config.json")
    if os.path.isfile(config_path):
        try:
            cfg = json.loads(open(config_path).read())
            if "workspaceDir" in cfg:
                return cfg["workspaceDir"]
        except Exception:
            pass
    return os.path.join(os.path.expanduser("~"), "Montaj")


def proxy_path_for(src: str) -> str:
    """Proxy path for `src`: ``<stem>_proxy_<PROXY_LOOK>.mp4``.

    Placement (SP3 fix S7):
      - Sources under the workspace root (project dirs, ``.sources/<id>/``
        shared lazy originals): the proxy is a SIBLING of the source — one
        proxy beside ``~/Montaj/.sources/<id>/original.mov`` serves every
        child clip derived from it.
      - Sources OUTSIDE the workspace (ad-hoc ``--clips <path> --symlink-clips``
        against a user's own footage folder): the proxy must NOT litter the
        user's footage directory, and must stay findable by
        ``montaj clean --proxies``. It goes to
        ``<workspace>/.sources/_proxycache/<realpath-sha1[:16]>/<name>`` —
        inside ``.sources/``, which clean always scans.

    The realpath hash keys the cache dir, so two different outside files with
    the same basename never collide, and the same file always maps to the same
    proxy regardless of which symlink reached it.
    """
    real = os.path.realpath(src)
    head, tail = os.path.split(real)
    name = f"{tail.rsplit('.', 1)[0]}_proxy_{PROXY_LOOK}.mp4"

    ws_real = os.path.realpath(_workspace_root())
    if head == ws_real or head.startswith(ws_real + os.sep):
        return os.path.join(head, name)

    digest = hashlib.sha1(real.encode("utf-8")).hexdigest()[:16]
    return os.path.join(ws_real, ".sources", "_proxycache", digest, name)


def is_proxy_fresh(proxy: str, src: str) -> bool:
    """True if `proxy` exists and is at least as new as `src` (mtime-invalidation,
    the repo's existing cache-freshness precedent).

    Concurrent children of the same shared lazy source may both find this
    False and both encode; the loser of the race writes to its own
    per-pid temp and `os.replace`s onto the same path — safe by construction
    (see `_run_atomic_encode`).
    """
    if not os.path.isfile(proxy):
        return False
    return os.path.getmtime(proxy) >= os.path.getmtime(src)


def _build_proxy_cmd(input_path: str, out_path: str, *, tonemap: bool, info: dict) -> tuple[list, bool]:
    """Build the ffmpeg command for the av1-crf35-fast proxy encode.

    `tonemap=True` composes the scale filter AHEAD of
    `_build_tonemap_vf_to_sdr()`'s zscale chain (scale-first ordering).
    `tonemap=False` is a plain scale — the source is already SDR.

    Returns (cmd, used_fallback_tonemap) — used_fallback_tonemap is True only
    when the tonemap arm ran without zscale (degraded color path; caller
    warns loudly, mirroring normalize()'s fallback warning).
    """
    scale = "scale='if(gt(iw,ih),-2,720)':'if(gt(iw,ih),720,-2)'"

    used_fallback_tonemap = False
    if tonemap:
        source_color_space = detect_from_transfer(info.get("color_transfer"))
        tonemap_vf, used_fallback_tonemap = _build_tonemap_vf_to_sdr(source_color_space)
        vf = f"{scale},{tonemap_vf},format=yuv420p"
    else:
        vf = scale

    cmd = [
        ffmpeg_bin(), "-y",
        # "auto" (not "videotoolbox") so the encode works on Linux/CI where
        # videotoolbox isn't compiled in; ffmpeg still selects videotoolbox on
        # macOS and falls back to software elsewhere.
        "-hwaccel", "auto",
        "-i", input_path,
    ]
    if not info.get("has_audio", True):
        cmd += ["-f", "lavfi", "-i", "anullsrc=cl=stereo:r=48000", "-shortest"]
    cmd += [
        "-vf", vf,
        "-c:v", "libsvtav1", "-crf", "35", "-preset", "8", "-g", "1",
        "-c:a", "libopus", "-b:a", "96k",
        "-movflags", "+faststart",
        out_path,
    ]

    return cmd, used_fallback_tonemap


def _source_duration(src: str, info: dict) -> float:
    """Source duration in seconds, for timeout sizing.

    `info` (probe_video()'s dict) doesn't carry duration in its standard
    shape, so this probes it fresh unless a caller has already attached one.
    """
    duration = info.get("duration")
    if duration is not None:
        return float(duration)
    return get_duration(src)


def make_proxy(src: str, out: str, *, tonemap: bool, info: dict) -> str:
    """Encode the full-source editing proxy for `src` to `out`.

    `tonemap`: False for an already-SDR master (eager path, no second color
    decision); True for an HDR original (lazy path, scale-first tonemap).
    `info`: ffprobe info dict (probe_video()'s shape) — used for has_audio
    (silent-source handling) and color_transfer (tonemap arm only).

    Writes atomically (per-pid temp + os.replace, via normalize.py's
    machinery) so a killed/timed-out encode never poisons `out`. Timeout
    scales with source duration: `max(900, duration * 2)`.

    Returns `out` on success; raises SystemExit (via fail()) on ffmpeg error.
    """
    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    _sweep_stale_temps(out)
    tmp_path = _tmp_for(out)

    cmd, used_fallback_tonemap = _build_proxy_cmd(src, tmp_path, tonemap=tonemap, info=info)

    if used_fallback_tonemap:
        progress("⚠⚠⚠ WARNING: zscale filter NOT AVAILABLE — falling back to bare tonemap ⚠⚠⚠")
        progress("Proxy HDR→SDR colors WILL be less accurate (washed out highlights, shifted colors).")
        progress("To fix: run `montaj doctor` for instructions on installing libzimg.")

    progress(f"Encoding proxy for {src}: av1-crf35-fast ({PROXY_LOOK})")

    timeout = max(900, _source_duration(src, info) * 2)
    _run_atomic_encode(cmd, tmp_path, out, label="ffmpeg proxy", timeout=timeout)

    if used_fallback_tonemap:
        progress("⚠⚠⚠ FALLBACK TONEMAP WAS USED — PROXY COLORS ARE DEGRADED ⚠⚠⚠")
        progress(f"File: {out}")
        progress("Re-encode after installing zscale for accurate proxy colors.")

    return out
