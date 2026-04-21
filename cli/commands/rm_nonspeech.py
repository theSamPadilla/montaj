#!/usr/bin/env python3
"""montaj rm-nonspeech — remove all non-speech regions using whisper word-level timestamps."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags, find_step
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("rm-nonspeech", help="Remove all non-speech regions (whisper word-level)")
    p.add_argument("input", help="Source video file")
    p.add_argument("--model", default="base",
                   choices=["tiny", "base", "medium", "large"],
                   help="Whisper model for speech detection (default: base)")
    p.add_argument("--max-word-gap", type=float, default=0.18,
                   help="Max gap between words to bridge in seconds (default: 0.18)")
    p.add_argument("--sentence-edge", type=float, default=0.10,
                   help="Padding to keep before/after each speech region in seconds (default: 0.10)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        find_step("rm_nonspeech"),
        "--input", args.input,
        "--model", args.model,
        "--max-word-gap", str(args.max_word_gap),
        "--sentence-edge", str(args.sentence_edge),
    ]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
