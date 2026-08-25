"""POST /run and all /projects/{id}* endpoints, plus _git_commit_sync helper."""
import asyncio
import io
import json
import math
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
from collections import deque
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from urllib.parse import urlparse

from serve.common import (
    MONTAJ_ROOT,
    resolve_workspace, find_project_dir, get_project_dir,
    run_subprocess,
    not_found, bad_request, forbidden, server_error,
    validate_project_subpath, _is_under,
)
from serve import context as context_store
from serve.caption_job import build_audio_mix_spec
from serve.routes.files import save_upload
from lib.ingest import ingest_source
from lib.project_tracks import normalize_tracks, track_items
from lib.remote_io import fetch_to_disk_async, push_from_disk_async, parse_allowed_hosts
from project.init import _copy_into_workspace
from serve.sse import SSEBroadcaster, sse_stream

from lib.common import SAFE_NAME as _SAFE_NAME, ffmpeg_bin, ffprobe_bin
from lib.look import curve_ids
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
    if "deriving SDR rendition" in line:
        return "sdr_derive"
    return None


_render_jobs: dict[str, _RenderJob] = {}

# Strong refs to in-flight detached render tasks. asyncio only weakly tracks
# fire-and-forget tasks, so without this a render task could be GC'd mid-run.
_render_task_refs: set = set()

# Conservative output-name whitelist: letters, digits, space, dash,
# underscore, dot. No path separators, so a sanitized name can never escape
# output_dir on its own.
_UNSAFE_OUTPUT_NAME_CHARS = re.compile(r"[^A-Za-z0-9 _.-]+")


def _sanitize_output_name(name: str, fallback: str) -> str:
    """Turn a caller-supplied render output name into a safe basename with no
    extension and no path components. Strips directory components (basename),
    the trailing extension, ``..``, and any character outside a conservative
    whitelist; falls back to ``fallback`` (the project dir name) if nothing
    safe survives."""
    base = os.path.basename(name)
    base = os.path.splitext(base)[0]
    base = base.replace("..", "")
    base = _UNSAFE_OUTPUT_NAME_CHARS.sub("", base)
    base = base.strip(" .")
    return base or fallback


async def _extract_cover_frame(output_path: "Path", cover: float, job: _RenderJob) -> None:
    """Best-effort poster-frame extraction for a finished render. Pulls the
    frame at ``cover`` seconds into a sidecar JPEG next to ``output_path``.
    Any failure here is logged to the job's line buffer and swallowed — the
    render itself already succeeded and must not be flipped to error over a
    missing thumbnail."""
    cover_path = output_path.with_suffix(".jpg")
    try:
        cmd = [
            ffmpeg_bin(), "-y",
            "-ss", str(cover),
            "-i", str(output_path),
            "-frames:v", "1",
            "-update", "1",
            str(cover_path),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        if proc.returncode != 0:
            job.lines.append(f"[render] cover extraction failed (exit {proc.returncode})")
    except Exception as e:
        job.lines.append(f"[render] cover extraction failed: {e}")


async def _run_render_detached(project_id: str, cmd: list[str], env: dict,
                               render_input: "Path", project_path: "Path",
                               job: _RenderJob, *, cover: float | None = None,
                               output_path: "Path | None" = None) -> None:
    """Run a render subprocess to completion regardless of any client. Owns the
    `_render_procs` / `_active_renders` slot until the render actually finishes, so
    a dropped SSE connection can't strand or abort it.

    ``cover``/``output_path`` (both optional) trigger a best-effort poster-frame
    extraction after a successful render — see `_extract_cover_frame`."""
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
            if cover is not None and output_path is not None:
                await _extract_cover_frame(output_path, cover, job)
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


class _CaptionJob:
    """Live state of a detached caption job, polled by GET /captions/status. The
    pipeline runs to completion independent of any client connection — a dropped
    request must NOT abort it."""
    __slots__ = ("status", "result", "error")

    def __init__(self) -> None:
        self.status: str = "running"   # running | done | error
        self.result: dict | None = None  # caption track dict (done)
        self.error: str | None = None    # error message (error)


_caption_jobs: dict[str, _CaptionJob] = {}

# Strong refs to in-flight detached caption tasks. asyncio only weakly tracks
# fire-and-forget tasks, so without this a caption task could be GC'd mid-run.
_caption_task_refs: set = set()


async def _run_caption_detached(
    project_id: str,
    project_dir: "Path",
    project: dict,
    model: str,
    language: str,
    style: str,
    broadcaster: "SSEBroadcaster",
    job: _CaptionJob,
) -> None:
    """Run the caption pipeline to completion regardless of any client. Owns the
    `_active_caption_jobs` slot until the pipeline actually finishes, so a dropped
    request can't strand or abort it."""
    try:
        track = await _run_caption_pipeline(
            project_id,
            project_dir,
            project,
            model,
            language,
            style,
            broadcaster=broadcaster,
            on_log=None,
            is_disconnected=None,
        )
        job.status, job.result = "done", track
    except CaptionPipelineError as e:
        job.status, job.error = "error", e.message
    except Exception as e:
        job.status, job.error = "error", str(e)
    finally:
        # Release the slot so a later request may proceed.
        # NOTE: the terminal job is intentionally NOT popped from _caption_jobs —
        # it persists so a post-completion GET /captions/status can still read it.
        # A new job overwrites _caption_jobs[project_id] after the 409 check clears.
        _active_caption_jobs.discard(project_id)
        # Clean up temp files (mirrors the SSE path's finally).
        for _tmp in (
            project_dir / "_caption_mix.json",
            project_dir / "_caption_mix.wav",
            project_dir / "_caption_words.json",
            project_dir / "_caption_words.srt",
            project_dir / "_caption_track.json",
        ):
            try:
                _tmp.unlink(missing_ok=True)
            except OSError:
                pass


class _IngestJob:
    """Live state of a detached footage-ingest job, polled by
    GET /sources/status/{job_id}. Runs to completion independent of any client
    connection — a dropped request must NOT abort it. Keyed by job_id, not
    project_id: unlike captions/renders, multiple imports may legitimately run
    concurrently for the same project (e.g. importing several files at once)."""
    __slots__ = ("status", "phase", "result", "error")

    def __init__(self) -> None:
        self.status: str = "running"     # running | done | error
        self.phase: str = "staging"      # staging | normalizing | building proxy | done
        self.result: dict | None = None  # appended clip dict (done)
        self.error: str | None = None    # error message (error)


_ingest_jobs: dict[str, _IngestJob] = {}

# Strong refs to in-flight detached ingest tasks. asyncio only weakly tracks
# fire-and-forget tasks, so without this an ingest task could be GC'd mid-run.
_ingest_task_refs: set = set()

_CLIP_ID_RE = re.compile(r"^clip-(\d+)$")


def _next_clip_id(project: dict) -> str:
    """Smallest ``clip-<N>`` id guaranteed not to collide with any existing
    source or timeline-item id. Scans both project["sources"] and every
    track's items (a placed clip shares its source's id, and a future
    placement of THIS new clip must not collide with it either) — mirrors the
    max+1 `asset-<N>` allocation in include_profile_asset below."""
    max_n = -1
    for src in project.get("sources") or []:
        m = _CLIP_ID_RE.match(str(src.get("id", "")))
        if m:
            max_n = max(max_n, int(m.group(1)))
    for track in project.get("tracks") or []:
        for item in track.get("items") or []:
            m = _CLIP_ID_RE.match(str(item.get("id", "")))
            if m:
                max_n = max(max_n, int(m.group(1)))
    return f"clip-{max_n + 1}"


async def _run_ingest_detached(
    project_id: str,
    project_dir: "Path",
    path: str,
    color_space: str,
    broadcaster: "SSEBroadcaster",
    job: "_IngestJob",
) -> None:
    """Run lib.ingest.ingest_source to completion regardless of any client,
    mirroring `_run_caption_detached`. `ingest_source` is blocking (ffmpeg
    probe/normalize/proxy), so it's offloaded to a thread — same reasoning as
    the caption pipeline's subprocess-bound work. Emits `event: log` SSE
    progress frames bracketing the staging/normalize/proxy work (ingest_source
    itself has no phase callback, so these narrate the call rather than
    stream sub-progress from inside it), then appends the resulting clip to
    project["sources"], persists + broadcasts project.json (same
    read-write-broadcast idiom as save_project / `_run_caption_pipeline`
    above), and records the outcome on `job`.

    The proxy is NEVER encoded inline (`proxy=False`): it is queued onto the
    shared look-migration queue once the clip is persisted, so the job finishes
    as soon as the source is staged and colour-normalized and the editor gets a
    usable clip immediately. Colour normalization stays inline — it decides what
    `src` even points at, which is correctness, not a cache.

    Ordering is load-bearing: `_ensure_current_proxies` resolves its write-back
    targets through `_apply_project_edits`, which RE-READS project.json and
    matches on (id, src). Enqueue before the append is on disk and the encode
    lands with nowhere to write its `proxySrc`."""
    def log(message: str) -> None:
        broadcaster.publish(project_id, f"event: log\ndata: {json.dumps({'message': message})}\n\n")

    try:
        job.phase = "staging"
        log(f"[ingest] staging {os.path.basename(path)}")

        clip = await asyncio.to_thread(
            ingest_source, project_dir, path, color_space, "eager", proxy=False
        )

        job.phase = "normalizing"
        log(f"[ingest] normalized to project color space ({color_space})")

        # Read fresh right before the append+write to minimize clobbering a
        # concurrent editor save (mirrors the caption pipeline's late read).
        project_path = Path(project_dir) / "project.json"
        project = json.loads(project_path.read_text())
        clip = {"id": _next_clip_id(project), **clip}
        project.setdefault("sources", []).append(clip)
        text = json.dumps(project, indent=2)
        project_path.write_text(text)
        broadcaster.publish(project_id, _sse_data_frame(text))

        # Only now the clip is on disk under a stable (id, src) can the encode's
        # write-back find it. A bin entry on no track is a first-class target:
        # `_look_migration_items` walks `sources` too. Best-effort — the clip is
        # already usable, and the editor's manual migration is the fallback.
        job.phase = "queueing proxy"
        try:
            queued = _ensure_current_proxies(
                project_id, Path(project_dir), project, broadcaster
            )["scheduled"]
            # `queued` counts every un-proxied item in the project, not just the
            # one just ingested: _ensure_current_proxies sweeps the whole thing,
            # so adding one clip to an AV1-era project legitimately starts many
            # encodes. Say the real number rather than implying it was one.
            log(f"[ingest] {queued} proxy encode(s) queued" if queued else "[ingest] no proxy needed")
        except Exception:
            log("[ingest] proxy could not be queued")

        job.status, job.result, job.phase = "done", clip, "done"
        log(f"[ingest] added {clip['id']}")
    except Exception as e:
        job.status, job.error = "error", str(e)
        log(f"[ingest] failed: {e}")


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


async def _run_init_subprocess(
    cmd: list[str],
    *,
    timeout: int = 1800,
    broadcaster: "SSEBroadcaster | None" = None,
) -> dict:
    """Spawn project/init.py via subprocess, capture stdout (project path), and
    return the parsed project.json dict. Raises HTTPException on any failure.

    When MONTAJ_DEBUG=1, stderr is streamed live to the server's own stderr so
    operators can watch progress in real time. Default (unset): stderr is buffered
    and only surfaced on non-zero exit.

    Init may DEFER proxy encoding (whole batches of it), which only skips the
    work — nothing schedules it. This is the single seam both creation paths go
    through, so the deferred work is queued here, on the existing single-worker
    background queue, rather than waiting for a user to notice the manual
    migration button. `broadcaster` is optional: without one the write-back into
    project.json still happens as each encode lands, only the live SSE nudge to
    an already-open editor is lost.
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
        project = json.loads(project_path.read_text())
    except Exception:
        raise server_error("read_failed", "Project created but could not be read back")

    # Queue whatever init deferred. De-duping, freshness skipping, SSE targets
    # and the write-back of `proxySrc` are all the existing queue's job — this
    # only starts it. Best-effort like ensure_project_proxies: a project that
    # was created successfully must never fail because housekeeping couldn't be
    # scheduled (the editor's manual migration remains the fallback).
    try:
        _ensure_current_proxies(project.get("id"), project_path.parent, project, broadcaster)
    except Exception:
        pass

    return project


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/run", status_code=201)
async def run_project(request: Request, body: dict = Body(...)):
    clips        = body.get("clips", [])
    assets       = body.get("assets", [])
    prompt       = body.get("prompt")
    workflow     = body.get("workflow", "clean_cut")
    name         = body.get("name")
    profile      = body.get("profile")
    project_path_arg = body.get("projectPath")
    remote_clips = body.get("remoteClips", [])
    remote_assets = body.get("remoteAssets", [])
    # Voiceover intake accepts a list (`voiceoverAssets`, one file per recorded
    # take) or the original single `voiceoverAsset`. Both normalize to a list;
    # init concatenates when there is more than one.
    voiceover_assets = body.get("voiceoverAssets")
    if voiceover_assets is None:
        single = body.get("voiceoverAsset")
        voiceover_assets = [single] if single else []
    if not isinstance(voiceover_assets, list):
        raise bad_request("invalid_field", "'voiceoverAssets' must be a list of paths")
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

        return await _run_init_subprocess(cmd, broadcaster=getattr(request.app.state, "broadcaster", None))

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

    for vo in voiceover_assets:
        if not isinstance(vo, str) or not Path(vo).is_file():
            raise bad_request("file_not_found", f"voiceoverAsset not found: {vo}")

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
    if voiceover_assets:
        cmd += ["--voiceover-asset"] + [str(v) for v in voiceover_assets]
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
    return await _run_init_subprocess(cmd, broadcaster=getattr(request.app.state, "broadcaster", None))


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


# ---------------------------------------------------------------------------
# Look migration at project open (SP6b T9)
#
# Look-version tags in artifact FILENAMES (lib/proxy.py's PROXY_LOOK,
# lib/normalize.py's normalized_output_path) make a stale artifact detectable
# by name alone — but only for code that recomputes the name. project.json
# items don't: they carry `normalizedSrc`/`proxySrc` POINTING AT the old-look
# file, which still exists on disk, so every filename-based freshness check
# short-circuits on a path that is fresh by mtime and wrong by look. That
# field-level staleness is what this pass heals.
#
# Shape: GET /projects/{id} runs the pass, repoints or clears the stale fields,
# writes project.json once, and returns the migrated body immediately. The
# re-encodes run in the background and land in project.json as they finish —
# the same "artifacts arrive after the response" UX imports already have.
# ---------------------------------------------------------------------------

class _LookMigrationUnit:
    """One background re-encode, plus every project.json field waiting on it.

    `targets` holds (project_id, project_dir, field, item_id, item_src,
    broadcaster) per waiting field — the fields this pass CLEARED and will
    repoint once the encode lands. One unit can serve several: the clips
    workflow fans N child projects out over one shared lazy source, so opening
    all N asks for the same proxy path.
    """
    __slots__ = ("kind", "src", "out", "color_space", "targets", "job_id")

    def __init__(self, kind: str, src: str, out: str, color_space: str) -> None:
        self.kind = kind                  # "proxy" | "normalize"
        self.src = src                    # encode input
        self.out = out                    # artifact this unit produces
        self.color_space = color_space
        self.targets: list[tuple] = []
        self.job_id: str | None = None


# Pending units (FIFO) and the one currently encoding. Together these are the
# in-flight guard: a unit is scheduled only when no queued/running unit already
# produces the same artifact, so opening a project twice — or opening five
# children of one shared source — never starts a duplicate encode. It also
# bounds concurrency: ONE worker drains the queue, so a project with 20 stale
# items runs 20 encodes back to back, never 20 at once. That is stricter than
# project/init.py's capacity-2 pools by design — this is background housekeeping
# that must not compete with a user-initiated render.
_look_migration_queue: list[_LookMigrationUnit] = []
_look_migration_current: _LookMigrationUnit | None = None
_look_migration_worker: "asyncio.Task | None" = None


def _look_migration_pending(kind: str, out: str) -> _LookMigrationUnit | None:
    """The queued-or-running unit producing `out`, if any."""
    if _look_migration_current is not None and \
            _look_migration_current.kind == kind and _look_migration_current.out == out:
        return _look_migration_current
    for unit in _look_migration_queue:
        if unit.kind == kind and unit.out == out:
            return unit
    return None


def _look_migration_enqueue(unit: _LookMigrationUnit) -> None:
    """Queue `unit` and make sure a worker is draining."""
    global _look_migration_worker
    _look_migration_queue.append(unit)
    if _look_migration_worker is None or _look_migration_worker.done():
        _look_migration_worker = asyncio.create_task(_look_migration_drain())


async def _look_migration_drain() -> None:
    """Run queued migration encodes one at a time, writing each result back into
    project.json as it lands."""
    global _look_migration_current, _look_migration_worker
    try:
        while _look_migration_queue:
            unit = _look_migration_queue.pop(0)
            _look_migration_current = unit
            try:
                path = await _run_look_migration_unit(unit)
            except Exception:
                path = None
            finally:
                _look_migration_current = None
            if path:
                _apply_look_migration_result(unit, path)
    finally:
        _look_migration_worker = None


async def _run_look_migration_unit(unit: _LookMigrationUnit) -> str | None:
    """Drive one unit's encode through the shared step-job machinery. Returns the
    produced path, or None if the encode failed or produced something other than
    the artifact we asked for (e.g. normalize's already-conformant short-circuit,
    which returns the INPUT path — repointing a field at that would undo the
    migration instead of completing it)."""
    from serve.jobs import create_job, get_job
    from serve.routes.steps import run_normalize_job, run_proxy_job

    unit.job_id = create_job()
    if unit.kind == "proxy":
        # tonemap=None: the proxy driver probes the source and tone-maps HDR,
        # exactly as a fresh import would — this pass must not second-guess it.
        await run_proxy_job(unit.job_id, unit.src, out=unit.out, tonemap=None)
    else:
        await run_normalize_job(unit.job_id, unit.src, unit.color_space, out=unit.out)

    job = get_job(unit.job_id) or {}
    if job.get("status") != "done":
        return None
    path = (job.get("result") or {}).get("path")
    return path if path == unit.out else None


def _apply_project_edits(project_path: Path, edits: list[tuple]) -> tuple[dict, str] | None:
    """Apply `(item_id, item_src, field, value)` edits to a project.json — a
    `None` value deletes the field. Returns the updated (project, json text), or
    None when nothing changed or the file can't be read.

    Serialization: read-modify-write with NO await between the read and the
    write, so under the single asyncio loop that serves this process it cannot
    interleave with PUT /projects/{id} (save_project above uses the same
    discipline) or with another unit's write-back. Re-reading rather than
    dumping a dict held across an await is what keeps a concurrent PUT from
    being clobbered. The rewrite is tmp+os.replace so a crash mid-write can't
    truncate the project (SP3 fix S6's reasoning, as cli/commands/clean.py).

    The project may have changed since the edits were computed: items are
    matched by (id, src), and an item that no longer exists is simply skipped.
    """
    try:
        project = json.loads(project_path.read_text())
    except (OSError, ValueError):
        return None  # project deleted, or unreadable — nothing to heal
    changed = False
    for item in _look_migration_items(project):
        for item_id, item_src, field, value in edits:
            if item.get("src") != item_src or item.get("id") != item_id:
                continue
            if value is None:
                if field in item:
                    del item[field]
                    changed = True
            elif item.get(field) != value:
                item[field] = value
                changed = True
    if not changed:
        return None
    text = json.dumps(project, indent=2)
    try:
        tmp = str(project_path) + ".tmp"
        Path(tmp).write_text(text)
        os.replace(tmp, project_path)
    except OSError:
        return None
    return project, text


def _apply_look_migration_result(unit: _LookMigrationUnit, path: str) -> None:
    """Write `path` back into every project.json waiting on this unit."""
    for project_id, project_dir, field, item_id, item_src, broadcaster in unit.targets:
        result = _apply_project_edits(
            Path(project_dir) / "project.json", [(item_id, item_src, field, path)]
        )
        if result is not None and broadcaster is not None:
            broadcaster.publish(project_id, _sse_data_frame(result[1]))


def _look_migration_items(project: dict):
    """Every video item in the project, across all tracks plus the `sources`
    mirror — the same two groups cli/commands/clean.py walks when it strips
    dangling proxySrc pointers. Overlay/image/caption items carry no video
    artifacts and are skipped."""
    groups = track_items(project) + [project.get("sources") or []]
    for group in groups:
        for item in group or []:
            if isinstance(item, dict) and item.get("type") == "video" and item.get("src"):
                yield item


async def migrate_project_look(
    project_id: str,
    project_dir: Path,
    project: dict,
    broadcaster: "SSEBroadcaster | None" = None,
) -> dict:
    """Repoint or clear look-stale artifact fields, schedule the re-encodes that
    heal the cleared ones, and return the project to serve — `project` itself
    when nothing was stale, otherwise the committed post-migration copy.

    Never raises and never blocks on an encode: the caller's response body is
    the migrated project, and the background queue delivers the rest over SSE.

    Per video item, with the item's source file present and absolute:

    * `proxySrc` whose filename lacks `_proxy_<PROXY_LOOK>_<PROXY_FORMAT>` (an
      old-look proxy such as `_proxy_hable1_h264`, or an old-format one such as
      the untagged-format `_proxy_vivid1`), or that names a file no longer on
      disk. The
      current-look proxy is adopted when it already exists and is fresher than
      the source; otherwise the field is cleared and an encode queued.
    * `normalizedSrc` naming THIS item's full-source master under the untagged
      legacy name (`<stem>_normalized_sdr_bt709.mp4`) when the source probes as
      HDR — i.e. a tone-mapped master built by a pre-vivid1 look. An untagged
      master of an SDR source is a live colour-conformance master carrying no
      look and is left alone; anything else in the field (a `normalize_window`
      window cache, a hand-written path) is NOT this item's master and is left
      alone too, because a full-source re-encode would break the window's
      `normalizedInPoint` rebase. A field already naming the tagged master is
      migrated only when that file has gone missing (`montaj clean` can delete
      a superseded master out from under a live pointer).

    A cleared field is safe on its own: preview and render both fall back to
    `src`, and render's own `normalizeIfNeeded` rebuilds the tagged master. So a
    failed background encode degrades to "no cache", never to a broken project.
    """
    try:
        return await _migrate_project_look(project_id, project_dir, project, broadcaster) or project
    except Exception:
        # A project must always open. Migration is best-effort housekeeping.
        return project


async def _migrate_project_look(
    project_id: str,
    project_dir: Path,
    project: dict,
    broadcaster: "SSEBroadcaster | None",
) -> dict | None:
    from lib.normalize import normalized_output_path, probe_video
    from lib.proxy import PROXY_FORMAT, PROXY_LOOK, is_proxy_fresh, proxy_path_for
    from lib.types.colorspace import DEFAULT_COLOR_SPACE, detect_from_transfer, is_hdr

    settings = project.get("settings") or {}
    color_space = settings.get("colorSpace") or DEFAULT_COLOR_SPACE
    proxies_enabled = settings.get("proxy") is not False

    items = list(_look_migration_items(project))
    if not items:
        return None

    # Pass 1 — name-only triage. Everything here is string work plus a stat, so
    # a migrated (or SDR-source, or carousel) project reaches the return below
    # having touched neither ffprobe nor the disk beyond a few isfile() calls.
    proxy_stale: list[dict] = []
    master_candidates: list[dict] = []
    for item in items:
        src = item["src"]
        # Relative srcs (overlay items may use them) can't be resolved against
        # the same base the artifact names were built from — out of scope.
        # A missing source is the plan's bound: nothing to re-encode from.
        if not os.path.isabs(src) or not os.path.isfile(src):
            continue

        proxy_src = item.get("proxySrc")
        if proxies_enabled and proxy_src and (
            # Both tags, not just the look: an AV1-generation proxy is named
            # `_proxy_<look>.mp4`, which CONTAINS `_proxy_<look>` — testing the
            # look alone judges every pre-H.264 proxy current and never retires
            # it. The browser codec probe now assumes H.264, so a project still
            # pointing at av01 files would be judged decodable on evidence that
            # no longer describes the file.
            f"_proxy_{PROXY_LOOK}_{PROXY_FORMAT}" not in os.path.basename(proxy_src)
            or not os.path.isfile(proxy_src)
        ):
            proxy_stale.append(item)

        normalized_src = item.get("normalizedSrc")
        if normalized_src and color_space == "sdr_bt709":
            tagged = normalized_output_path(src, color_space, tonemapped=True)
            untagged = normalized_output_path(src, color_space, tonemapped=False)
            if normalized_src == tagged and not os.path.isfile(tagged):
                # Already the current look, just deleted — no probe needed, the
                # tag itself is the proof it was tone-mapped.
                master_candidates.append(item)
            elif normalized_src == untagged:
                master_candidates.append(item)

    if not proxy_stale and not master_candidates:
        return None

    # Pass 2 — one ffprobe per unique src (project/init.py:489's discipline),
    # and only for the untagged-master candidates: untagged means "tone-mapped
    # under the old look OR a plain SDR conformance master", and only the
    # source's transfer function tells those apart. Off the event loop so the
    # probes can't stall SSE or another request.
    transfer_cache: dict[str, bool] = {}

    def _probe_is_hdr(path: str) -> bool:
        try:
            info = probe_video(path)
        except (Exception, SystemExit):
            return False
        if info is None:
            return False
        return is_hdr(detect_from_transfer(info.get("color_transfer")))

    to_probe = sorted({
        item["src"] for item in master_candidates
        if item.get("normalizedSrc") == normalized_output_path(item["src"], color_space, tonemapped=False)
    })
    for src in to_probe:
        transfer_cache[src] = await asyncio.to_thread(_probe_is_hdr, src)

    # Pass 3 — repoint what already exists, clear + queue what doesn't. Both maps
    # are keyed so the `tracks` item and its `sources` twin (same id, same src)
    # collapse to ONE edit and ONE encode instead of doing everything twice.
    units: dict[tuple, _LookMigrationUnit] = {}
    edits: dict[tuple, str | None] = {}

    def _schedule(kind: str, key: tuple, src: str, out: str) -> None:
        edits[key] = None  # clear the pointer; the write-back repoints it
        unit = units.get((kind, out))
        if unit is None:
            unit = _look_migration_pending(kind, out) or _LookMigrationUnit(kind, src, out, color_space)
            units[(kind, out)] = unit
        unit.targets.append((project_id, str(project_dir), key[2], key[0], key[1], broadcaster))

    for item in proxy_stale:
        key = (item.get("id"), item["src"], "proxySrc")
        if key in edits:
            continue
        # realpath so every child of a shared lazy source names — and races on —
        # the ONE proxy that serves them all (project/init.py's lazy arm does the
        # same before calling proxy_path_for).
        real_src = os.path.realpath(item["src"])
        out = proxy_path_for(real_src)
        if is_proxy_fresh(out, real_src):
            edits[key] = out  # already encoded — just repoint
        else:
            _schedule("proxy", key, real_src, out)

    for item in master_candidates:
        src = item["src"]
        key = (item.get("id"), src, "normalizedSrc")
        if key in edits:
            continue
        untagged = normalized_output_path(src, color_space, tonemapped=False)
        if item.get("normalizedSrc") == untagged and not transfer_cache.get(src):
            continue  # SDR source: the untagged master carries no look, leave it
        out = normalized_output_path(src, color_space, tonemapped=True)
        if os.path.isfile(out):
            edits[key] = out  # already encoded — just repoint
        else:
            _schedule("normalize", key, src, out)

    result = None
    if edits:
        result = _apply_project_edits(
            project_dir / "project.json",
            [(item_id, item_src, field, value) for (item_id, item_src, field), value in edits.items()],
        )
        if result is not None and broadcaster is not None:
            broadcaster.publish(project_id, _sse_data_frame(result[1]))

    for (kind, out), unit in units.items():
        if _look_migration_pending(kind, out) is unit:
            continue  # already queued/running — this open only added targets
        _look_migration_enqueue(unit)

    return result[0] if result is not None else None


def _ensure_current_proxies(
    project_id: str,
    project_dir: Path,
    project: dict,
    broadcaster: "SSEBroadcaster | None" = None,
) -> dict:
    """Manual proxy migration: heal every video item that lacks a current,
    fresh editing proxy, reusing the SP6b look-migration background apparatus.

    A superset of `_migrate_project_look`'s proxy triage: one `is_proxy_fresh`
    check covers missing proxies (no `proxySrc`), old-look proxies
    (`_proxy_hable1`), and dangling pointers (file deleted) alike. Sources are
    de-duped by target proxy path (`out`), so the clips fan-out's shared lazy
    source encodes once and every child repoints to it.

    Per unique `out`:
      * Fresh on disk — the current-look proxy already exists and is at least as
        new as the source. Repoint any item not already pointed at it (an
        immediate `_apply_project_edits`, broadcast at once) and count the
        source toward `alreadyFresh`.
      * Not fresh — reuse the queued/running unit if one already produces `out`,
        else build one, attach a target per item, and count toward `scheduled`.
        Unlike `_migrate_project_look` this does NOT pre-clear the stale
        `proxySrc`: a manual action's counts must only ever go DOWN, so the old
        pointer survives until the fresh encode lands and repoints it.

    Never awaits an encode — the background queue delivers write-backs over SSE.
    Returns `{"scheduled": N, "alreadyFresh": M}`, both counts of unique sources.
    """
    from lib.proxy import is_proxy_fresh, proxy_path_for
    from lib.types.colorspace import DEFAULT_COLOR_SPACE

    settings = project.get("settings") or {}
    if settings.get("proxy") is False:
        return {"scheduled": 0, "alreadyFresh": 0}
    color_space = settings.get("colorSpace") or DEFAULT_COLOR_SPACE

    # Group every present, absolute-sourced video item by the ONE proxy path it
    # would use (realpath so a shared lazy source's children collapse to one).
    by_out: dict[str, list[dict]] = {}
    real_by_out: dict[str, str] = {}
    for item in _look_migration_items(project):
        src = item["src"]
        if not (os.path.isabs(src) and os.path.isfile(src)):
            continue
        real_src = os.path.realpath(src)
        out = proxy_path_for(real_src)
        by_out.setdefault(out, []).append(item)
        real_by_out[out] = real_src

    edits: list[tuple] = []
    units: dict[str, _LookMigrationUnit] = {}
    scheduled = 0
    already_fresh = 0

    for out, items in by_out.items():
        real_src = real_by_out[out]
        if is_proxy_fresh(out, real_src):
            # Already encoded under the current look — just repoint any item that
            # isn't pointed at it yet. No encode.
            for item in items:
                if item.get("proxySrc") != out:
                    edits.append((item.get("id"), item["src"], "proxySrc", out))
            already_fresh += 1
        else:
            # Missing / old-look / dangling — queue an encode (or attach to one
            # already in flight for this out). Do NOT pre-clear proxySrc.
            unit = _look_migration_pending("proxy", out) \
                or _LookMigrationUnit("proxy", real_src, out, color_space)
            units[out] = unit
            for item in items:
                unit.targets.append(
                    (project_id, str(project_dir), "proxySrc", item.get("id"), item["src"], broadcaster)
                )
            scheduled += 1

    if edits:
        result = _apply_project_edits(project_dir / "project.json", edits)
        if result is not None and broadcaster is not None:
            broadcaster.publish(project_id, _sse_data_frame(result[1]))

    for out, unit in units.items():
        if _look_migration_pending("proxy", out) is unit:
            continue  # already queued/running — this trigger only added targets
        _look_migration_enqueue(unit)

    return {"scheduled": scheduled, "alreadyFresh": already_fresh}


@router.post("/projects/{project_id}/proxies")
async def ensure_project_proxies(project_id: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    """Generate the missing/stale editing proxies for a project (manual
    migration of pre-proxy projects). Reuses the look-migration queue: nothing
    is encoded in the request — units are queued and land in project.json over
    SSE as they finish. 202 when work was queued, 200 when everything was
    already fresh. Best-effort: housekeeping never 500s the caller."""
    project = json.loads((project_dir / "project.json").read_text())
    broadcaster = getattr(request.app.state, "broadcaster", None) if request is not None else None
    try:
        result = _ensure_current_proxies(project_id, project_dir, project, broadcaster)
    except Exception:
        result = {"scheduled": 0, "alreadyFresh": 0}
    return JSONResponse(result, status_code=202 if result["scheduled"] else 200)


@router.get("/proxies/status")
async def proxy_activity_status():
    """How much proxy encoding the background queue is doing right now:
    `{"running": int, "queued": int}`.

    A pure read of the look-migration queue's existing state — no new counters,
    no locks. Only `kind == "proxy"` units count; a `normalize` unit in flight is
    not proxy work. `running` is 0 or 1 because ONE worker drains the queue.

    Deliberately total: a client polls this on a timer (every few seconds while
    work is in flight), so it must be cheap and must never 500. Anything
    unexpected reports zeros — "nothing happening" — rather than erroring."""
    try:
        current = _look_migration_current
        running = 1 if current is not None and current.kind == "proxy" else 0
        queued = sum(1 for unit in _look_migration_queue if unit.kind == "proxy")
    except Exception:
        running, queued = 0, 0
    return {"running": running, "queued": queued}


@router.get("/projects/{project_id}")
async def get_project(project_id: str, request: Request = None, project_dir: Path = Depends(get_project_dir)):
    project_path = project_dir / "project.json"
    project = json.loads(project_path.read_text())
    broadcaster = getattr(request.app.state, "broadcaster", None) if request is not None else None

    # Lazy track-shape migration: converge a legacy `tracks: [[item]]` project to
    # the object shape `tracks: [{"id", "items"}]` the moment it's opened. This
    # is the ONLY place that migration runs — no button, no separate command.
    # `normalize_tracks` returns the SAME object when nothing needs to change,
    # which is exactly the "no write on an already-converged project" property:
    # a second open must not touch the file. Same tmp+os.replace, no-await-
    # between-read-and-write discipline as `_apply_project_edits` below, so this
    # can't interleave with a concurrent PUT.
    #
    # Runs BEFORE look migration on purpose: look migration's own write-back
    # (`_apply_project_edits`) re-reads project.json from disk and mutates item
    # fields in place WITHOUT touching track shape, so it just preserves
    # whatever shape it finds. Normalizing (and persisting) first means every
    # later re-read — the immediate stale-pointer clear below, and each
    # background job's write-back, however much later it lands — finds the
    # object shape already on disk and carries it through untouched. Migrating
    # shape second, off of look migration's returned project, would risk a
    # background write-back re-reading the disk BEFORE our shape write landed
    # and re-persisting the legacy shape underneath it.
    normalized = normalize_tracks(project)
    if normalized is not project:
        text = json.dumps(normalized, indent=2)
        try:
            tmp = str(project_path) + ".tmp"
            Path(tmp).write_text(text)
            os.replace(tmp, project_path)
        except OSError:
            pass  # degrade to "not converged yet" — a project must always open
        else:
            if broadcaster is not None:
                broadcaster.publish(project_id, _sse_data_frame(text))
        project = normalized

    # Heal look-stale artifact pointers before handing the project over. The
    # response is the MIGRATED body — the pass only ever does name/stat work
    # plus a bounded ffprobe pass; every re-encode is queued, never awaited.
    return await migrate_project_look(project_id, project_dir, project, broadcaster)


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
        env["MONTAJ_FFMPEG"] = ffmpeg_bin()
        env["MONTAJ_FFPROBE"] = ffprobe_bin()
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
    # Agents routinely PUT a still-legacy `tracks` shape (or a whole project
    # they hand-built). Normalize before writing so a server write never leaves
    # legacy tracks on disk — a no-op (same object back) when already
    # normalized or when `tracks` is absent/null, so the shallow-merge and
    # explicit-null-clears-a-field semantics above are untouched.
    merged = normalize_tracks(merged)
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


@router.post("/projects/{project_id}/versions")
async def create_version(project_id: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    """Checkpoint the current on-disk project.json as a manual version.

    No track reset, no status change, no project.json write — just a git commit
    of whatever is currently on disk, so it becomes a recoverable version. The
    commit-message shape matches the rerun/render paths so VersionPanel's parser
    picks it up. `_git_commit_sync` is no-op-safe: if there's nothing to
    commit, the history is unchanged.
    """
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    name_raw = body.get("name", "") if isinstance(body, dict) else ""
    if not isinstance(name_raw, str):
        name_raw = ""
    # Commit subjects don't like newlines; also cap length so the message stays
    # sensible in the UI parser.
    clean_name = name_raw.replace("\r", " ").replace("\n", " ").strip()
    if len(clean_name) > 120:
        clean_name = clean_name[:120].rstrip()
    label = clean_name or "manual save"

    project_path = project_dir / "project.json"
    project = json.loads(project_path.read_text())
    run_count = project.get("runCount", 1)

    await asyncio.to_thread(_git_commit_sync, project_dir, f"version: run {run_count} — {label}")

    # Return the same shape as GET /projects/{id}/versions so the client can
    # replace its list in one call.
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
    # Read current runCount from on-disk project.json before restoring, so the
    # "autosave before restore" snapshot lands in the current run's history.
    # _git_commit_sync is no-op-safe, so this only creates a version when the
    # working tree actually has uncommitted edits — the history won't fill
    # with noise on every restore.
    current_project = json.loads(project_path.read_text())
    current_run_count = current_project.get("runCount", 1)
    await asyncio.to_thread(
        _git_commit_sync, project_dir,
        f"version: run {current_run_count} — autosave before restore",
    )
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
    # A version from before the track-shape migration is legacy-shaped on disk
    # in that commit. Normalize before writing/broadcasting so a restore never
    # leaves legacy tracks on disk — a no-op (same object back) when the
    # restored version is already normalized, matching save_project's rule.
    restored = normalize_tracks(restored)
    project_path.write_text(json.dumps(restored, indent=2))
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    broadcaster.publish(project_id, f"data: {json.dumps(restored)}\n\n")
    return restored


@router.get("/projects/{project_id}/versions/{commit}/frame")
async def version_frame(
    project_id: str,
    commit: str,
    t: float,
    project_dir: Path = Depends(get_project_dir),
):
    """Render a single composited PNG frame at time ``t`` from a past version of
    the project (or the live working copy when ``commit == 'working'``).

    Powers the frontend A/B compare view: pick any historical version, ask for
    the frame at any timestamp, get back a PNG rendered from THAT commit's
    project.json without touching the live on-disk state. The (commit, t) pair
    is content-addressed for git commits, so successful PNGs are cached under
    ``render/samples/versions/<commit>/frame-<t>s.png``. The ``working``
    sentinel is never cached — its input state can change with any edit.
    """
    if t < 0:
        raise bad_request("invalid_argument", "t must be >= 0")

    is_working = commit == "working"

    # Validate the commit exists before doing anything expensive. Mirrors the
    # `git show ... returncode != 0 -> not_found` idiom in restore_version, but
    # with rev-parse we can 404 without allocating stdout bytes.
    if not is_working:
        proc = await asyncio.create_subprocess_exec(
            "git", "rev-parse", "--verify", f"{commit}^{{commit}}",
            cwd=str(project_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        if proc.returncode != 0:
            raise not_found("not_found", f"Commit '{commit}' not found")

    # Cached PNGs live alongside the extracted project.json for the same
    # (commit, t). Working-copy frames get their own bucket but are never served
    # from cache.
    bucket = "working" if is_working else commit
    cache_path = project_dir / "render" / "samples" / "versions" / bucket / f"frame-{t}s.png"
    cache_path.parent.mkdir(parents=True, exist_ok=True)

    if not is_working and cache_path.is_file():
        return FileResponse(
            cache_path,
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    # Materialize the project.json input the render will read. For a real
    # commit we `git show` it into render/versions/<commit>/project.json (kept
    # on disk as a natural companion to the cached frame). For 'working' we
    # feed the live file straight through.
    if is_working:
        input_json = project_dir / "project.json"
        if not input_json.is_file():
            raise not_found("not_found", "project.json not found")
    else:
        input_json = project_dir / "render" / "versions" / commit / "project.json"
        input_json.parent.mkdir(parents=True, exist_ok=True)
        show = await asyncio.create_subprocess_exec(
            "git", "show", f"{commit}:project.json",
            cwd=str(project_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_b, _ = await show.communicate()
        if show.returncode != 0:
            raise not_found("not_found", f"Commit '{commit}' not found")
        input_json.write_bytes(stdout_b)

    render_script = Path(render_runtime_dir()) / "sample-frame.js"
    if not render_script.is_file():
        raise server_error("not_found", f"{render_script.name} not found")

    node_bin = shutil.which("node")
    if not node_bin:
        raise server_error("not_found", "node not found in PATH")

    env = os.environ.copy()
    env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)
    env["MONTAJ_FFMPEG"] = ffmpeg_bin()
    env["MONTAJ_FFPROBE"] = ffprobe_bin()

    cmd = [
        node_bin, str(render_script),
        "--mode", "frame",
        "--project", str(input_json),
        "--at", str(t),
        "--out", str(cache_path),
        "--prefer-proxy",
    ]
    render_proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(MONTAJ_ROOT),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr_b = await render_proc.communicate()
    if render_proc.returncode != 0:
        err = (stderr_b or b"").decode("utf-8", errors="replace")[-500:]
        raise server_error("render_failed", f"sample-frame.js exit {render_proc.returncode}: {err}")
    if not cache_path.is_file():
        raise server_error("render_failed", "sample-frame.js reported success but no PNG was written")

    # Working-copy frames are the only mutable case — the input state changes
    # with every edit, so browsers/proxies must revalidate on every request.
    cache_header = "no-store" if is_working else "public, max-age=31536000, immutable"
    return FileResponse(
        cache_path,
        media_type="image/png",
        headers={"Cache-Control": cache_header},
    )


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

    # Restore video track to original source clips; drop captions/overlays.
    # `order` is a legacy field: nothing downstream sorts or requires it (grep
    # confirms no reader touches it), so a missing key on an init-created or
    # ingested source (lib/ingest.py never sets it) degrades to None rather
    # than KeyError-ing the whole rerun.
    source_clips = [{"id": c["id"], "src": c["src"], "order": c.get("order")} for c in sources]
    updated = {
        **project,
        "status": "pending",
        "runCount": run_count + 1,
        "tracks": [{"id": "trk-0", "items": source_clips}],
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


@router.post("/projects/{project_id}/sources")
async def ingest_project_source(
    project_id: str,
    request: Request,
    body: dict = Body(...),
    project_dir: Path = Depends(get_project_dir),
):
    """Kick a detached footage-ingest job: stage (or adopt in place if already
    staged — see lib/ingest.py's in-project guard), probe, normalize to the
    project's color space, and proxy a new source video, then append it to
    project["sources"]. Modeled on the async caption-job pattern (_CaptionJob /
    _run_caption_detached above). Clients poll
    GET .../sources/status/{job_id} to follow progress and pick up the
    appended clip or error once terminal.

    Body: {"path": "<absolute path to a readable video file>"}. The path is
    typically one just staged via POST /upload-asset (browser drop) or picked
    natively by the client (outside project_dir); lib.ingest.ingest_source
    handles both without a double copy.
    """
    path = body.get("path")
    if not isinstance(path, str) or not path:
        raise bad_request("missing_field", "'path' is required")
    if not os.path.isfile(path):
        raise bad_request("invalid_path", f"'{path}' is not a readable file")

    project_path = project_dir / "project.json"
    try:
        project = json.loads(project_path.read_text())
    except Exception:
        raise not_found("project_not_found", f"project.json for {project_id} not found")

    color_space = (project.get("settings") or {}).get("colorSpace")
    if not color_space:
        raise bad_request("no_color_space", "Project has no settings.colorSpace")

    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    job = _IngestJob()
    job_id = uuid.uuid4().hex
    _ingest_jobs[job_id] = job
    task = asyncio.create_task(
        _run_ingest_detached(project_id, project_dir, path, color_space, broadcaster, job)
    )
    _ingest_task_refs.add(task)
    task.add_done_callback(_ingest_task_refs.discard)
    return JSONResponse({"job_id": job_id}, status_code=202)


@router.get("/projects/{project_id}/sources/status/{job_id}")
async def ingest_source_status(
    project_id: str,
    job_id: str,
    project_dir: Path = Depends(get_project_dir),
):
    """Poll the state of a detached footage-ingest job kicked by
    POST /sources. Pairs with that route the same way GET /captions/status
    pairs with POST /captions?async=1. 404 if job_id is unknown (never ran in
    this process, or the process restarted since)."""
    job = _ingest_jobs.get(job_id)
    if job is None:
        raise not_found("job_not_found", f"Ingest job '{job_id}' not found")
    out: dict = {"status": job.status, "phase": job.phase}
    if job.status == "done":
        out["result"] = job.result
    elif job.status == "error":
        out["error"] = job.error
    return out


def _probe_source_duration(path: str) -> float:
    """Run ffprobe against `path` and return its duration in seconds.

    Raises ValueError with a short human-readable reason on any failure (bad
    exit code, unparseable stdout, timeout, or a non-positive/non-finite
    value) — never swallows the reason, unlike project/init.py's
    `_probe_duration`, which is best-effort at import time and returns None
    on any failure. This is the retry path a human explicitly triggered, so
    the UI needs to say *why* it failed, and a 180s timeout (vs. init's 60s)
    is warranted: it replaces a probe that already timed out once at import,
    typically on a large/HDR source, and there's no batch budget to protect
    here.

    Kept as a bare, synchronous, monkeypatchable function — the route offloads
    it with `asyncio.to_thread` since ffprobe blocks.
    """
    try:
        r = subprocess.run(
            # "-v error", not "quiet": quiet silences stderr entirely, which
            # would make the reason-extraction below dead code — the UI needs
            # ffprobe's actual reason (e.g. "moov atom not found"), not just
            # an exit code. stdout still carries only the duration either way.
            [ffprobe_bin(), "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=180,
        )
    except subprocess.TimeoutExpired:
        raise ValueError("ffprobe timed out after 180s")
    except OSError as e:
        raise ValueError(f"ffprobe failed to start: {e}")
    if r.returncode != 0:
        stderr = (r.stderr or "").strip()
        reason = stderr.splitlines()[-1] if stderr else f"exit code {r.returncode}"
        raise ValueError(f"ffprobe failed: {reason}")
    try:
        value = float(r.stdout.strip())
    except (TypeError, ValueError):
        raise ValueError(f"ffprobe produced no usable duration ({r.stdout.strip()!r})")
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"ffprobe produced an invalid duration ({value})")
    return value


@router.post("/projects/{project_id}/sources/{source_id}/probe-duration")
async def probe_source_duration(
    project_id: str,
    source_id: str,
    request: Request,
    project_dir: Path = Depends(get_project_dir),
):
    """Re-run the duration probe on one source and backfill `sourceDuration`.

    A clip's sourceDuration is best-effort at import (project/init.py's
    _probe_duration returns None on a non-zero ffprobe exit or its 60s
    timeout), so an init-created clip can legitimately carry no
    sourceDuration. The footage bin lets such a card be dragged, but the
    timeline canvas drop handler rejects any payload whose sourceDuration
    isn't finite and > 0 — so the clip is otherwise unplaceable. This is
    that clip's backfill path: the UI offers a retry affordance, this route
    re-probes with a longer timeout and, on success, writes the value onto
    the `sources[]` entry AND its `tracks[]` twin (if the clip was already
    placed) via `_apply_project_edits`, persists project.json, and broadcasts
    the SSE frame — the same read-modify-write + broadcast path the other
    source mutations in this module use.

    Never 500s on an ordinary bad file (missing codec info, corrupt header,
    timeout) — those come back as 400 probe_failed with a short reason so the
    UI can render it.
    """
    project_path = project_dir / "project.json"
    try:
        project = json.loads(project_path.read_text())
    except Exception:
        raise not_found("project_not_found", f"project.json for {project_id} not found")

    source = next(
        (s for s in (project.get("sources") or [])
         if isinstance(s, dict) and s.get("id") == source_id),
        None,
    )
    if source is None:
        raise not_found("source_not_found", f"Source '{source_id}' not found")

    src = source.get("src")
    if not src:
        raise bad_request("source_has_no_src", f"Source '{source_id}' has no src")
    if not os.path.isfile(src):
        raise not_found("file_not_found", f"Source file is missing: {src}")

    try:
        duration = await asyncio.to_thread(_probe_source_duration, src)
    except ValueError as e:
        raise bad_request("probe_failed", str(e))

    # _apply_project_edits returns None in three cases: (1) the benign no-op
    # where the freshly probed value already matched what's on disk, (2) the
    # tmp+os.replace write raised OSError, or (3) a concurrent PUT re-pathed
    # the source out from under the (id, src) match. Only (1) is safe to
    # report as success — (2) and (3) probed a real value that never made it
    # to disk, which is the same silent-failure shape this feature exists to
    # fix. We already hold the pre-probe value, so we can tell them apart.
    result = _apply_project_edits(
        project_path, [(source_id, src, "sourceDuration", duration)]
    )
    if result is None and source.get("sourceDuration") != duration:
        raise server_error(
            "probe_write_failed",
            "Probed the duration but could not save it to project.json",
        )
    if result is not None:
        _, text = result
        broadcaster: SSEBroadcaster = request.app.state.broadcaster
        broadcaster.publish(project_id, _sse_data_frame(text))

    return {"id": source_id, "src": src, "sourceDuration": duration}


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
        project = json.loads(project_path.read_text())
        project_type = project.get("projectType", "")
    except Exception:
        project = {}
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

    # Optional JSON body: { "export": "auto"|"sdr"|"both", "sdrCurve": <curve id> }.
    # Absent/empty body → today's behavior (render.js's own defaults). Mirrors the
    # rerun route's tolerant-parse pattern above; a GET-style POST with no body is
    # not an error here.
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    export = body.get("export")
    if export is not None and export not in ("auto", "sdr", "both"):
        raise HTTPException(422, detail={
            "error": "invalid_argument",
            "message": f"export must be one of auto, sdr, both (got {export!r})",
        })
    sdr_curve = body.get("sdrCurve")
    if sdr_curve is not None and sdr_curve not in curve_ids():
        raise HTTPException(422, detail={
            "error": "invalid_argument",
            "message": f"sdrCurve must be one of {curve_ids()} (got {sdr_curve!r})",
        })

    # Optional output naming + poster-frame extraction. `name` picks the output
    # basename (sanitized — see _sanitize_output_name — so it can never escape
    # output_dir); `cover` is a timeline timestamp (seconds) to grab as a
    # sidecar JPEG once the render succeeds. Both are video-only (the carousel
    # branch below never sets output_path, so cover extraction is skipped for
    # carousels regardless of what's in the body).
    name = body.get("name")
    cover_raw = body.get("cover")
    cover: float | None = None
    if isinstance(cover_raw, (int, float)) and not isinstance(cover_raw, bool) and cover_raw >= 0:
        cover = float(cover_raw)

    # Carousel renders go through asset normalization first: any .webp image bed
    # is transcoded to a sibling .png and the renderer is handed a normalized copy
    # of project.json (the sidecar Chromium can't decode .webp). render_input ==
    # project_path when nothing needed normalizing; otherwise it's a throwaway temp
    # file cleaned up in the event_stream finally.
    render_input = project_path
    output_path: Path | None = None
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
        safe_name = _sanitize_output_name(name, project_dir.name) if isinstance(name, str) else project_dir.name
        output_path = output_dir / f"{safe_name}.mp4"
        if output_path.resolve().parent != output_dir.resolve():
            # Sanitization already forbids path separators, so this should be
            # unreachable — but never write outside output/ regardless.
            raise server_error("invalid_argument", "invalid output name")
        script_args = [str(project_path), "--out", str(output_path)]
        if export:
            script_args += ["--export", export]
        if sdr_curve:
            script_args += ["--sdr-curve", sdr_curve]
        # Snapshot the current project.json into git before kicking off the
        # detached render, so every export creates a recoverable version.
        # _git_commit_sync is no-op-safe on a clean tree, so back-to-back
        # renders don't spam the history. Carousel already commits on →final;
        # this covers the video path.
        run_count = project.get("runCount", 1)
        await asyncio.to_thread(_git_commit_sync, project_dir, f"version: run {run_count} — export")

    if not render_script.is_file():
        raise server_error("not_found", f"{render_script.name} not found")

    node_bin = shutil.which("node")
    if not node_bin:
        raise server_error("not_found", "node not found in PATH")

    env = os.environ.copy()
    env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)
    env["MONTAJ_FFMPEG"] = ffmpeg_bin()
    env["MONTAJ_FFPROBE"] = ffprobe_bin()

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
        _run_render_detached(project_id, cmd, env, render_input, project_path, job,
                             cover=cover, output_path=output_path)
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
                # --export both makes job.result a two-line blob (master path,
                # then the derived SDR sibling). The SSE 'done' frame carries only
                # the first (master) line — same outputPath compat contract as
                # the status route below — rather than an unescaped multi-line
                # value that would corrupt the wire format's line-oriented framing.
                first_path = job.result.splitlines()[0] if job.result else job.result
                yield f"event: done\ndata: {first_path}\n\n"
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
        # --export both prints two stdout lines (master, then derived SDR
        # sibling); outputPaths carries the full list, outputPath stays the
        # first line for back-compat with every existing single-path reader.
        paths = job.result.splitlines() or [job.result]
        out["outputPath"] = paths[0]
        out["outputPaths"] = paths
    elif job.status == "error":
        out["error"] = job.result
    return out


class CaptionPipelineError(Exception):
    """A caption pipeline step exited non-zero. `message` is the human-readable
    text the SSE path surfaces as an `event: error` frame (and a detached caller
    can record as the job's error)."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _merge_caption_theme(prev: dict, track: dict) -> dict:
    """Carry forward every prior caption-track key the pipeline didn't just
    regenerate, so a new theme field survives caption regeneration by default
    instead of by memory.

    This used to be a hand-maintained allowlist of five keys (position, color,
    fontsize, bgColor, accentColor). A hand-maintained list means every new
    caption field has to be remembered here separately — and twice it wasn't:
    the per-style accent colours (highlightColor/activeColor/backgroundColor
    for karaoke, pop, and subtitle) were dropped, and the whole text-styling
    set (fontFamily, googleFonts, fontWeight, textTransform, letterSpacing,
    lineHeight, textAlign) would have been silently discarded the day it
    shipped. Same bug class, same fix, as `montaj_assets/render/render.js`'s
    clip-field list (see CHANGELOG.md, "a clip field can no longer silently
    fail to reach the renderer"): copy everything, then call out only the
    fields that genuinely need special handling.

    `style` is excluded because the route resolves it separately (and it's
    already on the regenerated track). `segments` is excluded because they
    are the whole point of the regeneration. A value the pipeline itself
    produced on `track` always wins over the carried-forward one.
    """
    for k, v in prev.items():
        if k not in ("style", "segments") and k not in track:
            track[k] = v
    return track


async def _run_caption_pipeline(
    project_id: str,
    project_dir: Path,
    project: dict,
    model: str,
    language: str,
    style: str,
    *,
    broadcaster: "SSEBroadcaster",
    on_log=None,
    is_disconnected=None,
):
    """Core caption pipeline, shared by the SSE route and (later) a detached
    async caller. Runs build_audio_mix_spec → write mix spec → mix_timeline →
    transcribe → caption, then persists project["captions"] (carrying prior
    theme keys forward), writes project.json, and broadcasts the update.

    Returns the final caption `track` dict on success.

    Responsibility split: this coroutine owns ONLY the pipeline work. It does
    NOT reserve/release the `_active_caption_jobs` slot and does NOT unlink the
    temp files — those stay with each caller's surrounding scope (the SSE route
    keeps them in its `finally` for byte-for-byte identical browser behavior;
    M2's detached caller will manage its own slot + cleanup). This keeps the
    coroutine free of caller-specific lifecycle concerns.

    Logging: for each subprocess stderr line, calls `on_log(label, text)` if
    provided (plain callable) instead of yielding.

    Disconnect: when `is_disconnected` (an async predicate) is provided — the
    SSE path — it is polled per step and the process tree is killed on
    disconnect, returning None as a sentinel so the caller can stop quietly.
    When NOT provided — the detached path — no polling happens and the job runs
    to completion regardless of any client.

    Step failure raises CaptionPipelineError so the caller can surface
    `event: error` vs. a recorded job error.
    """
    project_path = project_dir / "project.json"

    mix_timeline_py = MONTAJ_ROOT / "steps" / "audio" / "mix_timeline.py"
    transcribe_py = MONTAJ_ROOT / "steps" / "speech" / "transcribe.py"
    caption_py = MONTAJ_ROOT / "steps" / "lyrics" / "caption.py"

    mix_spec_path = project_dir / "_caption_mix.json"
    mix_wav_path = project_dir / "_caption_mix.wav"
    words_prefix = project_dir / "_caption_words"
    words_json_path = project_dir / "_caption_words.json"
    track_path = project_dir / "_caption_track.json"

    env = os.environ.copy()
    env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)

    # 1. Derive the audible mix from the WHOLE timeline: every unmuted video
    #    item on every enabled visual track, plus every unmuted audio track,
    #    each at its own timeline position. Output time is timeline time, so
    #    word timings map 1:1 without any remapping downstream.
    mix_spec = build_audio_mix_spec(project)

    # 2. Write the mix spec.
    mix_spec_path.write_text(json.dumps(mix_spec))

    steps = [
        (
            "mix_timeline",
            [str(mix_timeline_py), "--input", str(mix_spec_path),
             "--out", str(mix_wav_path)],
        ),
        (
            "transcribe",
            [str(transcribe_py), "--input", str(mix_wav_path),
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

        tail = deque(maxlen=40)
        disconnected = False
        while True:
            if is_disconnected is not None and await is_disconnected():
                kill_tree()
                disconnected = True
                break
            line = await proc.stderr.readline()
            if not line:
                break
            text = line.decode().rstrip()
            if text:
                tail.append(text)
                if on_log is not None:
                    on_log(label, text)

        if disconnected:
            return None

        await proc.stdout.read()
        await proc.wait()

        if proc.returncode != 0:
            tail_text = "\n".join(tail)
            msg = f"{label} failed (exit {proc.returncode})"
            if tail_text:
                msg = f"{msg}\n--- stderr tail ---\n{tail_text}"
            broadcaster.publish(project_id, f"event: log\ndata: {json.dumps({'message': msg})}\n\n")
            raise CaptionPipelineError(msg)

    # Persist the caption track onto the project and broadcast.
    track = json.loads(track_path.read_text())
    prev = project.get("captions") or {}
    track = _merge_caption_theme(prev, track)
    project["captions"] = track
    text = json.dumps(project, indent=2)
    project_path.write_text(text)
    broadcaster.publish(project_id, _sse_data_frame(text))

    return track


@router.post("/projects/{project_id}/captions")
async def generate_captions(
    project_id: str,
    request: Request,
    body: dict = Body(default={}),
    project_dir: Path = Depends(get_project_dir),
):
    """Regenerate the project's captions from the timeline's AUDIBLE mix.
    Streams progress as SSE log/done/error events.

    Pipeline (all subprocesses, stderr streamed as `log` events):
      1. build_audio_mix_spec — every unmuted video item on every enabled
                           visual track, plus every unmuted audio track, each
                           positioned at its own timeline time.
      2. mix_timeline    — sum that into one 16 kHz mono WAV whose time IS
                           timeline time (gaps stay silent).
      3. transcribe      — multilingual, language-auto-detecting, OUTPUT-time
                           word timings (plain audio in, NOT a trim spec).
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

    # Temp paths the pipeline writes; mirrored here so the generator's `finally`
    # can unlink them (kept identical to the pipeline's own paths).
    mix_spec_path = project_dir / "_caption_mix.json"
    mix_wav_path = project_dir / "_caption_mix.wav"
    words_json_path = project_dir / "_caption_words.json"
    track_path = project_dir / "_caption_track.json"

    broadcaster: SSEBroadcaster = request.app.state.broadcaster

    # Async mode: kick a detached job and return 202 immediately. Clients poll
    # GET /captions/status to follow progress and pick up the track or error once
    # terminal. Default (no async flag) keeps the SSE stream for back-compat.
    if request.query_params.get("async") in ("1", "true"):
        _active_caption_jobs.add(project_id)
        job = _CaptionJob()
        _caption_jobs[project_id] = job
        task = asyncio.create_task(
            _run_caption_detached(project_id, project_dir, project, model, language, style, broadcaster, job)
        )
        _caption_task_refs.add(task)
        task.add_done_callback(_caption_task_refs.discard)
        return JSONResponse({"projectId": project_id, "status": "running"}, status_code=202)

    # Reserve the slot now; the generator's `finally` releases it (covers
    # success, error, and client-disconnect alike).
    _active_caption_jobs.add(project_id)

    async def event_stream():
        try:
            # Bridge the pipeline's on_log callback to `event: log` frames over a
            # queue, so each stderr line is yielded the instant it's read (same
            # real-time streaming as the old inline loop). The pipeline runs as a
            # task; we drain the queue concurrently and surface the result/error
            # once it finishes. The pipeline polls request.is_disconnected and
            # kills the process tree on disconnect, returning None as the
            # sentinel.
            queue: "asyncio.Queue[str]" = asyncio.Queue()

            def on_log(label, text):
                queue.put_nowait(f"event: log\ndata: [{label}] {text}\n\n")

            task = asyncio.ensure_future(_run_caption_pipeline(
                project_id,
                project_dir,
                project,
                model,
                language,
                style,
                broadcaster=broadcaster,
                on_log=on_log,
                is_disconnected=request.is_disconnected,
            ))

            # Drain log frames until the pipeline task completes, then flush any
            # remaining queued frames.
            while not task.done() or not queue.empty():
                if not queue.empty():
                    yield queue.get_nowait()
                    continue
                getter = asyncio.ensure_future(queue.get())
                done, _ = await asyncio.wait(
                    {getter, task}, return_when=asyncio.FIRST_COMPLETED
                )
                if getter in done:
                    yield getter.result()
                else:
                    getter.cancel()

            try:
                track = task.result()
            except ValueError as e:
                # build_audio_mix_spec rejected the project (nothing audible).
                yield f"event: error\ndata: {str(e)}\n\n"
                return
            except CaptionPipelineError as e:
                yield f"event: error\ndata: {e.message}\n\n"
                return
            except Exception as e:
                # Catch-all so the stream ALWAYS ends with a terminal frame.
                # Without this, any exception out of `_run_caption_pipeline`
                # that isn't one of the two typed cases above (an ffmpeg
                # subprocess crash, a bug in a pipeline step, ...) would
                # propagate out of this generator with no frame ever yielded —
                # the client's read loop would see the connection just close,
                # with no `done`/`error` frame to act on. `asyncio.CancelledError`
                # does not subclass `Exception` (Python 3.8+), so a disconnect
                # cancellation still propagates through here untouched, and the
                # `None` sentinel path below is a normal return value, not an
                # exception, so it is unaffected by this clause either. See
                # the matching client-side `sawTerminal` guard in
                # ui/src/lib/api.ts, which covers this same failure mode from
                # the other end.
                yield f"event: error\ndata: {str(e)}\n\n"
                return

            # None sentinel = client disconnected mid-pipeline; stop quietly.
            if track is None:
                return

            # Done — carry the caption track in the payload.
            yield f"event: done\ndata: {json.dumps(track)}\n\n"
        finally:
            _active_caption_jobs.discard(project_id)
            for _tmp in (
                mix_spec_path,
                mix_wav_path,
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


@router.get("/projects/{project_id}/captions/status")
async def captions_status(project_id: str, project_dir: Path = Depends(get_project_dir)):
    """Poll the state of the current/last detached caption job for this project.
    Pairs with the async kick (POST /captions?async=1): clients hit this to follow
    progress and pick up the caption track or error once terminal. Returns idle when
    no caption job has run for this project this process lifetime."""
    job = _caption_jobs.get(project_id)
    if job is None:
        return {"status": "idle"}
    out: dict = {"status": job.status}
    if job.status == "done":
        out["captions"] = job.result
    elif job.status == "error":
        out["error"] = job.error
    return out


@router.post("/projects/{project_id}/context", status_code=204)
async def report_context(
    project_id: str,
    body: dict = Body(...),
    project_dir: Path = Depends(get_project_dir),
):
    """The editor telling us where its playhead is.

    Deliberately ephemeral — nothing here is written to project.json and nothing
    is committed. The get_project_dir dependency is here purely to 404 an
    unknown project rather than silently accumulating context for one.
    """
    try:
        context_store.report(project_id, body)
    except ValueError as e:
        raise bad_request("invalid_context", str(e))


@router.get("/context")
async def read_active_context():
    """Whatever editor reported most recently, enriched against its project.

    Always 200. "No editor is open" is a normal answer to this question, not an
    error — a 404 here would read to a caller as "this endpoint is broken".
    """
    active = context_store.active()
    if active is None:
        return {"active": False, "reason": "no editor has reported recently"}

    project_id, state = active
    workspace = resolve_workspace()
    project_dir = find_project_dir(workspace, project_id)
    if project_dir is None:
        return {"active": False, "reason": f"project '{project_id}' is no longer in the workspace"}
    try:
        project = json.loads((project_dir / "project.json").read_text())
    except (OSError, ValueError):
        return {"active": False, "reason": f"project '{project_id}' could not be read"}

    if not isinstance(project, dict):
        return {"active": False, "reason": f"project '{project_id}' is not a readable project file"}

    return {"active": True, **context_store.enrich(project_id, project, state)}
