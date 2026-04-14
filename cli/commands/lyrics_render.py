#!/usr/bin/env python3
"""montaj lyrics-render — burn caption track text onto a background video using ffmpeg drawtext."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("lyrics-render",
                               help="Render lyrics video with word-by-word caption overlay")
    p.add_argument("--captions",  required=True,
                   help="Caption track JSON from lyrics-sync or caption step")
    p.add_argument("--audio",     required=True,
                   help="Song audio file")
    p.add_argument("--input",     default=None,
                   help="Background video to loop (optional; uses solid color if omitted)")
    p.add_argument("--bg-color",  default="black",
                   help="Background color when no --input (default: black)")
    p.add_argument("--width",     type=int, default=720,
                   help="Output width in pixels (default: 720)")
    p.add_argument("--height",    type=int, default=1280,
                   help="Output height in pixels (default: 1280)")
    p.add_argument("--fps",       type=int, default=30,
                   help="Output frame rate (default: 30)")
    p.add_argument("--fontsize",  type=int, default=72,
                   help="Caption font size (default: 72)")
    p.add_argument("--color",     default="white",
                   help="Caption text color (default: white)")
    p.add_argument("--position",  default="center",
                   choices=["center", "top-left", "bottom-left"],
                   help="Caption position (default: center)")
    p.add_argument("--preview-duration", type=float, default=None,
                   help="Only render this many seconds (for quick previews)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.captions):
        emit_error("not_found", f"Captions file not found: {args.captions}")
    if not os.path.isfile(args.audio):
        emit_error("not_found", f"Audio file not found: {args.audio}")
    if args.input is not None and not os.path.isfile(args.input):
        emit_error("not_found", f"Input video not found: {args.input}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "lyrics_render.py"),
        "--captions", args.captions,
        "--audio",    args.audio,
        "--bg-color", args.bg_color,
        "--width",    str(args.width),
        "--height",   str(args.height),
        "--fps",      str(args.fps),
        "--fontsize", str(args.fontsize),
        "--color",    args.color,
        "--position", args.position,
    ]
    if args.input:
        cmd += ["--input", args.input]
    if args.preview_duration is not None:
        cmd += ["--preview-duration", str(args.preview_duration)]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=False, quiet=args.quiet)
