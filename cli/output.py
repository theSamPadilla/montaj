#!/usr/bin/env python3
"""Shared output helpers for CLI commands. Implements the output convention."""
import json, sys


def emit(result, as_json=False, quiet=False):
    """Relay a subprocess result to stdout/stderr, respecting the output convention.

    - On failure: write stderr to sys.stderr, exit 1
    - On success: write stdout to sys.stdout (optionally wrapped as JSON)
    - quiet=True: suppress stderr on success
    """
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        sys.exit(1)

    output = result.stdout.rstrip("\n")

    if as_json and output and not output.startswith(("{", "[")):
        print(json.dumps({"path": output}))
    else:
        print(output)

    if not quiet and result.stderr:
        sys.stderr.write(result.stderr)


def emit_error(code, message):
    """Write a structured JSON error to stderr and exit 1."""
    print(json.dumps({"error": code, "message": message}), file=sys.stderr)
    sys.exit(1)


def emit_path(path, as_json=False):
    """Write a file path to stdout, optionally as JSON."""
    if as_json:
        print(json.dumps({"path": path}))
    else:
        print(path)
