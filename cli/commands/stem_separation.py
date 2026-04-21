#!/usr/bin/env python3
"""montaj stem-separation — separate audio into stems using Demucs."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags, find_step
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("stem-separation", help="Separate audio into stems (vocals, drums, bass, other)")
    p.add_argument("input", help="Audio or video file to separate")
    p.add_argument("--stems", default="all",
                   help="Comma-separated stems to output: vocals,drums,bass,other or 'all' (default: all)")
    p.add_argument("--model", default="htdemucs",
                   choices=["htdemucs", "htdemucs_ft", "mdx_extra"],
                   help="Demucs model (default: htdemucs)")
    p.add_argument("--out-dir", help="Directory for stem WAV files")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        find_step("stem_separation"),
        "--input", args.input,
        "--stems", args.stems,
        "--model", args.model,
    ]
    if getattr(args, "out_dir", None):
        cmd += ["--out-dir", args.out_dir]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=False, quiet=args.quiet)
