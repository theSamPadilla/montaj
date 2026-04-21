#!/usr/bin/env python3
"""montaj snapshot — generate a frame grid contact sheet from a video."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags, find_step
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("snapshot", help="Generate a frame grid contact sheet from a video")
    p.add_argument("input", help="Source video file")
    p.add_argument("--cols",   type=int,   default=3,    help="Grid columns (default: 3)")
    p.add_argument("--rows",   type=int,   default=3,    help="Grid rows (default: 3)")
    p.add_argument("--start",  type=float, default=None, help="Window start in seconds")
    p.add_argument("--end",    type=float, default=None, help="Window end in seconds")
    p.add_argument("--frames", default=None,
                   help="Frames to sample: integer N (grid) or 'all' (individual files to directory)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        find_step("snapshot"),
        "--input", args.input,
        "--cols", str(args.cols),
        "--rows", str(args.rows),
    ]
    if args.start is not None:
        cmd += ["--start", str(args.start)]
    if args.end is not None:
        cmd += ["--end", str(args.end)]
    if args.frames is not None:
        cmd += ["--frames", args.frames]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
