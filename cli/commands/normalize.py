#!/usr/bin/env python3
"""montaj normalize — normalize a video clip to project working format."""
import os
from cli.main import add_global_flags
from lib.types.colorspace import ALL_COLOR_SPACES, DEFAULT_COLOR_SPACE


def register(subparsers):
    p = subparsers.add_parser("normalize", help="Normalize a video clip to the project's working color space + codec")
    p.add_argument("input", metavar="INPUT", help="Path to video file")
    p.add_argument("--color-space", dest="color_space",
                   choices=ALL_COLOR_SPACES, default=DEFAULT_COLOR_SPACE,
                   help=f"Project working color space (default: {DEFAULT_COLOR_SPACE}).")
    add_global_flags(p)  # adds --out, --json, --quiet
    p.set_defaults(func=handle)


def handle(args):
    from lib.normalize import normalize, probe_video, is_normalized
    from lib.common import require_file

    require_file(args.input)
    out = args.out or f"{args.input.rsplit('.', 1)[0]}_normalized_{args.color_space}.mp4"

    info = probe_video(args.input)
    if info and is_normalized(args.input, info, args.color_space):
        print(args.input)  # already conformant
        return

    result = normalize(args.input, out, args.color_space)
    print(result)
