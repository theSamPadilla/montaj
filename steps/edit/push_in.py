#!/usr/bin/env python3
"""push_in (PL89): a slow push on the talking-head clips, in one call.

- The clips: every video on the main track (the first; b-roll and overlays sit above it), or the `items` given.
- Each gets `scale` keyed from its start zoom to start + `zoom` across its whole length, linear, and `offsetY` keyed so
  the point `anchor` down the frame (the face, by default 35%) stays where it was. Consecutive clips alternate their
  start zoom (1.00, then 1.04), so the cut between two of them reads as a change of framing.
- A clip a person framed (a scale or offset of its own, or keys on scale, scaleX, scaleY, offsetX or offsetY) is left
  alone and named in `kept`; one push_in pushed before (its two-key shape) is pushed again, so a second run is the same.
- The write: tracks only, through lib/project_lock.update_project_or_fail, refused (`project_changed`) when the
  tracks changed since the step read them; a version of the project first.
Prints one short JSON: {pushed, kept?}.
"""
import argparse, copy, json, os, sys

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib import look_check as lc, project_revisions  # noqa: E402
from lib.common import fail  # noqa: E402
from lib.project_lock import update_project_or_fail  # noqa: E402
from lib.project_tracks import normalize_tracks  # noqa: E402
from lib.project_versions import commit_version, is_own_repo  # noqa: E402

DEFAULT_ZOOM = 0.07      # Claude alone's 1.00 to 1.07
ALT_START = 1.04         # every other clip starts here, so a cut between two of them changes the framing
DEFAULT_ANCHOR = 0.35    # the share of the frame's height that stays put: a talking head's face
FRAMING = ("scale", "scaleX", "scaleY", "offsetX", "offsetY")
VERSION_MESSAGE = "version: before push_in"
STEP_LOCK_TIMEOUT = 30.0


def read_tracks(project_path):
    """The project as read, and its tracks' revision."""
    with open(project_path, encoding="utf-8") as f:
        doc = json.load(f)
    return doc, project_revisions.revision_of(doc.get("tracks"))


def push_tracks(dur, s0, zoom, anchor):
    """The scale and offsetY tracks of one push over [0, dur] (item seconds)."""
    s1 = round(s0 + zoom, 4)
    oy = lambda s: round((0.5 - anchor) * 100 * (s - 1), 4)  # noqa: E731  keeps `anchor` where it was on screen
    return [
        {"prop": "scale", "points": [{"t": 0, "value": s0}, {"t": dur, "value": s1}]},
        {"prop": "offsetY", "points": [{"t": 0, "value": oy(s0)}, {"t": dur, "value": oy(s1)}]},
    ]


def ours(item):
    """True when the item's framing is a push_in's own: two-key scale and offsetY tracks and nothing else framing it."""
    if any(item.get(k) not in (None, 0, 1) for k in FRAMING if k != "scale") or item.get("scale") not in (None, 1):
        return False
    tracks = [t for t in (item.get("keyframes") or []) if t.get("prop") in FRAMING]
    props = sorted(t.get("prop") for t in tracks)
    return props == ["offsetY", "scale"] and all(len(t.get("points") or []) == 2 for t in tracks)


def framed_by_a_person(item):
    if ours(item):
        return False
    if item.get("scale") not in (None, 1) or any(item.get(k) not in (None, 0) for k in ("offsetX", "offsetY")):
        return True
    if any(item.get(k) not in (None, 1) for k in ("scaleX", "scaleY")):
        return True
    return any(t.get("prop") in FRAMING for t in (item.get("keyframes") or []))


def run(project_path, *, items=None, zoom=DEFAULT_ZOOM, anchor=DEFAULT_ANCHOR, detail=False):
    project_path = os.path.abspath(project_path)
    project_dir = os.path.dirname(project_path)
    if not (0 < zoom <= 0.2):
        fail("invalid_params", "zoom is how much the clip grows across it, more than 0 and at most 0.2 (0.07 is 7%).")
    if not (0 <= anchor <= 1):
        fail("invalid_params", "anchor is a share of the frame's height, 0 to 1.")
    on_disk, read_rev = read_tracks(project_path)
    project = normalize_tracks(copy.deepcopy(on_disk))
    tracks = project["tracks"]
    if items:
        everything = {it.get("id"): it for t in tracks for it in t.get("items", [])}
        for i in items:
            if i not in everything:
                fail("item_not_found", f"No item {i} on the timeline.")
            if everything[i].get("type") != "video":
                fail("not_a_video", f"{i} is a {everything[i].get('type')} item; push_in pushes video clips.")
        targets = [i for t in tracks for i in [it.get("id") for it in t.get("items", [])] if i in set(items)]
    else:
        main = tracks[0]["items"] if tracks else []
        targets = [it.get("id") for it in sorted(main, key=lambda x: lc._num(x.get("start"))) if it.get("type") == "video"]

    result = {"pushed": [], "kept": []}
    version = None

    def apply(fresh):
        nonlocal version
        if project_revisions.revision_of(fresh.get("tracks")) != read_rev:
            fail("project_changed", "The tracks changed since push_in read them (an edit in the editor or another "
                                    "step). Run push_in again.")
        before = normalize_tracks(copy.deepcopy(fresh))["tracks"]
        doc = normalize_tracks(fresh)
        by_id = {it.get("id"): it for t in doc["tracks"] for it in t.get("items", [])}
        result["pushed"].clear()
        result["kept"].clear()
        k = 0
        for i in targets:
            it = by_id[i]
            if framed_by_a_person(it):
                result["kept"].append(i)
                continue
            s0 = 1.0 if (k % 2 == 0 or len(targets) == 1) else ALT_START
            k += 1
            dur = round(lc._num(it.get("end")) - lc._num(it.get("start")), 3)
            rest = [t for t in (it.get("keyframes") or []) if t.get("prop") not in FRAMING]
            it.pop("scale", None)
            it.pop("offsetY", None)
            it["keyframes"] = rest + push_tracks(dur, s0, zoom, anchor)
            result["pushed"].append(i)
        if doc["tracks"] == before:
            return None   # nothing changes: nothing is written and no version is taken
        version = commit_version(project_dir, VERSION_MESSAGE)
        fresh["tracks"] = doc["tracks"]
        return fresh

    update_project_or_fail(project_path, apply, fail, timeout=STEP_LOCK_TIMEOUT)
    out = {"pushed": len(result["pushed"])}
    if result["kept"]:
        out["kept"] = list(result["kept"])
    if version is None and result["pushed"] and not is_own_repo(project_dir):
        out["version"] = False
    if detail:
        out["items"] = list(result["pushed"])
    return out


def main():
    parser = argparse.ArgumentParser(description="A slow push on the talking-head clips")
    parser.add_argument("--project", required=True, help="The project id, its folder, or its project.json")
    parser.add_argument("--items", default=None, help="Only these clips: a JSON list of item ids")
    parser.add_argument("--zoom", type=float, default=DEFAULT_ZOOM, help="How much each clip grows across it (default 0.07)")
    parser.add_argument("--anchor", type=float, default=DEFAULT_ANCHOR, help="The share of the height that stays put (default 0.35)")
    parser.add_argument("--detail", action="store_true", help="Also answer the pushed item ids")
    args = parser.parse_args()
    project_path = args.project
    if os.path.isdir(project_path):
        project_path = os.path.join(project_path, "project.json")
    if not os.path.isfile(project_path):
        fail("file_not_found", f"No project.json at {args.project}")
    items = None
    if args.items:
        try:
            items = json.loads(args.items)
        except ValueError:
            items = [args.items]
        if not isinstance(items, list) or not all(isinstance(i, str) for i in items):
            fail("invalid_params", "items is a JSON list of item ids.")
    print(json.dumps(run(project_path, items=items, zoom=args.zoom, anchor=args.anchor, detail=args.detail)))


if __name__ == "__main__":
    main()
