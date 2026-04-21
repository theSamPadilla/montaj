#!/usr/bin/env python3
"""montaj approve — mark an ai_video project's storyboard as approved.

Writes `storyboard.approval = {approvedAt: <ISO8601>}` to project.json. This
is the signal the ai-video director skill watches for (Phase 6) before calling
kling_generate. Use from the terminal when you're not using the UI's Approve
button.

Does NOT start generation — the agent does that. After running this command,
tell your agent in chat: "I approved the storyboard; please proceed with scene
generation." The agent will verify `storyboard.approval` is set, then enter
Phase 6.
"""
import json, os, tempfile
from datetime import datetime, timezone

from cli.main import add_global_flags
from cli.output import emit_error


def register(subparsers):
    p = subparsers.add_parser(
        "approve",
        help="Mark an ai_video project's storyboard as approved (triggers agent Phase 6).",
    )
    p.add_argument("--project", metavar="PATH",
                   help="Path to project.json (default: auto-discover from cwd / workspace/)")
    p.add_argument("--force", action="store_true",
                   help="Overwrite an existing approval (refresh approvedAt)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def _find_project():
    # Mirror status.py's discovery: cwd first, then most-recent workspace/ subdir.
    candidate = os.path.join(os.getcwd(), "project.json")
    if os.path.isfile(candidate):
        return candidate
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


def _write_atomic(path, data):
    """Write JSON atomically so a concurrent reader never sees a torn file."""
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".project.", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def handle(args):
    path = getattr(args, "project", None) or _find_project()
    if not path or not os.path.isfile(path):
        emit_error(
            "project_not_found",
            "No project.json found. Pass --project PATH or cd into the project directory.",
        )

    try:
        with open(path) as f:
            project = json.load(f)
    except json.JSONDecodeError as e:
        emit_error("invalid_json", f"Could not parse {path}: {e}")

    # --- Precondition checks ---
    project_type = project.get("projectType")
    if project_type != "ai_video":
        emit_error(
            "wrong_project_type",
            f"Approve is only meaningful for ai_video projects (this one is projectType={project_type!r}). "
            "For other project types, the agent drives status transitions directly.",
        )

    status = project.get("status")
    if status != "storyboard_ready":
        emit_error(
            "wrong_status",
            f"Project status is {status!r}; expected 'storyboard_ready'. "
            "Ask the agent to populate the storyboard first (scenes, imageRefs anchors, styleAnchor), "
            "then run approve.",
        )

    storyboard = project.get("storyboard") or {}
    scenes = storyboard.get("scenes") or []
    if not scenes:
        emit_error(
            "empty_storyboard",
            "storyboard.scenes is empty. The agent needs to populate scenes before approval "
            "has anything to act on.",
        )

    existing_approval = storyboard.get("approval")
    if existing_approval and not args.force:
        emit_error(
            "already_approved",
            f"Storyboard was already approved at {existing_approval.get('approvedAt', '?')}. "
            "Pass --force to refresh (useful after editing scenes and wanting to re-trigger generation).",
        )

    # --- Write approval ---
    approved_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    storyboard["approval"] = {"approvedAt": approved_at}
    project["storyboard"] = storyboard

    _write_atomic(path, project)

    scene_count = len(scenes)
    project_label = project.get("name") or project.get("id") or "<unnamed>"

    if args.json:
        print(json.dumps({
            "status": "ok",
            "approvedAt": approved_at,
            "project": project_label,
            "projectId": project.get("id"),
            "sceneCount": scene_count,
            "projectPath": path,
            "nextAction": "Tell your agent in chat to proceed with scene generation.",
            "agentMessage": _agent_message(project_label, project.get("id"), scene_count),
        }))
        return

    print(f"Approved storyboard for {project_label} at {approved_at}")
    print(f"  {scene_count} scene{'s' if scene_count != 1 else ''} ready to generate")
    print(f"  project.json: {path}")
    print()
    print("Next: tell your agent in chat:")
    print()
    print(f"  {_agent_message(project_label, project.get('id'), scene_count)}")
    print()
    print("The agent will verify the approval marker, then call kling_generate per scene.")


def _agent_message(label, project_id, scene_count):
    id_frag = f" (id: {project_id})" if project_id else ""
    return (
        f"I approved the storyboard for project \"{label}\"{id_frag}. "
        f"Please proceed with scene generation ({scene_count} scene{'s' if scene_count != 1 else ''}) "
        f"per the ai-video skill Phase 6 contract."
    )
