"""serve's side of a full disk (§541): HTTP 507 with the shared error shape.

Every route answers a full disk the same way:
`507 {"detail": {"error": "disk_full", "message", "needed", "free", "path"}}`.
`path` is the workspace root, never a file inside it. Three ways in:

- `DiskFull` raised by a preflight (lib/disk_space.preflight) or by a route that
  caught a disk-full OSError itself, to clean up first.
- Any disk-full OSError a route did not catch: the app's OSError handler
  (serve/server.py) answers it, and every other OSError stays the 500 it was.
- A child process (project/init.py, a step) that failed: `child_disk_full`
  reads its JSON error or its text.
"""
import os
import tempfile

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from lib.disk_space import DISK_FULL, DiskFull, free_bytes, is_disk_full, message, tool_reported_disk_full

STATUS = 507


def workspace_root() -> str | None:
    try:
        from serve.common import resolve_workspace
        return str(resolve_workspace())
    except Exception:
        return None


def detail_for(exc: BaseException | None = None, needed=None) -> dict:
    """The 507's detail for `exc` (a DiskFull keeps its own numbers), with
    `path` always the workspace root."""
    root = workspace_root()
    if isinstance(exc, DiskFull):
        d = exc.detail()
        d["path"] = root
        return d
    return DiskFull(needed=needed, free=free_bytes(root), path=root).detail()


def response(exc: BaseException | None = None) -> JSONResponse:
    return JSONResponse(status_code=STATUS, content={"detail": detail_for(exc)})


def http_error(exc: BaseException | None = None, needed=None) -> HTTPException:
    return HTTPException(STATUS, detail=detail_for(exc, needed=needed))


def _same_volume(a, b) -> bool:
    try:
        return os.stat(a).st_dev == os.stat(b).st_dev
    except OSError:
        return True


def spool_detail() -> dict:
    """The 507's detail for a full disk while a request body was spooled:
    Starlette spools to the temp folder, so when that is on another disk than
    the workspace, that disk is the one named (its free space and folder),
    never the workspace's."""
    root = workspace_root()
    spool = tempfile.gettempdir()
    if root and not _same_volume(spool, root):
        return DiskFull(free=free_bytes(spool), path=spool).detail()
    return detail_for(None)


def child_disk_full(err, stderr, root) -> dict | None:
    """A failed child process's error, as the 507 detail when it was a full
    disk: its own `disk_full` JSON, or (a child that is only text) a last line
    in the tool's own full-disk shape (lib.disk_space.tool_reported_disk_full),
    never the words anywhere. None for any other failure. Free space is read
    at `root` (the workspace) now; the child's own number is used only when
    that read fails. The child's text is never passed on: only the sentence."""
    err = err if isinstance(err, dict) else {}
    if err.get("error") == DISK_FULL:
        needed = err.get("needed") if isinstance(err.get("needed"), int) else None
        free = free_bytes(root)
        if free is None and isinstance(err.get("free"), int):
            free = err["free"]
        out = {"error": DISK_FULL, "message": message(needed, free), "needed": needed, "free": free, "path": root}
        if isinstance(err.get("headroom"), int):
            out["headroom"] = err["headroom"]
        return out
    if tool_reported_disk_full(stderr) or tool_reported_disk_full(err.get("message")):
        free = free_bytes(root)
        return {"error": DISK_FULL, "message": message(None, free), "needed": None, "free": free, "path": root}
    return None


__all__ = ["STATUS", "DiskFull", "is_disk_full", "detail_for", "response", "http_error", "child_disk_full", "workspace_root"]
