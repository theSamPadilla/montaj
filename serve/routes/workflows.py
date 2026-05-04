"""Workflow CRUD endpoints."""
import json
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from serve.common import MONTAJ_ROOT
from lib.types.project import normalize_project_type

router = APIRouter(prefix="/api")


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
    """Return a workflow JSON. Resolves user-global first, then built-in."""
    for _scope, d in _workflow_dirs():
        path = d / f"{name}.json"
        if path.exists():
            return json.loads(path.read_text())
    raise HTTPException(status_code=404, detail={"message": f"Workflow {name!r} not found"})


@router.put("/workflows/{name}")
async def save_workflow(name: str, body: dict = Body(...)):
    """Save a workflow to ~/.montaj/workflows/ (user-global scope)."""
    user_dir = Path.home() / ".montaj" / "workflows"
    user_dir.mkdir(parents=True, exist_ok=True)
    path = user_dir / f"{name}.json"
    path.write_text(json.dumps(body, indent=2))
    return body
