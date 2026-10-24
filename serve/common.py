"""Route-level helpers shared across serve/* endpoints."""
import asyncio
import json
import os
import re
import unicodedata
from pathlib import Path

from fastapi import HTTPException

from cli.deps import render_runtime_dir
from lib.project_lock import PROJECT_READ_ONLY_MESSAGE

MONTAJ_ROOT = Path(__file__).resolve().parent.parent


class DuplicateProjectId(Exception):
    """Two or more topmost (non-nested) project.json folders claim the same id,
    so the resolver cannot say which folder the id means and refuses rather than
    guess (§518). Carries every claiming folder so the caller can name them.

    The bug this closes: a copied project folder that kept the original's id used
    to silently take over the real project. `find_project_dir`'s rglob was FIRST
    MATCH WINS, so whichever folder the walk reached first became the one every
    read, write and render resolved to, and the per-folder project lock never
    serialised the two. serve maps this to a 409 `duplicate_project_id`."""

    def __init__(self, project_id: str, dirs) -> None:
        self.project_id = project_id
        self.dirs = [Path(d) for d in dirs]
        joined = ", ".join(str(d) for d in self.dirs)
        super().__init__(
            f"Two or more folders use the project id '{project_id}': {joined}. "
            "Give the copy a new project id."
        )


class _DuplicateIds:
    """Cache sentinel: this id is held by >1 topmost folder. Stored during a scan
    so a LATER resolve of the id raises on a cache HIT, not only on a fresh scan.
    Without it, a clean single-folder entry cached before the copy appeared would
    keep resolving (and silently serving the wrong folder) until the next
    rescan. Re-validated on every hit like a normal entry: each folder is
    re-checked against the live tree, and the sentinel is dropped once the
    collision is gone (down to one live folder)."""
    __slots__ = ("dirs",)

    def __init__(self, dirs) -> None:
        self.dirs = [Path(d) for d in dirs]


# id -> project dir (a Path) for a resolved id, or a `_DuplicateIds` sentinel for
# a colliding one. Validated on every hit (cheap reads) so it can never go stale:
# a moved/deleted project, or a collision that resolved, misses validation and
# falls through to a rescan. Populated during scans.
_project_dir_cache: dict[str, "Path | _DuplicateIds"] = {}


def _dir_claims_id(workspace: Path, project_id: str, project_dir: Path) -> bool:
    """True when `project_dir` is still a topmost (non-nested) project folder
    under `workspace` whose project.json carries `project_id`. One cheap read;
    the check a cache hit has always made, factored out so the duplicate sentinel
    can re-validate each of its folders the same way a single entry is."""
    try:
        pj = project_dir / "project.json"
        return (
            project_dir.is_relative_to(workspace)
            and not is_nested_project_json(pj, workspace)
            and json.loads(pj.read_text()).get("id") == project_id
        )
    except (OSError, ValueError, AttributeError):
        return False


def _live_duplicate_dirs(workspace: Path, project_id: str, dirs) -> list[Path]:
    """The subset of `dirs` that still claim `project_id` as topmost folders.
    De-duplicated by path, so a sentinel re-validation counts real folders."""
    live: list[Path] = []
    seen: set[str] = set()
    for d in dirs:
        d = Path(d)
        key = str(d)
        if key not in seen and _dir_claims_id(workspace, project_id, d):
            live.append(d)
            seen.add(key)
    return live


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


def prime_project_dir_cache(by_id: "dict[str, list[Path]]") -> None:
    """Record a scan's id -> topmost-folders map in the cache: a single folder as
    a plain Path (the fast path), a collision as a `_DuplicateIds` sentinel so a
    later resolve of it raises even on a cache hit. Shared by `find_project_dir`'s
    scan and `GET /projects`, so either one seeing a duplicate makes the
    per-project routes refuse it immediately."""
    for pid, dirs in by_id.items():
        _project_dir_cache[pid] = _DuplicateIds(dirs) if len(dirs) > 1 else Path(dirs[0])


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

    §518: when an id is claimed by TWO OR MORE topmost folders the resolver
    cannot pick one, so it raises `DuplicateProjectId` instead of guessing (the
    old scan took the first match and silently served it). The collision is
    detected during the ONE rglob (the scan records id -> list-of-dirs rather
    than returning at the first match), and a sentinel is cached for every
    colliding id so a later resolve raises even on a cache hit. Residual window:
    a copy created AFTER a clean single entry was cached, with nothing triggering
    a rescan in between, stays hidden until the next scan (a cache miss for any
    id, a revalidation failure, or `GET /projects`, which always scans and primes
    this cache through `prime_project_dir_cache`, so a duplicate it flags is
    refused by the per-project routes from then on). The
    sentinel is re-validated every hit, so once written the duplicate cannot be
    served; correctness is preferred over the cache for a colliding id.
    """
    cached = _project_dir_cache.get(project_id)
    if cached is not None:
        if isinstance(cached, _DuplicateIds):
            live = _live_duplicate_dirs(workspace, project_id, cached.dirs)
            if len(live) >= 2:
                raise DuplicateProjectId(project_id, live)
            # Down to one (or zero) live folder: the collision resolved. Drop the
            # sentinel and rescan, which re-caches the id as a normal entry.
            del _project_dir_cache[project_id]
        elif _dir_claims_id(workspace, project_id, cached):
            return cached
        else:
            del _project_dir_cache[project_id]

    # Full scan: record id -> every topmost folder that claims it, so a collision
    # is seen in this one walk rather than missed by an early return at the first
    # match.
    by_id: dict[str, list[Path]] = {}
    for p in workspace.rglob("project.json"):
        if is_nested_project_json(p, workspace):
            continue
        try:
            pid = json.loads(p.read_text()).get("id")
        except (OSError, ValueError, AttributeError):
            continue
        if pid:
            by_id.setdefault(pid, []).append(p.parent)

    # Cache every id the scan saw: a single folder as a plain Path (the fast
    # path), a collision as a sentinel so a later resolve of it raises on a hit.
    prime_project_dir_cache(by_id)

    dirs = by_id.get(project_id)
    if not dirs:
        return None
    if len(dirs) > 1:
        raise DuplicateProjectId(project_id, dirs)
    return dirs[0]


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


# The provenance records in a project's assets/ (serve/provenance.py), which only
# `record_provenance` writes.
PROVENANCE_RECORD_NAMES = (".provenance.json", ".generated.json")
# §477: a project's own files. A write or delete here would bypass the project lock and
# the save guard, so only save_project (and serve's own writers) touch them.
PROJECT_FILE_NAMES = ("project.json", "project.json.tmp", ".project.lock") + PROVENANCE_RECORD_NAMES


def _norm_name(name: str) -> str:
    """A file name as a case-folding filesystem may compare it: NFKC (compatibility forms,
    U+017F to s, a fullwidth letter to its ASCII one), the trailing dots and spaces Windows
    ignores dropped, then casefold (U+212A KELVIN SIGN to k)."""
    return unicodedata.normalize("NFKC", name).rstrip(". ").casefold()


def is_project_file_name(path, names=PROJECT_FILE_NAMES) -> bool:
    """The last segment, by either slash, names one of a project's own files (`names`)
    under the folding above."""
    base = re.split(r"[\\/]", str(path))[-1]
    return _norm_name(base) in {_norm_name(n) for n in names}


def lands_on_project_file(*paths, names=PROJECT_FILE_NAMES) -> bool:
    """Any of paths is, by name or as the very same file on disk, a project's own file in
    its folder: os.path.samefile against `<its parent>/project.json` (and the lock, the
    temp file and the provenance records; or just `names`) where both exist, so a name
    the filesystem folds in a way the name rule does not know, or a hard link, is caught
    too."""
    for path in paths:
        if path is None:
            continue
        if is_project_file_name(path, names):
            return True
        path = Path(path)
        for name in names:
            try:
                if os.path.samefile(path, path.parent / name):
                    return True
            except (OSError, ValueError):
                continue
    return False


def get_project_dir(project_id: str) -> Path:
    workspace = resolve_workspace()
    project_dir = find_project_dir(workspace, project_id)
    if project_dir is None:
        raise HTTPException(404, detail={
            "error": "not_found",
            "message": f"Project '{project_id}' not found. list_projects gives the ids.",
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


PROJECT_LOCKED_DETAIL = {
    "error": "project_locked",
    "message": "Montaj is finishing another change to this project. Try again in a moment.",
}


PROJECT_READ_ONLY_DETAIL = {
    "error": "project_read_only",
    "message": PROJECT_READ_ONLY_MESSAGE,
}


def forbidden(code: str, msg: str) -> HTTPException:
    return HTTPException(403, detail={"error": code, "message": msg})
