"""POST /run and all /projects/{id}* endpoints, plus _git_commit_sync helper."""
import asyncio
import json
import mimetypes
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from serve.common import (
    MONTAJ_ROOT,
    resolve_workspace, find_project_dir, get_project_dir,
    run_subprocess,
    not_found, bad_request, forbidden, server_error,
)
from project.init import _copy_into_workspace
from serve.sse import SSEBroadcaster, sse_stream

from lib.common import SAFE_NAME as _SAFE_NAME
from lib.types.kling import ASPECT_RATIOS, is_valid_aspect_ratio
from lib.workflow import read_workflow
from cli.deps import render_runtime_dir

router = APIRouter(prefix="/api")


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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/run", status_code=201)
async def run_project(body: dict = Body(...)):
    clips        = body.get("clips", [])
    assets       = body.get("assets", [])
    prompt       = body.get("prompt")
    workflow     = body.get("workflow", "clean_cut")
    name         = body.get("name")
    profile      = body.get("profile")
    project_path_arg = body.get("projectPath")

    if not prompt:
        raise bad_request("missing_field", "'prompt' is required")

    if project_path_arg is not None and not isinstance(project_path_arg, str):
        raise bad_request(
            "invalid_field",
            f"'projectPath' must be a string (got {type(project_path_arg).__name__})",
        )

    for clip in clips:
        if not Path(clip).is_file():
            raise bad_request("file_not_found", f"Clip not found: {clip}")

    for asset in assets:
        if not Path(asset).is_file():
            raise bad_request("file_not_found", f"Asset not found: {asset}")

    # ai_video intake — structured image/style refs + intake settings forwarded to init.py
    intake = body.get("aiVideoIntake") or {}

    if len(intake.get("styleRefs", [])) > 2:
        raise bad_request("invalid_intake", "at most 2 style refs allowed")

    image_ref_args = []
    for entry in intake.get("imageRefs", []):
        has_path = bool(entry.get("path"))
        has_text = bool(entry.get("text"))
        if has_path == has_text:  # neither or both
            raise bad_request("invalid_intake", "each imageRef requires exactly one of 'path' or 'text'")
        image_ref_args += ["--image-ref", json.dumps(entry)]

    style_ref_args = []
    for entry in intake.get("styleRefs", []):
        if not entry.get("path"):
            raise bad_request("invalid_intake", "each styleRef requires 'path'")
        style_ref_args += ["--style-ref", json.dumps(entry)]

    # Intake settings — structured Kling parameters + editorial goal.
    # NEVER appended to the prompt; stored as first-class fields on storyboard.
    intake_setting_args = []
    aspect_ratio = intake.get("aspectRatio")
    if aspect_ratio is not None:
        if not is_valid_aspect_ratio(aspect_ratio):
            raise bad_request("invalid_intake", f"aspectRatio must be one of {', '.join(ASPECT_RATIOS)} (got {aspect_ratio!r})")
        intake_setting_args += ["--aspect-ratio", aspect_ratio]
    target_duration = intake.get("targetDurationSeconds")
    if target_duration is not None:
        if not isinstance(target_duration, int) or target_duration <= 0:
            raise bad_request("invalid_intake", f"targetDurationSeconds must be a positive integer (got {target_duration!r})")
        intake_setting_args += ["--target-duration", str(target_duration)]
    resolution = intake.get("resolution")
    if resolution is not None:
        if not isinstance(resolution, str) or "x" not in resolution.lower():
            raise bad_request(
                "invalid_intake",
                f"resolution must be a 'WxH' string (got {resolution!r})",
            )
        try:
            w_str, h_str = resolution.lower().split("x", 1)
            w, h = int(w_str), int(h_str)
            if w <= 0 or h <= 0:
                raise ValueError
        except ValueError:
            raise bad_request(
                "invalid_intake",
                f"resolution must be 'WxH' with positive ints (got {resolution!r})",
            )
        intake_setting_args += ["--resolution", resolution]

    # Project working color space — accepts 'auto' (default smart-detect on init.py)
    # plus any key in ALL_COLOR_SPACES. Mirrors the aspectRatio/resolution validation
    # pattern.
    from lib.types.colorspace import ALL_COLOR_SPACES
    color_space = intake.get("colorSpace")
    if color_space is not None:
        if color_space != "auto" and color_space not in ALL_COLOR_SPACES:
            raise bad_request(
                "invalid_intake",
                f"colorSpace must be 'auto' or one of {ALL_COLOR_SPACES} "
                f"(got {color_space!r})",
            )
        intake_setting_args += ["--color-space", color_space]

    # Music intake validation
    music = intake.get('music')
    if music is not None:
        mode = music.get('mode')
        if mode not in ('upload', 'describe'):
            raise bad_request("invalid_intake", "music.mode must be 'upload' or 'describe'")
        if mode == 'upload' and not music.get('path'):
            raise bad_request("invalid_intake", "music mode 'upload' requires a path")
        if mode == 'describe' and not music.get('prompt', '').strip():
            raise bad_request("invalid_intake", "music mode 'describe' requires a non-empty prompt")

    # Voiceover intake validation
    voiceover = intake.get('voiceover')
    if voiceover is not None:
        if not voiceover.get('prompt', '').strip():
            raise bad_request("invalid_intake", "voiceover.prompt must be a non-empty string")

    # Music + voiceover CLI args
    audio_args = []
    if intake.get('music', {}).get('mode') == 'upload':
        audio_args += ['--music-upload', intake['music']['path']]
    elif intake.get('music', {}).get('mode') == 'describe':
        audio_args += ['--music-describe', intake['music']['prompt']]

    if intake.get('voiceover', {}).get('prompt'):
        audio_args += ['--voiceover-prompt', intake['voiceover']['prompt']]

    init_py = MONTAJ_ROOT / "project" / "init.py"
    cmd = [sys.executable, str(init_py), "--prompt", prompt, "--workflow", workflow]
    if name:
        cmd += ["--name", name]
    if assets:
        cmd += ["--assets"] + [str(a) for a in assets]
    if profile:
        cmd += ["--profile", profile]
    if project_path_arg:
        cmd += ["--project-path", project_path_arg]
    cmd += image_ref_args + style_ref_args + intake_setting_args + audio_args

    if clips:
        cmd += ["--clips"] + [str(c) for c in clips]
    else:
        # No clips — check workflow's requires_clips to decide how to proceed
        requires_clips = True  # conservative default
        wf_data = read_workflow(workflow)
        if wf_data is not None:
            requires_clips = wf_data.get("requires_clips", True)

        if not requires_clips:
            # Workflow explicitly says no footage needed — create canvas project
            cmd.append("--canvas")
        else:
            raise bad_request(
                "clips_required",
                f"Workflow '{workflow}' requires source footage. Provide clips or use a canvas workflow.",
            )

    # Async subprocess so init doesn't block the FastAPI event loop or stall SSE.
    # 30 min ceiling is a sanity bound, not a real expected duration — with parallel
    # normalize + audio fast path + resolution preservation, realistic init time is
    # seconds to a few minutes even on heavy footage.
    #
    # When MONTAJ_DEBUG=1, stderr is streamed live to the server's own stderr so
    # operators can watch normalize progress in real time. Default (unset): stderr
    # is buffered via proc.communicate() and only surfaced on non-zero exit, same
    # as before. Debug mode is opt-in because forwarding subprocess stderr to the
    # parent process clutters production logs.
    INIT_TIMEOUT_S = 1800
    debug_log = os.environ.get("MONTAJ_DEBUG") == "1"

    try:
        if debug_log:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=str(Path.cwd()),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                # Live-tee stderr to the server's stderr while still collecting
                # it for error reporting on non-zero exit.
                stdout_chunks: list[bytes] = []
                stderr_chunks: list[bytes] = []

                async def _drain_to_stderr(stream, sink):
                    while True:
                        line = await stream.readline()
                        if not line:
                            return
                        sink.append(line)
                        try:
                            sys.stderr.buffer.write(line)
                            sys.stderr.buffer.flush()
                        except Exception:
                            pass

                async def _read_all(stream, sink):
                    while True:
                        chunk = await stream.read(8192)
                        if not chunk:
                            return
                        sink.append(chunk)

                await asyncio.wait_for(
                    asyncio.gather(
                        _read_all(proc.stdout, stdout_chunks),
                        _drain_to_stderr(proc.stderr, stderr_chunks),
                        proc.wait(),
                    ),
                    timeout=INIT_TIMEOUT_S,
                )
                stdout = b"".join(stdout_chunks).decode()
                stderr = b"".join(stderr_chunks).decode()
                returncode = proc.returncode
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                raise HTTPException(504, detail={"error": "timeout", "message": f"Project init exceeded {INIT_TIMEOUT_S}s"})
        else:
            stdout, stderr, returncode = await run_subprocess(
                cmd,
                timeout=INIT_TIMEOUT_S,
                cwd=str(Path.cwd()),
            )
    except FileNotFoundError as e:
        raise server_error("init_failed", str(e))

    if returncode != 0:
        try:
            err = json.loads(stderr)
        except Exception:
            err = {"error": "init_failed", "message": stderr.strip()}
        # --project-path validation errors map to 400 per the workspace-paths
        # plan's HTTP contract (see docs/plans/2026-05-02-workspace-paths.md).
        # Hub's idempotent-retry logic pattern-matches on 400 + error code, so
        # these must not be 500. All other init.py error codes keep 500.
        status = 400 if err.get("error") in {"project_path_exists", "invalid_project_path"} else 500
        raise HTTPException(status, detail=err)

    project_path = Path(stdout.strip())
    try:
        return json.loads(project_path.read_text())
    except Exception:
        raise server_error("read_failed", "Project created but could not be read back")


@router.get("/projects")
async def list_projects(status: str | None = None):
    workspace = resolve_workspace()
    projects = []
    for p in sorted(workspace.rglob("project.json"), key=lambda f: f.stat().st_mtime, reverse=True):
        try:
            proj = json.loads(p.read_text())
        except Exception:
            continue
        if status and proj.get("status") != status:
            continue
        projects.append(proj)
    return projects


@router.get("/projects/{project_id}")
async def get_project(project_id: str, project_dir: Path = Depends(get_project_dir)):
    return json.loads((project_dir / "project.json").read_text())


@router.get("/projects/{project_id}/stream")
async def stream_project(project_id: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    project_path = project_dir / "project.json"

    queue = broadcaster.subscribe(project_id)
    # Send current state immediately on connect (must be single-line for SSE framing)
    initial = f"data: {json.dumps(json.loads(project_path.read_text()))}\n\n"

    async def event_stream():
        try:
            async for frame in sse_stream(request, queue, initial_frame=initial):
                yield frame
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
        raise bad_request("missing_field", "'message' is required")
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    frame = f"event: log\ndata: {json.dumps({'message': message})}\n\n"
    broadcaster.publish(project_id, frame)


@router.post("/projects/{project_id}/reload")
async def reload_project(project_id: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    """Re-read project.json from disk and broadcast to all SSE subscribers.
    Call this after making direct file edits that bypass the PUT endpoint.
    Returns {"subscribers": N} so callers can confirm the browser is connected."""
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    text = (project_dir / "project.json").read_text()
    n = len(broadcaster._subscribers.get(project_id, []))
    broadcaster.publish(project_id, f"data: {text}\n\n")
    return {"subscribers": n}


@router.post("/projects/{project_id}/reserve-path")
async def reserve_path(project_id: str, body: dict = Body(...)):
    prefix = body.get("prefix", "")
    extension = body.get("extension", "")
    if not prefix or not _SAFE_NAME.match(prefix):
        raise bad_request("invalid_prefix", "prefix must match [A-Za-z0-9_-]+")
    if not extension or not _SAFE_NAME.match(extension):
        raise bad_request("invalid_extension", "extension must match [A-Za-z0-9_-]+")

    workspace = resolve_workspace()
    project_dir = find_project_dir(workspace, project_id)
    if project_dir is None:
        raise not_found("project_not_found", f"Project '{project_id}' not found")

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = secrets.token_hex(3)
    path = project_dir / f"{prefix}_{ts}_{slug}.{extension}"
    return {"path": str(path)}


@router.delete("/projects/{project_id}", status_code=204)
async def delete_project(project_id: str, project_dir: Path = Depends(get_project_dir)):
    shutil.rmtree(project_dir)


@router.put("/projects/{project_id}")
async def save_project(project_id: str, body: dict = Body(...), request: Request = None, project_dir: Path = Depends(get_project_dir)):
    if body.get("id") != project_id:
        raise bad_request("id_mismatch", "Body id must match URL id")
    project_path = project_dir / "project.json"
    prev_status = json.loads(project_path.read_text()).get("status")
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
async def list_versions(project_id: str, project_dir: Path = Depends(get_project_dir)):
    def _git_log():
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

    return await asyncio.to_thread(_git_log)


@router.post("/projects/{project_id}/versions/{commit}/restore")
async def restore_version(project_id: str, commit: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    project_path = project_dir / "project.json"
    proc = await asyncio.create_subprocess_exec(
        "git", "show", f"{commit}:project.json",
        cwd=str(project_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_b, stderr_b = await proc.communicate()
    if proc.returncode != 0:
        raise not_found("not_found", f"Commit '{commit}' not found")
    try:
        restored = json.loads(stdout_b.decode())
    except Exception:
        raise server_error("parse_failed", "Could not parse project.json at that commit")
    project_path.write_text(json.dumps(restored, indent=2))
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    broadcaster.publish(project_id, f"data: {json.dumps(restored)}\n\n")
    return restored


@router.post("/projects/{project_id}/rerun")
async def rerun_project(project_id: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    project_path = project_dir / "project.json"
    project = json.loads(project_path.read_text())

    sources = project.get("sources")
    if not sources:
        raise bad_request("no_sources", "Project has no sources — cannot re-run")

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


_PROFILE_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")
_ASSET_FILE_RE   = re.compile(r"^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$")


@router.post("/projects/{project_id}/assets")
async def include_profile_asset(project_id: str, body: dict = Body(...), request: Request = None, project_dir: Path = Depends(get_project_dir)):
    """Copy an asset from a profile's asset library into this project.

    Body: {"from": {"profile": <name>, "filename": <name>}}.
    Drafts the change in project.json; the user commits separately via PUT.
    """
    src_ref = (body or {}).get("from") or {}
    profile_name = src_ref.get("profile")
    filename     = src_ref.get("filename")

    if not isinstance(profile_name, str) or not _PROFILE_NAME_RE.match(profile_name):
        raise bad_request("invalid_name", "Invalid profile name")
    if not isinstance(filename, str) or not _ASSET_FILE_RE.match(filename):
        raise bad_request("invalid_filename", "Invalid filename")

    project_path = project_dir / "project.json"
    project = json.loads(project_path.read_text())

    if not project.get("profile"):
        raise bad_request("no_profile", "Project has no profile attached")
    if project.get("profile") != profile_name:
        raise bad_request(
            "profile_mismatch",
            f"Project profile '{project.get('profile')}' does not match requested '{profile_name}'",
        )

    profile_assets_dir = Path.home() / ".montaj" / "profiles" / profile_name / "assets"
    src_path = (profile_assets_dir / filename).resolve()
    try:
        src_path.relative_to(profile_assets_dir.resolve())
    except (ValueError, OSError):
        raise forbidden("traversal", "Path escapes assets dir")
    if not src_path.is_file():
        raise not_found("not_found", f"Asset '{filename}' not found in profile '{profile_name}'")

    # Copy into project_dir, reusing the shared helper from project/init.py so
    # the collision-suffix pattern stays in one place.
    dest = Path(_copy_into_workspace(str(src_path), str(project_dir), "asset"))

    # Infer asset type from MIME (image / video / audio / file).
    mime = mimetypes.guess_type(dest.name)[0] or ""
    if   mime.startswith("image/"): asset_type = "image"
    elif mime.startswith("video/"): asset_type = "video"
    elif mime.startswith("audio/"): asset_type = "audio"
    else:                            asset_type = "file"

    existing = project.get("assets") or []
    next_idx = 0
    for a in existing:
        aid = a.get("id", "")
        if isinstance(aid, str) and aid.startswith("asset-"):
            try:
                n = int(aid.split("-", 1)[1])
                if n + 1 > next_idx:
                    next_idx = n + 1
            except ValueError:
                pass

    new_entry = {
        "id":   f"asset-{next_idx}",
        "src":  str(dest),
        "type": asset_type,
        "name": dest.name,
    }
    existing.append(new_entry)
    project["assets"] = existing

    text = json.dumps(project, indent=2)
    project_path.write_text(text)
    # Broadcast so SSE-subscribed UIs see the new asset immediately, matching
    # the pattern in save_project / restore_version / rerun_project.
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    broadcaster.publish(project_id, f"data: {text}\n\n")
    return project


@router.post("/projects/{project_id}/render")
async def render_project(project_id: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    """Render the project to a final MP4. Streams progress as SSE log/done/error events."""
    project_path = project_dir / "project.json"

    render_script = Path(render_runtime_dir()) / "render.js"
    if not render_script.is_file():
        raise server_error("not_found", "render/render.js not found")

    node_bin = shutil.which("node")
    if not node_bin:
        raise server_error("not_found", "node not found in PATH")

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
            start_new_session=True,   # new session → process group leader; killpg reaches ffmpeg grandchildren
        )

        def kill_tree():
            """Kill the entire process group so orphaned ffmpeg children don't keep writing."""
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (ProcessLookupError, OSError):
                try:
                    proc.kill()
                except Exception:
                    pass

        # Stream stderr (progress lines) to the client
        while True:
            if await request.is_disconnected():
                kill_tree()
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
