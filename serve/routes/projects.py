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

from fastapi import APIRouter, Body, Depends, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from urllib.parse import urlparse

from serve.common import (
    MONTAJ_ROOT,
    resolve_workspace, find_project_dir, get_project_dir,
    run_subprocess,
    not_found, bad_request, forbidden, server_error,
    validate_project_subpath, _is_under,
)
from serve.caption_job import build_cut_spec
from serve.routes.files import save_upload
from lib.remote_io import fetch_to_disk_async, push_from_disk_async, parse_allowed_hosts
from project.init import _copy_into_workspace
from serve.sse import SSEBroadcaster, sse_stream

from lib.common import SAFE_NAME as _SAFE_NAME
from lib.profile_assets import FILENAME_RE, NAME_RE
from lib.types.kling import ASPECT_RATIOS, is_valid_aspect_ratio
from lib.types.carousel import CAROUSEL_ASPECTS
from lib.workflow import read_workflow
from cli.deps import render_runtime_dir
from project.carousel_normalize import normalize_carousel_assets

router = APIRouter(prefix="/api")

# Required keys for every remote-fetch item (clips and assets share the same shape).
_REMOTE_REQUIRED_KEYS = ("url", "destPath", "contentType", "sizeBytes")

# In-flight render dedup. The UI can fire the same render twice (double-click,
# React effect re-run, SSE reconnect retry); without this, two render.js processes
# spawn against the same workspace and race-corrupt segment files. The render.js
# lockfile is a secondary defense at the OS layer — this set is the primary
# defense at the serve layer (single Python process, single asyncio loop, set
# mutations between awaits are race-free).
_active_renders: set[str] = set()

# Per-project handle on the in-flight MANUAL render subprocess. Lets a new render
# request terminate a previous one that hung or whose SSE stream was abandoned —
# the `_active_renders` set alone can't self-heal, because a wedged render never
# reaches the `finally` that releases its slot. Render-only.
_render_procs: dict[str, "asyncio.subprocess.Process"] = {}


def _kill_render_proc(proc: "asyncio.subprocess.Process") -> None:
    """Kill a render's whole process group so orphaned ffmpeg/browser children die too."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, OSError):
        try:
            proc.kill()
        except Exception:
            pass


def _supersede_active_render(project_id: str) -> bool:
    """Decide whether a new manual render may proceed for ``project_id``.

    If a prior manual render is still tracked (it hung, or its SSE stream was
    abandoned so its ``finally`` never released the slot), kill it, free the
    slot, and return True. If the slot is held by a non-render job (e.g. a
    carousel auto-render), return False so the caller rejects with 409.
    Otherwise return True.
    """
    prev = _render_procs.pop(project_id, None)
    if prev is not None:
        _kill_render_proc(prev)
        _active_renders.discard(project_id)
        return True
    return project_id not in _active_renders


class _RenderJob:
    """Live state of a detached render, polled by SSE log viewers. The render runs
    to completion independent of any client connection — a dropped SSE (e.g. the
    Cloudflare tunnel's ~100s wall on a multi-minute render, or a closed tab) must
    NOT abort it. An explicit stop goes through POST /render/cancel."""
    __slots__ = ("lines", "status", "result", "phase")

    def __init__(self) -> None:
        self.lines: list[str] = []      # accumulated stderr log lines
        self.status: str = "running"    # running | done | error
        self.result: str = ""           # output path (done) or message (error)
        self.phase: str = "preparing"   # preparing | captions | rendering | encoding | done


def _render_phase_for(line: str) -> str | None:
    """Map a render stderr line to a coarse progress phase, or None if it carries
    no phase signal. Markers below are the VERIFIED stderr strings emitted by
    render.js / compose.js. Captions is checked FIRST because a captions segment
    line also matches the generic "bundling segment" marker."""
    if "bundling segment" in line and "(captions)" in line:
        return "captions"
    if "bundling segment" in line or "with Puppeteer" in line:
        return "rendering"
    if "composing final video" in line or "concatenating" in line:
        return "encoding"
    return None


_render_jobs: dict[str, _RenderJob] = {}

# Strong refs to in-flight detached render tasks. asyncio only weakly tracks
# fire-and-forget tasks, so without this a render task could be GC'd mid-run.
_render_task_refs: set = set()


async def _run_render_detached(project_id: str, cmd: list[str], env: dict,
                               render_input: "Path", project_path: "Path",
                               job: _RenderJob) -> None:
    """Run a render subprocess to completion regardless of any client. Owns the
    `_render_procs` / `_active_renders` slot until the render actually finishes, so
    a dropped SSE connection can't strand or abort it."""
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(MONTAJ_ROOT),
            env=env,
            limit=10 * 1024 * 1024,  # ffmpeg config/filter lines exceed the 64KB default
            start_new_session=True,   # process-group leader so killpg reaches ffmpeg grandchildren
        )
        _render_procs[project_id] = proc  # register so a later render can supersede / cancel can kill
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            text = line.decode().rstrip()
            if text:
                job.lines.append(text)
                p = _render_phase_for(text)
                if p:
                    job.phase = p
        stdout = await proc.stdout.read()
        await proc.wait()
        if proc.returncode == 0:
            job.status, job.result, job.phase = "done", stdout.decode().strip(), "done"
        else:
            job.status, job.result = "error", f"Render failed (exit {proc.returncode})"
    except Exception as e:  # surface any spawn/IO failure to the viewer
        job.status, job.result = "error", str(e)
    finally:
        # Only release if we're still the tracked render — a later request may have
        # superseded us and taken the slot, and must not have its entry clobbered.
        if _render_procs.get(project_id) is proc:
            _render_procs.pop(project_id, None)
            _active_renders.discard(project_id)
        # NOTE: the terminal job is intentionally NOT popped from _render_jobs —
        # it persists so a post-completion GET /render/status can still read it.
        # A new render overwrites _render_jobs[project_id] after
        # _supersede_active_render, keeping this bounded to one entry per project.
        if render_input != project_path:
            try:
                Path(render_input).unlink()
            except OSError:
                pass


# In-flight caption-generation dedup. Same rationale as _active_renders: the UI
# (or an SSE reconnect) can fire the same caption job twice, and two concurrent
# jobs would race on the shared _caption_* scratch files in the project dir.
_active_caption_jobs: set[str] = set()

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


@router.delete("/projects/{project_id}")
async def delete_project(
    project_id: str,
    preserve_assets: bool = False,
    project_dir: Path = Depends(get_project_dir),
):
    """Delete a project's workspace directory.

    Default: behaviour unchanged — `shutil.rmtree(project_dir)` and 204 No Content.

    With `?preserve_assets=true`: before the rmtree, walk the project's
    `storyboard.imageRefs[].refImages` and `storyboard.styleRefs[].path`, and
    for every referenced file that lives **inside** this project_dir, move it
    into the workspace-level `_uploads/` junk drawer (the same dir the
    `POST /upload` endpoint writes to). Returns 200 with `{"preserved":
    {old_path: new_path, ...}}` so the caller can rewrite any UI state that
    held the doomed paths. Used by the editor's "back to setup" flow, which
    needs the uploaded image-ref / style-ref files to survive the round-trip
    through the new-project form prefill (without this, the prefill paths
    point into a workspace that no longer exists and `project/init.py` fails
    the next create with `file_not_found: Image ref not found`).

    Files outside this project_dir are left alone (they're either user-owned
    originals or references into another project). A missing project.json, a
    parse error, or a `shutil.move` failure on any single file is non-fatal:
    we still rmtree the project. The preserved map only includes files that
    were successfully moved.
    """
    from fastapi.responses import Response
    preserved: dict[str, str] = {}
    if preserve_assets:
        project_path = project_dir / "project.json"
        if project_path.is_file():
            try:
                proj = json.loads(project_path.read_text())
                sb = proj.get("storyboard") or {}
                # Collect every referenced path. imageRefs.refImages is a list
                # (the schema allows multiple frames per ref, though current
                # init.py only emits one). styleRefs.path is a single string.
                paths_to_evict: list[str] = []
                for ref in sb.get("imageRefs") or []:
                    for p in ref.get("refImages") or []:
                        if isinstance(p, str):
                            paths_to_evict.append(p)
                for ref in sb.get("styleRefs") or []:
                    p = ref.get("path")
                    if isinstance(p, str):
                        paths_to_evict.append(p)

                if paths_to_evict:
                    uploads_dir = resolve_workspace() / "_uploads"
                    uploads_dir.mkdir(parents=True, exist_ok=True)
                    project_dir_resolved = project_dir.resolve()
                    for raw in paths_to_evict:
                        try:
                            src = Path(raw)
                            if not src.is_file():
                                continue
                            # Only move files that live INSIDE this project's
                            # workspace dir. Anything else is a foreign reference
                            # (user-owned original, another project, etc.) and
                            # must not be touched.
                            if not _is_under(src.resolve(), project_dir_resolved):
                                continue
                            # De-dup the target name in _uploads/ — matches the
                            # save_upload() helper's naming convention so two
                            # back-to-setup round-trips don't clobber.
                            target = uploads_dir / src.name
                            stem, suffix = target.stem, target.suffix
                            counter = 1
                            while target.exists():
                                target = uploads_dir / f"{stem}_{counter}{suffix}"
                                counter += 1
                            shutil.move(str(src), str(target))
                            preserved[raw] = str(target)
                        except Exception:
                            # Best-effort: a single bad file must not block the delete.
                            pass
            except Exception:
                # If project.json is unparseable, fall through to the delete.
                pass

    shutil.rmtree(project_dir)

    if preserve_assets:
        return {"preserved": preserved}
    return Response(status_code=204)


async def _run_carousel_render_detached(project_id: str, project_dir: Path, scale: int | None = None):
    """Fire-and-forget carousel render used by auto-render-on-`final`.

    Unlike `render_project`'s SSE handler, this is NOT bound to an HTTP request, so
    a disconnecting client can never kill it (the SSE path kills the render tree on
    `request.is_disconnected()`). The caller MUST have already reserved the
    `_active_renders` slot; this coroutine releases it in `finally` and cleans up the
    normalized temp project.json.
    """
    project_path = project_dir / "project.json"
    render_input = project_path
    try:
        render_input = normalize_carousel_assets(project_path)
        render_script = Path(render_runtime_dir()) / "render-carousel.js"
        node_bin = shutil.which("node")
        if not node_bin or not render_script.is_file():
            return
        args = [node_bin, str(render_script), "--project-json", str(render_input)]
        if scale is not None:
            args += ["--scale", str(scale)]
        env = os.environ.copy()
        env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(MONTAJ_ROOT),
            env=env,
            start_new_session=True,
        )
        # Drain pipes so the child never blocks on a full stderr buffer; output is
        # advisory here (no client is listening). A non-zero exit (partial render)
        # is intentionally not raised — the good slides are already on disk.
        await proc.communicate()
    except Exception:
        pass
    finally:
        _active_renders.discard(project_id)
        if render_input != project_path:
            try:
                Path(render_input).unlink()
            except OSError:
                pass


@router.put("/projects/{project_id}")
async def save_project(project_id: str, body: dict = Body(...), request: Request = None, project_dir: Path = Depends(get_project_dir)):
    if body.get("id") != project_id:
        raise bad_request("id_mismatch", "Body id must match URL id")
    project_path = project_dir / "project.json"
    existing = json.loads(project_path.read_text())
    prev_status = existing.get("status")
    # Top-level shallow merge: preserve fields not present in the body. Agents
    # (per skills/native/SKILL.md) routinely PUT a partial body like
    # {id, status, tracks} when transitioning pending→draft; without this merge
    # creation-time metadata (name, workflow, editingPrompt, projectType,
    # runCount, settings, profile, …) gets wiped. To explicitly clear a field,
    # callers must send it as null in the body.
    merged = {**existing, **body}
    text = json.dumps(merged, indent=2)
    project_path.write_text(text)
    # Broadcast immediately — before the git commit so the UI update is instant.
    # Don't rely on the file watcher which can miss updates during SSE reconnect windows.
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    broadcaster.publish(project_id, _sse_data_frame(text))
    # Auto-commit to git on status transitions — run in a thread so it doesn't block the event loop
    new_status = merged.get("status")
    if new_status in ("draft", "final") and new_status != prev_status:
        run_count = merged.get("runCount", 1)
        asyncio.create_task(asyncio.to_thread(
            _git_commit_sync, project_dir, f"version: run {run_count} — {new_status}"
        ))
    # Auto-render carousels the moment they reach `final` so the rendered PNGs exist
    # without a separate manual POST /render. Fire-and-forget and deduped against any
    # in-flight render. Only carousels: video projects render on an explicit action.
    if (
        new_status == "final"
        and prev_status != "final"
        and merged.get("projectType") == "carousel"
        and project_id not in _active_renders
    ):
        _active_renders.add(project_id)
        asyncio.create_task(_run_carousel_render_detached(project_id, project_dir))
    return merged


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


@router.get("/projects/{project_id}/renders")
async def list_renders(project_id: str, project_dir: Path = Depends(get_project_dir)):
    """Depth-1 listing of <project_dir>/render/ — the rendered carousel slide
    PNGs (slide_NN.png).

    Carousel renders write here, NOT to output/ (the video-workflow staging
    dir, which is empty for carousels). Returns ABSOLUTE paths so callers can
    stream each file via GET /files (which serves absolute paths under the
    workspace root). Same envelope as /outputs."""
    render = project_dir / "render"
    if not render.is_dir():
        return {"outputs": []}
    outputs = []
    for entry in sorted(render.iterdir()):
        if not entry.is_file():
            continue
        try:
            size = entry.stat().st_size
        except OSError:
            continue
        ct, _ = mimetypes.guess_type(str(entry))
        outputs.append({
            "path": str(entry),
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


@router.post("/projects/{project_id}/upload-asset")
async def upload_asset_to_project(
    project_id: str,
    file: UploadFile,
    project_dir: Path = Depends(get_project_dir),
):
    """Accept a browser file drop scoped to a project, saving it into the
    project's own directory instead of the shared workspace _uploads/ folder.
    Keeps each project self-contained and portable."""
    dest = await save_upload(file, project_dir)
    return {"path": str(dest)}


@router.post("/projects/{project_id}/download")
async def download_assets(
    project_id: str,
    body: dict = Body(...),
    project_dir: Path = Depends(get_project_dir),
):
    """Pull remote files into the project workspace on local disk.

    Body: {"downloads": [{"url": "https://...", "destPath": "assets/img.png",
                          "contentType": "image/png", "sizeBytes": 12345,
                          "method": "GET", "headers": {...}}]}

    Returns 200 when all downloads succeed, 207 Multi-Status when any fail.
    Per-item errors are surfaced in the results list, not as 4xx (per-op failures
    are never request-level).

    Symmetric to /upload — same envelope shape, same allowlist enforcement,
    same path-traversal guards, same content-type / size validation. All those
    guards live in fetch_to_disk_async; this route is wiring only.
    """
    downloads = body.get("downloads")
    if not isinstance(downloads, list) or not downloads:
        raise bad_request("invalid_body", "'downloads' must be a non-empty list")

    allowed_hosts = parse_allowed_hosts()
    if not allowed_hosts:
        raise forbidden("allowlist_unset", "MONTAJ_HTTP_ALLOWED_HOSTS is required")

    results = await fetch_to_disk_async(downloads, project_dir, allowed_hosts)

    any_error = any(r.get("status") == "error" for r in results)
    return JSONResponse(
        status_code=207 if any_error else 200,
        content={"results": results},
    )


@router.delete("/projects/{project_id}/files")
async def delete_files(
    project_id: str,
    body: dict = Body(...),
    project_dir: Path = Depends(get_project_dir),
):
    """Delete files or subdirectories from the project workspace.

    Body: {"paths": ["render-tmp-abc123", "assets/foo.png"]}

    Each path is validated to stay under the project workspace
    (see validate_project_subpath). Directories are removed recursively
    (shutil.rmtree); files are unlinked. Missing paths are treated as
    success — this matches `rm -f` semantics.

    Returns 200 when all deletes succeed, 207 Multi-Status when any fail.
    Per-item errors are surfaced in the results list, not as 4xx (per-op
    failures are never request-level — same convention as /upload and
    /download).

    Symmetric to /upload (push) and /download (pull) — same envelope
    shape, same path-traversal guards via validate_project_subpath.

    Symlink note: validate_project_subpath .resolve()s the candidate,
    so symlinks whose target escapes the project are rejected. An
    in-project symlink resolves to its target — meaning this endpoint
    deletes the target file and leaves the link dangling, which
    diverges from POSIX `rm` semantics. A *dangling* in-project symlink
    (target already missing) resolves to a non-existent path and hits
    the idempotent "missing → deleted" branch, so the link survives.
    Acceptable for current callers.
    """
    paths = body.get("paths")
    if not isinstance(paths, list) or not paths:
        raise bad_request("invalid_body", "'paths' must be a non-empty list")

    results: list[dict] = []
    for raw in paths:
        if not isinstance(raw, str):
            results.append({"path": str(raw), "status": "error",
                            "error": "path must be a string"})
            continue
        try:
            target = validate_project_subpath(project_dir, raw)
        except HTTPException as e:
            # bad_request always returns {"error": code, "message": ...} —
            # extract the code for the per-item result.
            err_code = e.detail["error"] if isinstance(e.detail, dict) else "validation_error"
            results.append({"path": raw, "status": "error", "error": err_code})
            continue
        try:
            if target.is_dir() and not target.is_symlink():
                # rmtree refuses to follow a symlink-to-directory (raises OSError).
                # We want symmetric refusal — never recurse through a symlink.
                shutil.rmtree(target)
            elif target.exists() or target.is_symlink():
                target.unlink()
            # else: missing — treat as success (idempotent)
            results.append({"path": raw, "status": "deleted"})
        except OSError as e:
            results.append({"path": raw, "status": "error", "error": str(e)})

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

    # Reject if a render for this project is already in flight. The check-and-add
    # below is race-free because FastAPI handlers share one asyncio loop and the
    # set mutation runs between awaits.
    # A prior MANUAL render still tracked → it hung or its SSE stream was abandoned;
    # kill it and take over (re-clicking Render should always work). A non-render
    # holder of the slot (e.g. a carousel auto-render) still blocks with 409.
    if not _supersede_active_render(project_id):
        raise HTTPException(409, detail={
            "error": "concurrent_render",
            "message": f"A render for project {project_id} is already in progress.",
        })

    try:
        project_type = json.loads(project_path.read_text()).get("projectType", "")
    except Exception:
        project_type = ""

    scale_raw = request.query_params.get("scale")
    scale: int | None = None
    if scale_raw is not None:
        try:
            scale = int(scale_raw)
        except ValueError:
            raise HTTPException(400, detail={"error": "invalid_argument", "message": "scale must be an integer"})
        if scale not in (1, 2, 3):
            raise HTTPException(400, detail={"error": "invalid_argument", "message": "scale must be 1, 2, or 3"})

    # Carousel renders go through asset normalization first: any .webp image bed
    # is transcoded to a sibling .png and the renderer is handed a normalized copy
    # of project.json (the sidecar Chromium can't decode .webp). render_input ==
    # project_path when nothing needed normalizing; otherwise it's a throwaway temp
    # file cleaned up in the event_stream finally.
    render_input = project_path
    if project_type == "carousel":
        render_input = normalize_carousel_assets(project_path)
        render_script = Path(render_runtime_dir()) / "render-carousel.js"
        script_args = ["--project-json", str(render_input)]
        if scale is not None:
            script_args += ["--scale", str(scale)]
    else:
        render_script = Path(render_runtime_dir()) / "render.js"
        # Write the MP4 into the project's output/ dir (the video-workflow staging
        # dir that /outputs lists) instead of render.js's default render/<name>.mp4.
        output_dir = project_dir / "output"
        output_dir.mkdir(exist_ok=True)
        output_path = output_dir / f"{project_dir.name}.mp4"
        script_args = [str(project_path), "--out", str(output_path)]

    if not render_script.is_file():
        raise server_error("not_found", f"{render_script.name} not found")

    node_bin = shutil.which("node")
    if not node_bin:
        raise server_error("not_found", "node not found in PATH")

    env = os.environ.copy()
    env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)

    # Reserve the slot and kick the render off DETACHED, so it runs to completion
    # even if this SSE connection drops. A multi-minute render streamed through the
    # Hub proxy + Cloudflare tunnel will exceed the tunnel's ~100s wall; the tunnel
    # cuts the long-lived stream, and a render tied to the request lifecycle would
    # be killed mid-flight (the old kill-on-disconnect behaviour). Now the SSE below
    # is a pure *viewer* — a disconnect just stops viewing; the render keeps going,
    # the output lands, and clients reconnect / poll /outputs for it. An actual stop
    # goes through POST /render/cancel.
    _active_renders.add(project_id)
    cmd = [node_bin, str(render_script), *script_args]
    job = _RenderJob()
    _render_jobs[project_id] = job
    task = asyncio.create_task(
        _run_render_detached(project_id, cmd, env, render_input, project_path, job)
    )
    _render_task_refs.add(task)
    task.add_done_callback(_render_task_refs.discard)

    # Async mode: don't hold an SSE stream open — kick the detached render and
    # return immediately. Clients poll GET /render/status to follow progress and
    # collect the output path / error. Default (no async flag) keeps the SSE viewer
    # for back-compat with the CLI/agent.
    if request.query_params.get("async") in ("1", "true"):
        return JSONResponse({"projectId": project_id, "status": "running"}, status_code=202)

    async def event_stream():
        # Pure viewer over the detached job: replay the log buffer, stream new lines
        # as they arrive, and emit the terminal event when the render finishes.
        # Crucially, a client disconnect just returns — it does NOT kill the render.
        idx = 0
        while True:
            while idx < len(job.lines):
                yield f"event: log\ndata: {job.lines[idx]}\n\n"
                idx += 1
            if job.status == "done":
                yield f"event: done\ndata: {job.result}\n\n"
                return
            if job.status == "error":
                yield f"event: error\ndata: {job.result}\n\n"
                return
            if await request.is_disconnected():
                return
            await asyncio.sleep(0.4)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/projects/{project_id}/render/cancel")
async def cancel_render(project_id: str):
    """Explicitly stop an in-flight render. Since a dropped SSE no longer kills a
    render (it runs detached now), this is the *only* way to abort one — the Cancel
    button calls it. Kills the tracked process group; the detached task's `finally`
    then releases the slot. Idempotent: a no-op `cancelled: false` if nothing runs."""
    proc = _render_procs.get(project_id)
    if proc is not None:
        _kill_render_proc(proc)
        return {"cancelled": True}
    return {"cancelled": False}


@router.get("/projects/{project_id}/render/status")
async def render_status(project_id: str, project_dir: Path = Depends(get_project_dir)):
    """Poll the state of the current/last render for this project. Pairs with the
    async kick (POST /render?async=1): clients hit this to follow progress
    (phase) and pick up the output path or error once terminal. Returns idle when
    no render has run for this project this process lifetime."""
    job = _render_jobs.get(project_id)
    if job is None:
        return {"status": "idle"}
    out = {"status": job.status, "phase": job.phase}
    if job.status == "done":
        out["outputPath"] = job.result
    elif job.status == "error":
        out["error"] = job.result
    return out


@router.post("/projects/{project_id}/captions")
async def generate_captions(
    project_id: str,
    request: Request,
    body: dict = Body(default={}),
    project_dir: Path = Depends(get_project_dir),
):
    """Regenerate the project's captions over the trimmed timeline. Streams
    progress as SSE log/done/error events.

    Pipeline (all subprocesses, stderr streamed as `log` events):
      1. build_cut_spec  — derive the cut spec from the primary track
                           (single- or multi-source; multi-source composes all
                           tracks[0] clips, in order, into one MP4).
      2. materialize_cut — render the trimmed timeline to a plain MP4.
      3. transcribe      — multilingual, language-auto-detecting, OUTPUT-time
                           word timings (plain video in, NOT a trim spec).
      4. caption         — group words into styled caption segments.
    On success, writes project["captions"], persists project.json, broadcasts
    the update, and emits a `done` event carrying the caption track JSON.

    Mirrors the render route's streaming shape so it survives the ~100s
    Cloudflare tunnel wall.
    """
    project_path = project_dir / "project.json"

    # Reject if a caption job for this project is already in flight. Check-and-add
    # is race-free: one asyncio loop, set mutation runs between awaits.
    if project_id in _active_caption_jobs:
        raise HTTPException(409, detail={
            "error": "concurrent_caption_job",
            "message": f"A caption job for project {project_id} is already in progress.",
        })

    try:
        project = json.loads(project_path.read_text())
    except Exception:
        raise not_found("project_not_found", f"project.json for {project_id} not found")

    model = body.get("model") or "large"
    language = body.get("language") or "auto"
    style = body.get("style") or (project.get("captions") or {}).get("style") or "pop"

    materialize_cut_py = MONTAJ_ROOT / "steps" / "transform" / "materialize_cut.py"
    transcribe_py = MONTAJ_ROOT / "steps" / "speech" / "transcribe.py"
    caption_py = MONTAJ_ROOT / "steps" / "lyrics" / "caption.py"

    cut_spec_path = project_dir / "_caption_cut.json"
    cut_mp4_path = project_dir / "_caption_cut.mp4"
    words_prefix = project_dir / "_caption_words"
    words_json_path = project_dir / "_caption_words.json"
    track_path = project_dir / "_caption_track.json"

    env = os.environ.copy()
    env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)

    # Reserve the slot now; the generator's `finally` releases it (covers
    # success, error, and client-disconnect alike).
    _active_caption_jobs.add(project_id)

    async def event_stream():
        try:
            # 1. Derive the cut spec from the primary track (single- or
            #    multi-source). Multi-source composes all tracks[0] clips into
            #    one MP4; output-time word timings then map 1:1 to the timeline.
            try:
                cut_spec = build_cut_spec(project)
            except ValueError as e:
                yield f"event: error\ndata: {str(e)}\n\n"
                return

            # 2. Write the cut spec.
            cut_spec_path.write_text(json.dumps(cut_spec))

            # Each step is run as a subprocess with its stderr streamed as `log`
            # events. The loop is inlined (not a helper) because an inner
            # generator can't yield to the outer StreamingResponse.
            steps = [
                (
                    "materialize_cut",
                    [str(materialize_cut_py), "--input", str(cut_spec_path),
                     "--out", str(cut_mp4_path)],
                ),
                (
                    "transcribe",
                    [str(transcribe_py), "--input", str(cut_mp4_path),
                     "--model", model, "--language", language,
                     "--out", str(words_prefix)],
                ),
                (
                    "caption",
                    [str(caption_py), "--input", str(words_json_path),
                     "--style", style, "--out", str(track_path)],
                ),
            ]

            for label, args in steps:
                proc = await asyncio.create_subprocess_exec(
                    sys.executable, *args,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(MONTAJ_ROOT),
                    env=env,
                    limit=10 * 1024 * 1024,
                    start_new_session=True,
                )

                def kill_tree(p=proc):
                    try:
                        os.killpg(os.getpgid(p.pid), signal.SIGTERM)
                    except (ProcessLookupError, OSError):
                        try:
                            p.kill()
                        except Exception:
                            pass

                disconnected = False
                while True:
                    if await request.is_disconnected():
                        kill_tree()
                        disconnected = True
                        break
                    line = await proc.stderr.readline()
                    if not line:
                        break
                    text = line.decode().rstrip()
                    if text:
                        yield f"event: log\ndata: [{label}] {text}\n\n"

                if disconnected:
                    return

                await proc.stdout.read()
                await proc.wait()

                if proc.returncode != 0:
                    yield f"event: error\ndata: {label} failed (exit {proc.returncode})\n\n"
                    return

            # 6. Persist the caption track onto the project and broadcast.
            track = json.loads(track_path.read_text())
            prev = project.get("captions") or {}
            for k in ("position", "color", "fontsize", "bgColor"):
                if k in prev and k not in track:
                    track[k] = prev[k]
            project["captions"] = track
            text = json.dumps(project, indent=2)
            project_path.write_text(text)
            broadcaster: SSEBroadcaster = request.app.state.broadcaster
            broadcaster.publish(project_id, _sse_data_frame(text))

            # 7. Done — carry the caption track in the payload.
            yield f"event: done\ndata: {json.dumps(track)}\n\n"
        finally:
            _active_caption_jobs.discard(project_id)
            for _tmp in (
                cut_spec_path,
                cut_mp4_path,
                words_json_path,
                project_dir / "_caption_words.srt",
                track_path,
            ):
                try:
                    _tmp.unlink(missing_ok=True)
                except OSError:
                    pass

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
