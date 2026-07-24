"""Schema-driven CLI command generator.

``register_step_command`` builds an argparse subparser for a single-step command
directly from the step's reconciled JSON schema (``steps/<cat>/<name>.json``),
and attaches a generic handler that maps the parsed args to step flags, spawns
the step subprocess, and relays its output via ``emit``. One mapping replaces
the 16 near-identical hand-written wrapper files.

The parser mirrors what the schema declares; the handler mirrors
``serve/routes/steps.build_cli_args`` (skip ``None``, bool → bare flag,
repeatable → repeated flag, dict → ``json.dumps``, ``--input`` first, ``--out``
last). The genuine per-command remainder is expressed as a small declarative
``quirks`` dict, NOT code — see ``register_step_command`` for the vocabulary.
"""
import json
import os
import subprocess
import sys

from cli.main import add_global_flags, find_step
from cli.output import emit, emit_error
from lib.step_schema import load_step_schema


def _require_file(path, label):
    """Precheck: fail with a structured not_found error if ``path`` is missing.

    Factored out so tests can neutralize file-existence prechecks without
    touching ``os.path.isfile`` globally (which ``find_step`` also uses)."""
    if not os.path.isfile(path):
        emit_error("not_found", f"{label} not found: {path}")


def _add_param(parser, param):
    """Register one schema param on the subparser, per the type mapping."""
    flag = "--" + param["name"]
    kw = {}
    if param.get("description"):
        kw["help"] = param["description"]
    if param.get("required"):
        kw["required"] = True

    ptype = param.get("type")
    if param.get("repeatable"):
        # Any repeatable param → append, regardless of scalar type.
        kw["action"] = "append"
        kw["default"] = []
    elif ptype in ("bool", "boolean"):
        kw["action"] = "store_true"
    else:
        if ptype == "int":
            kw["type"] = int
        elif ptype == "float":
            kw["type"] = float
        elif ptype == "enum":
            kw["choices"] = param.get("options")
        # string / path / dict → plain string arg (dict = a JSON string on the CLI)
        # Forward the schema default so it surfaces in the MCP inputSchema
        # (mcp_schema introspects argparse) and gets forwarded to the child,
        # exactly as the hand wrappers' Python-level argparse defaults did.
        # Behaviorally inert: the step's own default == this default (guaranteed
        # by the schema↔step conformance test).
        if "default" in param:
            kw["default"] = param["default"]

    parser.add_argument(flag, **kw)


def _build_step_flags(args, schema, quirks):
    """Map parsed args → step subprocess flags. Mirrors build_cli_args semantics."""
    flags = []

    # --input first (translate a positional or --input value to the step's flag).
    input_val = getattr(args, "input", None)
    if input_val is not None:
        if isinstance(input_val, list):
            if len(input_val) == 1:
                flags += ["--input", str(input_val[0])]
            elif input_val:
                flags += ["--inputs"] + [str(f) for f in input_val]
        else:
            flags += ["--input", str(input_val)]

    # Declared params, in schema order.
    for param in schema.get("params", []):
        name = param["name"]
        dest = name.replace("-", "_")
        if name == "out" or dest == "input":
            continue  # --out is a global flag; input is handled above
        val = getattr(args, dest, None)
        if val is None:
            continue
        flag = "--" + name
        if param.get("type") in ("bool", "boolean"):
            if val:
                flags.append(flag)
        elif param.get("repeatable") or isinstance(val, list):
            for item in val:
                flags += [flag, str(item)]
        elif isinstance(val, dict):
            flags += [flag, json.dumps(val)]
        else:
            flags += [flag, str(val)]

    # Optionally forward the CLI's own --json to the child (envelope-emitting steps).
    if quirks.get("forward_json") and getattr(args, "json", False):
        flags.append("--json")

    # --out last.
    if getattr(args, "out", None):
        flags += ["--out", str(args.out)]

    return flags


def _make_handler(cli_name, step_name, schema, quirks):
    def handle(args):
        # required --out (steps whose output path is mandatory).
        if quirks.get("required_out") and not getattr(args, "out", None):
            emit_error("missing_out", f"--out is required for {cli_name}")

        # Exactly-one-of (handler-level XOR; keeps both flags optional in --help).
        xor = quirks.get("xor")
        if xor:
            a, b = xor
            if bool(getattr(args, a, None)) == bool(getattr(args, b, None)):
                emit_error("invalid_args",
                           f"Pass exactly one of --{a.replace('_', '-')} "
                           f"or --{b.replace('_', '-')}")

        # File-existence prechecks: the input file, plus any declared file params.
        input_val = getattr(args, "input", None)
        if input_val is not None:
            for f in (input_val if isinstance(input_val, list) else [input_val]):
                _require_file(f, "File")
        for dest in quirks.get("file_prechecks", ()):
            val = getattr(args, dest, None)
            if val is not None:
                _require_file(val, f"--{dest.replace('_', '-')}")

        cmd = [sys.executable, find_step(step_name), *_build_step_flags(args, schema, quirks)]
        result = subprocess.run(cmd, capture_output=True, text=True)

        # emit_json defaults True (pass the CLI's --json through to emit); a few
        # steps return their own JSON already and ignore it (emit_json=False).
        as_json = getattr(args, "json", False) if quirks.get("emit_json", True) else False
        emit(result, as_json=as_json, quiet=getattr(args, "quiet", False))

    return handle


def register_step_command(subparsers, cli_name, step_name=None, quirks=None):
    """Build an argparse subparser for a step from its JSON schema + a generic handler.

    ``quirks`` is a small DECLARATIVE dict (not code). Recognized keys:

      * ``step_name``     — step whose schema/script backs this command
                            (e.g. filler → rm_fillers). Also accepted as the
                            ``step_name`` argument.
      * ``required_out``  — handler fails if ``--out`` is absent.
      * ``xor``           — ``(dest_a, dest_b)``; exactly one must be provided.
      * ``file_prechecks``— dests whose value must be an existing file.
      * ``emit_json``     — passed to ``emit(as_json=...)``; default True. Set
                            False for steps that already print JSON and ignore
                            ``--json``.
      * ``forward_json``  — also forward ``--json`` to the child subprocess.
    """
    quirks = quirks or {}
    step_name = step_name or quirks.get("step_name") or cli_name.replace("-", "_")
    schema = load_step_schema(step_name)

    # help= feeds the parent command listing + the MCP tool description; the
    # hand wrappers set no argparse `description=`, so neither do we (keeps the
    # subcommand's own --help free of a description block).
    parser = subparsers.add_parser(cli_name, help=schema.get("description"))

    # Input handling (input block → positional / optional --input / nothing).
    blk = schema.get("input")
    if blk is not None and blk.get("type") != "any":
        if blk.get("required") is False:
            parser.add_argument("--input", default=None, help=blk.get("description"))
        else:
            kw = {"help": blk.get("description")}
            if blk.get("multiple"):
                kw["nargs"] = "+"
            parser.add_argument("input", **kw)

    # Declared params (skip the global --out and any param duplicating input).
    for param in schema.get("params", []):
        if param["name"] == "out" or param["name"].replace("-", "_") == "input":
            continue
        _add_param(parser, param)

    add_global_flags(parser)
    parser.set_defaults(func=_make_handler(cli_name, step_name, schema, quirks))
    return parser
