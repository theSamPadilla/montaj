#!/usr/bin/env python3
"""Resolve a workflow file to a concrete list of steps with merged params.

Two kinds of steps:
  - "step"  — a regular step script (steps/<name>.py + steps/<name>.json).
  - "skill" — an agent-driven step backed by a skill file (skills/<name>/SKILL.md).
              No executable, no param schema; the agent is expected to follow
              the skill's contract. Precedent: workflows/lyrics_video.json's
              `build` step and workflows/clean_cut.json's `select-takes` step.

The resolver looks for a step script first; if neither the .py nor the .json
is present it falls back to the skill path. Missing both paths is an error.
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
BUILT_IN_STEPS_DIR = os.path.join(MONTAJ_ROOT, "steps")
BUILT_IN_SKILLS_DIR = os.path.join(MONTAJ_ROOT, "skills")
USER_STEPS_DIR = os.path.expanduser("~/.montaj/steps")
USER_SKILLS_DIR = os.path.expanduser("~/.montaj/skills")


def _find_step_files(base_dir, name):
    """Search base_dir and one level of subdirectories for {name}.py + {name}.json.

    Returns (py_path, json_path) or (None, None).
    """
    # Flat (backwards compat for user/project-local steps)
    py = os.path.join(base_dir, f"{name}.py")
    js = os.path.join(base_dir, f"{name}.json")
    if os.path.isfile(py) and os.path.isfile(js):
        return py, js

    # One level of subdirectories
    if os.path.isdir(base_dir):
        for entry in os.scandir(base_dir):
            if entry.is_dir() and not entry.name.startswith((".", "_")):
                py = os.path.join(entry.path, f"{name}.py")
                js = os.path.join(entry.path, f"{name}.json")
                if os.path.isfile(py) and os.path.isfile(js):
                    return py, js

    return None, None


def resolve_step(uses, project_dir):
    """Resolve a `uses` reference.

    Returns a dict:
      - step  form: {"kind": "step",  "executable": <py>, "schema_path": <json>}
      - skill form: {"kind": "skill", "skill_path": <SKILL.md>}
    """
    if uses.startswith("montaj/"):
        name = uses[len("montaj/"):]
        steps_dir = BUILT_IN_STEPS_DIR
        skills_dir = BUILT_IN_SKILLS_DIR
    elif uses.startswith("user/"):
        name = uses[len("user/"):]
        steps_dir = USER_STEPS_DIR
        skills_dir = USER_SKILLS_DIR
    elif uses.startswith("./steps/"):
        name = uses[len("./steps/"):]
        steps_dir = os.path.join(project_dir, "steps")
        skills_dir = os.path.join(project_dir, "skills")
    else:
        fail("step_not_found", f"Unknown scope prefix in '{uses}'. Expected: montaj/, user/, or ./steps/")

    py_path, json_path = _find_step_files(steps_dir, name)
    if py_path and json_path:
        return {"kind": "step", "executable": py_path, "schema_path": json_path}

    # Skill fallback — skills-as-steps pattern. Skill name is always the
    # same as the bare step name (e.g. `montaj/lyrics-video` → skills/lyrics-video/SKILL.md).
    skill_path = os.path.join(skills_dir, name, "SKILL.md")
    if os.path.isfile(skill_path):
        return {"kind": "skill", "skill_path": skill_path}

    fail(
        "step_not_found",
        f"Step not found: '{uses}' (looked for {py_path} or {skill_path})",
    )


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
        workflow_path = os.path.join(os.path.join(MONTAJ_ROOT, "workflows"), f"{args.workflow}.json")

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

        ref = resolve_step(uses, project_dir)

        if ref["kind"] == "step":
            try:
                with open(ref["schema_path"]) as f:
                    schema = json.load(f)
            except json.JSONDecodeError as e:
                fail("invalid_json", f"Invalid JSON in step schema {ref['schema_path']}: {e}")

            params = merge_params(schema.get("params", []), workflow_params)

            resolved.append({
                "id": step_id,
                "uses": uses,
                "kind": "step",
                "executable": ref["executable"],
                "schema": schema,
                "params": params,
            })
        else:  # skill
            # Skill-backed step: no param schema, no executable. The agent
            # loads the skill and follows its contract. Any workflow-declared
            # `params` pass through as-is so skills can still accept config.
            resolved.append({
                "id": step_id,
                "uses": uses,
                "kind": "skill",
                "skill_path": ref["skill_path"],
                "params": workflow_params,
            })

    print(json.dumps(resolved, indent=2))


if __name__ == "__main__":
    main()
