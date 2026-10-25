#!/usr/bin/env python3
"""Waveform-based silence detection — reports keep ranges as a trim spec, no video encode."""
import json, math, os, re, sys, argparse
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, run, get_duration, ffmpeg_bin, ff_seconds, ff_input
from parallelism import batch_workers


# ── the 10 ms RMS reading of a source (§558 cut v5): one definition, shared with tests/cut_checks.py ──────────

FRAME_S = 0.01          # one RMS frame
SPEECH_PERCENTILE = 95  # a source's speech level: this percentile of its frames


def percentile(vals, p):
    """The p-th percentile of vals, linearly interpolated between the two nearest ranks (numpy's default)."""
    vals = sorted(vals)
    if not vals:
        raise ValueError("percentile of no values")
    pos = (len(vals) - 1) * p / 100.0
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(vals) - 1)
    return vals[lo] + (vals[hi] - vals[lo]) * (pos - lo)


def speech_level(frames_db) -> float:
    """A source's speech level: the SPEECH_PERCENTILE-th percentile of its 10 ms RMS frames, in dB."""
    return percentile(frames_db, SPEECH_PERCENTILE)


def flat_runs(frames_db, level):
    """[(first frame, end frame)) of each run of frames under `level` dB (flat), in order."""
    out, k, n = [], 0, len(frames_db)
    while k < n:
        if frames_db[k] < level:
            m = k
            while m < n and frames_db[m] < level:
                m += 1
            out.append((k, m))
            k = m
        else:
            k += 1
    return out


def envelope_silences(frames_db, threshold, min_silence, frame_s=FRAME_S):
    """The silences of a 10 ms RMS reading, as process_one's `silences`: every run of frames under `threshold` dB
    lasting `min_silence` seconds or more, as (start, end) seconds. silencedetect reads sample peaks instead, so
    soft bursts of noise (peaks some 10 dB over their RMS) break up a silence it would otherwise find."""
    need = int(round(min_silence / frame_s))
    return [(round(a * frame_s, 6), round(b * frame_s, 6)) for a, b in flat_runs(frames_db, threshold)
            if b - a >= need]


def process_one(input_path: str, threshold: float, min_silence: float, silences=None, min_keep: float = 0.05,
                duration: float | None = None) -> dict:
    """The keep ranges of `input_path`: what lies between its silences. silences: (start, end) seconds already
    found (cut passes envelope_silences of its own reading); None finds them with ffmpeg's silencedetect at
    `threshold` dB over `min_silence` s. min_keep: a keep this short or shorter between two silences (or at an
    end) is dropped, and silences closer than it merge; cut passes 0.0, so no sound is ever dropped. duration:
    the source's length, when the caller measured it."""
    require_file(input_path)
    dur = get_duration(input_path) if duration is None else float(duration)

    if silences is None:
        # Detect silences. Both values are floats, never caller text: text here is spliced into the
        # filter graph, where a `,` adds a filter that can write any file ffmpeg reaches (§563).
        r = run(
            [ffmpeg_bin(), "-i", ff_input(input_path),
             "-af", f"silencedetect=noise={float(threshold)}dB:d={ff_seconds(float(min_silence))}",
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

    # Merge silences closer than min_keep (50ms by default)
    merged = []
    for ss, se in sorted(silences):
        if merged and ss - merged[-1][1] < min_keep:
            merged[-1] = (merged[-1][0], max(merged[-1][1], se))
        else:
            merged.append((ss, se))

    # Compute keep ranges
    keeps = []
    pos = 0.0
    for ss, se in merged:
        if ss - pos > min_keep:
            keeps.append([pos, ss])
        pos = se
    if dur - pos > min_keep:
        keeps.append([pos, dur])

    if not keeps:
        fail("no_speech", f"No speech detected in {input_path}")

    return {"input": input_path, "keeps": keeps}


def main():
    parser = argparse.ArgumentParser(description="Remove silence using waveform amplitude analysis")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--input",        help="Single source video file")
    group.add_argument("--inputs",       nargs="+", metavar="FILE", help="Multiple source files (processed in parallel)")
    parser.add_argument("--threshold",   type=float, default=-30.0, help="Silence threshold in dB (default: -30)")
    parser.add_argument("--min-silence", type=float, default=0.3, help="Minimum silence duration to remove in seconds (default: 0.3)")
    parser.add_argument("-P", "--parallel", type=int, default=0, help="Max parallel workers (default and ceiling: what the machine can hold, at most 4)")
    parser.add_argument("--out",
                        help="Write the trim spec JSON to this file (single --input only) instead of "
                             "printing it, and print {\"path\": \"<abs path>\"} instead. Pass that path "
                             "as --input to a downstream step (e.g. rm_nonspeech) to chain without an "
                             "intermediate write_file.")
    args = parser.parse_args()
    if not (math.isfinite(args.threshold) and math.isfinite(args.min_silence)):
        fail("invalid_args", "--threshold and --min-silence must be finite numbers")

    if args.input:
        spec = process_one(args.input, args.threshold, args.min_silence)
        if args.out:
            out_path = os.path.abspath(args.out)
            out_dir = os.path.dirname(out_path)
            if out_dir:
                os.makedirs(out_dir, exist_ok=True)
            with open(out_path, "w") as f:
                json.dump(spec, f)
            print(json.dumps({"path": out_path}))
        else:
            print(json.dumps(spec))
    else:
        if args.out:
            fail("invalid_args", "--out is not supported with --inputs (batch mode produces multiple specs)")
        # One ffmpeg per worker, about 600 MB each: capped by cores and free memory (§338).
        workers = batch_workers(len(args.inputs), args.parallel)
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
