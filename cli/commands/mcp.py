#!/usr/bin/env python3
"""montaj mcp — Start the MCP server."""
import os, sys
from cli.main import add_global_flags, MONTAJ_ROOT
from cli.output import emit_error


def register(subparsers):
    p = subparsers.add_parser("mcp", help="Start MCP server")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    server_path = os.path.join(MONTAJ_ROOT, "mcp", "server.js")
    env = os.environ.copy()
    env["MONTAJ_PYTHON"] = sys.executable
    env["MONTAJ_PROJECT_DIR"] = os.getcwd()
    try:
        os.execvpe("node", ["node", server_path], env)
    except FileNotFoundError:
        emit_error("node_not_found", "node is not on PATH — install Node.js to use montaj mcp")
