"""Schema ↔ step-argparse conformance for the schema-driven CLI commands.

A step's JSON schema (``steps/<category>/<name>.json``) is meant to be a
faithful projection of what the step's own ``argparse`` actually accepts — the
CLI, the server (``serve/routes/steps.py``), and the AI-tool layer all read it.
When the two drift, a schema-driven CLI wrapper generated from the schema would
accept the wrong flags, wrong types, wrong defaults, or wrong choices.

This test pins BIDIRECTIONAL parity for the 16 commands the consolidation plan
migrates to schema-driven wrappers, plus ``normalize`` (added by SP8c T1: its
CLI wrapper stays hand-written — ``cli.commands.normalize`` in ``_COMMANDS``,
not the schema-generated ``_STEP_COMMANDS`` — but its schema is still read by
the server (``serve/routes/steps.py``) and the AI-tool layer, so drift there
is exactly as real as for the schema-driven 16). The step's argparse is
GROUND TRUTH; the schema must match it exactly, modulo:

  * the global flags the CLI adds itself — ``--out`` / ``--quiet`` / ``--json``
    (see ``cli/main.add_global_flags``); a step may declare ``--out``/``--json``
    of its own and that is fine, it just isn't required to be a schema param, and
  * the ``input`` handling — every step takes ``--input`` as a flag, but the
    schema models it via the top-level ``input`` block (which the generator turns
    into a positional, or an optional ``--input`` when ``required: false``), not
    as a param.

Scope note: only the commands in ``MIGRATED_STEPS`` are asserted. Other
built-in steps (cross_cut, montage, materialize_cut, remove_bg, waveform_*,
sample_*, …) have their own, currently-unreconciled schema drift and a wider
type vocabulary (``array``/``integer``/``number``, input types
``project``/``jsx``/``none``); folding them in is a separate reconciliation,
not this task.

The step parser is introspected by loading the module and intercepting
``ArgumentParser.parse_args`` (the step self-configures ``sys.path``), run in a
subprocess so import side effects stay out of the test process.
"""
import json
import subprocess
import sys

import pytest

from tests.conftest import REPO_ROOT, STEPS_DIR

# Step names (schema/​.py basenames) for the 16 migrated CLI commands, plus
# `normalize` (SP8c T1 — see module docstring). Note the CLI ``filler``
# command maps to the ``rm_fillers`` step.
MIGRATED_STEPS = (
    "probe", "transcribe", "caption", "extract_audio", "resize",
    "rm_nonspeech", "stem_separation", "lyrics_sync", "lyrics_render",
    "generate_image", "generate_music", "generate_voiceover",
    "kling_generate", "analyze_media", "snapshot", "rm_fillers",
    "normalize",
)

# Global flags the CLI layer owns; never required to appear as schema params.
GLOBAL_DESTS = {"out", "quiet", "json"}

# Schema param `type` vocabulary allowed for the migrated corpus.
VALID_TYPES = {"bool", "boolean", "int", "float", "enum", "string", "path", "dict", "list"}

# Harness: load a step module with parse_args intercepted, dump its argparse
# actions as JSON. The step inserts lib/ and the repo root onto sys.path itself,
# so importing by file path (which sets __file__) is enough.
_INTROSPECT = r"""
import argparse, importlib.util, json, sys

STEP_PATH = sys.argv[1]

class _Stop(Exception):
    pass

_cap = {}
def _capture(self, *a, **k):
    _cap["p"] = self
    raise _Stop()
argparse.ArgumentParser.parse_args = _capture

spec = importlib.util.spec_from_file_location("sut_step", STEP_PATH)
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)      # module-level imports + sys.path setup
    if hasattr(mod, "main"):
        mod.main()                    # builds the parser, then _capture stops it
except _Stop:
    pass

p = _cap.get("p")
if p is None:
    sys.exit("parser not captured (step did not call parse_args before doing work)")

def _jsonable(v):
    try:
        json.dumps(v); return v
    except TypeError:
        return repr(v)

out = []
for a in p._actions:
    if a.dest == "help":
        continue
    cls = type(a).__name__
    if not a.option_strings:
        kind = "positional"
    elif cls == "_StoreTrueAction":
        kind = "store_true"
    elif cls == "_AppendAction":
        kind = "append"
    else:
        kind = "store"
    out.append({
        "dest": a.dest,
        "flags": list(a.option_strings),
        "kind": kind,
        "type": (a.type.__name__ if a.type else None),
        "default": _jsonable(a.default),
        "choices": list(a.choices) if a.choices else None,
        "required": bool(a.required),
    })
print(json.dumps(out))
"""


def _locate(step_name):
    for sub in sorted(STEPS_DIR.iterdir()):
        if sub.is_dir() and not sub.name.startswith((".", "_")):
            schema = sub / f"{step_name}.json"
            script = sub / f"{step_name}.py"
            if schema.exists() and script.exists():
                return schema, script
    raise FileNotFoundError(f"no schema+script for step {step_name!r}")


def _introspect(script_path):
    """Return {dest: action-dict} for a step's argparse."""
    r = subprocess.run(
        [sys.executable, "-c", _INTROSPECT, str(script_path)],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert r.returncode == 0, f"introspection of {script_path} failed:\n{r.stderr}"
    return {a["dest"]: a for a in json.loads(r.stdout)}


def _normalize_default(param, step_action):
    """schema default vs step default, normalized per arg kind."""
    kind = step_action["kind"]
    if kind == "store_true":
        return bool(param.get("default", False)), bool(step_action["default"])
    if kind == "append":
        return (param.get("default") or []), (step_action["default"] or [])
    schema_default = param.get("default") if "default" in param else None
    return schema_default, step_action["default"]


def _divergences(schema, step):
    """List human-readable schema↔step divergences (empty == conformant)."""
    out = []
    params = {p["name"].replace("-", "_"): p for p in schema.get("params", [])}
    step_params = {d: a for d, a in step.items()
                   if d not in GLOBAL_DESTS and d != "input"}

    # --- input handling rule ---------------------------------------------
    blk = schema.get("input")
    step_has_input = "input" in step
    if blk is None or blk.get("type") == "any":
        if step_has_input:
            out.append("input: schema has no real input block but step declares --input")
    else:
        if not step_has_input:
            out.append(f"input: schema input block (type={blk.get('type')!r}) but step has no --input")
        else:
            step_required = step["input"].get("required", False)
            if blk.get("required") is False and step_required:
                out.append("input: block required:false but step --input is required")
            if blk.get("required") is not False and not step_required:
                out.append("input: block is required (default) but step --input is optional")

    # --- bidirectional param set -----------------------------------------
    for dest in step_params:
        if dest not in params:
            out.append(f"step arg --{dest.replace('_', '-')} is MISSING from the schema")
    for dest in params:
        if dest in GLOBAL_DESTS or dest == "input":
            continue
        if dest not in step:
            out.append(f"schema param '{dest}' is not a real step argument")

    # --- per-param type / choices / default / required -------------------
    for dest, p in params.items():
        if dest in GLOBAL_DESTS or dest == "input" or dest not in step:
            continue
        a = step[dest]
        stype = p.get("type")

        if stype not in VALID_TYPES:
            out.append(f"{dest}: schema type {stype!r} not in the allowed vocabulary")

        # schema type -> step reality
        if stype == "int" and a["type"] != "int":
            out.append(f"{dest}: schema type int but step type={a['type']}")
        if stype == "float" and a["type"] != "float":
            out.append(f"{dest}: schema type float but step type={a['type']}")
        if stype in ("bool", "boolean") and a["kind"] != "store_true":
            out.append(f"{dest}: schema type bool but step kind={a['kind']}")
        if p.get("repeatable") and a["kind"] != "append":
            out.append(f"{dest}: schema repeatable but step kind={a['kind']}")
        if stype == "enum":
            if not a["choices"]:
                out.append(f"{dest}: schema is enum but step declares no choices")
            elif p.get("options") != a["choices"]:
                out.append(f"{dest}: schema options {p.get('options')} != step choices {a['choices']}")

        # step reality -> schema type
        if a["type"] == "int" and stype != "int":
            out.append(f"{dest}: step type=int but schema type={stype!r}")
        if a["type"] == "float" and stype != "float":
            out.append(f"{dest}: step type=float but schema type={stype!r}")
        if a["kind"] == "store_true" and stype not in ("bool", "boolean"):
            out.append(f"{dest}: step is store_true but schema type={stype!r}")
        if a["kind"] == "append" and not p.get("repeatable"):
            out.append(f"{dest}: step is append but schema is not repeatable")
        if a["choices"] and stype != "enum":
            out.append(f"{dest}: step has choices {a['choices']} but schema type={stype!r} (not enum)")

        # required
        if bool(p.get("required")) != bool(a["required"]):
            out.append(f"{dest}: schema required={bool(p.get('required'))} "
                       f"but step required={bool(a['required'])}")

        # default (only meaningful for non-required params)
        if not p.get("required"):
            schema_d, step_d = _normalize_default(p, a)
            if schema_d != step_d:
                out.append(f"{dest}: schema default {schema_d!r} != step default {step_d!r}")

    return out


@pytest.mark.parametrize("step_name", MIGRATED_STEPS)
def test_schema_matches_step_argparse(step_name):
    schema_path, script_path = _locate(step_name)
    schema = json.loads(schema_path.read_text())
    step = _introspect(script_path)
    div = _divergences(schema, step)
    assert not div, (
        f"{step_name}: schema ↔ step-argparse divergence\n  - "
        + "\n  - ".join(div)
    )


def test_all_migrated_steps_have_valid_type_vocabulary():
    """Guard: every migrated schema param uses a known `type`."""
    bad = []
    for step_name in MIGRATED_STEPS:
        schema_path, _ = _locate(step_name)
        schema = json.loads(schema_path.read_text())
        for p in schema.get("params", []):
            if p.get("type") not in VALID_TYPES:
                bad.append(f"{step_name}.{p['name']}: {p.get('type')!r}")
    assert not bad, "invalid schema param types:\n  " + "\n  ".join(bad)
