#!/usr/bin/env python3
"""montaj best-take — score takes by speech confidence and delivery quality."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("best-take", help="Score takes by speech confidence and delivery, ranked best-first")
    p.add_argument("input", help="Source video file")
    p.add_argument("--model", default="base.en",
                   choices=["tiny.en", "base.en", "medium.en", "large"],
                   help="Whisper model for transcription (default: base.en)")
    p.add_argument("--min-pause", type=float, default=2.0,
                   help="Minimum pause between words to define a take boundary in seconds (default: 2.0)")
    p.add_argument("--min-words", type=int, default=5,
                   help="Minimum words in a take to include in results (default: 5)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "best_take.py"),
        "--input", args.input,
        "--model", args.model,
        "--min-pause", str(args.min_pause),
        "--min-words", str(args.min_words),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
