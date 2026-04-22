#!/usr/bin/env python3
"""Rapid montage: extract short beats from multiple clips and concatenate them.
Project-level metadata operation — no video encoding."""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from common import fail
from ai_video import find_project, save_project


def main():
    parser = argparse.ArgumentParser(description="Montage: rapid beats from multiple clips")
    parser.add_argument("--project-id", dest="project_id", required=True)
    parser.add_argument("--clips", required=True,
                        help="JSON array of clip IDs to montage, e.g. '[\"clip-1\",\"clip-2\"]'")
    parser.add_argument("--beat-duration", dest="beat_duration", type=float, default=1.0,
                        help="Duration of each beat in seconds (default: 1.0)")
    parser.add_argument("--offset", type=float, default=0.0,
                        help="Start offset within each clip in clip-local seconds (default: 0.0)")
    args = parser.parse_args()

    if args.beat_duration < 0.2:
        fail("invalid_params", "Beat duration must be >= 0.2s")

    try:
        clip_ids = json.loads(args.clips)
    except Exception as e:
        fail("invalid_params", f"Could not parse --clips: {e}")

    if len(clip_ids) < 2:
        fail("invalid_params", "Montage requires at least 2 clips")

    project_path, project = find_project(args.project_id)
    tracks0 = project.get("tracks", [[]])[0]

    # Find all target clips, preserving order from the input list
    clip_map = {c["id"]: (i, c) for i, c in enumerate(tracks0)}
    clips = []
    indices = []
    for cid in clip_ids:
        if cid not in clip_map:
            fail("not_found", f"Clip {cid} not found on tracks[0]")
        idx, clip = clip_map[cid]
        clips.append(clip)
        indices.append(idx)

    # Build montage beats: one beat per clip, round-robin
    # Each beat extracts beat_duration from the clip starting at offset
    new_clips = []
    timeline_start = min(c["start"] for c in clips)
    cursor = timeline_start

    for round_i in range(100):  # safety cap
        any_remaining = False
        for ci, clip in enumerate(clips):
            clip_dur = clip["outPoint"] - clip["inPoint"]
            local_start = args.offset + round_i * args.beat_duration
            local_end = local_start + args.beat_duration

            if local_start >= clip_dur:
                continue
            any_remaining = True
            local_end = min(local_end, clip_dur)
            seg_dur = local_end - local_start

            if seg_dur < 0.05:
                continue

            new_clips.append({
                "id": f"{clip['id']}-m-{round_i + 1}",
                "type": clip["type"],
                "src": clip["src"],
                "start": round(cursor, 6),
                "end": round(cursor + seg_dur, 6),
                "inPoint": round(clip["inPoint"] + local_start, 6),
                "outPoint": round(clip["inPoint"] + local_end, 6),
                "generation": clip.get("generation"),
            })
            cursor += seg_dur

        if not any_remaining:
            break

    if not new_clips:
        fail("invalid_params", "No beats could be extracted (offset exceeds all clip durations)")

    # Strip None generation fields
    for c in new_clips:
        if c.get("generation") is None:
            c.pop("generation", None)

    # Replace original clips with montage sequence
    # Remove all target clips, insert new clips at the earliest position
    target_ids = set(clip_ids)
    first_idx = min(indices)
    old_end = max(c["end"] for c in clips)
    new_end = cursor

    remaining = [c for c in tracks0 if c["id"] not in target_ids]
    before = [c for c in remaining if c["start"] < clips[0]["start"]]
    after = [c for c in remaining if c["start"] >= old_end]

    delta = new_end - old_end
    for c in after:
        c["start"] = round(c["start"] + delta, 6)
        c["end"] = round(c["end"] + delta, 6)

    tracks0 = before + new_clips + after
    project["tracks"] = [tracks0]
    save_project(project_path, project)

    total_dur = sum(c["end"] - c["start"] for c in new_clips)
    result = {
        "clips": len(new_clips),
        "duration": round(total_dur, 3),
        "beat_duration": args.beat_duration,
        "source_clips": len(clip_ids),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
