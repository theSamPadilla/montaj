#!/usr/bin/env python3
"""montaj jump-cut-detect — detect pauses, stutters, and false starts."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("jump-cut-detect", help="Detect pauses, stutters, and false starts (advisory)")
    p.add_argument("input", help="Source video file")
    p.add_argument("--noise", type=int, default=-30,
                   help="Silence noise floor in dB (default: -30)")
    p.add_argument("--min-pause", type=float, default=0.8,
                   help="Minimum silence duration to flag as a pause in seconds (default: 0.8)")
    p.add_argument("--model", default="none",
                   choices=["none", "tiny.en", "base.en", "medium.en", "large"],
                   help="Whisper model for stutter/false-start detection. 'none' = pause detection only (default: none)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "jump_cut_detect.py"),
        "--input", args.input,
        "--noise", str(args.noise),
        "--min-pause", str(args.min_pause),
        "--model", args.model,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
