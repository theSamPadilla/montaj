#!/usr/bin/env python3
"""montaj init — create an empty project in the current directory."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit


def register(subparsers):
    p = subparsers.add_parser("init", help="Create an empty project in the current directory")
    p.add_argument("--prompt",   required=True, help="Editing prompt")
    p.add_argument("--workflow", default="basic_trim", help="Workflow name (default: basic_trim)")
    p.add_argument("--name",     help="Project name label")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "project", "init.py"),
        "--prompt", args.prompt,
        "--workflow", args.workflow,
    ]
    if args.name:
        cmd += ["--name", args.name]
    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
