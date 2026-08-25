"""Both-shapes tolerance for ``project["tracks"]``.

A project's ``tracks`` is on disk in one of two shapes. The legacy shape is a
bare array of arrays::

    "tracks": [[item, item], [item]]

The object shape gives each track somewhere to hang properties that belong to
the TRACK rather than to a clip::

    "tracks": [
      {"id": "trk-0", "items": [item, item]},
      {"id": "trk-1", "items": [item], "volume": 0.8, "muted": false}
    ]

``volume`` / ``muted`` / ``enabled`` are optional and ABSENT by default, so a
normalized project behaves identically to the legacy one it came from. Track
order is unchanged and still meaningful (``tracks[0]`` is the primary footage
track; higher indices render on top).

The house rule is read-tolerant everywhere, write-normalized on open: readers
call :func:`track_items` and never care which shape is on disk; whoever opens
the project calls :func:`normalize_tracks` and persists the result.

:func:`normalize_tracks` returns the very same object when the project is
already normalized, which is how the lazy on-open migration decides whether it
needs to write to disk at all — a converged project must trigger no write.

Mirrored, semantics for semantics, by ``montaj_assets/render/project-tracks.js``
and ``normalizeTracks``/``trackItems`` in
``montaj_assets/editor/src/video/timeline/timeline-model.ts``. Change one,
change all three.
"""


def _is_object_form(tracks: list) -> bool:
    """True when ``tracks`` needs no work: every element is a dict carrying a
    non-empty string ``id`` and a list ``items``, and no two share an id."""
    seen = set()
    for track in tracks:
        if not isinstance(track, dict):
            return False
        tid = track.get("id")
        if not isinstance(tid, str) or not tid:
            return False
        if not isinstance(track.get("items"), list):
            return False
        if tid in seen:
            return False
        seen.add(tid)
    return True


def _assign_id(index: int, taken: set) -> str:
    """Generate an id for the track at ``index``, avoiding every id in
    ``taken``. The rule: ``trk-<index>``; if that is already taken, append an
    incrementing counter starting at 2 — ``trk-<index>-2``, ``trk-<index>-3``,
    … — until one is free. Deterministic and collision-free. ``taken`` is
    updated in place with the id handed out."""
    candidate = f"trk-{index}"
    suffix = 2
    while candidate in taken:
        candidate = f"trk-{index}-{suffix}"
        suffix += 1
    taken.add(candidate)
    return candidate


def normalize_tracks(project: dict) -> dict:
    """Return ``project`` with ``tracks`` in object form. Accepts either shape.

    Pure — never mutates the input, at any depth. New track dicts and new item
    LISTS are built; the item dicts themselves are carried over by reference.

    Idempotent, and identity-preserving: when ``tracks`` is already in object
    form (see :func:`_is_object_form`) the input object itself is returned, so
    ``normalize_tracks(p) is p``. Same for a project with no ``tracks`` key,
    ``tracks`` of ``None``, or a ``tracks`` that is not a list — validation is
    someone else's job and normalization never raises.

    Per element of ``tracks``:

    - a list → ``{"id": <generated>, "items": <copy>}``
    - a dict → preserved, with every other key (``volume``, ``muted``,
      ``enabled``, anything unknown) carried through untouched; ``items``
      coerced to a list (missing / ``None`` / non-list → ``[]``); ``id`` filled
      in when missing, not a string, empty, or a duplicate of an earlier
      track's id.
    - anything else (``None``, a string, a number) → ``{"id": <generated>,
      "items": []}``

    Generated ids are ``trk-<index>``, deduped against every id already present
    anywhere in ``tracks`` — see :func:`_assign_id` for the collision rule.
    """
    if not isinstance(project, dict):
        return project
    tracks = project.get("tracks")
    if not isinstance(tracks, list):
        return project
    if _is_object_form(tracks):
        return project

    # Every explicit id in the project, collected up front so a generated
    # `trk-<i>` can never land on an id a LATER track already claims.
    taken = set()
    for track in tracks:
        if isinstance(track, dict):
            tid = track.get("id")
            if isinstance(tid, str) and tid:
                taken.add(tid)

    kept = set()   # ids handed out so far, so a duplicate loses to the first holder
    out = []
    for index, track in enumerate(tracks):
        if isinstance(track, list):
            out.append({"id": _assign_id(index, taken), "items": list(track)})
        elif isinstance(track, dict):
            new = dict(track)
            items = track.get("items")
            new["items"] = list(items) if isinstance(items, list) else []
            tid = track.get("id")
            if isinstance(tid, str) and tid and tid not in kept:
                new["id"] = tid
            else:
                new["id"] = _assign_id(index, taken)
            out.append(new)
        else:
            out.append({"id": _assign_id(index, taken), "items": []})
        kept.add(out[-1]["id"])

    return {**project, "tracks": out}


def replace_track_items(project: dict, index: int, items: list) -> list:
    """Return a NEW normalized ``tracks`` list with track ``index``'s items replaced.

    Every other track is preserved, and every track's ``id`` / ``volume`` /
    ``muted`` / ``enabled`` survives. Pure — does not mutate ``project`` or any
    existing track dict. Grows the list with fresh empty tracks (ids from
    :func:`_assign_id`) if ``index`` is past the end.

    Assign the result straight back into the project at the one key::

        project["tracks"] = replace_track_items(project, 0, new_items)

    Never rebind ``project`` itself — callers up the stack hold that same dict.
    """
    tracks = normalize_tracks(project).get("tracks") if isinstance(project, dict) else None
    if not isinstance(tracks, list):
        tracks = []

    out = [dict(track) for track in tracks]
    taken = {t["id"] for t in out if isinstance(t.get("id"), str)}
    while len(out) <= index:
        out.append({"id": _assign_id(len(out), taken), "items": []})
    out[index]["items"] = list(items)
    return out


def track_items(project: dict) -> list:
    """Just the items, in track order — for the many callers that only read.

    ``[]`` when the project has no tracks (or a ``tracks`` too malformed to
    normalize). The returned lists are the normalized project's own item lists;
    treat them as read-only.
    """
    tracks = normalize_tracks(project).get("tracks") if isinstance(project, dict) else None
    if not isinstance(tracks, list):
        return []
    return [track["items"] for track in tracks]


def enabled_track_items(project: dict) -> list:
    """The items of ENABLED tracks only, in track order — for anything that
    PRODUCES picture and sound, as opposed to anything that EDITS.

    The counterpart to :func:`track_items`. Editing surfaces keep seeing a
    skipped track (you have to be able to turn it back on); playback and export
    do not. ``enabled`` is absent by default, so ``is not False`` is the test —
    an untouched project has every track enabled.

    A skipped track's slot is EMPTIED, not removed — this maps, it does not
    filter. Every consumer indexes this list positionally (index 0 is "the base
    footage track", the rest are "the overlay tracks"); filtering would shift
    every later track's index down and silently reassign it to the wrong role.
    Emptying preserves position while still contributing nothing to playback or
    export.

    Items are the normalized project's own lists, shared by reference; treat
    them as read-only.
    """
    tracks = normalize_tracks(project).get("tracks") if isinstance(project, dict) else None
    if not isinstance(tracks, list):
        return []
    return [track["items"] if track.get("enabled") is not False else [] for track in tracks]
