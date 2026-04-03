#!/usr/bin/env python3
"""Resolve a workflow file to a concrete list of steps with merged params."""
import argparse, json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
BUILT_IN_STEPS_DIR = os.path.join(MONTAJ_ROOT, "steps")
USER_STEPS_DIR = os.path.expanduser("~/.montaj/steps")
WORKFLOWS_DIR = os.path.join(MONTAJ_ROOT, "workflows")


def resolve_step(uses, project_dir):
    """Resolve a `uses` reference to (executable_path, schema_path)."""
    if uses.startswith("montaj/"):
        name = uses[len("montaj/"):]
        py_path = os.path.join(BUILT_IN_STEPS_DIR, f"{name}.py")
        json_path = os.path.join(BUILT_IN_STEPS_DIR, f"{name}.json")
    elif uses.startswith("user/"):
        name = uses[len("user/"):]
        py_path = os.path.join(USER_STEPS_DIR, f"{name}.py")
        json_path = os.path.join(USER_STEPS_DIR, f"{name}.json")
    elif uses.startswith("./steps/"):
        name = uses[len("./steps/"):]
        py_path = os.path.join(project_dir, "steps", f"{name}.py")
        json_path = os.path.join(project_dir, "steps", f"{name}.json")
    else:
        fail("step_not_found", f"Unknown scope prefix in '{uses}'. Expected: montaj/, user/, or ./steps/")

    if not os.path.isfile(py_path) or not os.path.isfile(json_path):
        fail("step_not_found", f"Step not found: '{uses}' (looked for {py_path})")

    return py_path, json_path


def merge_params(schema_params, workflow_overrides):
    """Merge workflow overrides over schema defaults. Workflow wins."""
    merged = {}
    for param in schema_params:
        if "default" in param:
            merged[param["name"]] = param["default"]
    merged.update(workflow_overrides or {})
    return merged


def main():
    parser = argparse.ArgumentParser(description="Resolve a workflow to concrete steps")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--workflow", help="Workflow name (resolved from workflows/)")
    group.add_argument("--path", help="Direct path to workflow .json file")
    parser.add_argument("--project-dir", help="Project root for ./steps/ scope resolution (default: cwd)")
    args = parser.parse_args()

    if args.path:
        workflow_path = os.path.abspath(args.path)
    else:
        workflow_path = os.path.join(WORKFLOWS_DIR, f"{args.workflow}.json")

    if not os.path.isfile(workflow_path):
        fail("workflow_not_found", f"Workflow file not found: {workflow_path}")

    try:
        with open(workflow_path) as f:
            workflow = json.load(f)
    except json.JSONDecodeError as e:
        fail("invalid_json", f"Invalid JSON in workflow: {e}")

    project_dir = args.project_dir or os.getcwd()
    resolved = []

    for step_entry in workflow.get("steps", []):
        step_id = step_entry.get("id", "")
        uses = step_entry.get("uses", "")
        workflow_params = step_entry.get("params", {})

        py_path, json_path = resolve_step(uses, project_dir)

        try:
            with open(json_path) as f:
                schema = json.load(f)
        except json.JSONDecodeError as e:
            fail("invalid_json", f"Invalid JSON in step schema {json_path}: {e}")

        params = merge_params(schema.get("params", []), workflow_params)

        resolved.append({
            "id": step_id,
            "uses": uses,
            "executable": py_path,
            "schema": schema,
            "params": params,
        })

    print(json.dumps(resolved, indent=2))


if __name__ == "__main__":
    main()
