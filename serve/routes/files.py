"""File-serving + asset endpoints: /files, /files/stream, /upload, /pick-files, /caption-template."""
import asyncio
import mimetypes
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from serve.common import (
    resolve_workspace, _is_under, _allowed_file_roots,
    not_found, bad_request, server_error, forbidden,
)
from serve.sse import sse_stream, SSEBroadcaster, JSX_GLOBAL_CHANNEL
from cli.deps import render_runtime_dir

router = APIRouter(prefix="/api")

CAPTION_STYLES = {"word-by-word", "pop", "karaoke", "subtitle", "highlight-box", "outline", "clean"}


async def save_upload(file: UploadFile, dest_dir: Path) -> Path:
    """Stream an uploaded file into dest_dir, de-duplicating the filename.
    Returns the absolute path written. Shared by the workspace-level and
    project-scoped upload routes."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / (file.filename or "upload")
    stem, suffix = dest.stem, dest.suffix
    counter = 1
    while dest.exists():
        dest = dest_dir / f"{stem}_{counter}{suffix}"
        counter += 1
    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):  # 1 MB chunks
            f.write(chunk)
    return dest


@router.post("/upload")
async def upload_file(file: UploadFile):
    """Accept a browser file drop, save to workspace/_uploads/, return absolute path."""
    dest = await save_upload(file, resolve_workspace() / "_uploads")
    return {"path": str(dest)}


@router.get("/pick-files")
async def pick_files(extensions: str | None = None, prompt: str = "Select files"):
    """Open a native file dialog and return selected absolute paths.

    extensions: optional comma-separated list of lowercase extensions without dots, e.g. "mp4,mov,avi"
    """
    exts = {e.strip().lower() for e in extensions.split(",")} if extensions else None
    return await asyncio.to_thread(_pick_files_sync, exts, prompt)


def _pick_files_sync(exts: set[str] | None, prompt: str) -> dict:
    """Blocking file-picker — runs in a thread pool so it doesn't block the event loop."""
    if sys.platform == "darwin":
        script = (
            f'set chosen to choose file '
            f'with multiple selections allowed '
            f'with prompt "{prompt}"\n'
            'set out to ""\n'
            'repeat with f in chosen\n'
            '  set out to out & POSIX path of f & "\\n"\n'
            'end repeat\n'
            'return out'
        )
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
        if r.returncode != 0:
            raise bad_request("cancelled", "No files selected")
        paths = [p for p in r.stdout.strip().split("\n") if p]
    else:
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.wm_attributes("-topmost", True)
            if exts:
                pattern = " ".join(f"*.{e}" for e in sorted(exts))
                filetypes = [(f"Supported files", pattern), ("All files", "*.*")]
            else:
                filetypes = [("All files", "*.*")]
            paths = list(filedialog.askopenfilenames(title=prompt, filetypes=filetypes))
            root.destroy()
        except Exception as exc:
            raise server_error("picker_failed", str(exc))

    if exts:
        paths = [p for p in paths if p.rsplit(".", 1)[-1].lower() in exts]
    return {"paths": paths}


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
    the workspace, or that resolve outside the workspace root.
    """
    try:
        body = await request.json()
    except Exception:
        raise bad_request("bad_request", "Request body must be JSON")

    raw_path = body.get("path", "")
    content = body.get("content", "")

    if not raw_path:
        raise bad_request("bad_request", "path is required")
    if not isinstance(raw_path, str) or not raw_path.startswith("/"):
        raise bad_request("bad_request", f"path must be absolute: {raw_path!r}")
    if not isinstance(content, str):
        raise bad_request("bad_request", "content must be a string")

    p = Path(raw_path)
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

    # Create parent dirs (a spec may be the first file in a subdir)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    encoded = content.encode("utf-8")
    resolved.write_bytes(encoded)
    return {"path": str(resolved), "bytes": len(encoded)}


@router.get("/files")
async def serve_file(path: str, request: Request):
    """Serve a local file by absolute path with range-request support.

    Range support is required for browsers to stream video without downloading
    the entire file first.

    Path safety: the resolved (symlink + .. normalized) target must be under
    one of the roots in `_allowed_file_roots()` — workspace, the global overlay
    library, or a profile's assets. Anything else returns 403. Suitable for
    sidecar deploys reached over the network.
    """
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
    Without ?path=: fires on every watched .jsx change; each frame carries
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
