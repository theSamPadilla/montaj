"""Workflow CRUD endpoints."""
import json
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from serve.common import MONTAJ_ROOT
from lib.types.project import normalize_project_type
from engine.resolve_workflow import resolve_step

router = APIRouter(prefix="/api")


def _annotate_steps(workflow: dict) -> None:
    """Tag each entry in workflow["steps"] with `kind` (additive only).

    An agent reading a workflow via get_workflow sees a bare `uses` string
    like "montaj/select-takes" and has no way to tell a real step (has a
    run_step executable) from a skill-backed one (agent follows
    skills/<name>/SKILL.md itself, there is nothing to run_step) — see
    engine.resolve_workflow.resolve_step, which already draws this
    distinction for the CLI. This mirrors that here so the same distinction
    reaches the MCP surface.

    Every entry keeps all of its existing fields untouched and gains `kind`:
    "step" or "skill" per resolve_step, or "unknown" if resolution itself
    fails (bad scope prefix in `uses`, or nothing on disk for it — e.g. a
    hand-edited or partially-installed workflow). "unknown" is used rather
    than leaving the entry unannotated so every entry has a `kind` an agent
    can branch on without a presence check. When kind is "skill", the
    skill's bare name is also set as `skill` (e.g. "select-takes") — read off
    the resolved skill_path rather than re-parsed from `uses`, so it stays
    correct regardless of scope prefix. The `app/` scope is also "skill" but
    has no skill_path to read a bare name off of — there, `skill` is the
    full `uses` (e.g. "app/point-cloud-character"), which is the name a
    caller passes to get_skill to load it remotely.

    resolve_step fails via lib.common.fail(), which does sys.exit(1) — a
    SystemExit, not an Exception — so it must be caught explicitly here or
    one bad entry would take down the whole serve process instead of just
    leaving that entry unannotated.

    An entry that isn't a dict at all (a hand-edited workflow can have
    anything in `steps`) is skipped outright rather than passed to
    `entry.get`, which would raise AttributeError and 500 the whole request
    for every other, well-formed entry alongside it.
    """
    project_dir = str(Path.cwd())
    for entry in workflow.get("steps", []):
        if not isinstance(entry, dict):
            continue
        uses = entry.get("uses", "")
        try:
            ref = resolve_step(uses, project_dir)
        except (SystemExit, Exception):
            entry["kind"] = "unknown"
            continue
        entry["kind"] = ref["kind"]
        if ref["kind"] == "skill":
            entry["skill"] = ref.get("skill") or Path(ref["skill_path"]).parent.name


def _workflow_dirs() -> list[tuple[str, Path]]:
    """Return [(scope, dir)] in resolution order: project-local → user-global → built-in."""
    return [
        ("project-local", Path.cwd() / "workflows"),
        ("user",          Path.home() / ".montaj" / "workflows"),
        ("built-in",      MONTAJ_ROOT / "workflows"),
    ]


@router.get("/workflows")
async def list_workflows():
    """List all workflows across scopes. Returns [{name, scope, project_type}], deduped (user wins)."""
    seen: dict[str, tuple[str, str]] = {}  # name -> (scope, project_type)
    for scope, d in _workflow_dirs():
        if not d.exists():
            continue
        for p in d.glob("*.json"):
            if p.stem in seen:
                continue
            try:
                data = json.loads(p.read_text())
                project_type = normalize_project_type(data.get("project_type"))
            except Exception:
                project_type = "editing"
            seen[p.stem] = (scope, project_type)
    return sorted(
        [{"name": name, "scope": scope, "project_type": pt} for name, (scope, pt) in seen.items()],
        key=lambda x: x["name"],
    )


@router.get("/workflows/{name}")
async def get_workflow(name: str):
    """Return a workflow JSON. Resolves user-global first, then built-in.

    Each entry under "steps" is annotated with `kind` ("step" | "skill" |
    "unknown") so a caller can tell a skill-backed entry (no run_step
    executable — call get_skill and do it yourself) from a real step, without
    guessing from list_steps. See _annotate_steps.
    """
    for _scope, d in _workflow_dirs():
        path = d / f"{name}.json"
        if path.exists():
            workflow = json.loads(path.read_text())
            _annotate_steps(workflow)
            return workflow
    raise HTTPException(status_code=404, detail={"message": f"Workflow {name!r} not found"})


@router.put("/workflows/{name}")
async def save_workflow(name: str, body: dict = Body(...)):
    """Save a workflow to ~/.montaj/workflows/ (user-global scope)."""
    user_dir = Path.home() / ".montaj" / "workflows"
    user_dir.mkdir(parents=True, exist_ok=True)
    path = user_dir / f"{name}.json"
    path.write_text(json.dumps(body, indent=2))
    return body
