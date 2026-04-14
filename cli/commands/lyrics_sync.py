#!/usr/bin/env python3
"""montaj lyrics-sync — sync lyrics text to audio and output a caption track JSON."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("lyrics-sync", help="Sync lyrics text to audio → caption track JSON")
    p.add_argument("input", help="Audio or video file containing the song")
    p.add_argument("--lyrics", required=True, help="Lyrics text file (one phrase per line)")
    p.add_argument("--model", default="base.en",
                   choices=["tiny.en", "base.en", "medium.en", "large"],
                   help="Whisper model (default: base.en)")
    p.add_argument("--language", default="en", help="Language code (default: en)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")
    if not os.path.isfile(args.lyrics):
        emit_error("not_found", f"Lyrics file not found: {args.lyrics}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "lyrics_sync.py"),
        "--input", args.input,
        "--lyrics", args.lyrics,
        "--model", args.model,
        "--language", args.language,
    ]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=False, quiet=args.quiet)
