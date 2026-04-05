#!/usr/bin/env python3
"""montaj materialize-cut — materialise a trim spec or raw video segment into an encoded clip."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("materialize-cut", help="Encode a trim spec or video segment into a clip")
    p.add_argument("input", help="Trim spec JSON or video file")
    p.add_argument("--inpoint",  type=float, help="Keep from this source time (seconds)")
    p.add_argument("--outpoint", type=float, help="Keep to this source time (seconds)")
    p.add_argument("--cuts",     help='JSON [[start,end],...] — ranges to remove')
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    if not os.path.isfile(args.input):
        emit_error("not_found", f"File not found: {args.input}")

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "steps", "materialize_cut.py"),
        "--input", args.input,
    ]
    if args.inpoint is not None:
        cmd += ["--inpoint", str(args.inpoint)]
    if args.outpoint is not None:
        cmd += ["--outpoint", str(args.outpoint)]
    if args.cuts:
        cmd += ["--cuts", args.cuts]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
