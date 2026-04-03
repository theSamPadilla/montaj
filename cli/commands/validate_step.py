#!/usr/bin/env python3
"""montaj validate-step — validate a step schema."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT
from cli.output import emit


def register(subparsers):
    p = subparsers.add_parser("validate-step", help="Validate a step schema")
    p.add_argument("name", help="Step name")
    p.add_argument("--project-dir", help="Project root for scope resolution (default: cwd)")
    p.set_defaults(func=handle)


def handle(args):
    project_dir = getattr(args, "project_dir", None) or os.getcwd()
    result = subprocess.run(
        [sys.executable,
         os.path.join(MONTAJ_ROOT, "engine", "validate_step.py"),
         "--step", args.name,
         "--project-dir", project_dir],
        capture_output=True, text=True,
    )
    emit(result, as_json=False, quiet=False)
