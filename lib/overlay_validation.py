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
``null`` because every consumer reads it through ``??``. Overlay items get the
shape check above; image and video items get the compositing check (§616:
``mask``, ``blendMode``, ``opacity`` and their keyframe tracks,
``_visual_item_errors``). Other item types are not checked. An overlay that
carries a ``mask`` or ``blendMode`` is refused, since overlays do not support
them.

Only NEW or CHANGED items are checked (FQ1.1 final review). A save that
carries `tracks` used to re-validate every overlay item on every PUT, so an
already-broken item already on disk (saved before this validator existed, or
saved back before a later edit made it invalid) blocked an unrelated save
forever — the agent could not even fix the ONE item it was trying to fix
without also being forced to repair every other pre-existing problem in the
same request. `overlay_item_errors` now takes the previous on-disk project
and skips any item that matches one already there (compared by canonical
JSON, multiset-aware so duplicates cancel out one-for-one) and, for an item
whose `id` reappears with different content, reports only the fields that
actually changed relative to the prior item with that id. A brand-new id (or
an id-less item with no exact prior match) is checked in full.
"""
from __future__ import annotations

import json
from collections import Counter
import math
from typing import Any

# Mirrors montaj_assets/timeline-core/src/mask.js (MASK_SHAPES, BLEND_MODES,
# MASK_KEYFRAME_PROPS and the clamps documented on ItemMask). Change both together.
MASK_SHAPES = ("ellipse", "rect", "wipe")
BLEND_MODES = ("normal", "screen", "multiply", "add", "lighten", "darken", "overlay")
MASK_KEYFRAME_PROPS = ("maskX", "maskY", "maskW", "maskH", "maskRotation", "maskFeather")
# The other props a clip keyframe track may name (geometry.js / curves.js KeyframeProp).
GEOMETRY_KEYFRAME_PROPS = ("offsetX", "offsetY", "scale", "scaleX", "scaleY", "rotation")
CROP_KEYFRAME_PROPS = ("cropX", "cropY", "cropW", "cropH")
CLIP_KEYFRAME_PROPS = GEOMETRY_KEYFRAME_PROPS + CROP_KEYFRAME_PROPS + ("opacity",) + MASK_KEYFRAME_PROPS
VISUAL_TYPES = ("image", "video")
ITEM_TYPES = ("overlay",) + VISUAL_TYPES
MASK_FEATHER_MAX = 0.5

REQUIRED_STRING = ("src",)
REQUIRED_NUMBER = ("start", "end")
OPTIONAL_NUMBER = ("offsetX", "offsetY", "scale", "scaleX", "scaleY", "rotation", "opacity")


def _is_number(value: Any) -> bool:
    # bool is an int subclass in Python; JSON true is not a number.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _item_errors(item: dict) -> list[tuple[str, str]]:
    """Return ``(field, problem)`` pairs for every wrong field on ``item``.

    Bare field name plus problem text — no location prefix and no item-id
    suffix, so a caller can both format the final message (prepending
    ``where`` and an id suffix) and compare a field name against the item's
    previous shape without re-parsing a formatted string.
    """
    errors: list[tuple[str, str]] = []

    def err(field: str, problem: str) -> None:
        errors.append((field, problem))

    item_id = item.get("id")
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

    for field in ("mask", "blendMode"):
        if item.get(field) is not None:
            err(field, "is not supported on overlay items (only image and video items take a mask or blend mode)")

    return errors


def _finite(value: Any) -> bool:
    return _is_number(value) and math.isfinite(value)


def _visual_item_errors(item: dict) -> list[tuple[str, str]]:
    """``(field, problem)`` pairs for the compositing fields of an image or
    video item: ``mask``, ``blendMode``, ``opacity`` and ``keyframes``.

    Fields may be dotted (``mask.shape``, ``keyframes[0].prop``); the
    changed-fields rule compares their root key. Lenient: unknown fields and
    null values are fine.
    """
    errors: list[tuple[str, str]] = []

    def err(field: str, problem: str) -> None:
        errors.append((field, problem))

    opacity = item.get("opacity")
    if opacity is not None and not (_finite(opacity) and 0 <= opacity <= 1):
        err("opacity", "must be a number from 0 to 1")

    blend = item.get("blendMode")
    if blend is not None and blend not in BLEND_MODES:
        err("blendMode", "must be one of " + ", ".join(BLEND_MODES))

    mask = item.get("mask")
    if mask is not None:
        if not isinstance(mask, dict):
            err("mask", "must be an object with a shape")
        else:
            if mask.get("shape") not in MASK_SHAPES:
                err("mask.shape", "must be one of " + ", ".join(MASK_SHAPES))
            for k in ("x", "y", "rotation"):
                v = mask.get(k)
                if v is not None and not _finite(v):
                    err(f"mask.{k}", "must be a finite number")
            for k in ("w", "h"):
                v = mask.get(k)
                if v is not None and not (_finite(v) and v > 0):
                    err(f"mask.{k}", "must be a number greater than 0")
            v = mask.get("radius")
            if v is not None and not (_finite(v) and 0 <= v <= 1):
                err("mask.radius", "must be a number from 0 to 1")
            v = mask.get("feather")
            if v is not None and not (_finite(v) and 0 <= v <= MASK_FEATHER_MAX):
                err("mask.feather", f"must be a number from 0 to {MASK_FEATHER_MAX}")
            v = mask.get("invert")
            if v is not None and not isinstance(v, bool):
                err("mask.invert", "must be a boolean")

    keyframes = item.get("keyframes")
    if isinstance(keyframes, list):
        for i, track in enumerate(keyframes):
            if not isinstance(track, dict):
                continue  # the array-of-objects check is _item_errors's business
            prop = track.get("prop")
            where = f"keyframes[{i}]"
            if prop not in CLIP_KEYFRAME_PROPS:
                err(f"{where}.prop", "must be one of " + ", ".join(CLIP_KEYFRAME_PROPS))
                continue
            if prop in MASK_KEYFRAME_PROPS and not isinstance(mask, dict):
                err(where, f"{prop} needs a mask on the item (a mask track does nothing without one)")
            points = track.get("points")
            if points is None:
                continue
            if not isinstance(points, list):
                err(f"{where}.points", "must be an array")
                continue
            for j, point in enumerate(points):
                value = point.get("value") if isinstance(point, dict) else None
                at = f"{where}.points[{j}].value"
                if not _finite(value):
                    err(at, "must be a finite number")
                elif prop == "opacity" and not 0 <= value <= 1:
                    err(at, "must be a number from 0 to 1")
                elif prop == "maskFeather" and not 0 <= value <= MASK_FEATHER_MAX:
                    err(at, f"must be a number from 0 to {MASK_FEATHER_MAX}")
                elif prop in ("maskW", "maskH") and not value > 0:
                    err(at, "must be a number greater than 0")
    return errors


def item_problems(item: dict) -> list[tuple[str, str]]:
    """Every ``(field, problem)`` on one item, by its type (overlay: shape check;
    image/video: compositing check; anything else: none)."""
    kind = item.get("type")
    if kind == "overlay":
        return _item_errors(item)
    if kind in VISUAL_TYPES:
        return _visual_item_errors(item)
    return []


def _root(field: str) -> str:
    """``mask.shape`` -> ``mask``; ``keyframes[0].prop`` -> ``keyframes``."""
    return field.split(".", 1)[0].split("[", 1)[0]


def _canonical_json(item: dict) -> str:
    return json.dumps(item, sort_keys=True, default=str)


def _id_key(item: dict) -> Any:
    """``item["id"]`` if it is a str or (non-bool) int, else ``None``.

    ``None`` is a valid dict key too, so callers must not conflate "no
    usable id" with "id key is None" — they check membership in
    ``prior_by_id`` for exactly the ids this returns, and an item with no
    usable id here is never inserted into that dict in the first place.
    """
    item_id = item.get("id")
    if isinstance(item_id, str) or (isinstance(item_id, int) and not isinstance(item_id, bool)):
        return item_id
    return None


def _checked_items(tracks: list) -> list[dict]:
    """Every dict item of a checked type (overlay, image, video) across
    ``tracks`` (object-form). The prior index is built from these, so a prior
    image and a prior overlay sharing an id keep separate entries (the index
    is keyed by ``(type, id)``)."""
    found: list[dict] = []
    for track in tracks:
        items = track.get("items") if isinstance(track, dict) else None
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, dict) and item.get("type") in ITEM_TYPES:
                found.append(item)
    return found


def overlay_item_errors(project: dict, previous: dict | None = None) -> list[str]:
    """Return field-level errors for every NEW or CHANGED overlay, image or
    video item in ``project["tracks"]``.

    Expects object-form tracks (run ``normalize_tracks`` first) — ``project``
    and, if given, ``previous`` (the prior on-disk project, also
    ``normalize_tracks``-ed). A missing or non-list ``tracks``, a track that
    is not an object, or an item that is not an object is left alone: this
    checks overlay items, not the track layout.

    ``previous`` omitted (or with no usable ``tracks``) means every overlay
    item in ``project`` is checked in full — this is also what a full-repo
    validity sweep (e.g. over every shipped fixture project) wants, since
    there is nothing to diff against there.

    Diffing algorithm:

    1. Every overlay item in ``previous`` is counted by its canonical JSON
       (multiset — two on-disk items with identical content both count).
       Items whose id is a ``str``/``int`` are also indexed by that id in
       ``prior_by_id`` (last one wins on a duplicate id).
    2. For each overlay item in ``project``, if its canonical JSON is still
       available in that multiset, it is unchanged (moved, or an id-less
       duplicate) — decrement and skip it entirely, no matter what shape it
       is. This is intentionally content-only: an item is "the same item" by
       what it contains, not by position.
    3. Otherwise run the full field check. If the item's id matches one in
       ``prior_by_id``, keep only the errors whose field is either absent
       from that prior item or holds a different value there — i.e. only
       what actually changed (or is new) about this item. An item whose id
       has no prior match is brand new and keeps every error.
    """
    tracks = project.get("tracks") if isinstance(project, dict) else None
    if not isinstance(tracks, list):
        return []

    prior_tracks = previous.get("tracks") if isinstance(previous, dict) else None
    prior_counts: Counter[str] = Counter()
    prior_by_id: dict[Any, dict] = {}
    if isinstance(prior_tracks, list):
        for prior_item in _checked_items(prior_tracks):
            prior_counts[_canonical_json(prior_item)] += 1
            key = _id_key(prior_item)
            if key is not None:
                prior_by_id[(prior_item.get("type"), key)] = prior_item

    errors: list[str] = []
    for t_idx, track in enumerate(tracks):
        items = track.get("items") if isinstance(track, dict) else None
        if not isinstance(items, list):
            continue
        for i_idx, item in enumerate(items):
            if not (isinstance(item, dict) and item.get("type") in ITEM_TYPES):
                continue

            canonical = _canonical_json(item)
            if prior_counts.get(canonical, 0) > 0:
                prior_counts[canonical] -= 1
                continue  # unchanged, moved, or an id-less duplicate

            item_errors = item_problems(item)
            prior_item = prior_by_id.get((item.get("type"), _id_key(item)))
            if prior_item is not None:
                item_errors = [
                    (field, problem) for field, problem in item_errors
                    if _root(field) not in prior_item
                    or prior_item.get(_root(field)) != item.get(_root(field))
                ]

            item_id = item.get("id")
            suffix = f" (item id {item_id!r})" if isinstance(item_id, str) and item_id else ""
            where = f"tracks[{t_idx}].items[{i_idx}]"
            errors.extend(f"{where}.{field} {problem}{suffix}" for field, problem in item_errors)
    return errors
