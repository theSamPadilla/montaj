#!/usr/bin/env python3
"""montaj concat — join multiple clips into one."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("concat", help="Join multiple clips into one")
    p.add_argument("inputs", nargs="+", help="Input video files in order")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not args.out:
        emit_error("missing_argument", "--out is required for concat")
    for path in args.inputs:
        if not os.path.isfile(path):
            emit_error("not_found", f"File not found: {path}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "concat.py"),
        "--inputs", *args.inputs,
    ]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
