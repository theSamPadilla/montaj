#!/usr/bin/env python3
"""montaj adaptor — Call an external AI generation adaptor."""
import os, sys
from cli.main import add_global_flags, MONTAJ_ROOT
from cli.output import emit_error


def _find_adaptor_js(name: str) -> str:
    """Resolve adaptor.js across three scopes. Last scope (project-local) wins."""
    scopes = [
        os.path.join(MONTAJ_ROOT, "adaptors", name),
        os.path.join(os.path.expanduser("~"), ".montaj", "adaptors", name),
        os.path.join(os.getcwd(), "adaptors", name),
    ]
    found = None
    for scope in scopes:
        js = os.path.join(scope, "adaptor.js")
        if os.path.isfile(js):
            found = js
    return found


def register(subparsers):
    p = subparsers.add_parser("adaptor", help="Call an external AI generation adaptor")
    p.add_argument("name",        help="Adaptor name (e.g. stitch, veo, elevenlabs)")
    p.add_argument("description", help="What to generate (plain text description)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    js_path = _find_adaptor_js(args.name)
    if not js_path:
        emit_error("adaptor_not_found", f"Adaptor '{args.name}' not found. Check adaptors/ directory.")

    env = os.environ.copy()
    env["MONTAJ_ROOT"]        = MONTAJ_ROOT
    env["MONTAJ_PROJECT_DIR"] = os.getcwd()

    cmd = ["node", js_path, args.description]
    if args.out:
        cmd += ["--out", args.out]

    try:
        os.execvpe("node", cmd, env)
    except FileNotFoundError:
        emit_error("node_not_found", "node is not on PATH — install Node.js to use montaj adaptor")
