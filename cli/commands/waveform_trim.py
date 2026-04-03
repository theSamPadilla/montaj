#!/usr/bin/env python3
"""montaj waveform-trim — remove silence using waveform amplitude analysis."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("waveform-trim", help="Remove silence using waveform amplitude analysis")
    p.add_argument("input", nargs="+", help="Source video file(s) — multiple files run in parallel")
    p.add_argument("--threshold", default="-30", help="Silence threshold in dB (default: -30)")
    p.add_argument("--min-silence", default="0.3",
                   help="Minimum silence duration in seconds (default: 0.3)")
    p.add_argument("-P", "--parallel", type=int, default=0,
                   help="Max parallel workers when processing multiple files (default: number of files)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    for f in args.input:
        if not os.path.isfile(f):
            emit_error("not_found", f"File not found: {f}")

    step = os.path.join(MONTAJ_ROOT, "steps", "waveform_trim.py")

    if len(args.input) == 1:
        cmd = [
            sys.executable, step,
            "--input", args.input[0],
            "--threshold", args.threshold,
            "--min-silence", args.min_silence,
        ]
        if args.out:
            cmd += ["--out", args.out]
    else:
        cmd = [
            sys.executable, step,
            "--inputs", *args.input,
            "--threshold", args.threshold,
            "--min-silence", args.min_silence,
        ]
        if args.parallel:
            cmd += ["-P", str(args.parallel)]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
