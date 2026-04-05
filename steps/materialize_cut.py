#!/usr/bin/env python3
"""Materialise a trim spec (or raw video with cuts) into an encoded H.264 clip.

Three input modes:
  trim spec JSON          → use keeps directly
  raw video + inpoint/outpoint → single-keep window
  raw video + --cuts      → invert cuts into keeps
Modes 2 and 3 can be combined: --inpoint/--outpoint clips the window, then --cuts removes ranges within it.
"""
import json, os, sys, argparse, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run, get_duration
from trim_spec import is_trim_spec, load as load_spec, merge as merge_keeps


EDGE_THRESHOLD = 0.05  # seconds — cuts within 50ms of edges are treated as edge cuts


def build_trim_filter(spec: dict) -> tuple:
    """
    Build (input_flags, filter_complex_string) for a trim spec.
    spec must have "input" (source path) and "keeps" (list of [start, end] pairs).
    """
    input_flags = ["-i", spec["input"]]
    keeps = spec["keeps"]
    n = len(keeps)

    filter_parts = []
    if n == 1:
        s, e = keeps[0]
        filter_parts.append(
            f"[0:v]trim=start={s:.4f}:end={e:.4f},setpts=PTS-STARTPTS,fps=30[vout]"
        )
        filter_parts.append(
            f"[0:a]atrim=start={s:.4f}:end={e:.4f},asetpts=PTS-STARTPTS[aout_raw]"
        )
    else:
        vs  = "".join(f"[vs{i}]" for i in range(n))
        as_ = "".join(f"[as{i}]" for i in range(n))
        filter_parts.append(f"[0:v]split={n}{vs}")
        filter_parts.append(f"[0:a]asplit={n}{as_}")
        for i, (s, e) in enumerate(keeps):
            filter_parts.append(
                f"[vs{i}]trim=start={s:.4f}:end={e:.4f},"
                f"setpts=PTS-STARTPTS,fps=30[vc{i}]"
            )
            filter_parts.append(
                f"[as{i}]atrim=start={s:.4f}:end={e:.4f},"
                f"asetpts=PTS-STARTPTS[ac{i}]"
            )
        seg_in = "".join(f"[vc{i}][ac{i}]" for i in range(n))
        filter_parts.append(f"{seg_in}concat=n={n}:v=1:a=1[vout][aout_raw]")

    filter_parts.append("[aout_raw]aresample=async=1000[aout]")
    return input_flags, ";".join(filter_parts)


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


def main():
    parser = argparse.ArgumentParser(
        description="Materialise a trim spec or raw video segment into an encoded H.264 clip"
    )
    parser.add_argument("--input",    required=True, help="Trim spec JSON or raw video file")
    parser.add_argument("--inpoint",  type=float,    help="Keep from this source time (seconds)")
    parser.add_argument("--outpoint", type=float,    help="Keep to this source time (seconds)")
    parser.add_argument("--cuts",                    help='JSON [[start,end],...] — ranges to remove')
    parser.add_argument("--out",                     help="Output path (default: {stem}_cut.mp4)")
    args = parser.parse_args()

    require_file(args.input)

    # ── Path 1: trim spec ────────────────────────────────────────────────────
    if is_trim_spec(args.input):
        spec = load_spec(args.input)
        require_file(spec["input"])
        keeps = spec["keeps"]
        source = spec["input"]

    # ── Paths 2 & 3: raw video ───────────────────────────────────────────────
    else:
        source = args.input
        duration = get_duration(source)
        inpt  = args.inpoint  if args.inpoint  is not None else 0.0
        outpt = args.outpoint if args.outpoint is not None else duration

        if outpt <= inpt:
            fail("invalid_range", f"--outpoint ({outpt}) must be greater than --inpoint ({inpt})")

        # Base window from inpoint/outpoint
        keeps = [[inpt, outpt]]

        # Subtract --cuts if provided.
        # Note: merge_keeps (from trim_spec) subtracts cut ranges from an existing keeps list.
        # compute_keeps (defined in this file) inverts cuts against a full video duration.
        # Here we already have the base window [[inpt, outpt]], so merge_keeps is correct.
        if args.cuts:
            try:
                cuts_list = json.loads(args.cuts)
            except json.JSONDecodeError as exc:
                fail("invalid_cuts", f"--cuts must be valid JSON: {exc}")
            keeps = merge_keeps(keeps, cuts_list)
            if not keeps:
                fail("invalid_range", "Cuts cover the entire window — nothing would remain")

    if not args.out:
        base = os.path.splitext(os.path.basename(source))[0]
        args.out = os.path.join(os.path.dirname(source), f"{base}_cut.mp4")

    spec = {"input": source, "keeps": keeps}
    input_flags, filter_str = build_trim_filter(spec)
    encode_flags = [
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
    ]

    fd, fc_path = tempfile.mkstemp(suffix=".txt", prefix="materialize_fc_")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(filter_str)
        run([
            "ffmpeg", "-y", *input_flags,
            "-/filter_complex", fc_path,
            "-map", "[vout]", "-map", "[aout]",
            *encode_flags, args.out,
        ])
    finally:
        if os.path.exists(fc_path):
            os.unlink(fc_path)

    check_output(args.out)
    print(args.out)


if __name__ == "__main__":
    main()
