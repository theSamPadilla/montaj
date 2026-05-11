"""POST /run and all /projects/{id}* endpoints, plus _git_commit_sync helper."""
import asyncio
import io
import json
import mimetypes
import re
import uuid
import zipfile
import os
import secrets
import shutil
import signal
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from urllib.parse import urlparse

from serve.common import (
    MONTAJ_ROOT,
    resolve_workspace, find_project_dir, get_project_dir,
    run_subprocess,
    not_found, bad_request, forbidden, server_error,
    validate_project_subpath,
)
from lib.remote_io import push_from_disk_async, parse_allowed_hosts
from project.init import _copy_into_workspace
from serve.sse import SSEBroadcaster, sse_stream

from lib.common import SAFE_NAME as _SAFE_NAME
from lib.profile_assets import FILENAME_RE, NAME_RE
from lib.types.kling import ASPECT_RATIOS, is_valid_aspect_ratio
from lib.types.carousel import CAROUSEL_ASPECTS
from lib.workflow import read_workflow
from cli.deps import render_runtime_dir

router = APIRouter(prefix="/api")

# Required keys for every remote-fetch item (clips and assets share the same shape).
_REMOTE_REQUIRED_KEYS = ("url", "destPath", "contentType", "sizeBytes")

OVERLAY_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
OVERLAY_MAX_BYTES = 65_536  # 64 KB — overlay JSX is small; reject big bodies hard.


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sse_data_frame(text: str) -> str:
    """Wrap a JSON payload in an SSE `data:` frame.

    SSE requires a `data:` prefix on every line of the payload; a multi-line
    string (e.g. the indent=2 form we write to disk) breaks the parser. Re-dump
    the parsed object on a single line so the wire format is one `data:` line.
    Falls back to a per-line prefix if the input is not parseable JSON.
    """
    try:
        return f"data: {json.dumps(json.loads(text))}\n\n"
    except (ValueError, TypeError):
        body = "\n".join(f"data: {line}" for line in text.splitlines())
        return f"{body}\n\n"


def _validate_remote_items(items: list, label: str, allowed_hosts: set[str]) -> None:
    """Eagerly validate a list of remote-fetch items at request time.

    Raises bad_request on shape errors and on host-not-allowed.
    Caller is responsible for the allowlist-unset 403 check (different code path).
    `label` is the field name (e.g. 'remoteClips') used in error messages.
    """
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            raise bad_request("invalid_remote_item", f"{label}[{i}] must be an object")
        for key in _REMOTE_REQUIRED_KEYS:
            if key not in item:
                raise bad_request("invalid_remote_item", f"{label}[{i}] missing required key: {key}")
        if not item["url"].startswith("https://"):
            raise bad_request("invalid_remote_item", f"{label}[{i}].url must be https://")
    # Host-membership check — only runs when allowed_hosts is non-empty (allowlist-unset
    # is handled separately by the caller before invoking this function).
    if allowed_hosts:
        for i, item in enumerate(items):
            host = (urlparse(item["url"]).hostname or "").lower()
            if host not in allowed_hosts:
                raise bad_request("invalid_remote_item", f"{label}[{i}].url host not allowed: {host}")


def _validate_optional_id(body: dict) -> str | None:
    """Returns the id field from the body parsed and canonicalized via uuid.UUID,
    or None when absent. Raises bad_request('invalid_id', ...) on malformed input.

    Validation runs at the HTTP boundary so a bad id never reaches the init.py
    subprocess. The CLI-level uuid.UUID parse in init.py is the second line of
    defense for direct CLI use. Canonicalize-on-store: any form uuid.UUID()
    accepts (canonical, hex32, braced, urn:uuid:..., uppercase) is normalized
    to lowercase 8-4-4-4-12. Truly malformed input (truncated, non-hex, empty,
    non-string) is rejected.
    """
    raw = body.get("id")
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise bad_request(
            "invalid_id",
            f"'id' must be a string (got {type(raw).__name__}: {raw!r})",
        )
    try:
        return str(uuid.UUID(raw))
    except ValueError:
        raise bad_request(
            "invalid_id",
            f"'id' must be a parseable UUID (got {raw!r})",
        )


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


async def _run_init_subprocess(cmd: list[str], *, timeout: int = 1800) -> dict:
    """Spawn project/init.py via subprocess, capture stdout (project path), and
    return the parsed project.json dict. Raises HTTPException on any failure.

    When MONTAJ_DEBUG=1, stderr is streamed live to the server's own stderr so
    operators can watch progress in real time. Default (unset): stderr is buffered
    and only surfaced on non-zero exit.
    """
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
                    timeout=timeout,
                )
                stdout = b"".join(stdout_chunks).decode()
                stderr = b"".join(stderr_chunks).decode()
                returncode = proc.returncode
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                raise HTTPException(504, detail={"error": "timeout", "message": f"Project init exceeded {timeout}s"})
        else:
            stdout, stderr, returncode = await run_subprocess(
                cmd,
                timeout=timeout,
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
    remote_clips = body.get("remoteClips", [])
    remote_assets = body.get("remoteAssets", [])
    project_id_arg = _validate_optional_id(body)

    # --- Carousel fast path — branch before clip/asset/intake validation ---
    wf_data = read_workflow(workflow)
    if wf_data is not None and wf_data.get("project_type") == "carousel":
        carousel_aspect = body.get("carouselAspect")
        if not carousel_aspect or carousel_aspect not in CAROUSEL_ASPECTS:
            raise bad_request(
                "invalid_field",
                f"'carouselAspect' is required for carousel workflows and must be one of {list(CAROUSEL_ASPECTS)} "
                f"(got {carousel_aspect!r})",
            )

        if not prompt:
            raise bad_request("missing_field", "'prompt' is required")

        init_py = MONTAJ_ROOT / "project" / "init.py"
        cmd = [
            sys.executable, str(init_py),
            "--workflow", workflow,
            "--carousel-aspect", carousel_aspect,
            "--prompt", prompt,
        ]
        if name:
            cmd += ["--name", name]
        if profile:
            cmd += ["--profile", profile]
        if project_path_arg:
            cmd += ["--project-path", project_path_arg]
        if project_id_arg:
            cmd += ["--id", project_id_arg]
        if assets:
            if not isinstance(assets, list):
                raise bad_request("invalid_field", "'assets' must be a list of paths")
            for asset in assets:
                if not isinstance(asset, str) or not os.path.isfile(asset):
                    raise bad_request("file_not_found", f"Asset not found: {asset}")
            cmd += ["--assets"] + [str(a) for a in assets]

        return await _run_init_subprocess(cmd)

    if not prompt:
        raise bad_request("missing_field", "'prompt' is required")

    if project_path_arg is not None and not isinstance(project_path_arg, str):
        raise bad_request(
            "invalid_field",
            f"'projectPath' must be a string (got {type(project_path_arg).__name__})",
        )

    # Validate remoteClips / remoteAssets — eager, before local file checks.
    if not isinstance(remote_clips, list):
        raise bad_request("invalid_field", "remoteClips must be a list")
    if not isinstance(remote_assets, list):
        raise bad_request("invalid_field", "remoteAssets must be a list")

    # Shape + https check (runs before allowlist so missing-key errors are surfaced first).
    _validate_remote_items(remote_clips, "remoteClips", set())
    _validate_remote_items(remote_assets, "remoteAssets", set())

    if remote_clips or remote_assets:
        allowed_hosts = parse_allowed_hosts()
        if not allowed_hosts:
            raise forbidden("allowlist_unset", "MONTAJ_HTTP_ALLOWED_HOSTS is required for remote inputs")
        # Re-run with the real allowlist so host-membership is checked.
        _validate_remote_items(remote_clips, "remoteClips", allowed_hosts)
        _validate_remote_items(remote_assets, "remoteAssets", allowed_hosts)
    else:
        allowed_hosts = set()

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
    if project_id_arg:
        cmd += ["--id", project_id_arg]
    cmd += image_ref_args + style_ref_args + intake_setting_args + audio_args

    if clips:
        cmd += ["--clips"] + [str(c) for c in clips]
    elif not remote_clips:
        # No local clips and no remote clips — check workflow's requires_clips to decide how to proceed
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

    for item in remote_clips:
        cmd += ["--remote-clip", json.dumps(item)]
    for item in remote_assets:
        cmd += ["--remote-asset", json.dumps(item)]

    # Async subprocess so init doesn't block the FastAPI event loop or stall SSE.
    # 30 min ceiling is a sanity bound, not a real expected duration — with parallel
    # normalize + audio fast path + resolution preservation, realistic init time is
    # seconds to a few minutes even on heavy footage.
    return await _run_init_subprocess(cmd)


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
    broadcaster.publish(project_id, _sse_data_frame(text))
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
    broadcaster.publish(project_id, _sse_data_frame(text))
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
    broadcaster.publish(project_id, _sse_data_frame(text))
    return updated


@router.post("/projects/{project_id}/assets")
async def include_profile_asset(project_id: str, body: dict = Body(...), request: Request = None, project_dir: Path = Depends(get_project_dir)):
    """Copy an asset from a profile's asset library into this project.

    Body: {"from": {"profile": <name>, "filename": <name>}}.
    Drafts the change in project.json; the user commits separately via PUT.
    """
    src_ref = (body or {}).get("from") or {}
    profile_name = src_ref.get("profile")
    filename     = src_ref.get("filename")

    if not isinstance(profile_name, str) or not NAME_RE.match(profile_name):
        raise bad_request("invalid_name", "Invalid profile name")
    if not isinstance(filename, str) or not FILENAME_RE.match(filename):
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
    broadcaster.publish(project_id, _sse_data_frame(text))
    return project


@router.get("/projects/{project_id}/render-zip")
async def render_zip(project_id: str, project_dir: Path = Depends(get_project_dir)):
    """Zip the contents of <project>/render/ and stream it as a download.

    Used by the carousel render modal so the user can grab all PNG slides in one click.
    Falls back to 404 if no render dir exists yet (renderer hasn't run, or was cleared).
    """
    render_dir = project_dir / "render"
    if not render_dir.is_dir():
        raise not_found("not_found", "no render directory")

    # In-memory zip — carousel renders are small (≤ ~10 PNGs at 1080×).
    # Skip manifest.json: it's a renderer-side output for agent/CLI tooling, not
    # something the human downloading this archive cares about.
    EXCLUDE = {"manifest.json"}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for entry in sorted(render_dir.iterdir()):
            if entry.is_file() and entry.name not in EXCLUDE:
                zf.write(entry, arcname=entry.name)
    buf.seek(0)

    project_name = project_dir.name
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{project_name}-slides.zip"',
        },
    )


@router.get("/projects/{project_id}/outputs")
async def list_outputs(project_id: str, project_dir: Path = Depends(get_project_dir)):
    """Depth-1 listing of <project_dir>/output/."""
    output = project_dir / "output"
    if not output.is_dir():
        return {"outputs": []}
    outputs = []
    for entry in sorted(output.iterdir()):
        if not entry.is_file():
            continue
        try:
            size = entry.stat().st_size
        except OSError:
            continue
        ct, _ = mimetypes.guess_type(str(entry))
        outputs.append({
            "path": f"output/{entry.name}",
            "sizeBytes": size,
            "contentType": ct or "application/octet-stream",
        })
    return {"outputs": outputs}


@router.post("/projects/{project_id}/upload")
async def upload_outputs(
    project_id: str,
    body: dict = Body(...),
    project_dir: Path = Depends(get_project_dir),
):
    """Push local project output files to remote URLs.

    Body: {"uploads": [{"srcPath": "output/render.mp4", "url": "https://...", "method": "PUT", "headers": {...}}]}

    Returns 200 when all uploads succeed, 207 Multi-Status when any fail.
    Per-item errors are surfaced in the results list, not as 4xx (per-op failures
    are never request-level).
    """
    uploads = body.get("uploads")
    if not isinstance(uploads, list) or not uploads:
        raise bad_request("invalid_body", "'uploads' must be a non-empty list")

    allowed_hosts = parse_allowed_hosts()
    if not allowed_hosts:
        raise forbidden("allowlist_unset", "MONTAJ_HTTP_ALLOWED_HOSTS is required")

    results = await push_from_disk_async(uploads, project_dir, allowed_hosts)

    any_error = any(r.get("status") == "error" for r in results)
    return JSONResponse(
        status_code=207 if any_error else 200,
        content={"results": results},
    )


@router.post("/projects/{project_id}/render")
async def render_project(project_id: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    """Render the project. Streams progress as SSE log/done/error events.

    Dispatches by projectType: carousel projects run render-carousel.js (PNG output),
    everything else runs render.js (MP4 output). Mirrors project/render.py.
    """
    project_path = project_dir / "project.json"

    try:
        project_type = json.loads(project_path.read_text()).get("projectType", "")
    except Exception:
        project_type = ""

    if project_type == "carousel":
        render_script = MONTAJ_ROOT / "montaj_assets" / "render" / "render-carousel.js"
        script_args = ["--project-json", str(project_path)]
    else:
        render_script = Path(render_runtime_dir()) / "render.js"
        script_args = [str(project_path)]

    if not render_script.is_file():
        raise server_error("not_found", f"{render_script.name} not found")

    node_bin = shutil.which("node")
    if not node_bin:
        raise server_error("not_found", "node not found in PATH")

    env = os.environ.copy()
    env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)

    async def event_stream():
        proc = await asyncio.create_subprocess_exec(
            node_bin, str(render_script), *script_args,
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


@router.put("/projects/{project_id}/overlays/{name}")
async def put_project_overlay(
    project_id: str,
    name: str,
    request: Request,
    project_dir: Path = Depends(get_project_dir),
):
    """Write agent-authored overlay JSX into <project_dir>/overlays/{name}.jsx.

    - Name: slug only (alphanumeric, _, -; 1-64 chars). Server appends `.jsx`.
    - Body: raw JSX text, UTF-8. Size cap: 64KB. Empty body → 400.
    - Idempotent PUT: 201 on first create, 200 on overwrite.
    - Path safety: name regex rules out traversal; validate_project_subpath
      is a belt-and-suspenders second check.
    """
    if not OVERLAY_NAME_RE.match(name):
        raise bad_request(
            "invalid_name",
            f"Overlay name must match {OVERLAY_NAME_RE.pattern} (got {name!r})",
        )

    body_bytes = await request.body()
    if len(body_bytes) > OVERLAY_MAX_BYTES:
        raise HTTPException(
            413,
            detail={
                "error": "payload_too_large",
                "message": f"Overlay body exceeds {OVERLAY_MAX_BYTES} bytes",
            },
        )
    if not body_bytes:
        raise bad_request("empty_body", "Overlay JSX body is required")

    try:
        jsx_text = body_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise bad_request("invalid_encoding", "Overlay body must be UTF-8 text")

    # Defense in depth: validate the relative path even though the name regex
    # already excludes traversal characters. Runs before mkdir so a future regex
    # weakening can't cause directory creation outside the project root.
    target = validate_project_subpath(project_dir, f"overlays/{name}.jsx")

    target.parent.mkdir(parents=True, exist_ok=True)

    created = not target.exists()
    target.write_text(jsx_text, encoding="utf-8")

    return JSONResponse(
        content={
            "name": name,
            "path": str(target),
            "bytes": len(body_bytes),
            "created": created,
        },
        status_code=201 if created else 200,
    )
