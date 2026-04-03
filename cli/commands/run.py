#!/usr/bin/env python3
"""montaj run — create a pending project from clips and a prompt."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error

CLIP_EXTENSIONS = {".mp4", ".mov", ".mkv", ".m4v", ".MP4", ".MOV", ".MKV", ".M4V"}


def register(subparsers):
    p = subparsers.add_parser("run", help="Create a pending project from clips and a prompt")
    p.add_argument("clips", nargs="*", help="Clip files or a directory containing clips")
    p.add_argument("--prompt",   required=True, help="Editing prompt")
    p.add_argument("--workflow", default="basic_trim", help="Workflow name (default: basic_trim)")
    p.add_argument("--name",     help="Project name label")
    p.add_argument("--canvas",   action="store_true", help="Canvas project — no source footage required")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if args.canvas and args.clips:
        emit_error("mutually_exclusive", "--canvas and clips are mutually exclusive")

    clip_paths = []
    if not args.canvas:
        for entry in args.clips:
            if os.path.isdir(entry):
                found = sorted(
                    p for p in (os.path.join(entry, f) for f in os.listdir(entry))
                    if os.path.isfile(p) and os.path.splitext(p)[1] in CLIP_EXTENSIONS
                )
                clip_paths.extend(found)
            elif os.path.isfile(entry):
                clip_paths.append(entry)
            else:
                emit_error("not_found", f"Not a file or directory: {entry}")

        if not clip_paths:
            emit_error("no_clips_found", "No clip files found. Supported formats: mp4, mov, mkv, m4v")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "project", "init.py"),
        "--prompt", args.prompt,
        "--workflow", args.workflow,
    ]
    if args.canvas:
        cmd.append("--canvas")
    if clip_paths:
        cmd += ["--clips", *clip_paths]
    if args.name:
        cmd += ["--name", args.name]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
