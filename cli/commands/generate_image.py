#!/usr/bin/env python3
"""montaj generate-image — generate an image via Gemini or OpenAI."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("generate-image", help="Generate an image via Gemini or OpenAI (API)")
    p.add_argument("--prompt", required=True, help="Text description")
    # Do NOT add --out here — add_global_flags(p) already provides it.
    p.add_argument("--provider", default="gemini", choices=["gemini", "openai"],
                   help="Which vendor to use (default: gemini)")
    p.add_argument("--ref-image", dest="ref_image", action="append", default=[],
                   help="Reference image(s), repeatable")
    p.add_argument("--size", default="1024x1024", help="Image dimensions")
    p.add_argument("--aspect-ratio", dest="aspect_ratio",
                   help="Gemini only. Ignored by OpenAI.")
    p.add_argument("--model", help="Override the connector's default model")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not args.out:
        emit_error("missing_out", "--out is required for generate-image")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "generate_image.py"),
        "--prompt",   args.prompt,
        "--out",      args.out,
        "--provider", args.provider,
        "--size",     args.size,
    ]
    if args.aspect_ratio: cmd += ["--aspect-ratio", args.aspect_ratio]
    if args.model:        cmd += ["--model", args.model]
    for ref in args.ref_image:
        cmd += ["--ref-image", ref]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
