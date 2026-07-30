#!/usr/bin/env python3
"""Detect shot boundaries in a video from ffmpeg scene scores.

Emits a shot list with per-shot motion statistics. Pure ffmpeg — no model,
no network, no credentials. This is the unit of the B-roll footage index:
a detected shot is the granularity an editor actually cuts at.

Motion is reported two ways because they answer different questions:
  motion_mean — is the camera moving throughout? (pan, push-in, handheld)
  motion_peak — did something happen at some point? (a subject enters, an
                on-screen element animates) — a locked-off shot of an
                animating map screen recording is mean-static but peak-active.
"""
import json, os, re, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import require_file, run, get_duration, ffmpeg_bin

# ffmpeg's metadata:print emits two lines per frame:
#   frame:123 pts:... pts_time:4.1
#   lavfi.scene_score=0.0123
_SCORE_RE = re.compile(r"pts_time:([0-9.]+)\s*\n\s*lavfi\.scene_score=([0-9.]+)")


def frame_scores(path: str, timeout: int) -> list[tuple[float, float]]:
    """Per-frame (timestamp, scene_score) for the whole file."""
    r = run([
        ffmpeg_bin(), "-nostdin", "-i", path,
        "-filter:v", "select='gte(scene,0)',metadata=print:file=-",
        "-f", "null", "-",
    ], timeout=timeout)
    return [(float(m.group(1)), float(m.group(2))) for m in _SCORE_RE.finditer(r.stdout)]


def boundaries(scores, threshold: float, duration: float, min_shot: float) -> list[float]:
    """Cut points, merged so no shot is shorter than min_shot."""
    cuts = [t for t, s in scores if s > threshold and t > 0.0]
    kept: list[float] = []
    prev = 0.0
    for t in cuts:
        if t - prev >= min_shot and duration - t >= min_shot:
            kept.append(t)
            prev = t
    return kept


def shot_motion(scores, start: float, end: float) -> tuple[float, float]:
    """Mean and peak scene score strictly inside a shot.

    The 60ms inset excludes the boundary frames themselves — their scores are
    the cut, not the shot's internal motion.
    """
    inner = [s for t, s in scores if start + 0.06 < t < end - 0.06]
    if not inner:
        return 0.0, 0.0
    return sum(inner) / len(inner), max(inner)


def detect(path: str, threshold: float, min_shot: float, timeout: int) -> dict:
    require_file(path)
    duration = get_duration(path)
    scores = frame_scores(path, timeout)
    edges = [0.0] + boundaries(scores, threshold, duration, min_shot) + [duration]

    shots = []
    for i in range(len(edges) - 1):
        start, end = edges[i], edges[i + 1]
        mean, peak = shot_motion(scores, start, end)
        shots.append({
            "index": i + 1,
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
            "motion_mean": round(mean, 5),
            "motion_peak": round(peak, 5),
        })
    return {"input": path, "duration": round(duration, 3), "shots": shots}


def main():
    parser = argparse.ArgumentParser(description="Detect shot boundaries via ffmpeg scene scores")
    parser.add_argument("--input", required=True, help="Source video file")
    parser.add_argument("--threshold", type=float, default=0.25,
                        help="Scene score above which a frame starts a new shot")
    parser.add_argument("--min-shot", type=float, default=0.4,
                        help="Minimum shot duration in seconds; shorter boundaries are dropped")
    parser.add_argument("--timeout", type=int, default=1800, help="ffmpeg timeout in seconds")
    parser.add_argument("--out", help="Write JSON here instead of stdout")
    args = parser.parse_args()

    result = detect(args.input, args.threshold, args.min_shot, args.timeout)

    if args.out:
        with open(args.out, "w") as f:
            json.dump(result, f, indent=2)
        print(args.out)
    else:
        print(json.dumps(result))


if __name__ == "__main__":
    main()
