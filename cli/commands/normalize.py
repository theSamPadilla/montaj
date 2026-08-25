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
    from lib.normalize import normalize, normalized_output_path, probe_video, is_normalized
    from lib.common import require_file
    from lib.types.colorspace import detect_from_transfer, is_hdr

    require_file(args.input)

    info = probe_video(args.input)
    if info and is_normalized(args.input, info, args.color_space):
        print(args.input)  # already conformant
        return

    tonemapped = (
        info is not None
        and is_hdr(detect_from_transfer(info.get("color_transfer")))
        and args.color_space == "sdr_bt709"
    )
    out = args.out or normalized_output_path(args.input, args.color_space, tonemapped=tonemapped)

    result = normalize(args.input, out, args.color_space, info=info)
    print(result)
