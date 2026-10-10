"""Conformed audio cache: every audio source decoded once to 48 kHz stereo PCM.

Cache layout: `<workspace>/.cache/conformed-audio/<key>.pcm` plus `<key>.json`.
`key` = sha1(abs path + size + mtime_ns), so an edited source gets a new key.
A source with no audio stream is recorded as `silent` (json only, no pcm).
The preview mixer reads the pcm by byte range through /api/files.

Capped per workspace (CACHE_MAX_BYTES, least-recently-accessed evicted).
"""
import hashlib
import json
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from lib.common import ffmpeg_bin, ffprobe_bin
from serve.common import resolve_workspace

# Measured 2026-10-09 on a generated 60 s stereo file (pink noise + 2 tones):
# conform time s16le ~0.15 s vs f32le ~0.13 s (equal, within noise); bytes
# 11.52 MB vs 23.04 MB; max abs error of int16 vs float32 after gain 0.11 is
# 3.4e-6 (-109 dBFS), far below the -80 dBFS audibility bar. int16 it is.
FORMAT = "pcm_s16le"
_FFMPEG_FMT = {"pcm_s16le": "s16le", "pcm_f32le": "f32le"}
_BYTES_PER_SAMPLE = {"pcm_s16le": 2, "pcm_f32le": 4}
SAMPLE_RATE = 48000
CHANNELS = 2

CACHE_MAX_BYTES = 2 * 1024 ** 3  # 2 GB per workspace (Sam, 2026-10-09)
MAX_JOBS = 2


def cache_max_bytes() -> int:
    """The cap, read per call so tests can override with MONTAJ_CONFORM_CACHE_BYTES."""
    v = os.environ.get("MONTAJ_CONFORM_CACHE_BYTES")
    try:
        return int(v) if v else CACHE_MAX_BYTES
    except ValueError:
        return CACHE_MAX_BYTES


def cache_dir() -> Path:
    return resolve_workspace() / ".cache" / "conformed-audio"


def key_for(src: Path) -> tuple[str, os.stat_result]:
    st = src.stat()
    raw = f"{src}\0{st.st_size}\0{st.st_mtime_ns}".encode()
    return hashlib.sha1(raw).hexdigest(), st


def _atomic_write_json(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + f".{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(data))
    os.replace(tmp, path)


def _read_meta(d: Path, key: str) -> dict | None:
    try:
        return json.loads((d / f"{key}.json").read_text())
    except (OSError, ValueError):
        return None


_lock = threading.Lock()
_running: dict[str, "object"] = {}   # key -> Future
_failed: dict[str, str] = {}         # key -> error text (memory only; retried on next POST)
_pool = ThreadPoolExecutor(max_workers=MAX_JOBS, thread_name_prefix="audio-conform")


def _has_audio(src: Path) -> bool:
    r = subprocess.run(
        [ffprobe_bin(), "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=index", "-of", "csv=p=0", str(src)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-400:] or "ffprobe failed")
    return bool(r.stdout.strip())


def _conform(src: Path, key: str, st: os.stat_result) -> None:
    d = cache_dir()
    d.mkdir(parents=True, exist_ok=True)
    now = time.time()
    meta = {
        "source": str(src), "size": st.st_size, "mtime_ns": st.st_mtime_ns,
        "sampleRate": SAMPLE_RATE, "channels": CHANNELS,
        "createdAt": now, "lastAccess": now,
    }
    if not _has_audio(src):
        meta.update(format=None, frames=0, bytes=0, silent=True)
        _atomic_write_json(d / f"{key}.json", meta)
        return
    pcm, tmp = d / f"{key}.pcm", d / f"{key}.pcm.tmp"
    try:
        r = subprocess.run(
            [ffmpeg_bin(), "-v", "error", "-y", "-i", str(src), "-map", "0:a:0",
             "-ac", str(CHANNELS), "-ar", str(SAMPLE_RATE),
             "-f", _FFMPEG_FMT[FORMAT], str(tmp)],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip()[-400:] or "ffmpeg failed")
        os.replace(tmp, pcm)
    finally:
        tmp.unlink(missing_ok=True)
    nbytes = pcm.stat().st_size
    meta.update(format=FORMAT, bytes=nbytes,
                frames=nbytes // (CHANNELS * _BYTES_PER_SAMPLE[FORMAT]), silent=False)
    _atomic_write_json(d / f"{key}.json", meta)


def _run_job(src: Path, key: str, st: os.stat_result) -> None:
    try:
        _conform(src, key, st)
        _failed.pop(key, None)
    except Exception as exc:  # noqa: BLE001 - recorded, surfaced as status=failed
        _failed[key] = str(exc)
    finally:
        # Evict BEFORE leaving _running so this job's own entry is protected
        # from the sweep only by being newest; other running jobs are skipped.
        try:
            evict()
        finally:
            with _lock:
                _running.pop(key, None)


def evict(max_bytes: int | None = None) -> list[str]:
    """Delete least-recently-accessed entries until total pcm bytes <= cap.
    Entries with a running job are never deleted. Returns evicted keys."""
    cap = cache_max_bytes() if max_bytes is None else max_bytes
    d = cache_dir()
    if not d.is_dir():
        return []
    with _lock:
        running = set(_running)
    entries = []
    for pcm in d.glob("*.pcm"):
        key = pcm.stem
        try:
            size = pcm.stat().st_size
        except OSError:
            continue
        meta = _read_meta(d, key) or {}
        entries.append((meta.get("lastAccess", 0), key, size))
    total = sum(e[2] for e in entries)
    gone = []
    for _, key, size in sorted(entries):
        if total <= cap:
            break
        if key in running:
            continue
        (d / f"{key}.json").unlink(missing_ok=True)
        (d / f"{key}.pcm").unlink(missing_ok=True)
        total -= size
        gone.append(key)
    return gone


def start(src: Path) -> dict:
    """Start (or join, or reuse) the conform for `src`; return its status."""
    try:
        key, st = key_for(src)
    except OSError:
        return {"status": "missing"}
    d = cache_dir()
    with _lock:
        if key in _running:
            return {"status": "running"}
        meta = _read_meta(d, key)
        if meta and (meta.get("silent") or (d / f"{key}.pcm").is_file()):
            return _from_meta(d, key, meta)
        _failed.pop(key, None)
        _running[key] = _pool.submit(_run_job, src, key, st)
    return {"status": "running"}


def _url(pcm: Path) -> str:
    from urllib.parse import quote
    return "/api/files?path=" + quote(str(pcm), safe="/")


def _from_meta(d: Path, key: str, meta: dict) -> dict:
    if meta.get("silent"):
        return {"status": "silent", "url": None, "format": None,
                "sampleRate": SAMPLE_RATE, "channels": CHANNELS, "frames": 0, "bytes": 0}
    return {"status": "ready", "url": _url(d / f"{key}.pcm"), "format": meta["format"],
            "sampleRate": meta["sampleRate"], "channels": meta["channels"],
            "frames": meta["frames"], "bytes": meta["bytes"]}


def lookup(src: Path) -> dict:
    """Status of the conform for `src`. Never starts a job. A hit updates lastAccess."""
    try:
        key, _ = key_for(src)
    except OSError:
        return {"status": "missing"}
    d = cache_dir()
    with _lock:
        if key in _running:
            return {"status": "running"}
    meta = _read_meta(d, key)
    if meta and (meta.get("silent") or (d / f"{key}.pcm").is_file()):
        meta["lastAccess"] = time.time()
        try:
            _atomic_write_json(d / f"{key}.json", meta)
        except OSError:
            pass
        return _from_meta(d, key, meta)
    if key in _failed:
        return {"status": "failed", "error": _failed[key]}
    return {"status": "missing"}
