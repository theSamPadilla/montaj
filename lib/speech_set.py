"""The project's speech: what loudness is measured on (§697).

Loudness normalization is ONE static master gain for the whole program,
`target - I`, where I is the integrated loudness of the SPEECH only when the
project has speech, else of the whole mix. A lane or item volume stays absolute.

Speech is every voiceover lane (`audio.tracks` entries with type "voiceover")
plus every timeline clip (video or audio item) whose source has a transcript
sidecar (`speech_lines.sidecar_for`). A lane with no type is not speech. A muted
lane or item is not speech.

Contract for render.js and mix-loudness.js: both take `--speech-set <file>`.
The file is {"v": 1, "items": [timeline item ids], "positions": [[track index,
item index], ...] (the same clips, by place: an id may repeat across tracks, or be
absent), "lanes": [audio.tracks ids], "srcs": [sorted unique absolute source paths]}.
A clip counts as speech only when its sidecar holds at least one word. A missing flag means the caller
decided nothing (the render falls back to the whole mix); an empty set
(`srcs: []`) means the caller decided there is no speech, so the whole mix is
measured.
"""
import json
import os
from pathlib import Path

from lib.speech_lines import sidecar_for, sidecar_has_words
from lib.speech_units import resolve_path, resolved_item

VERSION = 1
_MEDIA = ("video", "audio")

# sidecar path -> ((size, mtime_ns), has a word): a sidecar is parsed once per version of the file,
# not once per item per key (a 1.5 MB sidecar under 100 cuts cost 2 s a key).
_WORDS: dict[str, tuple[tuple[int, int], bool]] = {}
_WORDS_MAX = 512


def _has_words(path: str) -> bool:
    try:
        st = os.stat(path)
    except OSError:
        return False
    stamp = (st.st_size, st.st_mtime_ns)
    key = os.path.realpath(path)
    hit = _WORDS.get(key)
    if hit and hit[0] == stamp:
        return hit[1]
    ok = sidecar_has_words(path)
    if len(_WORDS) >= _WORDS_MAX:
        _WORDS.clear()
    _WORDS[key] = (stamp, ok)
    return ok


def _muted(entry) -> bool:
    return isinstance(entry, dict) and bool(entry.get("muted") or entry.get("mute"))


def _track_items(track):
    if isinstance(track, list):  # the legacy shape: a bare list of items
        return track
    if isinstance(track, dict):
        return track.get("items") or []
    return []


def members(project: dict, project_dir) -> tuple[list[tuple[int, int, dict]], list[dict]]:
    """((track index, item index, item) of each speech clip, speech lane entries)."""
    clips = []
    for ti, track in enumerate(project.get("tracks") or []):
        if _muted(track):
            continue
        for ii, item in enumerate(_track_items(track)):
            if not isinstance(item, dict) or item.get("type") not in _MEDIA or _muted(item):
                continue
            if not (isinstance(item.get("src"), str) and item["src"]):
                continue
            if sidecar_for(resolved_item(item, str(project_dir)), _has_words):
                clips.append((ti, ii, item))
    lanes = [lane for lane in ((project.get("audio") or {}).get("tracks") or [])
             if isinstance(lane, dict) and lane.get("type") == "voiceover" and not _muted(lane)]
    return clips, lanes


def _abs(path, project_dir) -> str:
    return str(Path(resolve_path(path, str(project_dir))))


def speech_set(project: dict, project_dir, found=None) -> dict:
    """The speech set of `project`; pure, writes nothing. `found` is `members(...)` when the caller has it."""
    clips, lanes = found if found is not None else members(project, project_dir)
    srcs = set()
    for _, _, item in clips:
        for f in ("src", "normalizedSrc"):
            if isinstance(item.get(f), str) and item[f]:
                srcs.add(_abs(item[f], project_dir))
    for lane in lanes:
        if isinstance(lane.get("src"), str) and lane["src"]:
            srcs.add(_abs(lane["src"], project_dir))
    return {
        "v": VERSION,
        "items": [it["id"] for _, _, it in clips if it.get("id") is not None],
        "positions": [[ti, ii] for ti, ii, _ in clips],
        "lanes": [ln["id"] for ln in lanes if ln.get("id") is not None],
        "srcs": sorted(srcs),
    }


def write_speech_set(project: dict, project_dir, name: str = "speech-set.json") -> Path:
    """Write the set to `<project_dir>/render/<name>` atomically; returns the file."""
    dest_dir = Path(project_dir) / "render"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / name
    tmp = dest_dir / f".{name}.{os.getpid()}.tmp"
    tmp.write_text(json.dumps(speech_set(project, project_dir)))
    os.replace(tmp, dest)
    return dest
