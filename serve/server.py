#!/usr/bin/env python3
"""montaj serve — FastAPI HTTP + SSE server."""
import asyncio
import os
import re
import threading
import subprocess
import sys
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.middleware.trustedhost import TrustedHostMiddleware

from lib import disk_space
from serve import disk_full, lockfile, save_guard
from lib.project_lock import ProjectLockTimeout, ProjectReadOnly
from serve.common import DuplicateProjectId, PROJECT_LOCKED_DETAIL, PROJECT_READ_ONLY_DETAIL, resolve_workspace
from serve.sse import SSEBroadcaster
from serve.watcher import GlobalOverlayWatcher, ProjectWatcher

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cli.deps import ui_runtime_dir

PORT      = int(os.environ.get("MONTAJ_SERVE_PORT", "3000"))
VITE_PORT = 5173
VITE_URL  = f"http://localhost:{VITE_PORT}"

# Headers that must not be forwarded in a proxy hop
_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "transfer-encoding",
    "te", "trailer", "upgrade", "proxy-authenticate", "proxy-authorization",
})
# When set, disables embedded UI behaviors. Consumed in two places below:
#   - lifespan(): gates Vite-dev spawn
#   - module-level SPA catch-all — route is not registered when HEADLESS
# To find the gates, grep for `if not HEADLESS` (2 hits: 1 inside lifespan,
# 1 at module scope wrapping the ~40-line `serve_spa` decorator block).
# serve never opens a browser, in either mode (it used to, outside headless).
# See docs/plans/2026-05-02-headless-serve.md.
HEADLESS = os.environ.get("MONTAJ_HEADLESS") == "1"

# §477: at import, before anything can start a subprocess, so the shell secret is gone
# from the environment every step inherits.
save_guard.startup()



# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # UI readiness is verified up-front by `cli/commands/serve.py` via check_ui().
    # Dev mode = working tree (.git present, dir or worktree-file). Use the same
    # helper as deps.check_ui() so the two stay consistent.
    from cli.deps import is_dev_checkout
    vite_proc = None
    if not HEADLESS and is_dev_checkout():
        print(f"[montaj] Starting Vite dev server on :{VITE_PORT}…")
        vite_proc = subprocess.Popen(
            ["npm", "run", "dev", "--prefix", ui_runtime_dir()],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    loop = asyncio.get_running_loop()
    workspace = resolve_workspace()
    workspace.mkdir(parents=True, exist_ok=True)

    broadcaster = SSEBroadcaster()
    watcher = ProjectWatcher(workspace, broadcaster, loop)
    watcher.start()
    overlay_watcher = GlobalOverlayWatcher(broadcaster, loop)
    overlay_watcher.start()

    http_client = httpx.AsyncClient(timeout=10.0)

    app.state.broadcaster     = broadcaster
    app.state.watcher         = watcher
    app.state.overlay_watcher = overlay_watcher
    app.state.vite_proc       = vite_proc
    app.state.http_client     = http_client

    # Announce this serve so a separately-spawned MCP server can find it.
    # Best-effort: a read-only HOME must not stop serve from starting.
    try:
        lockfile.write(port=PORT, workspace=workspace)
    except OSError:
        pass

    yield
    # A running yt-dlp (PL28) is in its own process group, so a kill of serve
    # does not take it along: kill it here. Its project resumes on open.
    from serve.routes.projects import kill_source_downloads
    kill_source_downloads()
    from serve.audio_conform import shutdown as shutdown_audio_conform
    shutdown_audio_conform()
    watcher.stop()
    overlay_watcher.stop()
    lockfile.remove()
    await http_client.aclose()
    # Naturally a no-op in headless mode (vite_proc stays None).
    if vite_proc:
        vite_proc.terminate()
        vite_proc.wait()


class _TrustedHostsFromEnv:
    """Refuse (400) a Host outside MONTAJ_SERVE_TRUSTED_HOSTS (comma-separated).

    A page whose hostname resolves to 127.0.0.1 (DNS rebinding) is otherwise
    same-origin with serve. `montaj serve` sets 127.0.0.1,localhost unless
    --network. Read per request, not when `app` is built at import, so the
    check holds however early serve.server was imported. Unset means no check
    (TestClient's Host is `testserver`)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        hosts = [h.strip() for h in os.environ.get("MONTAJ_SERVE_TRUSTED_HOSTS", "").split(",") if h.strip()]
        if not hosts:
            await self.app(scope, receive, send)
            return
        await TrustedHostMiddleware(self.app, allowed_hosts=hosts, www_redirect=False)(scope, receive, send)


# §541: the writes whose whole size is known before the body is read (a browser
# upload's Content-Length), checked against the free space before anything,
# Starlette's own spool of the body included, is written.
_PREFLIGHT_UPLOADS = re.compile(r"^/api/(upload|projects/[^/]+/upload-asset)$")


class _DiskFullGuard:
    """§541: a full disk is one 507 `disk_full`, never a bare 500.

    - An upload (`_PREFLIGHT_UPLOADS`) that would not fit with its headroom is
      refused before its body is read (lib/disk_space.preflight; a free-space
      read that fails lets it through). The body is drained, not read into
      anything, so the client gets the answer instead of a reset connection.
    - A disk-full OSError no route caught, raised before the answer started,
      becomes the 507 (serve/disk_full.py). Every other error passes through
      exactly as before."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        upload = scope.get("method") == "POST" and _PREFLIGHT_UPLOADS.match(scope.get("path") or "")
        # An upload being received holds the part of its declared size not yet
        # arrived, so a drop of many files at once is checked against the space
        # they will take together, and bytes already on disk are never counted
        # twice. Held before its own check (so two checks at once each see the
        # other) and released however the request ends.
        hold = _Reservation(_declared_length(scope) if upload else 0)
        try:
            await self._guarded(scope, receive, send, upload, hold)
        finally:
            # However the request ends: a refusal, an error, a cancel during the check.
            hold.release_all()

    async def _guarded(self, scope, receive, send, upload, hold):
        if upload:
            refusal = await _upload_preflight_off_loop(scope, own=hold.left)
            if refusal is not None:
                hold.release_all()
                await _drain(receive)
                await disk_full.response(refusal)(scope, receive, send)
                return
        started = False

        async def counting_receive():
            message = await receive()
            if message.get("type") == "http.request":
                hold.release(len(message.get("body") or b""))
                if not message.get("more_body"):
                    hold.release_all()
            else:
                hold.release_all()        # a disconnect
            return message

        async def tracking_send(message):
            nonlocal started
            if message.get("type") == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counting_receive if upload else receive, tracking_send)
        except Exception as exc:
            if started or not disk_full.is_disk_full(exc):
                raise
            await disk_full.response(exc)(scope, receive, send)


# §541: bytes declared by the uploads now being received and not yet arrived.
_reserved_uploads = [0]
_reserved_lock = threading.Lock()


class _Reservation:
    """`n` bytes held in `_reserved_uploads`, given back as they arrive
    (`release`) and all at once when the body is in or the request ends."""

    def __init__(self, n: int):
        self.left = max(0, int(n or 0))
        with _reserved_lock:
            _reserved_uploads[0] += self.left

    def release(self, k: int) -> None:
        with _reserved_lock:
            k = min(self.left, max(0, int(k)))
            self.left -= k
            _reserved_uploads[0] -= k

    def release_all(self) -> None:
        self.release(self.left)


@contextmanager
def upload_reservation(n: int):
    hold = _Reservation(n)
    try:
        yield hold
    finally:
        hold.release_all()


def reserved_upload_bytes() -> int:
    return _reserved_uploads[0]


_PREFLIGHT_TIMEOUT_S = 2.0


async def _upload_preflight_off_loop(scope, own: int = 0):
    """`_upload_preflight` in a worker thread (statvfs can block on a slow or
    network volume), at most `_PREFLIGHT_TIMEOUT_S`; a check that fails or is
    slow lets the upload through (fail open)."""
    loop = asyncio.get_running_loop()
    try:
        return await asyncio.wait_for(loop.run_in_executor(None, _upload_preflight, scope, own), _PREFLIGHT_TIMEOUT_S)
    except Exception:
        return None


def _declared_length(scope) -> int:
    try:
        return max(0, int(dict(scope.get("headers") or []).get(b"content-length", b"") or 0))
    except ValueError:
        return 0


def _upload_preflight(scope, own: int = 0):
    """The DiskFull an upload of this request's declared length would hit,
    counting the uploads already being received, or None. An upload with no
    Content-Length is not checked here; a full disk while it is received is
    still the 507 (`_http_exception_handler`, `_DiskFullGuard`)."""
    length = _declared_length(scope)
    if length <= 0:
        return None
    try:
        disk_space.preflight(resolve_workspace(), length, reserved=max(0, reserved_upload_bytes() - own))
    except disk_space.DiskFull as refusal:
        return refusal
    except Exception:
        return None
    return None


async def _drain(receive):
    while True:
        message = await receive()
        if message.get("type") != "http.request" or not message.get("more_body"):
            return


app = FastAPI(lifespan=lifespan)
# Added first, so it sits inside the host check (the last added is outermost).
app.add_middleware(_DiskFullGuard)
app.add_middleware(_TrustedHostsFromEnv)


@app.exception_handler(StarletteHTTPException)
async def _http_exception_handler(request: Request, exc: StarletteHTTPException):
    """§541 review: FastAPI turns ANY failure while it reads a request body
    into a 400 "There was an error parsing the body", a full disk under
    Starlette's spool of a multipart upload included. One whose cause is a
    full disk is the 507; every other HTTPException is answered exactly as
    FastAPI's own handler answers it."""
    if exc.status_code != disk_full.STATUS and disk_full.is_disk_full(exc):
        # The body's spool is the temp folder, which may be another disk.
        return JSONResponse(status_code=disk_full.STATUS, content={"detail": disk_full.spool_detail()})
    return await http_exception_handler(request, exc)


@app.exception_handler(disk_space.DiskFull)
async def _disk_full_handler(request: Request, exc: disk_space.DiskFull):
    """§541: a route's own DiskFull (a preflight, or a full disk it cleaned up
    after) is the 507 with the shared shape."""
    return disk_full.response(exc)


@app.exception_handler(ProjectLockTimeout)
async def _project_locked_handler(request: Request, exc: ProjectLockTimeout):
    """A project write lock that stayed busy is a 503 with the error shape every
    route uses (`detail: {error, message}`), never a bare 500."""
    return JSONResponse(status_code=503, content={"detail": dict(PROJECT_LOCKED_DETAIL)})

@app.exception_handler(ProjectReadOnly)
async def _project_read_only_handler(request: Request, exc: ProjectReadOnly):
    """A project folder that cannot be written is a 409 with the shared error
    shape, never a bare 500 with a traceback."""
    return JSONResponse(status_code=409, content={"detail": dict(PROJECT_READ_ONLY_DETAIL)})

@app.exception_handler(DuplicateProjectId)
async def _duplicate_project_id_handler(request: Request, exc: DuplicateProjectId):
    """§518: an id claimed by two or more topmost project folders cannot be
    resolved to one folder, so every read and write for it refuses with a 409
    that names all the folders, so the AI can give the copy a new id. This is
    behind the Depends() ~22 routes share, so the refusal is uniform."""
    return JSONResponse(status_code=409, content={"detail": {
        "error": "duplicate_project_id",
        "message": str(exc),
        "projectId": exc.project_id,
        "folders": [str(d) for d in exc.dirs],
    }})

# All API routes live under /api so they never collide with React Router paths.
# The SPA catch-all at the bottom handles everything else cleanly.



from serve.routes import skills as _skills_routes
from serve.routes import workflows as _workflows_routes
from serve.routes import overlays as _overlays_routes
from serve.routes import profiles as _profiles_routes
from serve.routes import profile_assets as _profile_assets_routes
from serve.routes import steps as _steps_routes
from serve.routes import files as _files_routes
from serve.routes import projects as _projects_routes
from serve.routes import audio as _audio_routes
app.include_router(_skills_routes.router)
app.include_router(_workflows_routes.router)
app.include_router(_overlays_routes.router)
app.include_router(_profiles_routes.router)
app.include_router(_profile_assets_routes.router)
app.include_router(_steps_routes.router)
app.include_router(_files_routes.router)
app.include_router(_projects_routes.router)
app.include_router(_audio_routes.router)


if not HEADLESS:
    # SPA catch-all — registered after the API router so /api/* routes are never shadowed.
    # Dev mode:  proxies to the Vite dev server (HMR, instant rebuilds).
    # Prod mode: serves from ui/dist/ (static build).
    # Headless mode: not registered — non-/api paths get FastAPI's default 404.
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str, request: Request):
        # Dev mode — proxy to Vite (only while the process is still alive)
        vite_proc = request.app.state.vite_proc
        if vite_proc is not None and vite_proc.poll() is None:
            qs  = f"?{request.url.query}" if request.url.query else ""
            url = f"{VITE_URL}/{full_path}{qs}"
            fwd_headers = {k: v for k, v in request.headers.items()
                           if k.lower() not in _HOP_BY_HOP | {"host"}}
            try:
                client: httpx.AsyncClient = request.app.state.http_client
                vr = await client.get(url, headers=fwd_headers, follow_redirects=True)
                resp_headers = {k: v for k, v in vr.headers.items()
                                if k.lower() not in _HOP_BY_HOP}
                return Response(content=vr.content, status_code=vr.status_code, headers=resp_headers)
            except (httpx.ConnectError, httpx.TimeoutException):
                # Vite still starting up — show a self-refreshing splash
                return HTMLResponse(
                    '<html><head><meta http-equiv="refresh" content="1">'
                    '<style>body{background:#030712;color:#6b7280;font-family:monospace;'
                    'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}'
                    '</style></head><body>Starting dev server…</body></html>'
                )
            # If vite_proc has exited (poll() is not None), fall through to dist/

        # Prod mode — serve from dist/
        ui_dist = Path(ui_runtime_dir()) / "dist"
        if not ui_dist.exists():
            return HTMLResponse(
                "<h1>UI not built.</h1><p>Run: <code>montaj install ui</code></p>",
                status_code=503,
            )
        target = (ui_dist / full_path).resolve()
        if target.is_file() and ui_dist.resolve() in target.parents:
            return FileResponse(str(target))
        return FileResponse(str(ui_dist / "index.html"))
