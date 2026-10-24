#!/usr/bin/env python3
"""Split a clip into sub-clips by removing time ranges. Project-level metadata
operation — no video encoding. The render engine materializes at render time."""
import copy, json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from common import fail, get_duration
from ai_video import find_project, save_project_changes
from lib.project_tracks import track_items, replace_track_items
from lib.item_ids import id_suffix


CARRIED = ("generation", "sourceCrop", "scale", "scaleX", "scaleY", "offsetX", "offsetY", "rotation", "opacity",
           "volume", "muted", "proxySrc", "sourceDuration", "sourceWidth", "sourceHeight", "sourceCreatedAt",
           "normalizedSrc", "normalizedInPoint")


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


def cut_clip(project, project_path, clip_id, *, spec_path=None, spec=None, cuts=None, keeps=None, track_index=0):
    """Split clip `clip_id` of the project's track `track_index` into one item per keep, packed end to end,
    and ripple the rest of that track. Mutates `project["tracks"]` in memory and writes nothing; main() saves.

    Exactly one of spec_path (a trim spec file), spec (the same, already read), cuts or keeps (JSON
    strings of clip-local [start, end] ranges). Returns {clips, removed, duration}. clean_cut calls it
    with a spec dict, in memory, before its one write."""
    items = track_items(project)
    tracks0 = items[track_index] if len(items) > track_index else []

    # Find the clip
    clip_index = None
    clip = None
    for i, c in enumerate(tracks0):
        if c["id"] == clip_id:
            clip_index = i
            clip = c
            break
    if clip is None:
        fail("not_found", f"Clip {clip_id} not found on tracks[{track_index}]")

    if clip.get("speed", 1) != 1 or clip.get("keyframes"):
        fail("unsupported_clip",
             f"Clip {clip_id} has a speed change or keyframes; jump_cut would drop them. Cut it in the editor.")

    base_dir = os.path.dirname(os.path.abspath(project_path))

    def resolve(path):
        return os.path.realpath(path if os.path.isabs(path) else os.path.join(base_dir, path))

    spec_keeps = None
    use_spec = bool(spec_path) or spec is not None
    if use_spec:
        try:
            if spec is None:
                with open(spec_path) as f:
                    spec = json.load(f)
            spec_keeps = spec["keeps"]
        except Exception as e:
            fail("invalid_params", f"Could not read keeps from --spec: {e}")
        spec_input = spec.get("input") if isinstance(spec, dict) else None
        if spec_input:
            owners = {resolve(clip[k]) for k in ("src", "proxySrc") if clip.get(k)}
            if resolve(spec_input) not in owners:
                fail("invalid_params", f"--spec is for {spec_input}, not clip {clip_id}'s {clip.get('src')}")

    if "inPoint" in clip and "outPoint" in clip:
        lo, hi = clip["inPoint"], clip["outPoint"]
    elif use_spec:
        # A clip project/init.py just created is a placeholder: the whole source, in source time.
        lo = 0.0
        hi = clip.get("sourceDuration") or get_duration(resolve(clip["src"]))
    else:
        fail("missing_fields",
             f"Clip {clip_id} has no inPoint/outPoint yet. Run probe and set them before jump_cut.")

    clip_duration = hi - lo

    # Parse ranges
    if use_spec:
        # A spec's keeps are source time; the clip's window starts at lo. null is open-ended.
        try:
            keeps = []
            for ks, ke in spec_keeps:
                ks = 0.0 if ks is None else min(max(ks - lo, 0.0), clip_duration)
                ke = clip_duration if ke is None else min(max(ke - lo, 0.0), clip_duration)
                keeps.append([ks, ke])
        except Exception as e:
            fail("invalid_params", f"Bad keeps in --spec: {e}")
    elif cuts:
        try:
            cuts = json.loads(cuts)
        except Exception as e:
            fail("invalid_params", f"Could not parse --cuts: {e}")
        keeps = cuts_to_keeps(cuts, clip_duration)
    else:
        try:
            keeps = json.loads(keeps)
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
            "inPoint": round(lo + ks, 6),
            "outPoint": round(lo + ke, 6),
        }
        # Inherit what the human set and what keeps preview and render on the same source. A normalized
        # cache covers the whole clip window, so any sub-window of it stays valid.
        for key in CARRIED:
            if key in clip:
                new_clip[key] = clip[key]
        if "normalizedSrc" in clip and "normalizedInPoint" not in clip:
            # A legacy cache starts at the clip's inPoint, not at 0 of the source.
            new_clip["normalizedInPoint"] = lo
        cursor += seg_duration
        new_clips.append(new_clip)

    # Replace clip and ripple
    tracks0 = ripple_tracks(tracks0, clip_index, 1, new_clips)
    # Only track 0 is rewritten — overlay tracks and their settings survive.
    # Overlay item times are deliberately left where they are; they do not
    # ripple with the primary track's retiming.
    project["tracks"] = replace_track_items(project, track_index, tracks0)

    total_kept = sum(c["outPoint"] - c["inPoint"] for c in new_clips)
    return {
        "clips": len(new_clips),
        "removed": round(clip_duration - total_kept, 3),
        "duration": round(total_kept, 3),
    }


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
    result = cut_clip(project, project_path, args.clip_id, spec_path=args.spec, cuts=args.cuts, keeps=args.keeps)
    save_project_changes(project_path, original, project)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
