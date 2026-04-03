#!/usr/bin/env python3
"""montaj render — render project.json [final] to MP4."""
import os
from cli.main import add_global_flags, MONTAJ_ROOT
from project.render import main as render_main


def register(subparsers):
    p = subparsers.add_parser("render", help="Render project.json [final] to MP4")
    p.add_argument("project", nargs="?", metavar="PROJECT", help="Path to project.json (default: ./project.json)")
    p.add_argument("--workers", metavar="N", type=int, help="Puppeteer worker count (default: CPU count)")
    p.add_argument("--clean",   action="store_true",   help="Remove intermediate files after render")
    add_global_flags(p)  # adds --json, --out, --quiet
    p.set_defaults(func=handle)


def handle(args):
    project_path = args.project or (
        "project.json" if os.path.exists("project.json") else None
    )
    if not project_path:
        from cli.output import emit_error
        emit_error("missing_argument", "No project.json found — pass a path or run from a project directory")
    render_main(
        project_path=project_path,
        out=args.out,
        workers=args.workers,
        clean=args.clean,
        montaj_root=MONTAJ_ROOT,
    )
