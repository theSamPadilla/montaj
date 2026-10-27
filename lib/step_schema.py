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


def flag_value(flag: str, val, numeric: bool) -> list[str]:
    """`[flag, value]`, or one `flag=value` token for a negative number on an int/float param: argparse reads
    `-3e1` or `-inf` standing alone as a flag of its own, but always reads what follows `=` as the value (§563).
    Shared by serve's build_cli_args and the CLI's _build_step_flags. An object or a list (an element of a repeated
    param: place's items) goes as JSON, never Python's repr (PL89b)."""
    text = json.dumps(val) if isinstance(val, (dict, list)) else str(val)
    if numeric and text.startswith("-"):
        return [f"{flag}={text}"]
    return [flag, text]


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
