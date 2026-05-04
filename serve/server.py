#!/usr/bin/env python3
"""montaj serve — FastAPI HTTP + SSE server."""
import asyncio
import os
import subprocess
import sys
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, Response

from serve.common import resolve_workspace
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
#   - lifespan() — gates Vite-dev spawn and webbrowser.open
#   - module-level SPA catch-all — route is not registered when HEADLESS
# To find the gates, grep for `if not HEADLESS` (3 hits: 2 inside lifespan,
# 1 at module scope wrapping the ~40-line `serve_spa` decorator block).
# See docs/plans/2026-05-02-headless-serve.md.
HEADLESS = os.environ.get("MONTAJ_HEADLESS") == "1"



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

    # Give Vite a moment to start before opening the browser
    if not HEADLESS:
        open_delay = 2.5 if vite_proc else 0.5
        loop.call_later(open_delay, lambda: webbrowser.open(f"http://localhost:{PORT}"))
    yield
    watcher.stop()
    overlay_watcher.stop()
    await http_client.aclose()
    # Naturally a no-op in headless mode (vite_proc stays None).
    if vite_proc:
        vite_proc.terminate()
        vite_proc.wait()


app = FastAPI(lifespan=lifespan)

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
app.include_router(_skills_routes.router)
app.include_router(_workflows_routes.router)
app.include_router(_overlays_routes.router)
app.include_router(_profiles_routes.router)
app.include_router(_profile_assets_routes.router)
app.include_router(_steps_routes.router)
app.include_router(_files_routes.router)
app.include_router(_projects_routes.router)


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
