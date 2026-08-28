"""Ephemeral editor context — where the playhead is, right now.

DELIBERATELY NOT PERSISTED. This is live UI state, not project data: it never
touches project.json, never commits, and dies with the process. A restarted
serve reports "no live editor" rather than a remembered lie about where someone
was looking ten minutes ago.

Shape follows the existing in-process state precedents in
serve/routes/projects.py (_active_renders, _caption_jobs): a module-level dict
keyed by project id, no locking. Same rationale as those — single process,
single asyncio loop, dict mutations between awaits are race-free.
"""
import time
from dataclasses import dataclass, field

from lib.project_tracks import track_items

# Past this, a reported context is treated as gone. Sized against the browser,
# not against taste: Chrome throttles a hidden tab's timers to once a minute,
# and the editor is usually in a background tab while the user is talking to an
# agent in another app — a 30s window would report "no editor open" for most of
# every minute of exactly the case this feature exists for. `ageMs` rides along
# in every response, so a caller that cares about a parked playhead can judge
# for itself rather than being told nothing is open.
CONTEXT_TTL_SEC = 120.0


@dataclass
class ContextState:
    playhead_sec: float
    selected_ids: list[str] = field(default_factory=list)
    selected_caption_id: str | None = None
    reported_at: float = field(default_factory=time.monotonic)

    def age_ms(self) -> int:
        return int((time.monotonic() - self.reported_at) * 1000)

    def is_fresh(self) -> bool:
        return (time.monotonic() - self.reported_at) < CONTEXT_TTL_SEC


_contexts: dict[str, ContextState] = {}
_active_project_id: str | None = None


def report(project_id: str, body: dict) -> ContextState:
    """Record what an editor says it is looking at. Raises ValueError on a
    malformed body so the route can turn it into a 400."""
    global _active_project_id, _contexts

    raw = body.get("playheadSec", 0.0)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError("playheadSec must be a number")
    playhead = float(raw)
    if playhead != playhead or playhead in (float("inf"), float("-inf")):
        raise ValueError("playheadSec must be finite")

    ids = body.get("selectedIds") or []
    if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids):
        raise ValueError("selectedIds must be a list of strings")

    caption_id = body.get("selectedCaptionId")
    if caption_id is not None and not isinstance(caption_id, str):
        raise ValueError("selectedCaptionId must be a string or null")

    state = ContextState(
        playhead_sec=max(0.0, playhead),
        selected_ids=list(ids),
        selected_caption_id=caption_id,
    )
    # Drop anything nobody can read any more. Entries are tiny, but a
    # never-pruned dict keyed by project id is a leak on principle, and the one
    # write path is the natural place to pay for it.
    _contexts = {k: v for k, v in _contexts.items() if v.is_fresh()}
    _contexts[project_id] = state
    _active_project_id = project_id
    return state


def get(project_id: str) -> ContextState | None:
    return _contexts.get(project_id)


def active() -> tuple[str, ContextState] | None:
    """The most recently reporting editor, if it is still fresh.

    Two tabs open: the last one to report wins. The caller surfaces which
    project it is, so a second tab reads as surprising rather than invisible.
    """
    if _active_project_id is None:
        return None
    state = _contexts.get(_active_project_id)
    if state is None or not state.is_fresh():
        return None
    return _active_project_id, state


def clear_all() -> None:
    """Test hook — production never needs this; the process exit is the reset."""
    global _active_project_id
    _contexts.clear()
    _active_project_id = None


# How many caption segments of lead-in and lead-out to include around the
# playhead. One each is enough to trim against ("cut from here to there")
# without turning a context read into a transcript dump.
_CAPTION_CONTEXT_SEGMENTS = 1


def _num(value) -> float | None:
    """A JSON value as a finite float, or None when it is not a real number.

    project.json is hand-editable and json.loads happily parses NaN/Infinity,
    so every number this module reads has to survive being a string, a list, or
    a NaN. None means "absent", which every caller already handles; raising
    would 500 a route whose whole contract is always-200.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return float(value)


def _items_with_track_idx(project: dict) -> list[tuple[int, dict]]:
    """Every visual item paired with its track index.

    `track_items` yields one item-list per track in order, having already
    normalized the legacy `VisualItem[][]` shape — so the index this join needs
    is just `enumerate`, and the shape tolerance stays in the one module that
    owns it.
    """
    return [
        (idx, item)
        for idx, items in enumerate(track_items(project))
        for item in (items or [])
        if isinstance(item, dict)
    ]


def _clip_at(project: dict, t: float) -> dict | None:
    """The item under the playhead, topmost track winning.

    Ties go to the HIGHER track index because that is what the viewer is
    actually looking at — an overlay sitting on top of a clip is the thing on
    screen. Within one track, later items win, matching the render's own
    z-order-by-position convention for same-track overlaps.
    """
    best: tuple[int, dict] | None = None
    for track_idx, item in _items_with_track_idx(project):
        start = item.get("start")
        end = item.get("end")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        if not (start <= t < end):
            continue
        if best is None or track_idx >= best[0]:
            best = (track_idx, item)
    if best is None:
        return None

    track_idx, item = best
    start = float(item["start"])
    in_point = item.get("inPoint")
    source_time = None
    if isinstance(in_point, (int, float)):
        source_time = round(float(in_point) + (t - start), 4)

    return {
        "id":            item.get("id"),
        "type":          item.get("type"),
        "src":           item.get("src"),
        "trackIdx":      track_idx,
        "start":         start,
        "end":           float(item["end"]),
        "inPoint":       in_point,
        "outPoint":      item.get("outPoint"),
        "sourceTimeSec": source_time,
    }


def _lane_of(seg: dict) -> int:
    """A caption segment's lane, defaulted and defensively coerced.

    Mirrors `laneOf` in editor/src/video/captionLanes.ts so serve and the
    editor agree on which row is "the transcript": `lane` is an optional dict
    key here exactly like it's an optional field there — absent (or
    negative/non-finite) means lane 0.
    """
    raw = _num(seg.get("lane"))
    if raw is None:
        return 0
    n = int(raw)
    return n if n >= 0 else 0


def _captions_around(project: dict, t: float) -> dict | None:
    """The caption segment under the playhead plus one either side.

    None when the project has no captions at all — a silent empty string would
    read to an agent as "nobody is saying anything here", which is a different
    claim from "this project has never been transcribed".
    """
    captions = project.get("captions")
    segments = captions.get("segments") if isinstance(captions, dict) else None
    if not isinstance(segments, list):
        return None
    usable = [
        s for s in segments
        if isinstance(s, dict)
        and isinstance(s.get("start"), (int, float))
        and isinstance(s.get("end"), (int, float))
    ]
    if not usable:
        return None

    # A project can now hold several caption rows (lanes). We want to quote
    # what is being SPOKEN, not a title card or call-out that happens to
    # overlap the playhead in a higher lane — so narrow to the LOWEST lane
    # present, not a literal lane 0. That keeps a hand-authored project whose
    # only captions sit on lane 2 reporting something instead of going silent.
    lowest_lane = min(_lane_of(s) for s in usable)
    usable = [s for s in usable if _lane_of(s) == lowest_lane]

    usable.sort(key=lambda s: s["start"])
    at_idx = next(
        (i for i, s in enumerate(usable) if s["start"] <= t < s["end"]),
        None,
    )
    if at_idx is None:
        # Between segments — anchor on the next one starting after the playhead,
        # falling back to the last segment when the playhead is past the end.
        at_idx = next(
            (i for i, s in enumerate(usable) if s["start"] >= t),
            len(usable) - 1,
        )
        segment_id_at = None
    else:
        segment_id_at = usable[at_idx].get("id")

    lo = max(0, at_idx - _CAPTION_CONTEXT_SEGMENTS)
    hi = min(len(usable), at_idx + _CAPTION_CONTEXT_SEGMENTS + 1)
    window = usable[lo:hi]

    return {
        "text":                 " ".join(str(s.get("text") or "").strip() for s in window).strip(),
        "segmentIdAtPlayhead":  segment_id_at,
        "startSec":             float(window[0]["start"]),
        "endSec":               float(window[-1]["end"]),
    }


def _markers(project: dict) -> list[dict] | None:
    """The operator's markers, sorted by time.

    ALL of them, not a window around the playhead the way captions are: a
    marker list is short by nature and its whole purpose is to be an index of
    the moments the operator cared about, so handing over only the nearby ones
    would defeat the point ("work through my markers" needs all of them).

    None — not [] — when the project has no markers, matching
    `_captions_around`'s discipline: "the operator marked nothing" and "this
    project has no markers" are different claims, and only the first should
    read as an empty list.
    """
    markers = project.get("markers")
    if not isinstance(markers, list):
        return None
    usable = [
        {"id": m["id"], "t": float(m["t"]), "label": str(m.get("label", ""))}
        for m in markers
        if isinstance(m, dict)
        and isinstance(m.get("id"), str)
        and isinstance(m.get("t"), (int, float))
    ]
    if not usable:
        return None
    usable.sort(key=lambda m: m["t"])
    return usable


def enrich(project_id: str, project: dict, state: ContextState) -> dict:
    """Join a reported playhead against the project into one actionable answer.

    This is what makes a single resource read enough to answer "tighten this
    section": the agent gets the clip, its source-time mapping, and the words,
    instead of a bare float it has to resolve with three more calls.
    """
    settings = project.get("settings")
    fps = _num(settings.get("fps") if isinstance(settings, dict) else None) or 30.0

    t = state.playhead_sec
    by_id = {
        item["id"]: (track_idx, item)
        for track_idx, item in _items_with_track_idx(project)
        if isinstance(item.get("id"), str)
    }
    selection = []
    for item_id in state.selected_ids:
        found = by_id.get(item_id)
        if found is None:
            continue          # a selection the project no longer contains
        track_idx, item = found
        selection.append({
            "id":       item_id,
            "kind":     item.get("type"),
            "src":      item.get("src"),
            "trackIdx": track_idx,
            "start":    item.get("start"),
            "end":      item.get("end"),
        })

    markers = _markers(project)

    return {
        "project": {
            "id":          project_id,
            "name":        project.get("name"),
            "status":      project.get("status"),
            "durationSec": max(
                (end for _, i in _items_with_track_idx(project)
                 if (end := _num(i.get("end"))) is not None),
                default=0.0,
            ),
        },
        "playhead": {"sec": round(t, 4), "frame": int(round(t * fps))},
        "clipAtPlayhead":            _clip_at(project, t),
        "selection":                 selection,
        "selectedCaptionId":         state.selected_caption_id,
        "transcriptAroundPlayhead":  _captions_around(project, t),
        **({"markers": markers} if markers is not None else {}),
        "ageMs":                     state.age_ms(),
    }
