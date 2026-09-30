#!/usr/bin/env python3
"""montaj log — post an operator-visible progress message.

The native implementation of the `_contract` "log `<message>`" verb
(skills/_contract/SKILL.md), for callers that reach Montaj through the raw
CLI rather than through an interface skill that already knows how to reach `serve`. skills/native/
SKILL.md documents the identical two-mode split for an assistant driving
Montaj directly:

- HTTP mode (`montaj serve` is running): POST {"message": ...} to
  /api/projects/<project>/log (serve/routes/projects.py), which broadcasts a
  `log` SSE frame the UI's activity feed renders live.
- CLI mode (no serve running): print the message to stderr.

Discovery of a running serve is via serve/lockfile.py, NOT the
MONTAJ_SERVE_PORT env var. `montaj log` runs as its own process, separate
from any `montaj serve` process, and MONTAJ_SERVE_PORT is only ever set in
serve's OWN os.environ (cli/commands/serve.py) — a sibling process never
inherits it. montaj_assets/mcp/serve-client.js's docstring documents the
identical problem on the Node/MCP side, solved the same way: a lockfile
serve writes at startup and removes at shutdown.

On top of the message itself, a JSON result is always printed to stdout so a
caller that never sees this process's stderr can tell what happened:
`{"shown": true}` once the UI actually got it, or `{"shown": false, "reason":
"serve_not_running"}` in CLI mode — the message still goes to stderr in that
case, unchanged. A 404 from the log endpoint (no project with that id) is
reported as `project_not_found` rather than the generic `log_failed`.
"""
import json
import sys

import httpx

from cli.main import add_global_flags
from cli.output import emit_error
from serve import lockfile

# Localhost either answers immediately or isn't there (mirrors
# montaj_assets/mcp/serve-client.js's FETCH_TIMEOUT_MS).
_TIMEOUT = 2.0


def register(subparsers):
    p = subparsers.add_parser(
        "log",
        help="Post a progress message to the UI (prints to stderr if serve isn't running)",
    )
    p.add_argument("--project", required=True, metavar="ID", help="Project id to log against")
    p.add_argument("message", help="Short, human-readable progress message")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    info = lockfile.read()
    if info is None:
        # CLI mode: no live `montaj serve` to post to. The message still goes
        # to stderr; the JSON result on stdout lets a caller that
        # never sees this process's stderr tell that it wasn't shown.
        print(args.message, file=sys.stderr)
        print(json.dumps({"shown": False, "reason": "serve_not_running"}))
        return

    url = f"http://127.0.0.1:{info['port']}/api/projects/{args.project}/log"
    try:
        resp = httpx.post(url, json={"message": args.message}, timeout=_TIMEOUT)
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            emit_error("project_not_found", "No project with that id.")
        emit_error("log_failed", f"could not reach montaj serve on port {info['port']}: {exc}")
    except httpx.HTTPError as exc:
        emit_error("log_failed", f"could not reach montaj serve on port {info['port']}: {exc}")
    else:
        print(json.dumps({"shown": True}))
