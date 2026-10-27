"""`audio.tracks` entries a save may write (§559).

An entry with no string `src` crashes every render, so a save that writes one is
refused with the fix. Only entries the save adds or changes are checked: an entry
already on disk (even a broken one) never blocks a save of its project.
"""


def audio_track_errors(project: dict, previous: dict | None = None) -> list[str]:
    audio = project.get("audio")
    tracks = audio.get("tracks") if isinstance(audio, dict) else None
    if not isinstance(tracks, list):
        return []
    old = (previous or {}).get("audio")
    old_tracks = old.get("tracks") if isinstance(old, dict) else None
    existing = old_tracks if isinstance(old_tracks, list) else []
    errors = []
    for i, track in enumerate(tracks):
        if track in existing:
            continue
        src = track.get("src") if isinstance(track, dict) else None
        if not isinstance(src, str) or not src:
            errors.append(
                f"audio.tracks[{i}] has no src: an audio track is "
                "{id, src: <absolute path>, start, ...}"
            )
    return errors
