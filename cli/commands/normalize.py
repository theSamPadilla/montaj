#!/usr/bin/env python3
"""montaj normalize — loudness normalization (LUFS)."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("normalize", help="Loudness normalization (LUFS)")
    p.add_argument("input", help="Source video or audio file")
    p.add_argument("--target", default="youtube",
                   choices=["youtube", "podcast", "broadcast", "custom"],
                   help="Platform preset: youtube=-14 LUFS, podcast=-16, broadcast=-23 (default: youtube)")
    p.add_argument("--lufs", type=float, default=-14,
                   help="Target LUFS when --target is 'custom' (default: -14)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "normalize.py"),
        "--input", args.input,
        "--target", args.target,
        "--lufs", str(args.lufs),
    ]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
