#!/usr/bin/env python3
"""montaj extract-audio — extract the audio track from a video."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags, find_step
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("extract-audio", help="Extract the audio track from a video")
    p.add_argument("input", help="Source video file")
    p.add_argument("--format", default="wav", choices=["wav", "mp3", "aac"],
                   help="Output audio format (default: wav)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        find_step("extract_audio"),
        "--input", args.input,
        "--format", args.format,
    ]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
