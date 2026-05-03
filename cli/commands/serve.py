#!/usr/bin/env python3
"""montaj serve — start local HTTP server and UI."""
import os
import sys

from cli.main import add_global_flags
from cli.deps import check_deps, check_ui
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
    p.add_argument(
        "--debug",
        action="store_true",
        help="Stream subprocess stderr (project init, etc.) live to the server's stderr "
             "for observability. Default: subprocess stderr is buffered and only surfaced "
             "on error. Equivalent to setting MONTAJ_DEBUG=1.",
    )
    p.add_argument(
        "--headless",
        action="store_true",
        help="Disable embedded UI (no Vite spawn, no browser auto-open, no SPA "
             "catch-all route). Skips the 'UI is built' check. For sidecar "
             "deployments where the host product provides its own frontend.",
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

    headless = args.headless or os.environ.get("MONTAJ_HEADLESS") == "1"

    if not headless:
        _, ui_error = check_ui()
        if ui_error:
            print(red(f"error: {ui_error}"), file=sys.stderr)
            print(f"\nRun: {bold('montaj install ui')}", file=sys.stderr)
            sys.exit(1)

    host = "0.0.0.0" if args.network else "127.0.0.1"

    if args.network:
        print(
            yellow("WARNING: server is listening on all network interfaces — "
                   "all devices on your local network can reach this server."),
            file=sys.stderr,
        )

    os.environ["MONTAJ_SERVE_PORT"] = str(args.port)
    if args.debug:
        os.environ["MONTAJ_DEBUG"] = "1"
        print(cyan("debug: streaming subprocess stderr (init progress, etc.) live"), file=sys.stderr)
    if headless:
        os.environ["MONTAJ_HEADLESS"] = "1"
        print(cyan("headless: UI disabled (no Vite, no browser, no SPA route)"), file=sys.stderr)
    uvicorn.run(
        "serve.server:app",
        host=host,
        port=args.port,
        log_level="info",
    )
