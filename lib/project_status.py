"""An export marks its project final.

`status` is a label (pending, draft, final): any status renders. Every render entry (serve's render route, the
headless `montaj render`) sets it to `final` first, so neither a person nor an agent has to, and renders whatever
the write did.
"""
import json
from pathlib import Path

from lib.project_lock import ProjectReadOnly, project_lock, write_json_atomic


def is_storyboard_stage(project: dict) -> bool:
    """A project still on a storyboard a person approves, or mid-generation: an ai_video or ai-broll project at
    `pending`, or any project at `storyboard_ready`. Mirrors the app's storyboard-stage rule."""
    status = project.get("status")
    if status == "storyboard_ready":
        return True
    return status == "pending" and (project.get("projectType") == "ai_video" or project.get("workflow") == "ai-broll")


def mark_final_locked(project_path, allows=None) -> "tuple[dict, str] | None":
    """Set `status` to `final`, the caller holding the project lock: only from `draft` or `pending`, never on a
    storyboard stage. Re-reads the file and changes nothing else, so a concurrent save is never clobbered.
    `allows(raw, project)` may veto the write (serve's Studio sync clash rule). Returns (project, text) when it
    wrote, else None."""
    path = Path(project_path)
    try:
        raw = path.read_text()
        project = json.loads(raw)
    except (OSError, ValueError):
        return None
    if not isinstance(project, dict) or project.get("status") not in ("draft", "pending") or is_storyboard_stage(project):
        return None
    project["status"] = "final"
    if allows is not None and not allows(raw, project):
        return None
    try:
        text = write_json_atomic(path, project)
    except (OSError, ProjectReadOnly):
        return None
    return project, text


def mark_final(project_path, allows=None) -> bool:
    """`mark_final_locked` under the project lock, then, when it wrote, the version commit serve makes on a move to
    `final` (a folder's own project.json only). Never raises: a label never stops a render."""
    try:
        with project_lock(Path(project_path)):
            result = mark_final_locked(project_path, allows)
    except Exception:  # noqa: BLE001
        return False
    if result is None:
        return False
    path = Path(project_path)
    if path.name == "project.json":
        try:
            from lib.project_versions import commit_version
            commit_version(path.parent, f"version: run {result[0].get('runCount', 1)} — final")
        except Exception:  # noqa: BLE001
            pass
    return True
