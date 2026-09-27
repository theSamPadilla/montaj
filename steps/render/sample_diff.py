#!/usr/bin/env python3
"""Compare consecutive sampled frame PNGs for single-frame pops and jump cuts.

Pure Pillow (no ffmpeg, no model, no network). Two independent signals over
the sequence's consecutive pairwise luma differences:

  pops  -- one frame unlike both its neighbours (a rendering glitch): the
           pair diffs on both sides of it are large, but the two-frame skip
           diff across it stays small. Fast real motion has a large skip
           diff too, and a clean cut has a small diff on one side, so
           neither is flagged.
  jumps -- one pair carries far more change than the rest of the sequence
           (e.g. a flood that should have eased over several frames landing
           in one): flagged against the median of every OTHER pair's diff.
           Needs at least 3 pairs, and never reports a pair that a pop
           already claimed.

With exactly two frames there is one pair and nothing to compare it against:
the report is that pair's diff alone, with empty pops/jumps. This is the
loop-seam form -- comparing a looping piece's first and last sampled frames.
"""
import argparse, json, os, statistics, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file

DEFAULT_SPIKE_RATIO = 3.0
DEFAULT_FLOOR = 2.0


def _luma_diff(path_a, path_b):
    """Mean absolute luma difference between two PNGs (0-255 scale)."""
    from PIL import Image, ImageChops, ImageStat

    a = Image.open(path_a).convert("L")
    b = Image.open(path_b).convert("L")
    if a.size != b.size:
        fail(
            "size_mismatch",
            f"{path_a} is {a.size[0]}x{a.size[1]}, {path_b} is "
            f"{b.size[0]}x{b.size[1]} -- frames must be the same size",
        )
    return ImageStat.Stat(ImageChops.difference(a, b)).mean[0]


def diff_frames(frames, spike_ratio=DEFAULT_SPIKE_RATIO, floor=DEFAULT_FLOOR):
    """Compare consecutive frames in time order; return the report dict."""
    n = len(frames)
    diffs = [_luma_diff(frames[i], frames[i + 1]) for i in range(n - 1)]

    if n == 2:
        return {"diff": round(diffs[0], 3), "pops": [], "jumps": []}

    pairs = [
        {"a": frames[i], "b": frames[i + 1], "diff": round(diffs[i], 3)}
        for i in range(n - 1)
    ]

    pops = []
    pop_frames = set()
    for i in range(1, n - 1):
        d_prev = diffs[i - 1]
        d_next = diffs[i]
        d_skip = _luma_diff(frames[i - 1], frames[i + 1])
        worst = min(d_prev, d_next)
        if worst > floor and worst > spike_ratio * max(d_skip, floor):
            pops.append({
                "frame": i,
                "path": frames[i],
                "d_prev": round(d_prev, 3),
                "d_next": round(d_next, 3),
                "d_skip": round(d_skip, 3),
            })
            pop_frames.add(i)

    # A pair spans frames j and j+1; it is not eligible to be reported as a
    # jump if either end is a frame a pop already claimed.
    pop_pairs = {
        j for j in range(n - 1)
        if j in pop_frames or (j + 1) in pop_frames
    }

    jumps = []
    if (n - 1) >= 3:
        for i in range(n - 1):
            if i in pop_pairs:
                continue
            others = diffs[:i] + diffs[i + 1:]
            med = statistics.median(others)
            if diffs[i] > floor and diffs[i] > spike_ratio * med:
                jumps.append({
                    "pair": i,
                    "diff": round(diffs[i], 3),
                    "median_others": round(med, 3),
                })

    return {
        "pairs": pairs,
        "mean": round(sum(diffs) / len(diffs), 3),
        "max": round(max(diffs), 3),
        "pops": pops,
        "jumps": jumps,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Compare consecutive sampled frame PNGs for single-frame pops and jump cuts"
    )
    parser.add_argument(
        "--frames", dest="frames", action="append", nargs="+", required=True,
        help="Sampled frame PNGs in time order (>= 2). Repeatable: pass "
             "'--frames a b c' or '--frames a --frames b --frames c'.",
    )
    parser.add_argument(
        "--spike-ratio", type=float, default=DEFAULT_SPIKE_RATIO,
        help=f"How many times a pair's diff must exceed the comparison diff "
             f"before it is flagged as a pop or jump (default: {DEFAULT_SPIKE_RATIO})",
    )
    parser.add_argument(
        "--floor", type=float, default=DEFAULT_FLOOR,
        help=f"Minimum luma diff (0-255 scale) a pair must clear before it "
             f"can be flagged as a pop or jump (default: {DEFAULT_FLOOR})",
    )
    parser.add_argument("--out", help="Write the JSON here and print {\"path\": ...} instead")
    args = parser.parse_args()

    frames = [p for group in args.frames for p in group]
    if len(frames) < 2:
        fail("invalid_args", "--frames requires at least 2 frame paths")
    for p in frames:
        require_file(p)

    result = diff_frames(frames, args.spike_ratio, args.floor)

    if args.out:
        out_path = os.path.abspath(args.out)
        out_dir = os.path.dirname(out_path)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(result, f)
        print(json.dumps({"path": out_path}))
    else:
        print(json.dumps(result))


if __name__ == "__main__":
    main()
