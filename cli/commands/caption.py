#!/usr/bin/env python3
"""montaj caption — prepare caption data for the render engine."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags, find_step
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("caption", help="Prepare caption track from a transcript")
    p.add_argument("input", help="Word-level transcript JSON from montaj transcribe")
    p.add_argument("--style", default="word-by-word",
                   choices=["word-by-word", "pop", "karaoke", "subtitle"],
                   help="Caption style (default: word-by-word)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        find_step("caption"),
        "--input", args.input,
        "--style", args.style,
    ]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
