#!/usr/bin/env python3
"""Validate a step's JSON schema against the montaj step spec."""
import argparse, json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail

VALID_INPUT_TYPES  = {"video", "audio", "srt", "json", "image", "any"}
VALID_OUTPUT_TYPES = {"video", "audio", "srt", "json", "image", "any", "path[]"}
VALID_PARAM_TYPES  = {"float", "int", "string", "bool", "enum"}

MONTAJ_ROOT    = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
BUILT_IN_DIR   = os.path.join(MONTAJ_ROOT, "steps")
USER_DIR       = os.path.expanduser("~/.montaj/steps")


def validate(path):
    if not os.path.isfile(path):
        fail("file_not_found", f"Schema file not found: {path}")

    try:
        with open(path) as f:
            schema = json.load(f)
    except json.JSONDecodeError as e:
        fail("invalid_json", f"Invalid JSON in {path}: {e}")

    stem = os.path.splitext(os.path.basename(path))[0]

    if "name" not in schema:
        fail("missing_field", "Missing required field: name")
    if schema["name"] != stem:
        fail("name_mismatch", f"name '{schema['name']}' does not match filename '{stem}'")

    if "description" not in schema:
        fail("missing_field", "Missing required field: description")
    if not schema["description"] or not str(schema["description"]).strip():
        fail("missing_field", "Field 'description' must be non-empty")

    if "input" not in schema:
        fail("missing_field", "Missing required field: input")
    input_type = schema["input"].get("type")
    if not input_type:
        fail("missing_field", "Missing required field: input.type")
    if input_type not in VALID_INPUT_TYPES:
        fail("invalid_type", f"Invalid input type '{input_type}'. Valid: {sorted(VALID_INPUT_TYPES)}")

    if "output" not in schema:
        fail("missing_field", "Missing required field: output")
    output_type = schema["output"].get("type")
    if not output_type:
        fail("missing_field", "Missing required field: output.type")
    if output_type not in VALID_OUTPUT_TYPES:
        fail("invalid_type", f"Invalid output type '{output_type}'. Valid: {sorted(VALID_OUTPUT_TYPES)}")

    params = schema.get("params", [])
    if not isinstance(params, list):
        fail("invalid_params", "Field 'params' must be an array")

    for i, param in enumerate(params):
        for field in ("name", "type", "description"):
            if field not in param:
                fail("missing_field", f"Param {i}: missing required field '{field}'")

        ptype = param["type"]
        if ptype not in VALID_PARAM_TYPES:
            fail("invalid_type", f"Param '{param['name']}': invalid type '{ptype}'. Valid: {sorted(VALID_PARAM_TYPES)}")

        if ptype == "enum":
            options = param.get("options")
            if not options or not isinstance(options, list) or len(options) == 0:
                fail("missing_options", f"Param '{param['name']}': enum type requires non-empty 'options' array")

        if "required" in param and not isinstance(param["required"], bool):
            fail("invalid_field", f"Param '{param['name']}': 'required' must be boolean")

    return schema


def resolve_step_path(name, project_dir=None):
    """Find a step schema by name, searching project-local → user-global → built-in."""
    candidates = []
    if project_dir:
        candidates.append(os.path.join(project_dir, "steps", f"{name}.json"))
    candidates.append(os.path.join(USER_DIR, f"{name}.json"))
    candidates.append(os.path.join(BUILT_IN_DIR, f"{name}.json"))
    for path in candidates:
        if os.path.isfile(path):
            return path
    fail("file_not_found", f"Step '{name}' not found in project-local, user-global, or built-in scopes")


def main():
    parser = argparse.ArgumentParser(description="Validate a step schema against the montaj spec")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--step", help="Step name (searched across all scopes)")
    group.add_argument("--path", help="Direct path to .json schema file")
    parser.add_argument("--project-dir", help="Project root for project-local scope (default: cwd)")
    args = parser.parse_args()

    if args.path:
        path = args.path
    else:
        project_dir = args.project_dir or os.getcwd()
        path = resolve_step_path(args.step, project_dir)

    schema = validate(path)
    print(json.dumps({"valid": True, "name": schema["name"]}))


if __name__ == "__main__":
    main()
