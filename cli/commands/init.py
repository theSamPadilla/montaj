#!/usr/bin/env python3
"""montaj init — create an empty project in the current directory."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit
from lib.types.colorspace import ALL_COLOR_SPACES


def register(subparsers):
    p = subparsers.add_parser("init", help="Create an empty project in the current directory")
    p.add_argument("--prompt",   required=True, help="Editing prompt")
    p.add_argument("--workflow", default="clean_cut", help="Workflow name (default: clean_cut)")
    p.add_argument("--name",     help="Project name label")
    p.add_argument(
        "--project-path",
        dest="project_path",
        default=None,
        help=(
            "Relative path (under the workspace root) where this project's "
            "directory should be created. Single segment for flat layouts "
            "(e.g. 'my-project'), multi-segment slash-separated for nested "
            "layouts (e.g. 'teamA/my-project'). When omitted, the directory "
            "name is generated as '<date>-<slug>' from --name."
        ),
    )
    p.add_argument(
        "--color-space",
        dest="color_space",
        choices=("auto",) + ALL_COLOR_SPACES,
        default="auto",
        help="Project working color space. 'auto' (default) detects from clip metadata.",
    )
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
    if args.project_path:
        cmd += ["--project-path", args.project_path]
    # Default 'auto' is omitted to keep CLI invocations clean — init.py also
    # defaults to 'auto', so passing it explicitly is unnecessary noise.
    if args.color_space and args.color_space != "auto":
        cmd += ["--color-space", args.color_space]
    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
