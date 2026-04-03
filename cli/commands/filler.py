#!/usr/bin/env python3
"""montaj filler — remove filler words (um, uh, etc.) from a video."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("filler", help="Remove filler words (um, uh, etc.) from a video")
    p.add_argument("input", help="Source video file")
    p.add_argument("--model", default="base.en",
                   choices=["tiny.en", "base.en", "medium.en", "large"],
                   help="Whisper model for filler detection (default: base.en)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "rm_fillers.py"),
        "--input", args.input,
        "--model", args.model,
    ]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
