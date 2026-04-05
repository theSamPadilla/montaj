#!/usr/bin/env python3
"""montaj apply-cuts — apply a trim spec to a single clip."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("apply-cuts", help="Apply a trim spec to a single clip")
    p.add_argument("input", help="Trim spec JSON or video file")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "apply_cuts.py"),
        "--input", args.input,
    ]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
