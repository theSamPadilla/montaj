#!/usr/bin/env python3
"""montaj serve — start local HTTP server and UI."""
import os
import sys

from cli.main import add_global_flags
from cli.deps import check_deps


def register(subparsers):
    p = subparsers.add_parser("serve", help="Start local HTTP server + UI")
    p.add_argument("--port", type=int, default=3000, help="Port (default: 3000)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    import uvicorn

    missing = check_deps()
    if missing:
        print("error: missing dependencies:", file=sys.stderr)
        for m in missing:
            print(f"  • {m}", file=sys.stderr)
        print("\nRun: montaj install", file=sys.stderr)
        sys.exit(1)

    os.environ["MONTAJ_SERVE_PORT"] = str(args.port)
    uvicorn.run(
        "serve.server:app",
        host="0.0.0.0",
        port=args.port,
        log_level="info",
    )
