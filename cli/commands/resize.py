#!/usr/bin/env python3
"""montaj resize — reframe a clip to a new aspect ratio."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("resize", help="Reframe a clip to a new aspect ratio")
    p.add_argument("input", help="Video file")
    p.add_argument("--ratio", required=True, choices=["9:16", "1:1", "16:9"],
                   help="Target aspect ratio")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "resize.py"),
        "--input", args.input,
        "--ratio", args.ratio,
    ]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
