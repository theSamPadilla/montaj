#!/usr/bin/env python3
"""Waveform-based silence detection — reports keep ranges as a trim spec, no video encode."""
import json, os, re, sys, argparse
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, run, get_duration


def process_one(input_path: str, threshold: str, min_silence: str) -> dict:
    require_file(input_path)
    dur = get_duration(input_path)

    # Detect silences
    r = run(
        ["ffmpeg", "-i", input_path,
         "-af", f"silencedetect=noise={threshold}dB:d={min_silence}",
         "-f", "null", "-"],
        check=False,
    )

    silences = []
    cs = None
    for line in r.stderr.split("\n"):
        s = re.search(r"silence_start: ([\d.]+)", line)
        e = re.search(r"silence_end: ([\d.]+)", line)
        if s:
            cs = float(s.group(1))
        if e and cs is not None:
            silences.append((cs, float(e.group(1))))
            cs = None
    if cs is not None:
        silences.append((cs, dur))

    # Merge silences closer than 50ms
    merged = []
    for ss, se in sorted(silences):
        if merged and ss - merged[-1][1] < 0.05:
            merged[-1] = (merged[-1][0], max(merged[-1][1], se))
        else:
            merged.append((ss, se))

    # Compute keep ranges
    keeps = []
    pos = 0.0
    for ss, se in merged:
        if ss - pos > 0.05:
            keeps.append([pos, ss])
        pos = se
    if dur - pos > 0.05:
        keeps.append([pos, dur])

    if not keeps:
        fail("no_speech", f"No speech detected in {input_path}")

    return {"input": input_path, "keeps": keeps}


def main():
    parser = argparse.ArgumentParser(description="Remove silence using waveform amplitude analysis")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--input",        help="Single source video file")
    group.add_argument("--inputs",       nargs="+", metavar="FILE", help="Multiple source files (processed in parallel)")
    parser.add_argument("--threshold",   default="-30", help="Silence threshold in dB (default: -30)")
    parser.add_argument("--min-silence", default="0.3", help="Minimum silence duration to remove in seconds (default: 0.3)")
    parser.add_argument("-P", "--parallel", type=int, default=0, help="Max parallel workers (default: number of inputs)")
    args = parser.parse_args()

    if args.input:
        print(json.dumps(process_one(args.input, args.threshold, args.min_silence)))
    else:
        workers = args.parallel or len(args.inputs)
        results: dict[int, dict] = {}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(process_one, path, args.threshold, args.min_silence): i
                for i, path in enumerate(args.inputs)
            }
            for future in as_completed(futures):
                idx = futures[future]
                results[idx] = future.result()
        print(json.dumps([results[i] for i in range(len(args.inputs))]))


if __name__ == "__main__":
    main()
