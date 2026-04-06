#!/usr/bin/env python3
"""montaj materialize-cut — materialise a trim spec or raw video segment into an encoded clip."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error

DEFAULT_WORKERS = 2


def register(subparsers):
    p = subparsers.add_parser("materialize-cut", help="Encode a trim spec or video segment into a clip")

    input_group = p.add_mutually_exclusive_group(required=True)
    input_group.add_argument("input", nargs="?", help="Trim spec JSON or video file")
    input_group.add_argument("--inputs", nargs="+", metavar="FILE",
                             help="Multiple trim specs or video files — processed with capped concurrency")

    p.add_argument("--inpoint",  type=float, help="Keep from this source time (seconds). Single input only.")
    p.add_argument("--outpoint", type=float, help="Keep to this source time (seconds). Single input only.")
    p.add_argument("--cuts",     help='JSON [[start,end],...] — ranges to remove. Single input only.')
    p.add_argument("--workers",  type=int, default=DEFAULT_WORKERS,
                   help=f"Max concurrent encodes for --inputs (default: {DEFAULT_WORKERS}). "
                        "Do not raise above 3 for 4K footage.")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    step = os.path.join(MONTAJ_ROOT, "steps", "materialize_cut.py")

    if args.inputs:
        cmd = [sys.executable, step, "--inputs", *args.inputs, "--workers", str(args.workers)]
    else:
        if not args.input:
            emit_error("missing_input", "Provide a positional input file or use --inputs")
        if not os.path.isfile(args.input):
            emit_error("not_found", f"File not found: {args.input}")
        cmd = [sys.executable, step, "--input", args.input]
        if args.inpoint  is not None: cmd += ["--inpoint",  str(args.inpoint)]
        if args.outpoint is not None: cmd += ["--outpoint", str(args.outpoint)]
        if args.cuts:                 cmd += ["--cuts",     args.cuts]
        if args.out:                  cmd += ["--out",      args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
