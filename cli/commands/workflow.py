#!/usr/bin/env python3
"""montaj workflow — workflow management commands."""
import glob, json, os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit_error, emit_path
from cli.help import R, B, C, D, Y


def register(subparsers):
    p = subparsers.add_parser("workflow", help="Workflow management")
    sub = p.add_subparsers(dest="workflow_cmd", required=True)

    # list
    pl = sub.add_parser("list", help="List available workflows")
    add_global_flags(pl)
    pl.set_defaults(func=handle_list)

    # new
    pn = sub.add_parser("new", help="Scaffold a new workflow file")
    pn.add_argument("name", help="Workflow name")
    add_global_flags(pn)
    pn.set_defaults(func=handle_new)

    # edit
    pe = sub.add_parser("edit", help="Open a workflow in $EDITOR")
    pe.add_argument("name", help="Workflow name")
    pe.set_defaults(func=handle_edit)

    # run
    pr = sub.add_parser("run", help="Run a workflow (alias for montaj run --workflow <name>)")
    pr.add_argument("name", help="Workflow name")
    pr.add_argument("clips", nargs="+", help="Clip files or directory")
    pr.add_argument("--prompt", required=True, help="Editing prompt")
    pr.add_argument("--project-name", help="Project name label")
    add_global_flags(pr)
    pr.set_defaults(func=handle_run)

    p.set_defaults(func=lambda args: p.print_help())


def _discover_workflows():
    """Return list of dicts across all scopes, deduped (project-local > user > built-in)."""
    scopes = [
        ("project-local", os.path.join(os.getcwd(), "workflows")),
        ("user",          os.path.expanduser("~/.montaj/workflows")),
        ("built-in",      os.path.join(MONTAJ_ROOT, "workflows")),
    ]
    seen = set()
    results = []
    for scope, directory in scopes:
        for path in sorted(glob.glob(os.path.join(directory, "*.json"))):
            stem = os.path.splitext(os.path.basename(path))[0]
            if stem in seen:
                continue
            try:
                with open(path) as f:
                    data = json.load(f)
                seen.add(stem)
                results.append({
                    "name":        data.get("name", stem),
                    "description": data.get("description", ""),
                    "scope":       scope,
                    "path":        path,
                })
            except (json.JSONDecodeError, OSError):
                pass
    return results


def handle_list(args):
    workflows = _discover_workflows()
    if getattr(args, "json", False):
        print(json.dumps(workflows, indent=2))
        return

    scope_order = ["project-local", "user", "built-in"]
    by_scope = {s: [] for s in scope_order}
    for w in workflows:
        by_scope.get(w["scope"], by_scope["built-in"]).append(w)

    scope_labels = {"project-local": "Project", "user": "User", "built-in": "Built-in"}
    first = True
    for scope in scope_order:
        group = by_scope[scope]
        if not group:
            continue
        if not first:
            print()
        first = False
        print(f"{Y}{scope_labels[scope]}{R}")
        for w in group:
            print(f"  {C}{B}{w['name']:<20}{R}  {w['description']}")


def handle_new(args):
    workflows_dir = os.path.join(os.getcwd(), "workflows")
    os.makedirs(workflows_dir, exist_ok=True)
    path = os.path.join(workflows_dir, f"{args.name}.json")
    if os.path.exists(path):
        emit_error("already_exists", f"Workflow already exists: {path}")
    template = {
        "name": args.name,
        "description": "Describe what this workflow does",
        "steps": [
            {"id": "probe", "uses": "montaj/probe"}
        ]
    }
    with open(path, "w") as f:
        json.dump(template, f, indent=2)
    emit_path(path, as_json=getattr(args, "json", False))


def handle_edit(args):
    # Resolve workflow across scopes
    scopes = [
        os.path.join(os.getcwd(), "workflows", f"{args.name}.json"),
        os.path.expanduser(f"~/.montaj/workflows/{args.name}.json"),
        os.path.join(MONTAJ_ROOT, "workflows", f"{args.name}.json"),
    ]
    path = next((p for p in scopes if os.path.isfile(p)), None)
    if not path:
        emit_error("workflow_not_found", f"Workflow not found: {args.name}")
    editor = os.environ.get("EDITOR", "vi")
    os.execvp(editor, [editor, path])


def handle_run(args):
    # Delegate to run command
    from cli.commands import run as run_cmd
    # Patch args to look like `montaj run`
    args.workflow = args.name
    args.name = getattr(args, "project_name", None)
    run_cmd.handle(args)
