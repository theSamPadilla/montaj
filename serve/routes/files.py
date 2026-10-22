"""File-serving + asset endpoints: /files, /files/stream, /upload, /caption-template."""
import mimetypes
import os
import re
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from lib.fs_safe import open_write_no_follow
from serve.common import (
    resolve_workspace, find_project_dir, _is_under, _allowed_file_roots,
    not_found, bad_request, forbidden, lands_on_project_file,
)
from serve import save_guard
from serve.out_guard import _has_git_component
from serve.sse import sse_stream, SSEBroadcaster, JSX_GLOBAL_CHANNEL
from cli.deps import render_runtime_dir

router = APIRouter(prefix="/api")

CAPTION_STYLES = {"word-by-word", "pop", "karaoke", "subtitle", "highlight-box", "outline", "clean", "accent", "plate"}

# Absolute-path check seam. On POSIX this is os.path.isabs (== startswith("/")
# for str paths); tests prove Windows behaviour by swapping this to
# ntpath.isabs, never by patching os.path.isabs or sys.platform globally.
_is_abs = os.path.isabs

PROJECT_FILE_PROTECTED_MESSAGE = ("project.json, the project's lock file and its provenance records can't be "
                                  "written as files. Change a project with save_project.")


def upload_name(filename) -> str:
    """The name an upload is saved under: the last component of the multipart
    filename, by either slash, so no `../` or absolute name leaves the folder.
    Empty, `.`, `..`, a NUL (or, on Windows, a drive or stream colon) is a 400
    invalid_filename, as profile_assets does."""
    base = re.split(r"[\\/]", filename or "upload")[-1]
    if not base or base in (".", "..") or "\x00" in base or (os.name == "nt" and ":" in base):
        raise bad_request("invalid_filename", "Invalid filename")
    return base


async def save_upload(file: UploadFile, dest_dir: Path) -> Path:
    """Stream an uploaded file into dest_dir under its own name (upload_name),
    de-duplicated. The file is created new (O_EXCL: never an existing file,
    never through a link), so an upload never replaces anything.
    Returns the absolute path written. Shared by the workspace-level and
    project-scoped upload routes."""
    name = upload_name(file.filename)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / name
    stem, suffix = dest.stem, dest.suffix
    counter = 1
    while True:
        try:
            f = open(dest, "xb")
            break
        except FileExistsError:
            dest = dest_dir / f"{stem}_{counter}{suffix}"
            counter += 1
    with f:
        while chunk := await file.read(1024 * 1024):  # 1 MB chunks
            f.write(chunk)
    return dest


@router.post("/upload")
async def upload_file(file: UploadFile):
    """Accept a browser file drop, save to workspace/_uploads/, return absolute path."""
    dest = await save_upload(file, resolve_workspace() / "_uploads")
    return {"path": str(dest)}


@router.get("/caption-template/{style}")
async def get_caption_template(style: str):
    """Serve a built-in caption template JSX file for in-browser preview."""
    if style not in CAPTION_STYLES:
        raise not_found("not_found", f"Unknown caption style: {style}")
    p = Path(render_runtime_dir()) / "templates" / "captions" / f"{style}.jsx"
    if not p.is_file():
        raise not_found("not_found", f"Template not found: {p}")
    return FileResponse(str(p), media_type="text/plain")


@router.post("/files")
async def write_file(request: Request):
    """Write a text file to an absolute path inside the workspace root.

    Body: { "path": "<absolute path>", "content": "<text>" }

    Path safety: the resolved parent directory must be under the workspace root
    only — NOT under the overlay/profile/template library roots (those are
    read-only). Rejects paths that are not absolute, that contain .. escaping
    the workspace, or that resolve outside the workspace root. The final file's
    real path must stay inside the workspace, the open is O_NOFOLLOW so a
    symlink planted at the target is refused, not written through (H3), and a
    `.git` component is refused (H5).
    """
    try:
        body = await request.json()
    except Exception:
        raise bad_request("bad_request", "Request body must be JSON")

    raw_path = body.get("path", "")
    content = body.get("content", "")

    if not raw_path:
        raise bad_request("bad_request", "path is required")
    if not isinstance(raw_path, str) or not _is_abs(raw_path):
        raise bad_request("bad_request", f"path must be absolute: {raw_path!r}")
    if not isinstance(content, str):
        raise bad_request("bad_request", "content must be a string")

    if lands_on_project_file(raw_path):
        raise bad_request("project_file_protected", PROJECT_FILE_PROTECTED_MESSAGE)

    p = Path(raw_path)
    if re.split(r"[\\/]", raw_path)[-1] in ("", ".", ".."):
        raise bad_request("bad_request", f"path must name a file: {raw_path!r}")
    workspace_root = resolve_workspace().resolve()

    # Resolve the parent directory — we check the parent (not the file itself,
    # which may not exist yet) so new files in an existing subdir are accepted.
    try:
        resolved_parent = p.parent.resolve()
    except OSError:
        raise forbidden("forbidden", "Path is outside the workspace root")

    if not _is_under(resolved_parent, workspace_root):
        raise forbidden("forbidden", "Path is outside the workspace root")

    # Use the canonical absolute path derived from the parent so we don't
    # resolve a non-existent file (which would silently keep the raw path).
    resolved = resolved_parent / p.name
    # A symlink under another name, or a name the filesystem folds onto one, may still
    # land on one: checked by name and as the same file on disk.
    try:
        landing = resolved.resolve()
    except OSError:
        landing = resolved
    if lands_on_project_file(resolved, landing):
        raise bad_request("project_file_protected", PROJECT_FILE_PROTECTED_MESSAGE)

    # H5: a .git component (given, through a symlinked parent, or at the final link) would plant a git
    # hook or config where serve shells git in a project.
    if _has_git_component(raw_path, str(resolved), str(landing)):
        raise bad_request("project_file_protected", "A file path may not write inside a project's .git folder.")

    # H3: only the parent was checked before, so a symlink planted AT the destination redirected the write
    # outside the workspace. Require the final file's real path to stay inside the workspace, and open with
    # O_NOFOLLOW so a symlink at the target is refused (ELOOP) rather than written through. The route
    # legitimately overwrites (editing an overlay JSX, a spec), so O_TRUNC, not O_EXCL.
    if not _is_under(Path(os.path.realpath(resolved)), workspace_root):
        raise forbidden("forbidden", "Path is outside the workspace root")

    # §482: a file in an open Studio sync clash, as its relpath in the topmost project folder holding it.
    save_guard.check_sync_paths(getattr(request, "headers", None), [(str(resolved), False)])

    # Create parent dirs (a spec may be the first file in a subdir)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    encoded = content.encode("utf-8")
    try:
        fd = open_write_no_follow(str(resolved))
    except OSError:
        # ELOOP (a symlink or reparse point sits at the target) or any other open failure: refuse, never follow it.
        raise forbidden("forbidden", "Path is outside the workspace root")
    with os.fdopen(fd, "wb") as f:
        f.write(encoded)
    return {"path": str(resolved), "bytes": len(encoded)}


@router.get("/files")
async def serve_file(path: str, request: Request, project: str | None = None):
    """Serve a local file by absolute path with range-request support.

    Range support is required for browsers to stream video without downloading
    the entire file first.

    Path safety: the resolved (symlink + .. normalized) target must be under
    one of the roots in `_allowed_file_roots()` — workspace, the global overlay
    library, or a profile's assets. Anything else returns 403. Suitable for
    sidecar deploys reached over the network.

    With `project=<id>` and a RELATIVE `path`, the path is taken relative to
    that project's directory (the way the renderer resolves a stored src), then
    goes through every check below unchanged, so `../` escapes are still
    refused. An absolute `path` ignores `project`.
    """
    project_root: Path | None = None
    if project and not _is_abs(path) and not path.startswith(("/", "\\")):
        project_dir = find_project_dir(resolve_workspace(), project)
        if project_dir is None:
            raise not_found("not_found", f"Project not found: {project}")
        project_root = project_dir
        p = project_dir / path.replace("\\", "/")
    else:
        p = Path(path)
    if not p.is_file():
        # macOS screenshot filenames use NARROW NO-BREAK SPACE (\u202f) before AM/PM,
        # but paths written by the agent (or pasted) use a regular space.
        parent = p.parent
        if parent.is_dir():
            target = p.name.replace('\u202f', ' ')
            for candidate in parent.iterdir():
                if candidate.name.replace('\u202f', ' ') == target:
                    p = candidate
                    break
        if not p.is_file():
            raise not_found("not_found", f"File not found: {path}")

    # Scope check — runs after any NBSP-fallback reassignment of p, before any
    # stat/serve operation. Both p and each allowed root are .resolve()'d so
    # the comparison is over canonical (symlink-followed, .. -normalized) paths.
    # Because p.resolve() follows symlinks, a symlinked source whose RESOLVED
    # target is still under the workspace root is intentionally servable — this
    # is how clips-workflow child projects preview a shared source they link to.
    # A symlink whose target escapes the roots still 403s (resolve catches it).
    # TOCTOU: a symlink swap between resolve and open is theoretically race-able,
    # but not exploitable from the network in the sidecar threat model.
    try:
        resolved = p.resolve()
    except OSError:
        raise forbidden("forbidden", "Path is outside the allowed roots")
    # A project-relative src must stay inside its own project (no `..` or
    # symlink hop into a sibling project), on top of the allowed-roots check.
    if project_root is not None and not _is_under(resolved, project_root.resolve()):
        raise forbidden("forbidden", "Path is outside the project")
    if not any(_is_under(resolved, root) for root in _allowed_file_roots()):
        raise forbidden("forbidden", "Path is outside the allowed roots")
    p = resolved  # use the canonicalized path for stat/serve below

    # FileResponse handles Range (206/416), Content-Length, ETag, and does its
    # reads off the event loop — replacing the hand-rolled sync-read generators.
    media_type = mimetypes.guess_type(str(p))[0] or "application/octet-stream"
    return FileResponse(p, media_type=media_type)


@router.get("/files/stream")
async def stream_file(request: Request, path: str | None = None):
    """SSE stream of file-change events.

    With ?path=<abs path>: fires only when that one file changes (legacy
    per-file channel — kept for external consumers, e.g. the Overlays page's
    single-file preview).
    Without ?path=: fires on every watched overlay source change
    (.jsx, .js, .mjs, .ts, .tsx, .json); each frame carries
    {"path": ...} so the client filters. One connection serves every watcher
    in a tab — see docs/plans/2026-07-22-editor-connection-pool.md.
    """
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    channel = f"jsx:{path}" if path else JSX_GLOBAL_CHANNEL
    queue = broadcaster.subscribe(channel)

    async def event_stream():
        try:
            async for frame in sse_stream(request, queue):
                yield frame
        finally:
            broadcaster.unsubscribe(channel, queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
