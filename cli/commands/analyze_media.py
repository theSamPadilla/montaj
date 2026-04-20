#!/usr/bin/env python3
"""montaj analyze-media — analyze a media file (video, audio, or image) with Gemini Flash."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("analyze-media", help="Analyze a media file (video, audio, or image) with Gemini Flash (API)")
    p.add_argument("input", help="Media file (video, audio, or image)")
    p.add_argument("--prompt", required=True, help="Question or instruction")
    p.add_argument("--model", default="gemini-2.5-flash")
    p.add_argument("--json-output", dest="json_output", action="store_true",
                   help="Ask the model to return structured JSON")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "analyze_media.py"),
        "--input",  args.input,
        "--prompt", args.prompt,
        "--model",  args.model,
    ]
    if args.json_output: cmd += ["--json-output"]
    if args.out:         cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
