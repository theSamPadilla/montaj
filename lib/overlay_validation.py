"""Lenient shape check for ``type: "overlay"`` items in a project's tracks.

Nothing downstream validated these before: ``save_project`` shallow-merged and
wrote whatever it was sent, and the renderer only fails on some wrong shapes
(a missing ``src`` throws deep inside ``render.js``; a ``googleFonts`` object
renders silently in a fallback face). An agent guessing the item shape got no
signal either way.

The shape here is derived from the consumers, not invented:

- ``montaj_assets/render/render.js`` (overlay spec build, ~line 873): reads
  ``id`` (segment file name), ``src`` (``resolve(item.src)``, throws when
  absent), ``start``/``end`` (quantized to frames), and ``?? default`` reads of
  ``props``, ``offsetX``, ``offsetY``, ``scale``, ``scaleX``, ``scaleY``,
  ``rotation``, ``opacity``, ``opaque``, ``googleFonts``, ``keyframes``.
- ``montaj_assets/render/bundle.js`` ``generateHtml``: ``googleFonts`` is
  ``.filter``/``.map``-ed as an array of font SPEC strings.
- ``montaj_assets/editor/src/schema.ts`` ``VisualItem``: ``id: string``,
  ``start``/``end: number``, ``props?: Record<string, unknown>``,
  ``googleFonts?: string[]``, ``keyframes?: KeyframeTrack[]``.

Lenient by design: unknown fields are allowed, and every optional field may be
``null`` because every consumer reads it through ``??``. Only items whose
``type`` is exactly ``"overlay"`` are checked; image and video items are not.
"""
from __future__ import annotations

from typing import Any

REQUIRED_STRING = ("src",)
REQUIRED_NUMBER = ("start", "end")
OPTIONAL_NUMBER = ("offsetX", "offsetY", "scale", "scaleX", "scaleY", "rotation", "opacity")


def _is_number(value: Any) -> bool:
    # bool is an int subclass in Python; JSON true is not a number.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _item_errors(item: dict, where: str) -> list[str]:
    errors: list[str] = []
    item_id = item.get("id")
    suffix = f" (item id {item_id!r})" if isinstance(item_id, str) and item_id else ""

    def err(field: str, problem: str) -> None:
        errors.append(f"{where}.{field} {problem}{suffix}")

    for field in REQUIRED_STRING:
        if field not in item or item[field] is None:
            err(field, "is required and must be a non-empty string")
        elif not isinstance(item[field], str) or not item[field].strip():
            err(field, "must be a non-empty string")

    # `id` is optional: render.js only uses it to name the segment file and the
    # docs show id-less items (docs/ARCHITECTURE.md). The editor assumes one,
    # so when present it must be a usable string or number.
    if item_id is not None and not (
        (isinstance(item_id, str) and item_id.strip()) or _is_number(item_id)
    ):
        err("id", "must be a non-empty string")

    for field in REQUIRED_NUMBER:
        if field not in item or item[field] is None:
            err(field, "is required and must be a number (seconds)")
        elif not _is_number(item[field]):
            err(field, "must be a number (seconds)")

    for field in OPTIONAL_NUMBER:
        value = item.get(field)
        if value is not None and not _is_number(value):
            err(field, "must be a number")

    props = item.get("props")
    if props is not None and not isinstance(props, dict):
        err("props", "must be an object")

    opaque = item.get("opaque")
    if opaque is not None and not isinstance(opaque, bool):
        err("opaque", "must be a boolean")

    fonts = item.get("googleFonts")
    if fonts is not None and not (
        isinstance(fonts, list) and all(isinstance(f, str) for f in fonts)
    ):
        err("googleFonts", 'must be an array of strings, e.g. ["Anton", "Syne:wght@800"]')

    keyframes = item.get("keyframes")
    if keyframes is not None and not (
        isinstance(keyframes, list) and all(isinstance(k, dict) for k in keyframes)
    ):
        err("keyframes", "must be an array of objects")

    return errors


def overlay_item_errors(project: dict) -> list[str]:
    """Return field-level errors for every overlay item in ``project["tracks"]``.

    Expects object-form tracks (run ``normalize_tracks`` first). A missing or
    non-list ``tracks``, a track that is not an object, or an item that is not
    an object is left alone: this checks overlay items, not the track layout.
    """
    tracks = project.get("tracks") if isinstance(project, dict) else None
    if not isinstance(tracks, list):
        return []
    errors: list[str] = []
    for t_idx, track in enumerate(tracks):
        items = track.get("items") if isinstance(track, dict) else None
        if not isinstance(items, list):
            continue
        for i_idx, item in enumerate(items):
            if isinstance(item, dict) and item.get("type") == "overlay":
                errors.extend(_item_errors(item, f"tracks[{t_idx}].items[{i_idx}]"))
    return errors
