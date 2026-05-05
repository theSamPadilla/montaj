#!/usr/bin/env python3
"""montaj upload — push local files to remote URLs."""
import json
import os
import sys
from pathlib import Path

from cli.main import add_global_flags
from cli.output import emit_error
from lib.remote_io import push_from_disk, parse_allowed_hosts


def register(subparsers):
    p = subparsers.add_parser(
        "upload",
        help="Push local files to remote URLs (e.g. signed S3/GCS PUT URLs)",
    )
    p.add_argument(
        "--src",
        dest="src",
        action="append",
        default=[],
        metavar="PATH",
        help=(
            "Source file path (relative to project dir). Repeatable; must match --to count. "
            "For per-upload headers/method, use --uploads-file instead."
        ),
    )
    p.add_argument(
        "--to",
        dest="to",
        action="append",
        default=[],
        metavar="URL",
        help="Destination URL (https only). Repeatable; must match --src count.",
    )
    p.add_argument(
        "--method",
        dest="method",
        default="PUT",
        metavar="METHOD",
        help="HTTP method applied to ALL paired-flag uploads (default: PUT).",
    )
    p.add_argument(
        "--header",
        dest="headers",
        action="append",
        default=[],
        metavar="K=V",
        help=(
            "Header applied to ALL paired-flag uploads (repeatable). "
            "For per-upload headers, use --uploads-file."
        ),
    )
    p.add_argument(
        "--uploads-file",
        dest="uploads_file",
        default=None,
        metavar="PATH",
        help=(
            "Path to a JSON array of upload items "
            "({srcPath, url, method?, headers?}). "
            "Combined with any --src/--to pairs (file items appended after flag items)."
        ),
    )
    add_global_flags(p)
    p.set_defaults(func=handle)


def _find_project():
    """Locate project.json: cwd first, then most recent workspace subdir."""
    candidate = os.path.join(os.getcwd(), "project.json")
    if os.path.isfile(candidate):
        return candidate
    workspace_dir = os.path.join(os.getcwd(), "workspace")
    if os.path.isdir(workspace_dir):
        entries = [
            os.path.join(workspace_dir, d)
            for d in os.listdir(workspace_dir)
            if os.path.isdir(os.path.join(workspace_dir, d))
        ]
        entries.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        for entry in entries:
            candidate = os.path.join(entry, "project.json")
            if os.path.isfile(candidate):
                return candidate
    return None


def _load_uploads_file(path: str) -> list:
    """Load and validate a JSON uploads file. Errors via emit_error."""
    if not os.path.isfile(path):
        emit_error("file_not_found", f"--uploads-file: file not found: {path!r}")
    try:
        with open(path) as fh:
            data = json.load(fh)
    except json.JSONDecodeError as exc:
        emit_error("invalid_json", f"--uploads-file {path!r} is not valid JSON: {exc}")
    if not isinstance(data, list):
        emit_error("invalid_uploads_file", "must be a JSON array")
    for i, item in enumerate(data):
        for key in ("srcPath", "url"):
            if key not in item:
                emit_error(
                    "invalid_uploads_file",
                    f"item missing required key: {key!r} (item index {i})",
                )
    return data


def _parse_headers(header_args: list[str]) -> dict:
    """Parse a list of 'K=V' strings into a dict. Errors on malformed entries."""
    headers = {}
    for h in header_args:
        if "=" not in h:
            emit_error("invalid_argument", f"--header must be in K=V format, got: {h!r}")
        k, _, v = h.partition("=")
        headers[k.strip()] = v.strip()
    return headers


def handle(args):
    # ── 1. Validate inputs ──────────────────────────────────────────────────────
    has_paired = bool(args.src or args.to)
    has_file = bool(args.uploads_file)

    if not has_paired and not has_file:
        emit_error("missing_argument", "Pass --src/--to pairs or --uploads-file")

    if len(args.src) != len(args.to):
        emit_error(
            "mismatched_arguments",
            f"--src and --to must appear the same number of times "
            f"(got {len(args.src)} --src, {len(args.to)} --to)",
        )

    # ── 2. Resolve project dir ──────────────────────────────────────────────────
    project_json = _find_project()
    if not project_json:
        emit_error(
            "project_not_found",
            "No project.json found. Run 'montaj run' or 'montaj init' first.",
        )
    project_dir = Path(project_json).parent

    # ── 3. Allowlist ────────────────────────────────────────────────────────────
    allowed_hosts = parse_allowed_hosts()
    if not allowed_hosts:
        emit_error(
            "allowlist_unset",
            "MONTAJ_HTTP_ALLOWED_HOSTS is required for upload",
        )

    # ── 4. Build items list ─────────────────────────────────────────────────────
    shared_headers = _parse_headers(args.headers)

    items: list[dict] = []

    # Paired-flag items (shared method + headers).
    for src, to in zip(args.src, args.to):
        item: dict = {"srcPath": src, "url": to, "method": args.method.upper()}
        if shared_headers:
            item["headers"] = shared_headers
        items.append(item)

    # File items (per-item method/headers from the file; defaults applied by push_from_disk).
    if args.uploads_file:
        file_items = _load_uploads_file(args.uploads_file)
        items.extend(file_items)

    # ── 5. Push ─────────────────────────────────────────────────────────────────
    results = push_from_disk(items, project_dir, allowed_hosts)

    # ── 6. Output ───────────────────────────────────────────────────────────────
    payload = json.dumps({"results": results})
    any_error = any(r.get("status") == "error" for r in results)

    if not args.quiet:
        print(payload)

    sys.exit(1 if any_error else 0)
