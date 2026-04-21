#!/usr/bin/env python3
"""montaj probe — extract metadata from a video file."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags, find_step
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("probe", help="Extract metadata from a video file")
    p.add_argument("input", help="Video file to probe")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        find_step("probe"),
        "--input", args.input,
    ]
    if args.out:
        cmd += ["--out", args.out]
    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
