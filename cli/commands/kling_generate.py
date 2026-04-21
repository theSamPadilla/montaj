#!/usr/bin/env python3
"""montaj kling-generate — generate video via Kling v3 Omni."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags, find_step
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("kling-generate", help="Generate video via Kling v3 Omni (API)")
    p.add_argument("--prompt", required=True, help="Scene description (max 2500 chars)")
    p.add_argument("--first-frame", dest="first_frame", help="Starting image")
    p.add_argument("--last-frame",  dest="last_frame",  help="Ending image (requires --first-frame)")
    p.add_argument("--ref-image",   dest="ref_image", action="append", default=[], help="Reference image (max 3, repeatable)")
    p.add_argument("--duration", type=int, default=5, help="Clip length 3-15s (default 5)")
    p.add_argument("--negative-prompt", dest="negative_prompt")
    p.add_argument("--sound", default="on", choices=["on", "off"])
    p.add_argument("--aspect-ratio", dest="aspect_ratio", default="16:9")
    p.add_argument("--mode", default="std", choices=["std", "pro"])
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not args.out:
        emit_error("missing_out", "--out is required for kling-generate (output .mp4 path)")

    cmd = [
        sys.executable,
        find_step("kling_generate"),
        "--prompt",   args.prompt,
        "--out",      args.out,
        "--duration", str(args.duration),
        "--sound",    args.sound,
        "--aspect-ratio", args.aspect_ratio,
        "--mode",     args.mode,
    ]
    if args.first_frame:     cmd += ["--first-frame", args.first_frame]
    if args.last_frame:      cmd += ["--last-frame",  args.last_frame]
    if args.negative_prompt: cmd += ["--negative-prompt", args.negative_prompt]
    for r in args.ref_image: cmd += ["--ref-image", r]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
