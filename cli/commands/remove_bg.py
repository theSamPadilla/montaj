#!/usr/bin/env python3
"""montaj remove-bg — remove video background using RVM."""
import os
import subprocess
import sys

from cli.main import find_step


def register(subparsers):
    p = subparsers.add_parser("remove-bg", help="Remove video background (RVM)")
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--input", help="Single source video file")
    group.add_argument("--inputs", nargs="+", help="Multiple source video files")
    p.add_argument("--out", help="Output path (only valid with --input)")
    p.add_argument("--downsample", type=float, default=0.5, help="Downsample ratio (0.25–1.0)")
    p.add_argument("--max-height", type=int, help="Scale the cutout down to at most this display height (even number)")
    p.add_argument("--progress", action="store_true", help="Emit JSON progress lines to stderr")
    p.set_defaults(func=handle)


def handle(args):
    step = find_step("remove_bg")
    cmd = [sys.executable, step]

    if args.input:
        cmd += ["--input", args.input]
        if args.out:
            cmd += ["--out", args.out]
    else:
        cmd += ["--inputs"] + args.inputs

    cmd += ["--downsample", str(args.downsample)]
    if args.max_height is not None:
        cmd += ["--max-height", str(args.max_height)]
    if args.progress:
        cmd.append("--progress")

    r = subprocess.run(cmd)
    sys.exit(r.returncode)
