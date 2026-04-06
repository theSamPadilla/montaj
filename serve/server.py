#!/usr/bin/env python3
"""montaj serve — FastAPI HTTP + SSE server."""
import asyncio
import html as html_lib
import json
import os
import subprocess
import sys
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import APIRouter, Body, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse

from serve.sse import SSEBroadcaster
from serve.watcher import GlobalOverlayWatcher, ProjectWatcher

MONTAJ_ROOT = Path(__file__).resolve().parent.parent
PORT      = int(os.environ.get("MONTAJ_SERVE_PORT", "3000"))
VITE_PORT = 5173
VITE_URL  = f"http://localhost:{VITE_PORT}"

# Headers that must not be forwarded in a proxy hop
_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "transfer-encoding",
    "te", "trailer", "upgrade", "proxy-authenticate", "proxy-authorization",
})
STEP_TIMEOUT_S = int(os.environ.get("MONTAJ_STEP_TIMEOUT", "900"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _git_commit_sync(project_dir: Path, message: str) -> None:
    """Blocking git commit — call via asyncio.to_thread to avoid blocking the event loop."""
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "montaj", "GIT_AUTHOR_EMAIL": "montaj@local",
        "GIT_COMMITTER_NAME": "montaj", "GIT_COMMITTER_EMAIL": "montaj@local",
    }
    subprocess.run(["git", "add", "project.json"], cwd=str(project_dir), env=env,
                   capture_output=True)
    result = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=str(project_dir), env=env,
                            capture_output=True)
    if result.returncode == 0:
        return  # nothing staged — skip commit
    subprocess.run(["git", "commit", "-m", message], cwd=str(project_dir), env=env,
                   capture_output=True)


def resolve_workspace() -> Path:
    config_path = Path.home() / ".montaj" / "config.json"
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text())
            if "workspaceDir" in cfg:
                return Path(cfg["workspaceDir"])
        except Exception:
            pass
    return Path.home() / "Montaj"



def scan_overlays(overlays_dir: Path) -> list[dict]:
    """Scan an overlays directory for overlay entries.

    Supports a flat layout and one level of grouping:
      {overlays_dir}/{name}/{name}.jsx          — ungrouped
      {overlays_dir}/{group}/{name}/{name}.jsx  — grouped

    Each overlay dir must contain {name}.jsx; {name}.json is optional."""
    results = []
    if not overlays_dir.exists():
        return results

    def _entry(subdir: Path, group: str | None) -> dict:
        jsx_path  = subdir / f"{subdir.name}.jsx"
        schema: dict = {}
        json_path = subdir / f"{subdir.name}.json"
        if json_path.exists():
            try:
                schema = json.loads(json_path.read_text())
            except Exception:
                pass
        entry = {
            "name":        subdir.name,
            "description": schema.get("description", ""),
            "props":       schema.get("props", []),
            "jsxPath":     str(jsx_path),
        }
        if group:
            entry["group"] = group
        return entry

    for subdir in sorted(overlays_dir.iterdir()):
        if not subdir.is_dir():
            continue
        if (subdir / f"{subdir.name}.jsx").exists():
            results.append(_entry(subdir, group=None))
        else:
            children = sorted(subdir.iterdir())
            overlay_children = [c for c in children if c.is_dir() and (c / f"{c.name}.jsx").exists()]
            if overlay_children:
                for child in overlay_children:
                    results.append(_entry(child, group=subdir.name))
            else:
                results.append({"group": subdir.name, "empty": True})

    return results


def scan_steps() -> dict[str, tuple[dict, Path]]:
    """Scan native (built-in) then custom (~/.montaj/steps). Later scope overwrites earlier.
    Returns dict[name, (schema, py_path)]."""
    scopes = [
        MONTAJ_ROOT / "steps",
        Path.home() / ".montaj" / "steps",
    ]
    steps: dict[str, tuple[dict, Path]] = {}
    for scope in scopes:
        if not scope.exists():
            continue
        for json_file in scope.glob("*.json"):
            try:
                schema = json.loads(json_file.read_text())
            except Exception:
                continue
            name = schema.get("name")
            if not name:
                continue
            py_path = scope / (name + ".py")
            if not py_path.exists():
                continue
            steps[name] = (schema, py_path)
    return steps


def build_cli_args(schema: dict, body: dict) -> list[str]:
    """Map request body fields to CLI flags. Mirrors mcp/server.js buildCliArgs."""
    flags: list[str] = []

    inp = schema.get("input", {})
    if inp.get("multiple"):
        files = body.get("inputs", [])
        if len(files) == 1:
            flags += ["--input", str(files[0])]
        elif files:
            flags += ["--inputs"] + [str(f) for f in files]
    elif "input" in body:
        flags += ["--input", str(body["input"])]

    for param in schema.get("params", []):
        val = body.get(param["name"])
        if val is None:
            continue
        if param.get("type") == "bool":
            if val:
                flags.append("--" + param["name"])
        else:
            flags += ["--" + param["name"], json.dumps(val) if isinstance(val, (list, dict)) else str(val)]

    if "out" in body:
        flags += ["--out", str(body["out"])]

    return flags


def validate_params(schema: dict, body: dict) -> None:
    """Validate body params against schema constraints. Raises HTTPException 422 on failure."""
    errors = []
    for param in schema.get("params", []):
        name  = param["name"]
        val   = body.get(name)
        ptype = param.get("type")

        if val is None:
            if param.get("required"):
                errors.append(f"'{name}' is required")
            continue

        if ptype in ("float", "int"):
            try:
                num = float(val) if ptype == "float" else int(val)
            except (TypeError, ValueError):
                errors.append(f"'{name}' must be a {ptype}, got {val!r}")
                continue
            if "min" in param and num < param["min"]:
                errors.append(f"'{name}' must be >= {param['min']}, got {num}")
            if "max" in param and num > param["max"]:
                errors.append(f"'{name}' must be <= {param['max']}, got {num}")

        elif ptype == "enum":
            options = param.get("options", [])
            if val not in options:
                errors.append(f"'{name}' must be one of {options}, got {val!r}")

    if errors:
        raise HTTPException(422, detail={"error": "invalid_params", "message": "; ".join(errors)})


def wrap_output(stdout: str, schema: dict) -> dict:
    """Wrap bare file paths as JSON. Steps that already return JSON pass through."""
    text = stdout.strip()
    if text.startswith(("{", "[")):
        return json.loads(text)
    return {"path": text, "type": schema.get("output", {}).get("type", "file")}


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    ui_src  = MONTAJ_ROOT / "ui"
    ui_dist = MONTAJ_ROOT / "ui" / "dist"

    vite_proc = None
    if (ui_src / "src").exists():
        # Dev checkout — run Vite dev server for HMR instead of serving dist/
        if not (ui_src / "node_modules").exists():
            print("[montaj] Installing UI dependencies…")
            r = subprocess.run(["npm", "install", "--prefix", str(ui_src)], capture_output=True, text=True)
            if r.returncode != 0:
                print(f"[montaj] npm install failed:\n{r.stderr or r.stdout}", flush=True)
                raise RuntimeError("npm install failed — see output above")
        print(f"[montaj] Starting Vite dev server on :{VITE_PORT}…")
        vite_proc = subprocess.Popen(
            ["npm", "run", "dev", "--prefix", str(ui_src)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    elif not ui_dist.exists() and (ui_src / "package.json").exists():
        # Production install, dist missing — build once
        print("[montaj] Building UI for the first time — this takes ~30s…")
        r = subprocess.run(["npm", "install", "--prefix", str(ui_src)], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"[montaj] npm install failed:\n{r.stderr or r.stdout}", flush=True)
            raise RuntimeError("UI build failed at npm install — see output above")
        r = subprocess.run(["npm", "run", "build", "--prefix", str(ui_src)], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"[montaj] npm run build failed:\n{r.stderr or r.stdout}", flush=True)
            raise RuntimeError("UI build failed at npm run build — see output above")

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
    open_delay = 2.5 if vite_proc else 0.5
    loop.call_later(open_delay, lambda: webbrowser.open(f"http://localhost:{PORT}"))
    yield
    watcher.stop()
    overlay_watcher.stop()
    await http_client.aclose()
    if vite_proc:
        vite_proc.terminate()
        vite_proc.wait()


app = FastAPI(lifespan=lifespan)

# All API routes live under /api so they never collide with React Router paths.
# The SPA catch-all at the bottom handles everything else cleanly.
router = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------



@router.post("/run", status_code=201)
async def run_project(body: dict = Body(...)):
    clips    = body.get("clips", [])
    assets   = body.get("assets", [])
    prompt   = body.get("prompt")
    workflow = body.get("workflow", "clean_cut")
    name     = body.get("name")
    profile  = body.get("profile")

    if not prompt:
        raise HTTPException(400, detail={"error": "missing_field", "message": "'prompt' is required"})

    for clip in clips:
        if not Path(clip).is_file():
            raise HTTPException(400, detail={"error": "file_not_found", "message": f"Clip not found: {clip}"})

    for asset in assets:
        if not Path(asset).is_file():
            raise HTTPException(400, detail={"error": "file_not_found", "message": f"Asset not found: {asset}"})

    init_py = MONTAJ_ROOT / "project" / "init.py"
    cmd = [sys.executable, str(init_py), "--prompt", prompt, "--workflow", workflow]
    if name:
        cmd += ["--name", name]
    if assets:
        cmd += ["--assets"] + [str(a) for a in assets]
    if profile:
        cmd += ["--profile", profile]

    if clips:
        cmd += ["--clips"] + [str(c) for c in clips]
    else:
        # No clips — check workflow's requires_clips to decide how to proceed
        requires_clips = True  # conservative default
        workflow_path = MONTAJ_ROOT / "workflows" / f"{workflow}.json"
        if workflow_path.exists():
            try:
                wf_data = json.loads(workflow_path.read_text())
                requires_clips = wf_data.get("requires_clips", True)
            except Exception:
                pass

        if not requires_clips:
            # Workflow explicitly says no footage needed — create canvas project
            cmd.append("--canvas")
        else:
            raise HTTPException(
                400,
                detail={
                    "error": "clips_required",
                    "message": f"Workflow '{workflow}' requires source footage. Provide clips or use a canvas workflow."
                }
            )

    # Blocking subprocess inside async handler — acceptable for single-user local
    # tool but blocks all requests (including SSE keepalives) for the duration.
    # Fix: asyncio.create_subprocess_exec + await proc.communicate()
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60, cwd=str(Path.cwd()))
    except subprocess.TimeoutExpired:
        raise HTTPException(504, detail={"error": "timeout", "message": "Project init exceeded 60s"})
    if result.returncode != 0:
        try:
            err = json.loads(result.stderr)
        except Exception:
            err = {"error": "init_failed", "message": result.stderr.strip()}
        raise HTTPException(500, detail=err)

    project_path = Path(result.stdout.strip())
    try:
        return json.loads(project_path.read_text())
    except Exception:
        raise HTTPException(500, detail={"error": "read_failed", "message": "Project created but could not be read back"})


@router.get("/projects")
async def list_projects(status: str | None = None):
    workspace = resolve_workspace()
    projects = []
    for p in sorted(workspace.glob("*/project.json"), key=lambda f: f.stat().st_mtime, reverse=True):
        try:
            proj = json.loads(p.read_text())
        except Exception:
            continue
        if status and proj.get("status") != status:
            continue
        projects.append(proj)
    return projects


@router.get("/projects/{project_id}")
async def get_project(project_id: str):
    workspace = resolve_workspace()
    for p in workspace.glob("*/project.json"):
        try:
            data = json.loads(p.read_text())
            if data.get("id") == project_id:
                return data
        except Exception:
            pass
    raise HTTPException(404, detail={"error": "not_found", "message": f"Project '{project_id}' not found"})


@router.get("/projects/{project_id}/stream")
async def stream_project(project_id: str, request: Request):
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    workspace = resolve_workspace()

    project_path: Path | None = None
    for p in workspace.glob("*/project.json"):
        try:
            data = json.loads(p.read_text())
            if data.get("id") == project_id:
                project_path = p
                break
        except Exception:
            pass

    if project_path is None:
        raise HTTPException(404, detail={"error": "not_found", "message": f"Project '{project_id}' not found"})

    queue = broadcaster.subscribe(project_id)

    async def event_stream():
        try:
            # Send current state immediately on connect
            yield f"data: {project_path.read_text()}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=25)
                    yield frame  # already a complete SSE frame
                except asyncio.TimeoutError:
                    # SSE comment keeps connection alive through proxies
                    yield ": keepalive\n\n"
        finally:
            broadcaster.unsubscribe(project_id, queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/projects/{project_id}/log", status_code=204)
async def log_status(project_id: str, body: dict = Body(...), request: Request = None):
    message = str(body.get("message", "")).strip()
    if not message:
        raise HTTPException(400, detail={"error": "missing_field", "message": "'message' is required"})
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    frame = f"event: log\ndata: {json.dumps({'message': message})}\n\n"
    broadcaster.publish(project_id, frame)


@router.post("/projects/{project_id}/reload")
async def reload_project(project_id: str, request: Request):
    """Re-read project.json from disk and broadcast to all SSE subscribers.
    Call this after making direct file edits that bypass the PUT endpoint.
    Returns {"subscribers": N} so callers can confirm the browser is connected."""
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    workspace = resolve_workspace()
    for p in workspace.glob("*/project.json"):
        try:
            text = p.read_text()
            data = json.loads(text)
            if data.get("id") == project_id:
                n = len(broadcaster._subscribers.get(project_id, []))
                broadcaster.publish(project_id, f"data: {text}\n\n")
                return {"subscribers": n}
        except Exception:
            pass
    raise HTTPException(404, detail={"error": "not_found", "message": f"Project '{project_id}' not found"})


@router.get("/info")
async def get_info():
    return {
        "skill_path": str(MONTAJ_ROOT / "skills/onboarding/SKILL.md"),
        "root_skill_path": str(MONTAJ_ROOT / "SKILL.md"),
        "style_profile_skill_path": str(MONTAJ_ROOT / "skills/style-profile/SKILL.md"),
    }


def scan_skills() -> list[dict]:
    """Scan native (built-in) then custom (~/.montaj/skills) skills. Later scope overwrites earlier.
    Reads YAML frontmatter from each skills/<name>/SKILL.md. Returns list of {name, description, scope}."""
    import re
    scopes = [
        (MONTAJ_ROOT / "skills",           "native"),
        (Path.home() / ".montaj" / "skills", "custom"),
    ]
    skills: dict[str, dict] = {}
    for scope_dir, scope_label in scopes:
        if not scope_dir.exists():
            continue
        for skill_dir in sorted(scope_dir.iterdir()):
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.exists():
                continue
            text = skill_md.read_text()
            # Parse YAML frontmatter between --- delimiters
            m = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
            if not m:
                continue
            fm: dict = {}
            for line in m.group(1).splitlines():
                if ":" in line:
                    k, _, v = line.partition(":")
                    fm[k.strip()] = v.strip().strip('"')
            name = fm.get("name")
            if not name:
                continue
            if fm.get("step", "").lower() not in ("true", "1", "yes"):
                continue
            skills[name] = {
                "name": f"montaj/{name}",
                "description": fm.get("description", ""),
                "scope": scope_label,
            }
    return list(skills.values())


@router.get("/skills")
async def list_skills():
    return scan_skills()


@router.get("/steps")
async def list_steps():
    return [schema for schema, _ in scan_steps().values()]


@router.post("/steps/{name}")
async def run_step(name: str, body: dict = Body(default={})):
    steps = scan_steps()
    if name not in steps:
        raise HTTPException(404, detail={"error": "not_found", "message": f"Step '{name}' not found"})

    schema, py_path = steps[name]
    validate_params(schema, body)
    cli_args = build_cli_args(schema, body)

    # Blocking subprocess inside async handler — acceptable for single-user local
    # tool but blocks all requests (including SSE keepalives) for the duration.
    # Fix: asyncio.create_subprocess_exec + await proc.communicate()
    try:
        result = subprocess.run(
            [sys.executable, str(py_path), *cli_args],
            capture_output=True, text=True,
            timeout=STEP_TIMEOUT_S,
            cwd=str(Path.cwd()),
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, detail={"error": "timeout", "message": f"Step '{name}' exceeded {STEP_TIMEOUT_S}s"})

    if result.returncode != 0:
        try:
            err = json.loads(result.stderr)
        except Exception:
            err = {"error": "step_failed", "message": result.stderr.strip()}
        raise HTTPException(500, detail=err)

    return wrap_output(result.stdout, schema)


@router.delete("/projects/{project_id}", status_code=204)
async def delete_project(project_id: str):
    import shutil
    workspace = resolve_workspace()
    project_dir: Path | None = None
    for p in workspace.glob("*/project.json"):
        try:
            if json.loads(p.read_text()).get("id") == project_id:
                project_dir = p.parent
                break
        except Exception:
            pass
    if project_dir is None:
        raise HTTPException(404, detail={"error": "not_found", "message": f"Project '{project_id}' not found"})
    shutil.rmtree(project_dir)


@router.put("/projects/{project_id}")
async def save_project(project_id: str, body: dict = Body(...), request: Request = None):
    if body.get("id") != project_id:
        raise HTTPException(400, detail={"error": "id_mismatch", "message": "Body id must match URL id"})
    workspace = resolve_workspace()
    project_path: Path | None = None
    project_dir:  Path | None = None
    prev_status:  str  | None = None
    for p in workspace.glob("*/project.json"):
        try:
            data = json.loads(p.read_text())
            if data.get("id") == project_id:
                project_path = p
                project_dir  = p.parent
                prev_status  = data.get("status")
                break
        except Exception:
            pass
    if project_path is None:
        raise HTTPException(404, detail={"error": "not_found", "message": f"Project '{project_id}' not found"})
    text = json.dumps(body, indent=2)
    project_path.write_text(text)
    # Broadcast immediately — before the git commit so the UI update is instant.
    # Don't rely on the file watcher which can miss updates during SSE reconnect windows.
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    broadcaster.publish(project_id, f"data: {text}\n\n")
    # Auto-commit to git on status transitions — run in a thread so it doesn't block the event loop
    new_status = body.get("status")
    if new_status in ("draft", "final") and new_status != prev_status:
        run_count = body.get("runCount", 1)
        asyncio.create_task(asyncio.to_thread(
            _git_commit_sync, project_dir, f"version: run {run_count} — {new_status}"
        ))
    return body


@router.get("/projects/{project_id}/versions")
async def list_versions(project_id: str):
    workspace = resolve_workspace()
    project_dir: Path | None = None
    for p in workspace.glob("*/project.json"):
        try:
            if json.loads(p.read_text()).get("id") == project_id:
                project_dir = p.parent
                break
        except Exception:
            pass
    if project_dir is None:
        raise HTTPException(404, detail={"error": "not_found", "message": f"Project '{project_id}' not found"})
    result = subprocess.run(
        ["git", "log", "--pretty=format:%H|%s|%aI", "--", "project.json"],
        cwd=str(project_dir), capture_output=True, text=True,
    )
    versions = []
    for line in result.stdout.strip().splitlines():
        parts = line.split("|", 2)
        if len(parts) == 3:
            versions.append({"hash": parts[0], "message": parts[1], "timestamp": parts[2]})
    return versions


@router.post("/projects/{project_id}/versions/{commit}/restore")
async def restore_version(project_id: str, commit: str, request: Request):
    workspace = resolve_workspace()
    project_path: Path | None = None
    project_dir:  Path | None = None
    for p in workspace.glob("*/project.json"):
        try:
            if json.loads(p.read_text()).get("id") == project_id:
                project_path = p
                project_dir  = p.parent
                break
        except Exception:
            pass
    if project_path is None:
        raise HTTPException(404, detail={"error": "not_found", "message": f"Project '{project_id}' not found"})
    result = subprocess.run(
        ["git", "show", f"{commit}:project.json"],
        cwd=str(project_dir), capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise HTTPException(404, detail={"error": "not_found", "message": f"Commit '{commit}' not found"})
    try:
        restored = json.loads(result.stdout)
    except Exception:
        raise HTTPException(500, detail={"error": "parse_failed", "message": "Could not parse project.json at that commit"})
    project_path.write_text(json.dumps(restored, indent=2))
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    broadcaster.publish(project_id, f"data: {json.dumps(restored)}\n\n")
    return restored


@router.post("/projects/{project_id}/rerun")
async def rerun_project(project_id: str, request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    workspace = resolve_workspace()
    project_path: Path | None = None
    project_dir: Path | None = None
    project: dict | None = None
    for p in workspace.glob("*/project.json"):
        try:
            data = json.loads(p.read_text())
            if data.get("id") == project_id:
                project_path = p
                project_dir = p.parent
                project = data
                break
        except Exception:
            pass
    if project_path is None or project is None:
        raise HTTPException(404, detail={"error": "not_found", "message": f"Project '{project_id}' not found"})

    sources = project.get("sources")
    if not sources:
        raise HTTPException(400, detail={"error": "no_sources", "message": "Project has no sources — cannot re-run"})

    run_count = project.get("runCount", 1)
    version_label = body.get("versionName") or project.get("status", "draft")

    # Commit the completed version to git before resetting (in a thread — non-blocking)
    await asyncio.to_thread(_git_commit_sync, project_dir, f"version: run {run_count} — {version_label}")

    # Restore video track to original source clips; drop captions/overlays
    source_clips = [{"id": c["id"], "src": c["src"], "order": c["order"]} for c in sources]
    updated = {
        **project,
        "status": "pending",
        "runCount": run_count + 1,
        "tracks": [{"id": "main", "type": "video", "clips": source_clips}],
    }
    if "prompt" in body:
        updated["editingPrompt"] = body["prompt"]
    if "workflow" in body:
        updated["workflow"] = body["workflow"]

    text = json.dumps(updated, indent=2)
    project_path.write_text(text)
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    broadcaster.publish(project_id, f"data: {text}\n\n")
    return updated


def _workflow_dirs() -> list[tuple[str, Path]]:
    """Return [(scope, dir)] in resolution order: user-global → built-in."""
    return [
        ("user",    Path.home() / ".montaj" / "workflows"),
        ("builtin", Path.cwd() / "workflows"),
    ]


@router.get("/workflows")
async def list_workflows():
    """List all workflows across scopes. Returns [{name, scope}], deduped (user wins)."""
    seen: dict[str, str] = {}
    for scope, d in _workflow_dirs():
        if not d.exists():
            continue
        for p in d.glob("*.json"):
            if p.stem not in seen:
                seen[p.stem] = scope
    return sorted(
        [{"name": name, "scope": scope} for name, scope in seen.items()],
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
async def pick_files():
    """Open a native file dialog and return selected absolute paths."""
    return await asyncio.to_thread(_pick_files_sync)


def _pick_files_sync() -> dict:
    """Blocking file-picker — runs in a thread pool so it doesn't block the event loop."""
    if sys.platform == "darwin":
        # No type filter — 'of type' requires UTIs on modern macOS and is unreliable
        script = (
            'set chosen to choose file '
            'with multiple selections allowed '
            'with prompt "Select video clips"\n'
            'set out to ""\n'
            'repeat with f in chosen\n'
            '  set out to out & POSIX path of f & "\\n"\n'
            'end repeat\n'
            'return out'
        )
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
        if r.returncode != 0:
            raise HTTPException(400, detail={"error": "cancelled", "message": "No files selected"})
        paths = [p for p in r.stdout.strip().split("\n") if p]
    else:
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.wm_attributes("-topmost", True)
            paths = list(filedialog.askopenfilenames(
                title="Select video clips",
                filetypes=[("Video files", "*.mp4 *.mov *.avi *.mkv *.webm *.m4v"), ("All files", "*.*")],
            ))
            root.destroy()
        except Exception as exc:
            raise HTTPException(500, detail={"error": "picker_failed", "message": str(exc)})
    return {"paths": paths}


CAPTION_STYLES = {"word-by-word", "pop", "karaoke", "subtitle"}

@router.get("/caption-template/{style}")
async def get_caption_template(style: str):
    """Serve a built-in caption template JSX file for in-browser preview."""
    if style not in CAPTION_STYLES:
        raise HTTPException(404, detail={"error": "not_found", "message": f"Unknown caption style: {style}"})
    p = MONTAJ_ROOT / "render" / "templates" / "captions" / f"{style}.jsx"
    if not p.is_file():
        raise HTTPException(404, detail={"error": "not_found", "message": f"Template not found: {p}"})
    return FileResponse(str(p), media_type="text/plain")


@router.post("/projects/{project_id}/render")
async def render_project(project_id: str, request: Request):
    """Render the project to a final MP4. Streams progress as SSE log/done/error events."""
    import shutil
    workspace = resolve_workspace()
    project_path: Path | None = None
    for p in workspace.glob("*/project.json"):
        try:
            if json.loads(p.read_text()).get("id") == project_id:
                project_path = p
                break
        except Exception:
            pass

    if project_path is None:
        raise HTTPException(404, detail={"error": "not_found", "message": f"Project '{project_id}' not found"})

    render_script = MONTAJ_ROOT / "render" / "render.js"
    if not render_script.is_file():
        raise HTTPException(500, detail={"error": "not_found", "message": "render/render.js not found"})

    node_bin = shutil.which("node")
    if not node_bin:
        raise HTTPException(500, detail={"error": "not_found", "message": "node not found in PATH"})

    env = os.environ.copy()
    env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)

    async def event_stream():
        proc = await asyncio.create_subprocess_exec(
            node_bin, str(render_script), str(project_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(MONTAJ_ROOT),
            env=env,
            limit=10 * 1024 * 1024,  # 10MB — ffmpeg config/filter lines exceed the 64KB default
        )

        # Stream stderr (progress lines) to the client
        while True:
            if await request.is_disconnected():
                proc.kill()
                return
            line = await proc.stderr.readline()
            if not line:
                break
            text = line.decode().rstrip()
            if text:
                yield f"event: log\ndata: {text}\n\n"

        stdout = await proc.stdout.read()
        await proc.wait()

        if proc.returncode == 0:
            output_path = stdout.decode().strip()
            yield f"event: done\ndata: {output_path}\n\n"
        else:
            yield f"event: error\ndata: Render failed (exit {proc.returncode})\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/files")
async def serve_file(path: str):
    """Serve a local file by absolute path — lets the browser load source clips.
    SECURITY NOTE: This endpoint exposes any readable file on the filesystem to
    the browser. Acceptable for a localhost-only tool. If montaj ever leaves
    localhost, scope this to workspace + known clip directories only."""
    p = Path(path)
    if p.is_file():
        return FileResponse(str(p))
    # macOS screenshot filenames use NARROW NO-BREAK SPACE (\u202f) before AM/PM,
    # but paths written by the agent (or pasted) use a regular space.
    # Scan the parent directory for a name that matches after normalising both to space.
    parent = p.parent
    if parent.is_dir():
        target = p.name.replace('\u202f', ' ')
        for candidate in parent.iterdir():
            if candidate.name.replace('\u202f', ' ') == target:
                return FileResponse(str(candidate))
    raise HTTPException(404, detail={"error": "not_found", "message": f"File not found: {path}"})


@router.get("/files/stream")
async def stream_file(path: str, request: Request):
    """SSE stream that fires whenever a specific local file changes.
    Used by the Overlays page to get live updates when an agent edits a JSX file."""
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    channel = f"jsx:{path}"
    queue = broadcaster.subscribe(channel)

    async def event_stream():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=25)
                    yield frame
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
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


@router.get("/overlays")
async def list_overlays():
    """List all overlays from the global overlay library (~/.montaj/overlays/)."""
    return scan_overlays(Path.home() / ".montaj" / "overlays")


@router.post("/overlays/groups", status_code=201)
async def create_overlay_group(body: dict = Body(...)):
    """Create a new group folder inside ~/.montaj/overlays/."""
    name = str(body.get("name", "")).strip()
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise HTTPException(400, detail={"error": "invalid_name", "message": "Invalid group name"})
    group_dir = Path.home() / ".montaj" / "overlays" / name
    group_dir.mkdir(parents=True, exist_ok=True)
    return {"name": name}


@router.get("/profiles/{name}/overlays")
async def list_profile_overlays(name: str):
    """List overlays from a profile's overlay library (~/.montaj/profiles/{name}/overlays/)."""
    overlays_dir = Path.home() / ".montaj" / "profiles" / name / "overlays"
    return scan_overlays(overlays_dir)


@router.post("/profiles/{name}/overlays/groups", status_code=201)
async def create_profile_overlay_group(name: str, body: dict = Body(...)):
    """Create a new group folder inside ~/.montaj/profiles/{name}/overlays/."""
    group = str(body.get("name", "")).strip()
    if not group or "/" in group or "\\" in group or group.startswith("."):
        raise HTTPException(400, detail={"error": "invalid_name", "message": "Invalid group name"})
    group_dir = Path.home() / ".montaj" / "profiles" / name / "overlays" / group
    group_dir.mkdir(parents=True, exist_ok=True)
    return {"name": group}




def parse_style_frontmatter(style_path: Path) -> dict:
    """Parse YAML frontmatter from style_profile.md. Returns {} if absent or malformed."""
    if not style_path.exists():
        return {}
    try:
        text = style_path.read_text()
        if not text.startswith("---"):
            return {}
        end = text.index("---", 3)
        block = text[3:end].strip()
        result: dict = {}
        for line in block.splitlines():
            if ":" not in line:
                continue
            key, _, val = line.partition(":")
            result[key.strip()] = val.strip()
        return result
    except Exception:
        return {}


def _load_analysis(profile_dir: Path, source: str) -> dict:
    path = profile_dir / f"analysis_{source}.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _build_profile_response(name: str, profile_dir: Path) -> dict:
    """Build a profile response dict from style_profile.md frontmatter + analysis JSON."""
    fm = parse_style_frontmatter(profile_dir / "style_profile.md")
    current  = _load_analysis(profile_dir, "current")
    inspired = _load_analysis(profile_dir, "inspired")
    ca = current.get("aggregate", {})
    ia = inspired.get("aggregate", {})

    current_colors  = ca.get("dominant_colors", [])
    inspired_colors = ia.get("dominant_colors", [])
    merged = []
    seen: set = set()
    for pair in zip(current_colors, inspired_colors):
        for c in pair:
            if c not in seen:
                seen.add(c); merged.append(c)
    for c in current_colors + inspired_colors:
        if c not in seen:
            seen.add(c); merged.append(c)

    sources = []
    if current.get("video_count"):
        sources.append({"type": "current", "video_count": current["video_count"]})
    if inspired.get("video_count"):
        sources.append({"type": "inspired", "video_count": inspired["video_count"]})

    data: dict = {
        "name":    name,
        "created": fm.get("created", ""),
        "updated": fm.get("updated", ""),
        "style_profile_path": str(profile_dir / "style_profile.md"),
        "sources": sources,
        "style_meta": fm,
        "stats": {
            "videos_analyzed":   sum(s["video_count"] for s in sources),
            "avg_duration":      ca.get("avg_duration"),
            "avg_cuts_per_min":  ca.get("avg_cuts_per_min"),
            "avg_wpm":           ca.get("avg_wpm"),
            "avg_speech_ratio":  ca.get("avg_speech_ratio"),
            "dominant_colors":   current_colors[:6],
            "common_resolution": ca.get("common_resolution") or ia.get("common_resolution"),
            "common_fps":        ca.get("common_fps") or ia.get("common_fps"),
        },
        "color_palette": {
            "current":  current_colors,
            "inspired": inspired_colors,
            "merged":   merged[:10],
        },
    }
    return data


@router.get("/profiles")
async def list_profiles():
    """List all creator profiles from ~/.montaj/profiles/."""
    profiles_dir = Path.home() / ".montaj" / "profiles"
    if not profiles_dir.exists():
        return []
    results = []
    for entry in sorted(profiles_dir.iterdir()):
        if not entry.is_dir():
            continue
        if not (entry / "analysis_current.json").exists():
            continue
        try:
            results.append(_build_profile_response(entry.name, entry))
        except Exception:
            continue
    return results


@router.get("/profiles/{name}")
async def get_profile(name: str):
    """Return profile metadata + style document content."""
    profile_dir = Path.home() / ".montaj" / "profiles" / name
    if not (profile_dir / "analysis_current.json").exists():
        raise HTTPException(404, detail={"error": "not_found", "message": f"Profile '{name}' not found"})

    data = _build_profile_response(name, profile_dir)

    style_path = profile_dir / "style_profile.md"
    if style_path.exists():
        data["style_doc"] = style_path.read_text()

    # Attach sample frame paths
    frames_dir = profile_dir / "frames"
    if frames_dir.exists():
        data["sample_frames"] = [str(f) for f in sorted(frames_dir.glob("*.jpg"))]

    return data


app.include_router(router)


# SPA catch-all — registered after the API router so /api/* routes are never shadowed.
# Dev mode:  proxies to the Vite dev server (HMR, instant rebuilds).
# Prod mode: serves from ui/dist/ (static build).
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
    ui_dist = MONTAJ_ROOT / "ui" / "dist"
    if not ui_dist.exists():
        return HTMLResponse(
            "<h1>UI not built.</h1><p>Run: <code>npm run build --prefix ui/</code></p>",
            status_code=503,
        )
    target = (ui_dist / full_path).resolve()
    if target.is_file() and ui_dist.resolve() in target.parents:
        return FileResponse(str(target))
    return FileResponse(str(ui_dist / "index.html"))
