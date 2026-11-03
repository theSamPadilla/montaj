"""The export mix's loudness, for the editor preview (§660).

The export levels its final mix with one loudnorm to `settings.loudness`. The
editor preview plays the same mix and levels it with a static master gain of
`target - inputI`, so it needs `inputI`: the mix's integrated loudness, which
render/mix-loudness.js measures through the export's own graph.

`start(project_dir)` answers at once: `off` (no target), `ready`/`silent` from
the cache, `failed`, or `running` while the one job a project may have at a time
runs in the background. The caller asks again (the same POST) until it settles.

The cache is in memory, keyed by `cache_key`: the parts of project.json that
change the mix, plus each source's path, size and mtime, so the same mix
answers instantly and any change to it measures again.
"""
import hashlib
import json
import logging
import re
import shutil
import subprocess
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from cli.deps import render_runtime_dir
from lib.common import node_child_env
from lib.speech_set import members, speech_set, write_speech_set
from lib.proc import detached_kwargs, kill_tree
from serve.audio_conform import _low_priority
from serve.common import MONTAJ_ROOT

# Bump when the measurement changes, so an older answer is never reused.
MEASURE_VERSION = 2
# A measurement decodes every clip and lane once (far faster than real time);
# past this it is killed, process tree and all, and answers `failed`.
JOB_TIMEOUT_S = 300
MAX_JOBS = 2                # projects measured at once; each runs one job at a time
CACHE_MAX_ENTRIES = 256     # answers kept, least recently used dropped
FAILED_RETRY_S = 60         # a failed mix is measured again after this

_log = logging.getLogger(__name__)

# Clip and lane fields that change what the mix sounds like: where a source is
# read from and when, plus anything named for level, mute, fades, speed,
# ducking or transitions (a crossfade shapes the clips' audio too).
_ITEM_FIELDS = {"type", "src", "nobg_src", "normalizedSrc", "normalizedInPoint", "remove_bg",
                "start", "end", "inPoint", "outPoint"}
_AUDIO_FIELD = re.compile(r"volume|mute|fade|speed|duck|crossfade|transition|audio|enabled", re.I)
_SRC_FIELDS = ("src", "nobg_src", "normalizedSrc")


_LEVEL_FIELD = re.compile(r"volume|gain", re.I)


def _unity(entry):
    """`entry` without its level fields: with no speech the whole mix is measured at unity
    (render/mix-loudness.js), so a fader is not part of what is measured. Mutes, fades and
    timing stay."""
    if not isinstance(entry, dict):
        return entry
    return {k: v for k, v in entry.items() if not _LEVEL_FIELD.search(k)}


def _item_view(item, unity=False):
    if not isinstance(item, dict):
        return item
    if item.get("type") in ("video", "image"):
        view = {k: v for k, v in item.items() if k in _ITEM_FIELDS or _AUDIO_FIELD.search(k)}
        return _unity(view) if unity else view
    # Overlays and captions carry no sound, but where they sit sets the
    # timeline the clips are cut on and how long the mix runs.
    return {k: item.get(k) for k in ("type", "start", "end")}


def _track_view(track, unity=False):
    if isinstance(track, list):  # the legacy shape: a bare list of items
        return {"items": [_item_view(i, unity) for i in track]}
    if not isinstance(track, dict):
        return track
    view = {k: v for k, v in track.items() if k != "items" and _AUDIO_FIELD.search(k)}
    if unity:
        view = _unity(view)
    view["items"] = [_item_view(i, unity) for i in track.get("items") or []]
    return view


def _source_paths(project: dict) -> list[str]:
    paths = []
    for track in project.get("tracks") or []:
        items = track if isinstance(track, list) else (track.get("items") if isinstance(track, dict) else None)
        for item in items or []:
            if isinstance(item, dict) and item.get("type") in ("video", "image"):
                paths += [item[f] for f in _SRC_FIELDS if isinstance(item.get(f), str)]
    for lane in ((project.get("audio") or {}).get("tracks") or []):
        if isinstance(lane, dict) and isinstance(lane.get("src"), str):
            paths.append(lane["src"])
    return paths


def _stat(path: str, project_dir: Path):
    p = Path(path)
    p = p if p.is_absolute() else project_dir / p
    try:
        st = p.stat()
    except OSError:
        return [str(p), None, None]
    return [str(p), st.st_size, st.st_mtime_ns]


_TIMING = ("start", "end", "inPoint", "outPoint")


def _partners(tracks, ti, ii, item):
    """Timing of the same-track items overlapping a speech clip: a crossfade shapes its audio."""
    track = tracks[ti]
    items = track if isinstance(track, list) else (track.get("items") if isinstance(track, dict) else None)
    a, b = item.get("start"), item.get("end")
    out = []
    for j, other in enumerate(items or []):
        if j == ii or not isinstance(other, dict):
            continue
        s, e = other.get("start"), other.get("end")
        if all(isinstance(x, (int, float)) for x in (a, b, s, e)) and s < b and a < e:
            out.append([j, {k: other.get(k) for k in _TIMING}])
    return out


def _speech_key_view(project: dict, project_dir: Path, sset: dict, found) -> dict:
    """What changes the speech bus, and nothing else (§697): a non-speech lane's or
    clip's volume, mute, fade or src is level the master gain never re-measures."""
    clips, lanes = found
    tracks = project.get("tracks") or []
    stats = set()
    for src in sset["srcs"]:
        stats.add(tuple(_stat(src, project_dir)))
        stats.add(tuple(_stat(str(Path(src).with_suffix(".json")), project_dir)))
    return {
        "set": sset,
        "clips": [[ti, ii, _item_view(item) if item.get("type") == "video" else item, _track_view({**tracks[ti], "items": []})
                   if isinstance(tracks[ti], dict) else None] for ti, ii, item in clips],
        "partners": [[ti, ii, _partners(tracks, ti, ii, item)] for ti, ii, item in clips],
        "lanes": lanes,
        "stats": sorted(stats, key=str),
    }


def cache_key(project: dict, project_dir: Path) -> str:
    """A key over everything that changes the loudness measured, and nothing else.

    With speech, only the speech bus counts; without, the whole mix."""
    settings = project.get("settings") or {}
    found = members(project, project_dir)  # once: every sidecar check is behind it
    sset = speech_set(project, project_dir, found)
    if sset["srcs"]:
        view = {
            "v": MEASURE_VERSION,
            "settings": {"loudness": settings.get("loudness"), "fps": settings.get("fps")},
            "speech": _speech_key_view(project, project_dir, sset, found),
        }
        return hashlib.sha1(json.dumps(view, sort_keys=True, default=str).encode()).hexdigest()
    view = {
        "v": MEASURE_VERSION,
        # fps: the planner cuts the clips on the frame grid.
        "settings": {"loudness": settings.get("loudness"), "fps": settings.get("fps")},
        # unity: no speech measures the whole mix with every volume at 1.0, so no fader is in the key
        "tracks": [_track_view(t, unity=True) for t in project.get("tracks") or []],
        "lanes": [_unity(l) for l in (project.get("audio") or {}).get("tracks") or []],
        "sources": sorted(_stat(p, project_dir) for p in set(_source_paths(project))),
    }
    return hashlib.sha1(json.dumps(view, sort_keys=True, default=str).encode()).hexdigest()


_lock = threading.Lock()
_results: "OrderedDict[str, dict]" = OrderedDict()  # key -> answer
_failed: dict[str, tuple[float, str]] = {}           # key -> (when, error)
_running: dict[str, str] = {}                        # project dir -> key being measured
_pool = ThreadPoolExecutor(max_workers=MAX_JOBS, thread_name_prefix="mix-loudness")


def _answer(result: dict) -> dict:
    status = result.get("status")
    target = result.get("targetI")
    if status == "measured":
        i = result.get("inputI")
        if not isinstance(i, (int, float)) or not isinstance(target, (int, float)):
            return {"status": "failed", "error": "no integrated loudness in the measurement"}
        return {"status": "ready", "inputI": i, "targetI": target, "gainDb": round(target - i, 2),
                "inputTP": result.get("inputTP"), "inputLRA": result.get("inputLRA"),
                **({"basis": result["basis"]} if "basis" in result else {})}
    if status == "silent":
        return {"status": "silent", "targetI": target}
    if status == "off":
        return {"status": "off"}
    return {"status": "failed", "error": f"unexpected measurement: {result!r}"[:400]}


def _measure(project_json: Path) -> dict:
    script = Path(render_runtime_dir()) / "mix-loudness.js"
    node = shutil.which("node")
    if not node or not script.is_file():
        raise RuntimeError("node or mix-loudness.js not found")
    env = node_child_env()
    env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)
    try:
        project = json.loads(project_json.read_text())
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"project.json unreadable: {exc}") from None
    set_file = write_speech_set(project, project_json.parent)
    argv, extra = _low_priority([node, str(script), "--project", str(project_json),
                                 "--speech-set", str(set_file)])
    detach = detached_kwargs()
    if "creationflags" in detach:
        extra["creationflags"] = extra.get("creationflags", 0) | detach.pop("creationflags")
    proc = subprocess.Popen(argv, cwd=str(MONTAJ_ROOT), env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, **extra, **detach)
    try:
        out, err = proc.communicate(timeout=JOB_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        kill_tree(proc)  # its ffmpeg children too
        proc.communicate()
        raise RuntimeError(f"timeout after {JOB_TIMEOUT_S} s") from None
    if proc.returncode != 0:
        raise RuntimeError((err or "").strip()[-400:] or f"exit {proc.returncode}")
    return json.loads(out.strip().splitlines()[-1])


def _key_on_disk(project_dir: Path) -> str | None:
    try:
        return cache_key(json.loads((project_dir / "project.json").read_text()), project_dir)
    except (OSError, ValueError, AttributeError):
        return None


def _run_job(project_dir: Path, key: str) -> None:
    try:
        answer = _answer(_measure(project_dir / "project.json"))
        # The mix changed while it was measured: this answer is of neither
        # version for certain, so it is dropped and the next ask measures again.
        if _key_on_disk(project_dir) != key:
            return
        with _lock:
            if answer["status"] == "failed":
                _failed[key] = (time.time(), answer["error"])
            else:
                _results[key] = answer
                while len(_results) > CACHE_MAX_ENTRIES:
                    _results.popitem(last=False)
    except Exception as exc:  # noqa: BLE001 - recorded, answered as failed
        _log.info("mix loudness of %s failed: %s", project_dir, exc)
        with _lock:
            _failed[key] = (time.time(), str(exc)[:400])
    finally:
        with _lock:
            _running.pop(str(project_dir), None)


def start(project_dir: Path) -> dict:
    """Start (or join, or answer from the cache) the measurement of this project's mix."""
    try:
        project = json.loads((project_dir / "project.json").read_text())
    except (OSError, ValueError) as exc:
        return {"status": "failed", "error": f"project.json unreadable: {exc}"}
    if not isinstance(project, dict):
        return {"status": "failed", "error": "project.json is not an object"}
    if (project.get("settings") or {}).get("loudness") is None:
        return {"status": "off"}
    key = cache_key(project, project_dir)
    with _lock:
        if key in _results:
            _results.move_to_end(key)
            return dict(_results[key])
        if str(project_dir) in _running:
            return {"status": "running"}
        failed = _failed.get(key)
        if failed and time.time() - failed[0] < FAILED_RETRY_S:
            return {"status": "failed", "error": failed[1]}
        _failed.pop(key, None)
        _running[str(project_dir)] = key
        _pool.submit(_run_job, project_dir, key)
    return {"status": "running"}


def _reset() -> None:
    """Tests: forget every answer, after waiting out any job still running."""
    end = time.time() + 120
    while _running and time.time() < end:
        time.sleep(0.05)
    with _lock:
        _results.clear()
        _failed.clear()


def shutdown() -> None:
    """Drop queued measurements so serve's exit does not wait on them."""
    _pool.shutdown(wait=False, cancel_futures=True)
