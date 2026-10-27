"""`audio.tracks` entries a save may write (§559).

An entry with no string `src` crashes every render, so a save that adds one, or takes an entry's src away, is refused
with the fix. An old entry that already had no src never blocks a save (2b, 2026-10-26: refusing it would lock a person
out of their own project): re-sent as it is it passes quietly, and with other fields changed (start, end, volume, a
shift) it passes with a warning that it won't play. An entry is the same old entry by its `id`, or, without one, by its
place in the list.
"""

WANT = "an audio track is {id, src: <absolute path>, start, ...}"


def _has_src(track) -> bool:
    src = track.get("src") if isinstance(track, dict) else None
    return isinstance(src, str) and bool(src)


def _tracks(project) -> list | None:
    audio = (project or {}).get("audio")
    tracks = audio.get("tracks") if isinstance(audio, dict) else None
    return tracks if isinstance(tracks, list) else None


def audio_track_check(project: dict, previous: dict | None = None) -> tuple[list[str], list[str]]:
    """(errors, warnings) for the `audio.tracks` a save writes over `previous` (the project on disk)."""
    tracks = _tracks(project)
    if tracks is None:
        return [], []
    existing = _tracks(previous) or []
    by_id = {t["id"]: t for t in existing if isinstance(t, dict) and isinstance(t.get("id"), str)}
    errors, warnings = [], []
    for i, track in enumerate(tracks):
        if _has_src(track) or track in existing:
            continue
        tid = track.get("id") if isinstance(track, dict) else None
        if isinstance(tid, str):
            old = by_id.get(tid)
        else:
            old = existing[i] if i < len(existing) and isinstance(existing[i], dict) and not isinstance(existing[i].get("id"), str) else None
        if old is not None and not _has_src(old):
            warnings.append(f"audio.tracks[{i}] still has no src; it won't play")
        else:
            errors.append(f"audio.tracks[{i}] has no src: {WANT}")
    return errors, warnings


def audio_track_errors(project: dict, previous: dict | None = None) -> list[str]:
    return audio_track_check(project, previous)[0]
