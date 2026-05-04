"""File-serving + asset endpoints: /files, /files/stream, /upload, /pick-files, /caption-template."""
import asyncio
import mimetypes
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from serve.common import (
    resolve_workspace, _is_under, _allowed_file_roots,
    not_found, bad_request, server_error, forbidden,
)
from serve.sse import sse_stream, SSEBroadcaster
from cli.deps import render_runtime_dir

router = APIRouter(prefix="/api")

CAPTION_STYLES = {"word-by-word", "pop", "karaoke", "subtitle"}


@router.post("/upload")
async def upload_file(file: UploadFile):
    """Accept a browser file drop, save to workspace/_uploads/, return absolute path."""
    workspace = resolve_workspace()
    uploads_dir = workspace / "_uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)

    dest = uploads_dir / (file.filename or "upload")
    stem, suffix = dest.stem, dest.suffix
    counter = 1
    while dest.exists():
        dest = uploads_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):  # 1 MB chunks
            f.write(chunk)

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
    # TOCTOU: a symlink swap between resolve and open is theoretically race-able,
    # but not exploitable from the network in the sidecar threat model.
    try:
        resolved = p.resolve()
    except OSError:
        raise forbidden("forbidden", "Path is outside the allowed roots")
    if not any(_is_under(resolved, root) for root in _allowed_file_roots()):
        raise forbidden("forbidden", "Path is outside the allowed roots")
    p = resolved  # use the canonicalized path for stat/serve below

    file_size = p.stat().st_size
    media_type = mimetypes.guess_type(str(p))[0] or "application/octet-stream"
    range_header = request.headers.get("range")

    if not range_header:
        # No range requested — stream the whole file
        async def full_stream():
            with open(p, "rb") as f:
                while chunk := f.read(1 << 16):
                    yield chunk
        return StreamingResponse(full_stream(), media_type=media_type, headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
        })

    # Parse "bytes=start-end"
    try:
        byte_range = range_header.removeprefix("bytes=")
        start_str, end_str = byte_range.split("-", 1)
        start = int(start_str) if start_str else 0
        end   = int(end_str)   if end_str   else file_size - 1
    except Exception:
        raise HTTPException(416, detail="Invalid Range header")

    end = min(end, file_size - 1)
    if start > end or start >= file_size:
        raise HTTPException(416, headers={"Content-Range": f"bytes */{file_size}"})

    chunk_size = end - start + 1

    async def range_stream():
        with open(p, "rb") as f:
            f.seek(start)
            remaining = chunk_size
            while remaining > 0:
                data = f.read(min(1 << 16, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(
        range_stream(),
        status_code=206,
        media_type=media_type,
        headers={
            "Content-Range":  f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges":  "bytes",
            "Content-Length": str(chunk_size),
        },
    )


@router.get("/files/stream")
async def stream_file(path: str, request: Request):
    """SSE stream that fires whenever a specific local file changes.
    Used by the Overlays page to get live updates when an agent edits a JSX file."""
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    channel = f"jsx:{path}"
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
