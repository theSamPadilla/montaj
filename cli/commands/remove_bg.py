#!/usr/bin/env python3
"""montaj remove-bg — remove video background using RVM."""
import os
import subprocess
import sys

from cli.main import find_step


def register(subparsers):
    p = subparsers.add_parser("remove-bg", help="Remove video background (RVM)")
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--input", help="Single source video file")
    group.add_argument("--inputs", nargs="+", help="Multiple source video files")
    p.add_argument("--out", help="Output path (only valid with --input)")
    p.add_argument(
        "--model",
        default="rvm_mobilenetv3",
        choices=["rvm_mobilenetv3", "rvm_resnet50"],
        help="RVM model variant",
    )
    p.add_argument("--cpu", action="store_true", help="Force CPU and parallelize via multiprocessing")
    p.add_argument("--workers", type=int, help="Worker count for --cpu mode")
    p.add_argument("--downsample", type=float, default=0.5, help="Downsample ratio (0.25–1.0)")
    p.add_argument("--progress", action="store_true", help="Emit JSON progress lines to stderr")
    p.set_defaults(func=handle)


def handle(args):
    step = find_step("remove_bg")
    cmd = [sys.executable, step]

    if args.input:
        cmd += ["--input", args.input]
        if args.out:
            cmd += ["--out", args.out]
    else:
        cmd += ["--inputs"] + args.inputs

    cmd += ["--model", args.model, "--downsample", str(args.downsample)]

    if args.cpu:
        cmd.append("--cpu")
    if args.workers is not None:
        cmd += ["--workers", str(args.workers)]
    if args.progress:
        cmd.append("--progress")

    r = subprocess.run(cmd)
    sys.exit(r.returncode)
