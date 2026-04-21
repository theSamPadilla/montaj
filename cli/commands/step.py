#!/usr/bin/env python3
"""montaj step — run a step by name."""
import argparse, glob, json, os, subprocess, sys
from cli.main import MONTAJ_ROOT
from cli.output import emit, emit_error

from cli.help import R, Y, C, D


def register(subparsers):
    p = subparsers.add_parser("step", help="Run a step by name", add_help=False)
    p.add_argument("step_name", nargs="?", metavar="<name>", help="Step to run")
    p.add_argument("step_args", nargs=argparse.REMAINDER, help=argparse.SUPPRESS)
    p.add_argument("-h", "--help", action="store_true", default=False,
                   help="Show available steps and exit")
    p.set_defaults(func=lambda args: handle(args, p))


def handle(args, parser):
    if args.help or not args.step_name:
        _print_help(parser)
        sys.exit(0)

    name = args.step_name.replace("-", "_")
    step_file = _find_step_py(name)
    if not step_file:
        emit_error("not_found", f"Unknown step: {args.step_name}")

    cmd = [sys.executable, step_file] + (args.step_args or [])
    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=False, quiet=False)


def _print_help(parser):
    parser.print_help()
    print(f"\n{Y}available steps{R}:")
    scopes = [
        ("built-in",      os.path.join(MONTAJ_ROOT, "steps")),
        ("user",          os.path.expanduser("~/.montaj/steps")),
        ("project-local", os.path.join(os.getcwd(), "steps")),
    ]
    seen = set()
    seen_names = set()
    found = False
    for scope, directory in scopes:
        real_dir = os.path.realpath(directory)
        if real_dir in seen:
            continue
        seen.add(real_dir)
        json_files = sorted(glob.glob(os.path.join(directory, "*.json")))
        json_files += sorted(glob.glob(os.path.join(directory, "*", "*.json")))
        for path in json_files:
            try:
                with open(path) as f:
                    data = json.load(f)
                name = data.get("name", os.path.splitext(os.path.basename(path))[0])
                if name in seen_names:
                    continue
                seen_names.add(name)
                desc = data.get("description", "")
                print(f"  {C}{name:<24}{R} {desc:<55} {D}[{scope}]{R}")
                found = True
            except (json.JSONDecodeError, OSError):
                pass
    if not found:
        print(f"  {D}no steps found{R}")


def _find_step_py(name):
    scopes = [
        os.path.join(os.getcwd(), "steps"),
        os.path.expanduser("~/.montaj/steps"),
        os.path.join(MONTAJ_ROOT, "steps"),
    ]
    for directory in scopes:
        # Flat
        path = os.path.join(directory, f"{name}.py")
        if os.path.isfile(path):
            return path
        # Subdirectories
        if os.path.isdir(directory):
            for entry in os.scandir(directory):
                if entry.is_dir() and not entry.name.startswith((".", "_")):
                    path = os.path.join(entry.path, f"{name}.py")
                    if os.path.isfile(path):
                        return path
    return None
