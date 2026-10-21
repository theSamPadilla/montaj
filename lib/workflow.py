"""Workflow resolution — single source of truth for finding workflow files.

Used by project/init.py, serve/server.py, and cli/commands/workflow.py.
Resolution order: project-local → user-global → built-in.
"""
import json
import os
import re

# MONTAJ_ROOT must be passed or derived by the caller — this module is in lib/
# and doesn't know the repo root at import time.

_MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# A workflow name is a single plain segment (H7): `{name}` is joined into `{name}.json` under the workflow
# dirs, so `..` or a `\` (which Windows treats as a separator) would escape to any *.json on disk.
WORKFLOW_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def is_valid_workflow_name(name) -> bool:
    return isinstance(name, str) and bool(WORKFLOW_NAME_RE.fullmatch(name))


def resolve_workflow_path(name: str, montaj_root: str | None = None) -> str | None:
    """Find a workflow JSON by name. Returns the absolute path or None.

    Resolution order: project-local (cwd), user-global (~/.montaj), built-in.
    A name that is not a single plain segment is rejected (None): it must not
    traverse out of the workflow folders (H7).
    """
    if not is_valid_workflow_name(name):
        return None
    root = montaj_root or _MONTAJ_ROOT
    candidates = [
        os.path.join(os.getcwd(), "workflows", f"{name}.json"),
        os.path.expanduser(f"~/.montaj/workflows/{name}.json"),
        os.path.join(root, "workflows", f"{name}.json"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def read_workflow(name: str, montaj_root: str | None = None) -> dict | None:
    """Resolve and parse a workflow JSON. Returns the dict or None on any failure."""
    path = resolve_workflow_path(name, montaj_root)
    if not path:
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None
