#!/usr/bin/env python3
"""montaj pacing — analyze speech pacing and flag slow sections."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("pacing", help="Analyze speech pacing: WPM per window, slow sections")
    p.add_argument("input", help="Source video file")
    p.add_argument("--model", default="base.en",
                   choices=["tiny.en", "base.en", "medium.en", "large"],
                   help="Whisper model for transcription (default: base.en)")
    p.add_argument("--window", type=float, default=5.0,
                   help="Window size in seconds for WPM calculation (default: 5.0)")
    p.add_argument("--slow-threshold", type=float, default=0.7,
                   help="Fraction of avg WPM below which a window is flagged as slow (default: 0.7)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "pacing.py"),
        "--input", args.input,
        "--model", args.model,
        "--window", str(args.window),
        "--slow-threshold", str(args.slow_threshold),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
