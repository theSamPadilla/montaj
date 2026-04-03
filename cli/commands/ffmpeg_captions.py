#!/usr/bin/env python3
"""montaj ffmpeg-captions — burn static text captions into a video."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("ffmpeg-captions", help="Burn static text captions into a video")
    p.add_argument("input", help="Source video file")
    p.add_argument("--text", required=True, help="Text to display")
    p.add_argument("--fontsize", type=int, default=48,
                   help="Font size in pixels (default: 48)")
    p.add_argument("--position", default="center", choices=["center", "top", "bottom"],
                   help="Text position (default: center)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "ffmpeg_captions.py"),
        "--input", args.input,
        "--text", args.text,
        "--fontsize", str(args.fontsize),
        "--position", args.position,
    ]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
