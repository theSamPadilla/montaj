"""Route-level helpers shared across serve/* endpoints."""
import asyncio
import json
import os
from pathlib import Path

from fastapi import HTTPException

MONTAJ_ROOT = Path(__file__).resolve().parent.parent


def find_project_dir(workspace: Path, project_id: str) -> Path | None:
    """Find the project directory for a given project id.

    Walks the workspace recursively (any depth under the workspace root) and
    matches by the `id` field inside each `project.json`. Tenant-isolation
    layers (Hub) rely on consumers validating ownership at their API boundary
    before calling Montaj — Montaj itself is tenant-unaware and finds a project
    wherever it lives in the workspace tree.

    INVARIANT: exactly one `project.json` per project, at the project's root
    directory. If a future feature ever writes a `project.json` inside a
    subdirectory of a project (e.g., per-segment metadata), discovery would
    silently misbehave because rglob would match both. Either preserve this
    invariant or move to a depth-capped scan.
    """
    for p in workspace.rglob("project.json"):
        try:
            if json.loads(p.read_text()).get("id") == project_id:
                return p.parent
        except Exception:
            pass
    return None


def resolve_workspace() -> Path:
    """Resolve the active workspace dir.

    Precedence (matches project/init.py): MONTAJ_WORKSPACE_DIR env var first,
    then ~/.montaj/config.json's workspaceDir, then ~/Montaj.

    Reads env + Path.home() at call time, not import time. Do not cache at
    module scope — test_server_workspace.py relies on per-call evaluation
    so monkeypatch.setenv works without sys.modules surgery.
    """
    env_dir = os.environ.get("MONTAJ_WORKSPACE_DIR")
    if env_dir:
        return Path(env_dir)
    config_path = Path.home() / ".montaj" / "config.json"
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text())
            if "workspaceDir" in cfg:
                return Path(cfg["workspaceDir"])
        except Exception:
            pass
    return Path.home() / "Montaj"


def _allowed_file_roots() -> list[Path]:
    """Directory roots /api/files is allowed to serve from.

    Ordered: project workspace first (most-common path), then global overlay
    library, then profile assets. Each is .resolve()'d so symlinked roots
    compare correctly against a resolved request path. Add new asset roots
    here, not by introducing a parallel allowlist elsewhere.
    """
    return [
        resolve_workspace().resolve(),
        (Path.home() / ".montaj" / "overlays").resolve(),
        (Path.home() / ".montaj" / "profiles").resolve(),
    ]


def _is_under(path: Path, root: Path) -> bool:
    """True if `path` is `root` or anywhere beneath it. Both must already be
    .resolve()'d by the caller — pure path comparison, no filesystem I/O."""
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def get_project_dir(project_id: str) -> Path:
    workspace = resolve_workspace()
    project_dir = find_project_dir(workspace, project_id)
    if project_dir is None:
        raise HTTPException(404, detail={
            "error": "not_found",
            "message": f"Project '{project_id}' not found",
        })
    return project_dir


async def run_subprocess(
    cmd: list[str],
    *,
    timeout: int,
    cwd: str | None = None,
    env: dict | None = None,
) -> tuple[str, str, int]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=env,
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(
            proc.communicate(), timeout=timeout,
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise HTTPException(504, detail={
            "error": "timeout",
            "message": f"Subprocess exceeded {timeout}s",
        })
    return stdout_b.decode(), stderr_b.decode(), proc.returncode


def not_found(code: str, msg: str) -> HTTPException:
    return HTTPException(404, detail={"error": code, "message": msg})


def bad_request(code: str, msg: str) -> HTTPException:
    return HTTPException(400, detail={"error": code, "message": msg})


def server_error(code: str, msg: str) -> HTTPException:
    return HTTPException(500, detail={"error": code, "message": msg})


def forbidden(code: str, msg: str) -> HTTPException:
    return HTTPException(403, detail={"error": code, "message": msg})
