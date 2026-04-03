#!/usr/bin/env python3
"""montaj trim — cut a clip by in/out points."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("trim", help="Cut a clip by start/end points")
    p.add_argument("input", help="Video file")
    p.add_argument("--start", help="Start time (seconds or HH:MM:SS)")
    p.add_argument("--end", help="End time (seconds or HH:MM:SS)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")
    if not args.end:
        emit_error("invalid_argument", "--end is required")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "trim.py"),
        "--input", args.input,
    ]
    if args.start:
        cmd += ["--start", args.start]
    if args.end:
        cmd += ["--end", args.end]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
