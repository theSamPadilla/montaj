#!/usr/bin/env python3
"""Split a clip into sub-clips by removing time ranges. Project-level metadata
operation — no video encoding. The render engine materializes at render time."""
import copy, json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from common import fail
from ai_video import find_project, save_project_changes
from lib.project_tracks import track_items, replace_track_items
from lib.item_ids import id_suffix


def cuts_to_keeps(cuts, clip_duration):
    """Convert cut ranges (remove) to keep ranges."""
    cuts = sorted(cuts, key=lambda c: c[0])
    keeps = []
    cursor = 0.0
    for cs, ce in cuts:
        if cs > cursor:
            keeps.append([cursor, cs])
        cursor = max(cursor, ce)
    if cursor < clip_duration:
        keeps.append([cursor, clip_duration])
    return keeps


def ripple_tracks(tracks0, insert_index, old_count, new_clips):
    """Replace old_count items at insert_index with new_clips, ripple timeline."""
    before = tracks0[:insert_index]
    after = tracks0[insert_index + old_count:]

    # Compute where the new block starts
    block_start = new_clips[0]["start"] if new_clips else 0.0
    block_end = block_start + sum(c["outPoint"] - c["inPoint"] for c in new_clips)

    # Shift everything after
    old_end = tracks0[insert_index + old_count - 1]["end"] if old_count else block_start
    delta = block_end - old_end
    for c in after:
        c["start"] = round(c["start"] + delta, 6)
        c["end"] = round(c["end"] + delta, 6)

    return before + new_clips + after


def main():
    parser = argparse.ArgumentParser(description="Jump-cut a clip: remove time ranges, keep the rest")
    parser.add_argument("--project-id", dest="project_id", required=True)
    parser.add_argument("--clip-id", dest="clip_id", required=True,
                        help="ID of the clip on tracks[0] to jump-cut")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--cuts", help="JSON array of [start, end] ranges to REMOVE (clip-local time)")
    group.add_argument("--keeps", help="JSON array of [start, end] ranges to KEEP (clip-local time)")
    group.add_argument("--spec", help="Trim spec JSON file (e.g. from rm_fillers): its `keeps` are source time")
    args = parser.parse_args()

    project_path, project = find_project(args.project_id)
    # The step rewrites only `tracks`, onto a fresh read under the project lock;
    # this copy is what it read, to notice tracks edited meanwhile.
    original = copy.deepcopy(project)
    items = track_items(project)
    tracks0 = items[0] if items else []

    # Find the clip
    clip_index = None
    clip = None
    for i, c in enumerate(tracks0):
        if c["id"] == args.clip_id:
            clip_index = i
            clip = c
            break
    if clip is None:
        fail("not_found", f"Clip {args.clip_id} not found on tracks[0]")

    if "inPoint" not in clip or "outPoint" not in clip:
        fail("missing_fields",
             f"Clip {args.clip_id} has no inPoint/outPoint yet. Run probe and set them before jump_cut.")

    clip_duration = clip["outPoint"] - clip["inPoint"]

    # Parse ranges
    if args.spec:
        try:
            with open(args.spec) as f:
                spec_keeps = json.load(f)["keeps"]
        except Exception as e:
            fail("invalid_params", f"Could not read keeps from --spec: {e}")
        # A spec's keeps are source time; the clip's window starts at inPoint. null is open-ended.
        lo, hi = clip["inPoint"], clip["outPoint"]
        try:
            keeps = [[(lo if s is None else s) - lo, (hi if e is None else e) - lo] for s, e in spec_keeps]
        except Exception as e:
            fail("invalid_params", f"Bad keeps in --spec: {e}")
    elif args.cuts:
        try:
            cuts = json.loads(args.cuts)
        except Exception as e:
            fail("invalid_params", f"Could not parse --cuts: {e}")
        keeps = cuts_to_keeps(cuts, clip_duration)
    else:
        try:
            keeps = json.loads(args.keeps)
        except Exception as e:
            fail("invalid_params", f"Could not parse --keeps: {e}")

    # Validate ranges
    for s, e in keeps:
        if s < 0 or e > clip_duration + 0.01 or s >= e:
            fail("invalid_params", f"Keep range [{s}, {e}] invalid for clip duration {clip_duration}")

    # Filter out tiny segments (< 0.05s)
    keeps = [[s, e] for s, e in keeps if e - s >= 0.05]
    if not keeps:
        fail("invalid_params", "No keep ranges remain after filtering")

    # Build new clip items. One random part per run (lib/item_ids.py): two
    # copies of a project cutting the same clip must not mint the same ids.
    sfx = id_suffix()
    new_clips = []
    cursor = clip["start"]
    for seg_i, (ks, ke) in enumerate(keeps):
        seg_duration = ke - ks
        new_clip = {
            "id": f"{clip['id']}-seg-{seg_i + 1}-{sfx}",
            "type": clip["type"],
            "src": clip["src"],
            "start": round(cursor, 6),
            "end": round(cursor + seg_duration, 6),
            "inPoint": round(clip["inPoint"] + ks, 6),
            "outPoint": round(clip["inPoint"] + ke, 6),
        }
        # Inherit generation metadata and the fields that keep preview and render on the same source.
        # A normalized cache covers the whole clip window, so any sub-window of it stays valid.
        for key in ("generation", "proxySrc", "sourceWidth", "sourceHeight", "sourceDuration",
                    "normalizedSrc", "normalizedInPoint"):
            if key in clip:
                new_clip[key] = clip[key]
        cursor += seg_duration
        new_clips.append(new_clip)

    # Replace clip and ripple
    tracks0 = ripple_tracks(tracks0, clip_index, 1, new_clips)
    # Only track 0 is rewritten — overlay tracks and their settings survive.
    # Overlay item times are deliberately left where they are; they do not
    # ripple with the primary track's retiming.
    project["tracks"] = replace_track_items(project, 0, tracks0)
    save_project_changes(project_path, original, project)

    total_kept = sum(c["outPoint"] - c["inPoint"] for c in new_clips)
    result = {
        "clips": len(new_clips),
        "removed": round(clip_duration - total_kept, 3),
        "duration": round(total_kept, 3),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
