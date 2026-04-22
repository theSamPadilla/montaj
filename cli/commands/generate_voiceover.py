#!/usr/bin/env python3
"""montaj generate-voiceover — synthesise a voiceover audio file from text."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags, find_step
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser(
        "generate-voiceover",
        help="Synthesise a voiceover audio file from text (Kling or Gemini TTS)",
    )
    p.add_argument("--text",      help="Script text (inline)")
    p.add_argument("--text-file", dest="text_file", help="Path to a file containing the script")
    p.add_argument("--voice",     required=True, help="Voice identifier")
    # --out is provided by add_global_flags
    p.add_argument("--vendor",    default="kling", choices=["kling", "gemini"],
                   help="TTS vendor (default: kling)")
    p.add_argument("--model",     help="Override vendor default model")
    p.add_argument("--speed",     type=float, default=1.0,
                   help="Playback speed (Kling only)")
    p.add_argument("--language",  help="Language hint (Kling only)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not args.out:
        emit_error("missing_out", "--out is required for generate-voiceover")
    if bool(args.text) == bool(args.text_file):
        emit_error("invalid_args", "Pass exactly one of --text or --text-file")
    if args.text_file and not os.path.isfile(args.text_file):
        emit_error("not_found", f"File not found: {args.text_file}")

    cmd = [
        sys.executable,
        find_step("generate_voiceover"),
        "--voice",  args.voice,
        "--out",    args.out,
        "--vendor", args.vendor,
        "--speed",  str(args.speed),
    ]
    if args.text:      cmd += ["--text", args.text]
    if args.text_file: cmd += ["--text-file", args.text_file]
    if args.model:     cmd += ["--model", args.model]
    if args.language:  cmd += ["--language", args.language]
    if args.json:      cmd += ["--json"]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
