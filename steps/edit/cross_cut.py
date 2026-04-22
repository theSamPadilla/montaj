#!/usr/bin/env python3
"""Interleave segments from two clips (A-roll / B-roll). Project-level metadata
operation — no video encoding. The render engine materializes at render time."""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from common import fail
from ai_video import find_project, save_project


def segment_clip(clip, seg_duration):
    """Split a clip into fixed-duration segments. Returns list of (local_start, local_end)."""
    clip_dur = clip["outPoint"] - clip["inPoint"]
    segments = []
    cursor = 0.0
    while cursor < clip_dur - 0.01:
        end = min(cursor + seg_duration, clip_dur)
        if end - cursor >= 0.05:  # skip tiny tails
            segments.append((cursor, end))
        cursor = end
    return segments


def main():
    parser = argparse.ArgumentParser(description="Cross-cut: interleave segments from two clips")
    parser.add_argument("--project-id", dest="project_id", required=True)
    parser.add_argument("--clip-a", dest="clip_a", required=True,
                        help="A-roll clip ID")
    parser.add_argument("--clip-b", dest="clip_b", required=True,
                        help="B-roll clip ID")
    parser.add_argument("--segment-duration", dest="segment_duration", type=float, default=1.5,
                        help="Duration of each alternating segment in seconds (default: 1.5)")
    args = parser.parse_args()

    if args.segment_duration < 0.2:
        fail("invalid_params", "Segment duration must be >= 0.2s")

    project_path, project = find_project(args.project_id)
    tracks0 = project.get("tracks", [[]])[0]

    # Find both clips
    clip_a = clip_b = None
    idx_a = idx_b = None
    for i, c in enumerate(tracks0):
        if c["id"] == args.clip_a:
            clip_a, idx_a = c, i
        elif c["id"] == args.clip_b:
            clip_b, idx_b = c, i
    if clip_a is None:
        fail("not_found", f"Clip {args.clip_a} not found on tracks[0]")
    if clip_b is None:
        fail("not_found", f"Clip {args.clip_b} not found on tracks[0]")

    # Segment both clips
    segs_a = segment_clip(clip_a, args.segment_duration)
    segs_b = segment_clip(clip_b, args.segment_duration)

    # Interleave: A1, B1, A2, B2, ...
    # Use min length, then append remaining from whichever is longer
    new_clips = []
    timeline_cursor = min(clip_a["start"], clip_b["start"])
    max_pairs = max(len(segs_a), len(segs_b))

    for i in range(max_pairs):
        # A segment
        if i < len(segs_a):
            ls, le = segs_a[i]
            seg_dur = le - ls
            new_clips.append({
                "id": f"{clip_a['id']}-x-{i + 1}",
                "type": clip_a["type"],
                "src": clip_a["src"],
                "start": round(timeline_cursor, 6),
                "end": round(timeline_cursor + seg_dur, 6),
                "inPoint": round(clip_a["inPoint"] + ls, 6),
                "outPoint": round(clip_a["inPoint"] + le, 6),
                "generation": clip_a.get("generation"),
            })
            timeline_cursor += seg_dur

        # B segment
        if i < len(segs_b):
            ls, le = segs_b[i]
            seg_dur = le - ls
            new_clips.append({
                "id": f"{clip_b['id']}-x-{i + 1}",
                "type": clip_b["type"],
                "src": clip_b["src"],
                "start": round(timeline_cursor, 6),
                "end": round(timeline_cursor + seg_dur, 6),
                "inPoint": round(clip_b["inPoint"] + ls, 6),
                "outPoint": round(clip_b["inPoint"] + le, 6),
                "generation": clip_b.get("generation"),
            })
            timeline_cursor += seg_dur

    # Strip None generation fields
    for c in new_clips:
        if c.get("generation") is None:
            c.pop("generation", None)

    # Replace both original clips with the interleaved sequence.
    # Remove both originals, insert new clips at the earlier position.
    first_idx = min(idx_a, idx_b)
    second_idx = max(idx_a, idx_b)
    # Remove second first (higher index) to preserve lower index
    before = tracks0[:first_idx]
    between = [c for c in tracks0[first_idx + 1:second_idx] if c["id"] not in (args.clip_a, args.clip_b)]
    after = tracks0[second_idx + 1:]

    # Ripple after-clips
    old_end = max(clip_a["end"], clip_b["end"])
    new_end = timeline_cursor
    delta = new_end - old_end
    for c in between + after:
        c["start"] = round(c["start"] + delta, 6)
        c["end"] = round(c["end"] + delta, 6)

    tracks0 = before + new_clips + between + after
    project["tracks"] = [tracks0]
    save_project(project_path, project)

    total_dur = sum(c["end"] - c["start"] for c in new_clips)
    result = {
        "clips": len(new_clips),
        "duration": round(total_dur, 3),
        "segment_duration": args.segment_duration,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
