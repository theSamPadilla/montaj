#!/usr/bin/env python3
"""montaj transcribe — transcribe audio/video to SRT and word-level JSON."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags, find_step
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("transcribe", help="Transcribe audio/video to SRT and word-level JSON")
    p.add_argument("input", help="Audio or video file")
    p.add_argument("--model", default="base.en",
                   choices=["tiny.en", "base.en", "medium.en", "tiny", "base", "medium", "large", "large-v3"],
                   help="Whisper model (default: base.en). *.en models auto-upgrade to "
                        "multilingual when --language is non-English.")
    p.add_argument("--language", default="en", help="Language code (default: en), or 'auto'")
    p.add_argument("--max-context", type=int, default=None,
                   help="whisper.cpp -mc; set 0 to disable cross-window context and "
                        "prevent repetition-loop hallucinations on long audio")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        find_step("transcribe"),
        "--input", args.input,
        "--model", args.model,
        "--language", args.language,
    ]
    if args.max_context is not None:
        cmd += ["--max-context", str(args.max_context)]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=False, quiet=args.quiet)  # transcribe returns JSON already
