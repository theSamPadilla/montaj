#!/usr/bin/env python3
"""Materialise a trim spec (or raw video with cuts) into an encoded H.264 clip.

Three input modes:
  trim spec JSON          → use keeps directly
  raw video + inpoint/outpoint → single-keep window
  raw video + --cuts      → invert cuts into keeps
Modes 2 and 3 can be combined: --inpoint/--outpoint clips the window, then --cuts removes ranges within it.

Batch mode (--inputs): materialise multiple clips with capped concurrency (default: 2 workers).
Each encode is a full libx264 pass — running too many in parallel exhausts memory on 4K footage.
"""
import json, os, sys, argparse, tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run, get_duration
from trim_spec import is_trim_spec, load as load_spec, merge as merge_keeps


EDGE_THRESHOLD = 0.05  # seconds — cuts within 50ms of edges are treated as edge cuts
DEFAULT_WORKERS = 2    # max concurrent encodes — each libx264 pass is memory-heavy at 4K


def build_ffmpeg_args(spec: dict) -> tuple:
    """
    Build (input_args, filter_complex_string) using input-level seeking.

    Each keep segment gets its own -ss/-t/-i triple placed before the input flag.
    ffmpeg seeks at the container level — only the requested segment is decoded.
    For multi-keep, the same source file is opened N times with different seek
    windows; streams are normalised and concatenated in the filter graph.

    This avoids the trim/split filter pattern which forces a full file decode
    regardless of the requested segment position.
    """
    source = spec["input"]
    keeps  = spec["keeps"]
    n      = len(keeps)

    input_args = []
    for s, e in keeps:
        input_args += ["-ss", f"{s:.4f}", "-t", f"{e - s:.4f}", "-i", source]

    filter_parts = []
    if n == 1:
        filter_parts.append("[0:v]setpts=PTS-STARTPTS,fps=30[vout]")
        filter_parts.append("[0:a]asetpts=PTS-STARTPTS[aout_raw]")
    else:
        for i in range(n):
            filter_parts.append(f"[{i}:v]setpts=PTS-STARTPTS,fps=30[vc{i}]")
            filter_parts.append(f"[{i}:a]asetpts=PTS-STARTPTS[ac{i}]")
        seg_in = "".join(f"[vc{i}][ac{i}]" for i in range(n))
        filter_parts.append(f"{seg_in}concat=n={n}:v=1:a=1[vout][aout_raw]")

    filter_parts.append("[aout_raw]aresample=async=1000[aout]")
    return input_args, ";".join(filter_parts)


def compute_keeps(duration: float, cuts: list) -> list:
    """Given a list of (start, end) cut ranges, return the kept intervals."""
    cuts_sorted = sorted((max(0.0, float(s)), min(duration, float(e))) for s, e in cuts)
    keeps = []
    cursor = 0.0
    for s, e in cuts_sorted:
        if e <= s:
            continue
        if s > cursor + EDGE_THRESHOLD:
            keeps.append([cursor, s])
        cursor = max(cursor, e)
    if cursor < duration - EDGE_THRESHOLD:
        keeps.append([cursor, duration])
    if not keeps:
        fail("invalid_range", "Cuts cover the entire file — nothing would remain")
    return keeps


def _encode_one(source: str, keeps: list, out_path: str) -> str:
    """Encode a single clip. Returns out_path on success, raises on failure."""
    spec = {"input": source, "keeps": keeps}
    input_args, filter_str = build_ffmpeg_args(spec)
    encode_flags = [
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
    ]
    fd, fc_path = tempfile.mkstemp(suffix=".txt", prefix="materialize_fc_")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(filter_str)
        run([
            "ffmpeg", "-y", *input_args,
            "-/filter_complex", fc_path,
            "-map", "[vout]", "-map", "[aout]",
            *encode_flags, out_path,
        ])
    finally:
        if os.path.exists(fc_path):
            os.unlink(fc_path)
    check_output(out_path)
    return out_path


def _resolve_input(path: str) -> tuple:
    """Return (source, keeps) for a trim spec or raw video path."""
    require_file(path)
    if is_trim_spec(path):
        spec = load_spec(path)
        require_file(spec["input"])
        return spec["input"], spec["keeps"]
    # Raw video with no cuts — full file as single keep
    duration = get_duration(path)
    return path, [[0.0, duration]]


def main():
    parser = argparse.ArgumentParser(
        description="Materialise a trim spec or raw video segment into an encoded H.264 clip"
    )
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--input",  help="Trim spec JSON or raw video file")
    input_group.add_argument("--inputs", nargs="+", help="Multiple trim specs or video files (batch mode)")

    parser.add_argument("--inpoint",  type=float, help="Keep from this source time (seconds). --input only.")
    parser.add_argument("--outpoint", type=float, help="Keep to this source time (seconds). --input only.")
    parser.add_argument("--cuts",                 help='JSON [[start,end],...] — ranges to remove. --input only.')
    parser.add_argument("--out",                  help="Output path (default: {stem}_cut.mp4). --input only.")
    parser.add_argument(
        "--workers", type=int, default=DEFAULT_WORKERS,
        help=f"Max concurrent encodes in batch mode (default: {DEFAULT_WORKERS}). "
             "Each libx264 pass is memory-heavy — do not raise above 3 for 4K footage.",
    )
    args = parser.parse_args()

    # ── Single input ──────────────────────────────────────────────────────────
    if args.input:
        require_file(args.input)

        if is_trim_spec(args.input):
            spec = load_spec(args.input)
            require_file(spec["input"])
            keeps  = spec["keeps"]
            source = spec["input"]
        else:
            source   = args.input
            duration = get_duration(source)
            inpt     = args.inpoint  if args.inpoint  is not None else 0.0
            outpt    = args.outpoint if args.outpoint is not None else duration

            if outpt <= inpt:
                fail("invalid_range", f"--outpoint ({outpt}) must be greater than --inpoint ({inpt})")

            keeps = [[inpt, outpt]]

            if args.cuts:
                try:
                    cuts_list = json.loads(args.cuts)
                except json.JSONDecodeError as exc:
                    fail("invalid_cuts", f"--cuts must be valid JSON: {exc}")
                keeps = merge_keeps(keeps, cuts_list)
                if not keeps:
                    fail("invalid_range", "Cuts cover the entire window — nothing would remain")

        if not args.out:
            base     = os.path.splitext(os.path.basename(source))[0]
            args.out = os.path.join(os.path.dirname(source), f"{base}_cut.mp4")

        print(_encode_one(source, keeps, args.out))

    # ── Batch input ───────────────────────────────────────────────────────────
    else:
        if args.inpoint is not None or args.outpoint is not None or args.cuts or args.out:
            fail("invalid_args", "--inpoint, --outpoint, --cuts, and --out are not valid with --inputs")

        jobs = []
        for path in args.inputs:
            source, keeps = _resolve_input(path)
            base     = os.path.splitext(os.path.basename(source))[0]
            out_path = os.path.join(os.path.dirname(source), f"{base}_cut.mp4")
            jobs.append((source, keeps, out_path))

        results = [None] * len(jobs)
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(_encode_one, src, keeps, out): i for i, (src, keeps, out) in enumerate(jobs)}
            for future in as_completed(futures):
                idx = futures[future]
                results[idx] = future.result()  # raises on encode failure

        print(json.dumps(results))


if __name__ == "__main__":
    main()
