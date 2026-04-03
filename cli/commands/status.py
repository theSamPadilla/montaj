#!/usr/bin/env python3
"""montaj status — show current project state."""
import json, os
from cli.main import add_global_flags
from cli.output import emit_error


def register(subparsers):
    p = subparsers.add_parser("status", help="Show current project.json state")
    p.add_argument("--project", metavar="PATH", help="Path to project.json")
    add_global_flags(p)
    p.set_defaults(func=handle)


def _find_project():
    # 1. cwd
    candidate = os.path.join(os.getcwd(), "project.json")
    if os.path.isfile(candidate):
        return candidate
    # 2. most recent workspace subdirectory
    workspace_dir = os.path.join(os.getcwd(), "workspace")
    if os.path.isdir(workspace_dir):
        entries = [
            os.path.join(workspace_dir, d)
            for d in os.listdir(workspace_dir)
            if os.path.isdir(os.path.join(workspace_dir, d))
        ]
        entries.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        for entry in entries:
            candidate = os.path.join(entry, "project.json")
            if os.path.isfile(candidate):
                return candidate
    return None


def handle(args):
    path = getattr(args, "project", None) or _find_project()
    if not path or not os.path.isfile(path):
        emit_error("project_not_found", "No project.json found. Run 'montaj run' or 'montaj init' first.")

    with open(path) as f:
        project = json.load(f)

    if args.json:
        print(json.dumps(project, indent=2))
        return

    clips = sum(
        len(t.get("clips", []))
        for t in project.get("tracks", [])
        if t.get("type") == "video"
    )
    print(f"id:       {project.get('id', '—')}")
    if project.get("name"):
        print(f"name:     {project['name']}")
    print(f"status:   {project.get('status', '—')}")
    print(f"workflow: {project.get('workflow', '—')}")
    print(f"prompt:   {project.get('editingPrompt', '—')}")
    print(f"clips:    {clips}")
    print(f"path:     {path}")
