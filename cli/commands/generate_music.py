#!/usr/bin/env python3
"""montaj generate-music — generate a music clip from a text prompt via Lyria 3."""
import subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags, find_step
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser(
        "generate-music",
        help="Generate a music clip from a text prompt (Gemini Lyria 3 Clip)",
    )
    p.add_argument("--prompt",      required=True)
    # --out is provided by add_global_flags
    p.add_argument("--model",       help="Override Lyria model")
    p.add_argument("--seed",        type=int)
    p.add_argument("--with-vocals", dest="with_vocals", action="store_true",
                   help="Allow vocals (default: instrumental-only)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not args.out:
        emit_error("missing_out", "--out is required for generate-music")

    cmd = [
        sys.executable,
        find_step("generate_music"),
        "--prompt", args.prompt,
        "--out",    args.out,
    ]
    if args.model:            cmd += ["--model", args.model]
    if args.seed is not None: cmd += ["--seed", str(args.seed)]
    if args.with_vocals:      cmd += ["--with-vocals"]
    if args.json:             cmd += ["--json"]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
