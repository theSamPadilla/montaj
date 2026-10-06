"""Route-level helpers shared across serve/* endpoints."""
import asyncio
import json
import os
from pathlib import Path

from fastapi import HTTPException

from cli.deps import render_runtime_dir

MONTAJ_ROOT = Path(__file__).resolve().parent.parent


# id -> project dir. Validated on every hit (cheap single read) so it can never
# go stale: a moved/deleted project misses validation and falls through to a
# rescan. Populated opportunistically during scans.
_project_dir_cache: dict[str, Path] = {}


def is_nested_project_json(path: Path, workspace: Path) -> bool:
    """True when `path` (a project.json under `workspace`) sits inside another
    project's folder: a folder above it, below the workspace, holds a
    project.json of its own. Such a file belongs to that project and is never a
    project itself. Comparing versions writes one at
    `<project>/render/versions/<commit>/project.json`, a snapshot carrying the
    project's own id. Plain folders above a project (`teamA/abc`) hold no
    project.json, so nested layouts are unaffected."""
    folder = path.parent.parent
    while folder != workspace and folder != folder.parent:
        if (folder / "project.json").is_file():
            return True
        folder = folder.parent
    return False


def find_project_dir(workspace: Path, project_id: str) -> Path | None:
    """Find the project directory for a given project id.

    Walks the workspace recursively (any depth under the workspace root) and
    matches by the `id` field inside each `project.json`. Tenant-isolation
    layers (Hub) rely on consumers validating ownership at their API boundary
    before calling Montaj — Montaj itself is tenant-unaware and finds a project
    wherever it lives in the workspace tree.

    A module-level id -> dir cache backs this (it's behind a Depends() used by
    ~22 routes, and the full rglob + per-file JSON parse is the dominant cost
    on every request). The cached entry is re-validated on every hit with a
    single read of that project's project.json, so a moved/deleted project
    just falls through to a full rescan instead of returning stale data.

    A project is the TOPMOST folder holding a project.json: a project.json
    nested inside a project's folder (`is_nested_project_json`) is skipped.
    Comparing versions writes such a snapshot, with the project's own id, and
    before this rule a full scan cached the last match per id, which pointed
    the project's later reads and saves at the snapshot folder.
    """
    cached = _project_dir_cache.get(project_id)
    if cached is not None:
        try:
            if cached.is_relative_to(workspace) and \
                    json.loads((cached / "project.json").read_text()).get("id") == project_id:
                return cached
        except (OSError, ValueError, AttributeError):
            pass
        del _project_dir_cache[project_id]

    for p in workspace.rglob("project.json"):
        if is_nested_project_json(p, workspace):
            continue
        try:
            pid = json.loads(p.read_text()).get("id")
        except (OSError, ValueError, AttributeError):
            continue
        if pid:
            _project_dir_cache[pid] = p.parent
        if pid == project_id:
            return p.parent
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
        (Path(render_runtime_dir()) / "templates" / "overlays").resolve(),
    ]


def _is_under(path: Path, root: Path) -> bool:
    """True if `path` is `root` or anywhere beneath it. Both must already be
    .resolve()'d by the caller — pure path comparison, no filesystem I/O."""
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def validate_project_subpath(project_dir: Path, rel_path: str) -> Path:
    """Resolve `rel_path` under `project_dir` and reject anything that
    escapes, is empty, is absolute, or names the project dir itself.

    Used by both fetch (`destPath`) and upload (`srcPath`).
    Public — sits alongside `find_project_dir`, `resolve_workspace`,
    `get_project_dir`."""
    if not isinstance(rel_path, str) or not rel_path.strip():
        raise bad_request("path_traversal", "path is required")
    if rel_path.startswith("/"):
        raise bad_request("path_traversal", f"path must be relative: {rel_path}")
    if rel_path.strip() in (".", "..", "./", "../"):
        raise bad_request("path_traversal", f"path must name a file: {rel_path}")
    candidate = (project_dir / rel_path).resolve()
    project_root = project_dir.resolve()
    if not _is_under(candidate, project_root):
        raise bad_request("path_traversal", f"path escapes project dir: {rel_path}")
    if candidate == project_root:
        raise bad_request("path_traversal", f"path must name a file: {rel_path}")
    return candidate


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
