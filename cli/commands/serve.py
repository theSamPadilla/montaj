#!/usr/bin/env python3
"""montaj serve — start local HTTP server and UI."""
import os
import sys

from cli.main import add_global_flags
from cli.deps import check_deps
from cli.help import bold, green, yellow, cyan, dim, red


def register(subparsers):
    p = subparsers.add_parser("serve", help="Start local HTTP server + UI")
    p.add_argument("--port", type=int, default=3000, help="Port (default: 3000)")
    p.add_argument(
        "--network",
        action="store_true",
        help="Bind to all network interfaces (0.0.0.0) instead of localhost only. "
             "WARNING: exposes the server to all devices on your local network — "
             "only use on trusted networks.",
    )
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    import uvicorn

    missing = check_deps()
    if missing:
        print(red("error: missing dependencies:"), file=sys.stderr)
        for m in missing:
            print(red(f"  • {m}"), file=sys.stderr)
        print(f"\nRun: {bold('montaj install')}", file=sys.stderr)
        sys.exit(1)

    host = "0.0.0.0" if args.network else "127.0.0.1"

    if args.network:
        print(
            yellow("WARNING: server is listening on all network interfaces — "
                   "all devices on your local network can reach this server."),
            file=sys.stderr,
        )

    os.environ["MONTAJ_SERVE_PORT"] = str(args.port)
    uvicorn.run(
        "serve.server:app",
        host=host,
        port=args.port,
        log_level="info",
    )
