"""Load a step's JSON schema (steps/<category>/<name>.json).

The single loader the schema-driven CLI wrappers use to find a built-in step's
schema. Mirrors the built-in scope of ``serve.routes.steps.scan_steps`` — flat
files first (backwards compat), then one level of category subdirectories, with
the subdirectory name injected as ``category`` — but WITHOUT the
``~/.montaj/steps`` user scope: CLI wrappers exist only for built-in steps.
"""
import json
import os

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def load_step_schema(step_name: str) -> dict:
    """Return the parsed schema for a built-in step, with an injected ``category``.

    Scans ``MONTAJ_ROOT/steps`` for ``<step_name>.json``. Raises ``KeyError`` if
    no such built-in step schema exists.
    """
    steps_dir = os.path.join(MONTAJ_ROOT, "steps")

    # Flat file (backwards compat) — no category.
    flat = os.path.join(steps_dir, f"{step_name}.json")
    if os.path.isfile(flat):
        with open(flat) as fh:
            return json.load(fh)

    # One level of category subdirectories.
    for entry in sorted(os.scandir(steps_dir), key=lambda e: e.name):
        if entry.is_dir() and not entry.name.startswith((".", "_")):
            path = os.path.join(entry.path, f"{step_name}.json")
            if os.path.isfile(path):
                with open(path) as fh:
                    schema = json.load(fh)
                schema["category"] = entry.name
                return schema

    raise KeyError(step_name)
