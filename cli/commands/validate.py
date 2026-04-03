#!/usr/bin/env python3
"""montaj validate — validate step, project, or workflow JSON files."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT
from cli.output import emit


def register(subparsers):
    p = subparsers.add_parser("validate", help="Validate a step, project, or workflow JSON file")
    sub = p.add_subparsers(dest="kind", required=False)

    sp = sub.add_parser("step",     help="Validate a step schema (.json)")
    sp.add_argument("filename", help="Path to step .json file")
    sp.set_defaults(func=handle)

    pp = sub.add_parser("project",  help="Validate a project.json file")
    pp.add_argument("filename", help="Path to project.json")
    pp.set_defaults(func=handle)

    wp = sub.add_parser("workflow", help="Validate a workflow .json file")
    wp.add_argument("filename", help="Path to workflow .json file")
    wp.set_defaults(func=handle)

    p.set_defaults(func=lambda args: p.print_help())


def handle(args):
    result = subprocess.run(
        [sys.executable,
         os.path.join(MONTAJ_ROOT, "engine", "validate.py"),
         args.kind, args.filename],
        capture_output=True, text=True,
    )
    emit(result, as_json=False, quiet=False)
