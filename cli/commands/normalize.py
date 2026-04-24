#!/usr/bin/env python3
"""montaj normalize — normalize a video clip to project working format."""
import os
from cli.main import add_global_flags


def register(subparsers):
    p = subparsers.add_parser("normalize", help="Normalize a video clip to project format (H.264, yuv420p, bt709)")
    p.add_argument("input", metavar="INPUT", help="Path to video file")
    p.add_argument("--width", type=int, default=1920)
    p.add_argument("--height", type=int, default=1080)
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--crf", type=int, default=16)
    add_global_flags(p)  # adds --out, --json, --quiet
    p.set_defaults(func=handle)


def handle(args):
    from lib.normalize import normalize, probe_video, is_normalized
    from lib.common import require_file

    require_file(args.input)
    out = args.out or args.input.rsplit(".", 1)[0] + "_normalized.mp4"

    info = probe_video(args.input)
    if info and is_normalized(args.input, info, args.width, args.height, args.fps):
        print(args.input)  # already conformant
        return

    normalize(args.input, out, args.width, args.height, args.fps, args.crf)
