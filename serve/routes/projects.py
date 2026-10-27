"""POST /run and all /projects/{id}* endpoints, plus _git_commit_sync helper."""
import asyncio
import contextlib
import errno
import io
import json
import tempfile
import logging
import math
import mimetypes
import re
import uuid
import zipfile
import os
import secrets
import shutil
import subprocess
import sys
import time
from collections import deque
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Body, Depends, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from urllib.parse import quote, urlparse

from serve.common import (
    MONTAJ_ROOT,
    resolve_workspace, find_project_dir, get_project_dir, prime_project_dir_cache, is_nested_project_json,
    run_subprocess,
    not_found, bad_request, forbidden, server_error,
    validate_project_subpath, _is_under, lands_on_project_file,
)
from serve import context as context_store
from serve.caption_job import build_audio_mix_spec, caption_input_change, caption_input_fingerprint
from serve.caption_theme import sanitize_theme, seed_prev
from serve import provenance
from serve import save_guard
from lib import project_revisions
from serve.jobs import create_job, set_done, set_error, get_job
from serve.routes.files import drawable_upload, save_upload, upload_name
from serve.disk_full import STATUS as disk_full_status, child_disk_full, detail_for as disk_full_detail, workspace_root as disk_full_root
from lib.disk_space import DiskFull, is_disk_full
from lib.canvas import SOURCE_DEFAULT, SOURCE_EXPLICIT, SOURCE_FOOTAGE, canvas_for_footage, fps_from_rate, modal_dims
from lib.ingest import ingest_source
from lib.project_versions import GIT_SAFE_FLAGS, commit_version
from lib.fs_remove import rmtree_force
from lib import project_lock as _project_lock_mod
from lib.project_lock import ProjectLockTimeout, ProjectReadOnly, project_lock, project_lock_async, write_json_atomic
from lib.proc import kill_tree as _kill_tree, detached_kwargs as _detached_kwargs
from lib.overlay_validation import overlay_item_errors
from lib.audio_validation import audio_track_check
from lib.caption_translation import TranslationError, apply_show, apply_translation, show_new_language, finish_regenerated_track, is_translation, merge_caption_theme as _lib_merge_caption_theme, record_source_language
from lib.project_tracks import normalize_tracks, track_items
from lib.project_migrate import converge
from lib.item_ids import id_suffix
from lib.remote_io import fetch_to_disk_async, push_from_disk_async, parse_allowed_hosts
from lib.youtube import (
    DownloadProgress, classify_error, parse_montaj_line, parse_printed_path, parse_youtube_url, ytdlp_argv,
)
from project.init import _copy_into_workspace
from serve.save_media import (
    apply_borrowed_media, begin_copies, borrowed_from, copy_borrowed_media, forget_pending, pending_media,
    plan_borrowed_media,
    project_deleting, project_gone, retry_later, settle_copies, sweep_stale_temps,
)
from serve.sse import SSEBroadcaster, sse_stream

from lib.common import SAFE_NAME as _SAFE_NAME, DEFAULT_WHISPER_MODEL, ffmpeg_bin, ffprobe_bin, node_child_env, whisper_model_missing, ff_path
from lib.look import curve_ids
from lib.profile_assets import FILENAME_RE, NAME_RE
from lib.types.kling import ASPECT_RATIOS, is_valid_aspect_ratio
from lib.types.carousel import CAROUSEL_ASPECTS
from lib.types.colorspace import ALL_COLOR_SPACES
from lib.workflow import read_workflow
from lib.normalize import SEEK_PREROLL_S
from cli.deps import render_runtime_dir
from project.carousel_normalize import normalize_carousel_assets

logger = logging.getLogger(__name__)

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
    _kill_tree(proc)


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

# How many trailing stderr lines a failed render reports back. The whole log can
# run to thousands of ffmpeg/Puppeteer lines; the cause is essentially always at
# the end, and this travels through the Hub proxy to an agent's context window.
_RENDER_LOG_TAIL = 40

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
    missing thumbnail.

    Two-stage seek (PV48 T3, see SEEK_PREROLL_S): the finished render is our
    own HDR output when the project's color space is HDR, which is open-GOP
    HEVC (libx265 default GOP) — a plain input seek (`-ss cover -i`) into a
    keyframe's leading-picture window returns the keyframe instead of the
    frame at ``cover`` (1-3 frames late, measured PV48 T3 audit). ``cover``
    is caller-supplied and arbitrary (not rounded), so it is routinely at
    risk. Same pattern as ``lib/color_provenance.py``'s ``_thumbnails``: seek
    ``near`` at the input (fast) when it is a positive number of seconds,
    then finish the remaining ``cover - near`` seconds as an output-side
    ``-ss`` before ``-frames:v 1`` — exact, and still cheap since ffmpeg
    decodes and discards only up to the target, not the whole file."""
    cover_path = output_path.with_suffix(".jpg")
    try:
        near = max(0.0, cover - SEEK_PREROLL_S)
        cmd = [
            ffmpeg_bin(), "-y",
            *(["-ss", f"{near:.6f}"] if near > 0 else []),
            "-i", str(output_path),
            "-ss", f"{cover - near:.6f}",
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
            **_detached_kwargs(),   # process-group leader so kill_tree reaches ffmpeg grandchildren
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
                # sdr_derive is the last phase before done. The SDR rendition
                # is a compose of its own (PV42), so its "concatenating" line
                # would otherwise walk the stepper back to encoding.
                if p and job.phase != "sdr_derive":
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
    __slots__ = ("status", "result", "error", "detail")

    def __init__(self) -> None:
        self.status: str = "running"   # running | done | error
        self.result: dict | None = None  # caption track dict (done)
        self.error: str | None = None    # error message (error)
        self.detail: dict | None = None  # the structured refusal, when the error is one (§477)


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
    theme: dict = None,
    who=None,
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
            theme=theme,
            who=who,
        )
        job.status, job.result = "done", track
    except CaptionPipelineError as e:
        job.status, job.error = "error", e.message
        job.detail = e.detail
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
    __slots__ = ("status", "phase", "result", "error", "code", "needed", "free")

    def __init__(self) -> None:
        self.status: str = "running"     # running | done | error
        self.phase: str = "staging"      # staging | normalizing | building proxy | done
        self.result: dict | None = None  # appended clip dict (done)
        self.error: str | None = None    # error message (error)
        # §541: "disk_full" (with the numbers) when the error is a full disk; else None.
        self.code: str | None = None
        self.needed: int | None = None
        self.free: int | None = None


_ingest_jobs: dict[str, _IngestJob] = {}


class _IngestRefused(Exception):
    """The clip's landing was refused (§482, an open Studio sync clash): the job's error is the message."""

# Strong refs to in-flight detached ingest tasks. asyncio only weakly tracks
# fire-and-forget tasks, so without this an ingest task could be GC'd mid-run.
_ingest_task_refs: set = set()

# `clip-<N>` (init, older imports) and `clip-<N>-<6 hex>` (an import since §482).
_CLIP_ID_RE = re.compile(r"^clip-(\d+)(?:-[0-9a-f]{6})?$")


def _next_clip_id(project: dict) -> str:
    """A ``clip-<N>-<6 hex>`` id guaranteed not to collide with any existing
    source or timeline-item id. Scans both project["sources"] and every
    track's items (a placed clip shares its source's id, and a future
    placement of THIS new clip must not collide with it either) — mirrors the
    max+1 `asset-<N>` allocation in include_profile_asset below.

    N is max+1 over both forms, so a number is never reused. The random part
    is §482's: two copies of one project each importing a clip into the same
    base must not both mint ``clip-<N>`` (lib/item_ids.py)."""
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
    return f"clip-{max_n + 1}-{id_suffix()}"


async def _record_source_provenance(project_dir, clip: dict, entry: dict, log) -> None:
    """POST /sources's provenance entry, for each file the clip stores: `src`, and
    `normalizedSrc` when there is one. Best effort: a record that cannot be
    written is logged and never fails the ingest."""
    paths = [clip.get("src"), clip.get("normalizedSrc")]
    for path in dict.fromkeys(p for p in paths if isinstance(p, str) and p):
        try:
            await asyncio.to_thread(provenance.record_provenance, project_dir, path, entry)
        except Exception as e:
            log(f"[ingest] provenance not recorded for {os.path.basename(path)}: {e}")


async def _run_ingest_detached(
    project_id: str,
    project_dir: "Path",
    path: str,
    color_space: str,
    broadcaster: "SSEBroadcaster",
    job: "_IngestJob",
    provenance_entry: dict | None = None,
    who=None,
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
        async with project_lock_async(project_path):
            raw = project_path.read_text()
            project = json.loads(raw)
            clip = {"id": _next_clip_id(project), **clip}
            project.setdefault("sources", []).append(clip)
            # §482: checked again as the request's writer, for a clash recorded while it ran.
            refused = save_guard.maintenance_refusal(raw, project, who)
            if refused is not None:
                raise _IngestRefused(refused["message"])
            text = _write_project_json(project_path, project)
        broadcaster.publish(project_id, _sse_data_frame(text))
        if provenance_entry is not None:
            await _record_source_provenance(project_dir, clip, provenance_entry, log)

        # Only now the clip is on disk under a stable (id, src) can the encode's
        # write-back find it. A bin entry on no track is a first-class target:
        # `_look_migration_items` walks `sources` too. Best-effort — the clip is
        # already usable, and the editor's manual migration is the fallback.
        job.phase = "queueing proxy"
        try:
            await _warm_proxy_inputs(_video_srcs(project))
            swept = await _ensure_current_proxies_async(project_id, Path(project_dir), project, broadcaster)
            queued = swept["scheduled"]
            # `queued` counts every un-proxied item in the project, not just the
            # one just ingested: _ensure_current_proxies sweeps the whole thing,
            # so adding one clip to an AV1-era project legitimately starts many
            # encodes. Say the real number rather than implying it was one.
            # A clip skipped because it could not be read (PV57) is not "no
            # proxy needed": that case keeps the line it had before the skip
            # existed, when the ProbeError reached the except below.
            if queued:
                log(f"[ingest] {queued} proxy encode(s) queued")
            elif swept.get("probeFailed"):
                log("[ingest] proxy could not be queued")
            else:
                log("[ingest] no proxy needed")
        except Exception:
            log("[ingest] proxy could not be queued")

        job.status, job.result, job.phase = "done", clip, "done"
        log(f"[ingest] added {clip['id']}")
    except Exception as e:
        if isinstance(e, DiskFull) or is_disk_full(e):
            # §541: one plain sentence and the numbers, never the errno text.
            full = disk_full_detail(e)
            job.status, job.error, job.code = "error", full["message"], full["error"]
            job.needed, job.free = full["needed"], full["free"]
            log(f"[ingest] failed: {full['message']}")
            return
        job.status, job.error = "error", str(e)
        log(f"[ingest] failed: {e}")


# ---------------------------------------------------------------------------
# YouTube source download (PL28)
#
# `POST /run` with `clipUrls` creates the project at once with an empty
# timeline and a top-level `sourceDownload` record, then downloads the video
# here, in a detached task, and adds the clip as init would have. Serve is the
# only writer of the record:
#
#   {"kind": "youtube", "url", "status": "downloading", "jobId", "percent"?}
#   {"kind": "youtube", "url", "status": "done", "clipId"}
#   {"kind": "youtube", "url", "status": "failed", "error": <code>}
#
# §51: `percent` (0-99, never back) appears once yt-dlp reports progress, a
# project with no name takes the video's title, and
# `POST /projects/{id}/source-download/retry` starts a failed one again.
#
# `jobId` is a serve/jobs.py job, so `GET /api/steps/jobs/{jobId}` (what the
# MCP `get_step_result` polls) answers `done` with the clip or `error` with
# `{"error": <code>, "message"}`. The registry is in-process: after a serve
# restart the record still says `downloading`, and `GET /projects/{id}`
# (`_ensure_source_download`) restarts the task under a new `jobId`.
# ---------------------------------------------------------------------------

# One live task per project, and its running yt-dlp (so DELETE and shutdown
# can kill it: a POSIX kill of serve does not take its own children along).
_source_download_tasks: dict[str, "asyncio.Task"] = {}
_source_download_procs: dict[str, "asyncio.subprocess.Process"] = {}

# Last bytes of yt-dlp's output kept for the classifier. The printed path, the
# max-filesize notice and the ERROR lines are all at the end; the progress
# lines before them can run to megabytes on a long video.
_YTDLP_TAIL_BYTES = 256 * 1024
# §51: `percent` is written (and broadcast) at most this often.
_PERCENT_WRITE_INTERVAL_S = 1.0

_SOURCE_DOWNLOAD_MESSAGES = {
    "unavailable": "This video can't be downloaded: it is private, removed, age-restricted, members-only or not available in this region.",
    "blocked": "YouTube blocked the download. Try again later.",
    "offline": "No internet connection.",
    "too_long": "The video is longer than 3 hours, or is a live stream.",
    "too_large": "The video is larger than 4 GB.",
    "no_space": "Not enough disk space.",
    "failed": "The download failed.",
}


def _parse_clip_urls(raw, clips, remote_clips) -> dict | None:
    """`POST /run`'s `clipUrls`: None when absent or empty, else the one parsed
    link (`lib.youtube.parse_youtube_url`). Raises the 400s."""
    if raw is None or raw == []:
        return None
    if not isinstance(raw, list):
        raise bad_request("invalid_field", "'clipUrls' must be a list of links")
    if len(raw) > 1:
        raise bad_request("invalid_clip_url", "'clipUrls' takes one link")
    if clips or remote_clips:
        raise bad_request("mutually_exclusive", "Send either 'clipUrls' or clips, not both")
    parsed = parse_youtube_url(raw[0])
    if not parsed["ok"]:
        if parsed["reason"] == "shorts":
            raise bad_request("invalid_clip_url", "Shorts links are not supported")
        raise bad_request("invalid_clip_url", "Not a YouTube watch or youtu.be link")
    return parsed


def _write_project_json(project_path: Path, project: dict) -> str:
    """tmp + os.replace under a temp name of its own (pid + random), with the
    PermissionError retry (lib/project_lock.write_json_atomic). Callers that read
    project.json first hold `project_lock` from their read to this write (§467).
    Returns the text written."""
    return write_json_atomic(project_path, project)


def _start_source_download(
    project_id: str,
    project_dir: Path,
    url: str,
    video_id: str,
    broadcaster: "SSEBroadcaster | None" = None,
    *,
    resume: bool = False,
    who=None,
) -> dict | None:
    """Write a `downloading` record under a new `jobId` and start the task.
    Returns the project as written, or None when nothing was started.

    §482: nothing starts while a field the download writes (SOURCE_DOWNLOAD_FIELDS)
    is in an open Studio sync clash, for anyone but `who` when it is a person; the
    record stays as it is and the next open starts it.

    Synchronous on purpose: the live-task check, the read, the write and the
    task's registration happen with no await between, so two callers (two
    GETs, or a GET racing the create) start one task. With `resume`, the
    record on disk must still be `downloading` for this link."""
    live = _source_download_tasks.get(project_id)
    if live is not None and not live.done():
        return None
    project_path = Path(project_dir) / "project.json"
    with project_lock(project_path):
        try:
            project = json.loads(project_path.read_text())
        except (OSError, ValueError):
            return None
        if resume:
            current = project.get("sourceDownload")
            if not isinstance(current, dict) or current.get("status") != "downloading" or current.get("url") != url:
                return None
        if save_guard.sync_refusal(project_id, who if who is not None else save_guard.MAINTENANCE,
                                   SOURCE_DOWNLOAD_FIELDS) is not None:
            return None
        job_id = create_job()
        project["sourceDownload"] = {"kind": "youtube", "url": url, "status": "downloading", "jobId": job_id}
        try:
            text = _write_project_json(project_path, project)
        except (OSError, ProjectReadOnly) as e:
            set_error(job_id, {"error": "failed", "message": str(e)})
            return None
    task = asyncio.create_task(
        _run_source_download(project_id, Path(project_dir), url, video_id, job_id, broadcaster)
    )
    _source_download_tasks[project_id] = task

    def _forget(t: "asyncio.Task") -> None:
        if _source_download_tasks.get(project_id) is t:
            del _source_download_tasks[project_id]

    task.add_done_callback(_forget)
    if broadcaster is not None:
        broadcaster.publish(project_id, _sse_data_frame(text))
    return project


# What a YouTube source download writes, from its record to the clip it lands (§482).
SOURCE_DOWNLOAD_FIELDS = ("sourceDownload", "sources", "tracks", "name")


def _ensure_source_download(
    project_id: str,
    project_dir: Path,
    project: dict,
    broadcaster: "SSEBroadcaster | None" = None,
) -> dict:
    """`GET /projects/{id}`'s hook: a record still `downloading` with no live
    task (serve restarted, or a stale editor save put it back) gets a new
    `jobId` and a new task. With a live task, the response carries the record
    on disk, so it names the live `jobId`. Never raises: a project must always
    open."""
    try:
        record = project.get("sourceDownload")
        if not isinstance(record, dict) or record.get("status") != "downloading":
            return project
        live = _source_download_tasks.get(project_id)
        if live is not None and not live.done():
            on_disk = json.loads((Path(project_dir) / "project.json").read_text()).get("sourceDownload")
            return {**project, "sourceDownload": on_disk} if isinstance(on_disk, dict) else project
        parsed = parse_youtube_url(record.get("url"))
        if not parsed["ok"]:
            return project
        started = _start_source_download(
            project_id, project_dir, record["url"], parsed["id"], broadcaster, resume=True,
        )
        if started is None:
            return project
        return {**project, "sourceDownload": started["sourceDownload"]}
    except Exception:
        return project


async def _spawn_ytdlp(argv: list[str]) -> "asyncio.subprocess.Process":
    """yt-dlp in its own process group, so `_kill_tree` takes its ffmpeg merge
    child too. The seam the tests replace; nothing here touches the network."""
    return await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        **_detached_kwargs(),
    )


async def _read_tail(stream, limit: int = _YTDLP_TAIL_BYTES, on_line=None) -> str:
    """Drain `stream` to EOF, keeping only its last `limit` bytes. With
    `on_line`, each line (ended by \\n or \\r: yt-dlp rewrites its progress
    line with \\r) is handed to it as it arrives; a raising callback is ignored."""
    if stream is None:
        return ""
    buf = bytearray()
    pending = bytearray()
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            break
        buf += chunk
        if len(buf) > limit:
            del buf[:-limit]
        if on_line is None:
            continue
        pending += chunk
        *lines, rest = re.split(rb"[\r\n]", bytes(pending))
        pending = bytearray(rest[-limit:])
        for line in lines:
            if line:
                try:
                    on_line(line.decode("utf-8", errors="replace"))
                except Exception:
                    pass
    if on_line is not None and pending:
        try:
            on_line(pending.decode("utf-8", errors="replace"))
        except Exception:
            pass
    return buf.decode("utf-8", errors="replace")


def _update_downloading_record(project_dir: Path, job_id: str, change) -> str | None:
    """Read, `change(project, record)`, write: only while the record is still
    this job's download, and only when `change` returns True. Synchronous, so
    no await falls between the read and the write. Returns the text written."""
    project_path = Path(project_dir) / "project.json"
    with project_lock(project_path):
        try:
            raw = project_path.read_text()
            project = json.loads(raw)
        except (OSError, ValueError):
            return None
        record = project.get("sourceDownload")
        if not isinstance(record, dict) or record.get("status") != "downloading" or record.get("jobId") != job_id:
            return None
        if not change(project, record):
            return None
        if not save_guard.maintenance_allows(raw, project):   # §482: skipped while clashed
            return None
        try:
            return _write_project_json(project_path, project)
        except (OSError, ProjectReadOnly):
            return None


_line_update_tasks: set = set()


def _schedule_record_update(project_dir: Path, job_id: str, change, publish) -> None:
    """The line handler runs inside a stream-reader callback, which cannot
    await: hand the write to a small task that takes the async lock first, so
    a busy lock never blocks the event loop. A lock that stays busy drops this
    update (the next progress line writes a newer one)."""
    async def run():
        try:
            async with project_lock_async(Path(project_dir) / "project.json"):
                text = _update_downloading_record(project_dir, job_id, change)
        except ProjectLockTimeout:
            return
        except Exception:
            return
        publish(text)

    try:
        task = asyncio.get_running_loop().create_task(run())
    except RuntimeError:
        return   # no event loop (never in serve): nothing to write from here
    _line_update_tasks.add(task)
    task.add_done_callback(_line_update_tasks.discard)


def _source_download_line_handler(project_id: str, project_dir: Path, job_id: str,
                                  broadcaster: "SSEBroadcaster | None", *, clock=time.monotonic):
    """§51: what yt-dlp prints, as it prints it. The title names a project
    that has none; progress sets the record's `percent` (rising, at most once
    per _PERCENT_WRITE_INTERVAL_S)."""
    progress = DownloadProgress()
    last = {"at": None, "percent": None}

    def publish(text):
        if text is not None and broadcaster is not None:
            broadcaster.publish(project_id, _sse_data_frame(text))

    def name_it(title):
        def change(project, _record):
            if isinstance(project.get("name"), str) and project["name"].strip():
                return False
            project["name"] = title
            return True
        _schedule_record_update(project_dir, job_id, change, publish)

    def set_percent(pct):
        def change(_project, record):
            if record.get("percent") == pct:
                return False
            record["percent"] = pct
            return True
        _schedule_record_update(project_dir, job_id, change, publish)

    def on_line(line):
        event = parse_montaj_line(line)
        if event is None:
            return
        if event[0] == "title":
            name_it(event[1])
        elif event[0] == "size":
            progress.size(event[1])
        elif event[0] == "progress":
            pct = progress.update(event[1], event[2])
            now = clock()
            if last["percent"] is not None and pct <= last["percent"]:
                return
            if last["at"] is not None and now - last["at"] < _PERCENT_WRITE_INTERVAL_S:
                return
            last["at"], last["percent"] = now, pct
            set_percent(pct)

    return on_line


def _kill_source_download_proc(proc) -> None:
    if proc is None or proc.returncode is not None:
        return
    try:
        _kill_tree(proc)
    except Exception:
        pass


def _same_path(a: str, b: str) -> bool:
    return a == b or os.path.realpath(a) == os.path.realpath(b)


async def _run_source_download(
    project_id: str,
    project_dir: Path,
    url: str,
    video_id: str,
    job_id: str,
    broadcaster: "SSEBroadcaster | None",
) -> None:
    """Download to `<project_dir>/youtube-<id>.mp4` (deterministic, so a
    restart resumes the partial with `--continue`; an existing complete file
    skips yt-dlp), then finalize. A cancel (DELETE, shutdown) kills yt-dlp and
    writes nothing, so after a quit the record still says `downloading`."""
    proc = None
    try:
        target = project_dir / f"youtube-{video_id}.mp4"
        path = str(target) if target.is_file() else None
        if path is None:
            proc = await _spawn_ytdlp(ytdlp_argv(url, project_dir, video_id))
            _source_download_procs[project_id] = proc
            on_line = _source_download_line_handler(project_id, project_dir, job_id, broadcaster)
            stdout, stderr = await asyncio.gather(_read_tail(proc.stdout, on_line=on_line), _read_tail(proc.stderr))
            returncode = await proc.wait()
            # The file path comes from the printed line only: with --no-quiet
            # stdout is also yt-dlp's log, and a duration or size skip exits 0.
            code = classify_error(returncode, stdout, stderr)
            if code is None:
                path = parse_printed_path(stdout)
                if not path or not os.path.isfile(path):
                    code, path = "failed", None
            if code is not None:
                await _fail_source_download_patiently(
                    project_id, project_dir, url, video_id, job_id, code, broadcaster, remove_partials=True)
                return
        await _finalize_source_download(project_id, project_dir, url, path, job_id, broadcaster)
    except asyncio.CancelledError:
        _kill_source_download_proc(proc)
        raise
    except Exception as e:
        # A finalize that failed on a complete file keeps the file (a clip
        # already in `sources` may point at it); only yt-dlp's failures above
        # remove what it wrote.
        await _fail_source_download_patiently(
            project_id, project_dir, url, video_id, job_id, "failed", broadcaster,
            remove_partials=False, message=str(e))
    finally:
        if proc is not None and _source_download_procs.get(project_id) is proc:
            del _source_download_procs[project_id]


async def _finalize_source_download(
    project_id: str,
    project_dir: Path,
    url: str,
    path: str,
    job_id: str,
    broadcaster: "SSEBroadcaster | None",
) -> None:
    """Add the downloaded file as init would have, once.

    Idempotent, keyed by the file's path: a source already at this `src` is
    reused (a stale save can put the record back to `downloading` after a
    finalize, and the next open runs this again). A new clip goes to `sources`
    and, only while the project is `pending` (the agent's lifecycle), to
    `tracks[0].items` in init's shape. Read to write with no await between, as
    `_run_ingest_detached`, so a concurrent PUT cannot interleave."""
    project_path = project_dir / "project.json"
    settings = json.loads(project_path.read_text()).get("settings") or {}
    color_space = settings.get("colorSpace") or "sdr_bt709"
    # Lazy always: the H.264 SDR download fits the default SDR project, and
    # export conforms anything else inline. The proxy is queued below.
    clip = await asyncio.to_thread(ingest_source, str(project_dir), path, color_space, "lazy", proxy=False)

    async with _patient_lock(project_path):
        try:
            raw = project_path.read_text()
            project = json.loads(raw)
        except (OSError, ValueError):
            return  # deleted meanwhile
        sources = project.get("sources")
        if not isinstance(sources, list):
            sources = project["sources"] = []
        existing = next((s for s in sources if isinstance(s, dict) and isinstance(s.get("src"), str)
                         and _same_path(s["src"], clip["src"])), None)
        if existing is not None:
            clip = existing
        else:
            clip = {"id": _next_clip_id(project), **clip}
            sources.append(clip)
            if project.get("status") == "pending":
                tracks = project.get("tracks")
                if not isinstance(tracks, list) or not tracks:
                    tracks = project["tracks"] = [{"id": "trk-0", "items": []}]
                first = tracks[0]
                if isinstance(first, dict):
                    first.setdefault("items", []).append(dict(clip))
                elif isinstance(first, list):
                    first.append(dict(clip))
        project["sourceDownload"] = {"kind": "youtube", "url": url, "status": "done", "clipId": clip["id"]}
        refused = save_guard.maintenance_refusal(raw, project)
        if refused is None:
            text = _write_project_json(project_path, project)
    if refused is not None:
        # §482: a field it lands in is in an open Studio sync clash. The record stays `downloading`, so the
        # next open after the clash closes lands it (the file is kept).
        set_error(job_id, refused)
        return
    if broadcaster is not None:
        broadcaster.publish(project_id, _sse_data_frame(text))
    # Where the file came from (serve/provenance.py). Best-effort, like the proxy below.
    try:
        await asyncio.to_thread(provenance.record_provenance, project_dir, clip["src"],
                                {"kind": "web", "via": "youtube", "sourceUrl": url})
    except Exception as e:
        logger.warning("source download: provenance not recorded for %s: %s", clip.get("src"), e)

    # The proxy, as `_run_ingest_detached`: queued only once the clip is on
    # disk under its (id, src). Best-effort.
    try:
        await _warm_proxy_inputs(_video_srcs(project))
        await _ensure_current_proxies_async(project_id, project_dir, project, broadcaster)
    except Exception:
        pass
    # The canvas and fps follow this first footage. Never raises.
    await ensure_source_dims(project_id, project_dir, project, broadcaster)
    set_done(job_id, clip)


def _fail_source_download(
    project_id: str,
    project_dir: Path,
    url: str,
    video_id: str,
    job_id: str,
    code: str,
    broadcaster: "SSEBroadcaster | None",
    *,
    remove_partials: bool,
    message: str | None = None,
) -> None:
    if remove_partials:
        for partial in project_dir.glob(f"youtube-{video_id}.*"):
            try:
                if partial.is_file():
                    partial.unlink()
            except OSError:
                pass
    project_path = project_dir / "project.json"
    with project_lock(project_path):
        try:
            raw = project_path.read_text()
            project = json.loads(raw)
            project["sourceDownload"] = {"kind": "youtube", "url": url, "status": "failed", "error": code}
            # §482: `sourceDownload` in an open Studio sync clash keeps `downloading` (it resumes at an open).
            text = _write_project_json(project_path, project) if save_guard.maintenance_allows(raw, project) else None
        except (OSError, ValueError, ProjectReadOnly):
            text = None
    if text is not None and broadcaster is not None:
        broadcaster.publish(project_id, _sse_data_frame(text))
    set_error(job_id, {"error": code, "message": message or _SOURCE_DOWNLOAD_MESSAGES.get(code, _SOURCE_DOWNLOAD_MESSAGES["failed"])})


async def _cancel_source_download(project_id: str) -> None:
    """Stop a project's download (DELETE): cancel the task first, so the
    killed yt-dlp is not read as a failure, then kill it and wait for both."""
    task = _source_download_tasks.pop(project_id, None)
    proc = _source_download_procs.pop(project_id, None)
    if task is not None and not task.done():
        task.cancel()
    _kill_source_download_proc(proc)
    if task is not None:
        await asyncio.wait({task}, timeout=5)
    if proc is not None:
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except Exception:
            pass


def kill_source_downloads() -> None:
    """Serve shutdown: cancel every download task, then kill its yt-dlp. The
    records stay `downloading`, so each resumes when its project is opened."""
    for task in list(_source_download_tasks.values()):
        task.cancel()
    for proc in list(_source_download_procs.values()):
        _kill_source_download_proc(proc)


@router.post("/projects/{project_id}/source-download/retry")
async def retry_source_download(project_id: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    """§51: start a failed YouTube download again, from the link in its
    record, under a new `jobId`. 409 `not_failed` unless the record is
    `failed`. Answers `{"sourceDownload": <the downloading record>}`."""
    try:
        project = json.loads((project_dir / "project.json").read_text())
    except (OSError, ValueError):
        raise not_found("not_found", "Project not found")
    record = project.get("sourceDownload")
    if not isinstance(record, dict) or record.get("status") != "failed":
        raise HTTPException(409, detail={"error": "not_failed", "message": "Only a failed download can be tried again."})
    parsed = parse_youtube_url(record.get("url"))
    if not parsed["ok"]:
        raise bad_request("invalid_clip_url", "The download's link is not a YouTube watch or youtu.be link")
    # The record is read again under the lock (the first read was before it, and a
    # lock wait is an await): it must still be the failed one.
    async with project_lock_async(project_dir / "project.json"):
        try:
            record = json.loads((project_dir / "project.json").read_text()).get("sourceDownload")
        except (OSError, ValueError):
            raise not_found("not_found", "Project not found")
        if not isinstance(record, dict) or record.get("status") != "failed":
            raise HTTPException(409, detail={"error": "not_failed", "message": "Only a failed download can be tried again."})
        parsed = parse_youtube_url(record.get("url"))
        if not parsed["ok"]:
            raise bad_request("invalid_clip_url", "The download's link is not a YouTube watch or youtu.be link")
        # §482: what the download writes, in an open Studio sync clash.
        who = save_guard.sync_who(getattr(request, "headers", None))
        save_guard.check_sync(who, project_id, SOURCE_DOWNLOAD_FIELDS)
        started = _start_source_download(project_id, project_dir, record["url"], parsed["id"],
                                         request.app.state.broadcaster, who=who)
    if started is None:
        raise HTTPException(409, detail={"error": "not_failed", "message": "This download is already running."})
    return {"sourceDownload": started["sourceDownload"]}


OVERLAY_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
# Overlay JSX is code, not media, but a Hub template's stage component is not
# small: the 3D templates' model3d_stage.jsx is about 80 KB, and the old 64 KB
# cap answered their install with a 413. 512 KB leaves room for that and still
# rejects anything that is plainly not a component.
OVERLAY_MAX_BYTES = 524_288


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
    commit_version(project_dir, message)


_TIMING_PREFIX = "MONTAJ_TIMING "
_TIMING_PHASES = ("git_init", "copy", "probe", "git_commit", "write")


def _last_json_error(text: str) -> dict | None:
    """The last `{"error": ...}` line in a child's stderr (progress lines
    come before it), or None."""
    for line in reversed((text or "").strip().splitlines()):
        try:
            parsed = json.loads(line)
        except Exception:
            continue
        if isinstance(parsed, dict) and "error" in parsed:
            return parsed
    return None


def _set_server_timing(response: Response, value: str | None) -> None:
    if value:
        response.headers["Server-Timing"] = value


def _split_init_timing(stderr: str) -> tuple[str, dict | None]:
    """Remove init's MONTAJ_TIMING line from stderr; return (stderr, parsed or None).

    Malformed lines are dropped too and parse to None, so a bad line never
    reaches an error message or breaks the route. Values are kept only as ints.
    """
    kept: list[str] = []
    timing = None
    for line in stderr.splitlines(keepends=True):
        if not line.startswith(_TIMING_PREFIX):
            kept.append(line)
            continue
        try:
            raw = json.loads(line[len(_TIMING_PREFIX):])
            total = raw["total"]
            phases = raw.get("phases", {})
            if isinstance(total, bool) or not isinstance(total, (int, float)):
                raise ValueError
            parsed = {"total": int(total), "phases": {}}
            for k in _TIMING_PHASES:
                v = phases.get(k) if isinstance(phases, dict) else None
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    parsed["phases"][k] = int(v)
            timing = parsed
        except Exception:
            timing = None
    return "".join(kept), timing


def _server_timing_header(timings: dict) -> str | None:
    """Server-Timing value from {"spawn": ms, "init": {...} | None}. Durations only."""
    parts: list[str] = []
    spawn = timings.get("spawn")
    init = timings.get("init")
    if spawn is not None:
        parts.append(f"spawn;dur={int(spawn)}")
    if init:
        parts.append(f"init;dur={init['total']}")
        if spawn is not None:
            parts.append(f"startup;dur={max(0, int(spawn) - init['total'])}")
        for k in _TIMING_PHASES:
            if k in init["phases"]:
                parts.append(f"{k};dur={init['phases'][k]}")
    return ", ".join(parts) or None


async def _run_init_subprocess(
    cmd: list[str],
    *,
    timeout: int = 1800,
    broadcaster: "SSEBroadcaster | None" = None,
    background_normalize: bool = False,
    timings: dict | None = None,
) -> dict:
    """Spawn project/init.py via subprocess, capture stdout (project path), and
    return the parsed project.json dict. Raises HTTPException on any failure.

    `background_normalize`: init ran lazy on serve's behalf (no transcode), so
    the colour conversions eager mode would have done inline are queued here,
    after the proxies. See `_ensure_background_normalize`.

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
    spawn_started = time.perf_counter()

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

    # Init's own timing line comes off stderr before anything reads it, so it
    # can never show up inside an error message.
    stderr, init_timing = _split_init_timing(stderr)
    if timings is not None:
        timings["spawn"] = int(round((time.perf_counter() - spawn_started) * 1000.0))
        timings["init"] = init_timing

    if returncode != 0:
        try:
            err = json.loads(stderr)
        except Exception:
            err = _last_json_error(stderr) or {"error": "init_failed", "message": stderr.strip()}
        # §541: a full disk is the 507 with one plain sentence: init's own
        # disk_full, or an older init's traceback that says so. Never the text.
        full = child_disk_full(err, stderr, disk_full_root())
        if full is not None:
            raise HTTPException(disk_full_status, detail=full)
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
        await _warm_proxy_inputs(_video_srcs(project))
        await _ensure_current_proxies_async(project.get("id"), project_path.parent, project, broadcaster)
    except Exception:
        pass

    # Queued AFTER the proxies on purpose: the queue is FIFO and single-worker,
    # so every clip gets a fast preview first and the conversions (minutes each
    # at 4K) run behind them.
    if background_normalize:
        try:
            project = await _ensure_background_normalize(
                project.get("id"), project_path.parent, project, broadcaster, created=True,
            ) or project
        except Exception:
            pass

    return project


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/run", status_code=201)
async def run_project(request: Request, response: Response, body: dict = Body(...)):
    """Create a project by invoking project/init.py, and stream its progress.

    Init settings are accepted under two body keys:

    - ``initSettings`` — the current spelling. Keys: ``resolution`` ("WxH"),
      ``normalize`` ("eager" | "lazy"), ``symlinkClips`` (bool), ``derivedFrom``
      (str). Unknown keys are rejected rather than ignored. These are forwarded
      for EVERY workflow, not just ai_video.
    - ``aiVideoIntake`` — the legacy spelling, still supported (montaj's own UI
      sends it). It additionally carries imageRefs/styleRefs/aspectRatio/
      targetDurationSeconds/colorSpace/music/voiceover, which have no
      ``initSettings`` equivalent. Where both supply ``resolution``,
      ``initSettings`` wins and the legacy key logs a deprecation.

    CAVEAT — carousel workflows: this route takes a fast path for carousel
    project types that returns before any intake parsing, so ``initSettings``
    and ``aiVideoIntake`` are **not read at all** for a carousel. In particular
    ``derivedFrom`` is accepted by the request and silently discarded: the
    carousel builder in init.py never writes it either. Carousel lineage is
    unsupported, not merely unplumbed. See _validate_carousel_args in
    project/init.py for what would have to change.
    """
    clips        = body.get("clips", [])
    assets       = body.get("assets", [])
    prompt       = body.get("prompt")
    workflow     = body.get("workflow", "overlays")
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
    if project_id_arg:
        # §482: a second folder under a synced project's id shares its clash set (A-17), so the AI may not make
        # one while a clash is open. Not even from the window it drives with the clash held (B1 allows writing a held
        # clash's names, never a second copy of the project): a driven run is checked as the AI's.
        who = getattr(request, "headers", None)
        if save_guard.sync_who(who).kind == "drive":
            who = save_guard.MAINTENANCE
        save_guard.check_sync(who, project_id_arg, everything=True)

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

        timings: dict = {}
        project = await _run_init_subprocess(
            cmd, broadcaster=getattr(request.app.state, "broadcaster", None), timings=timings,
        )
        _set_server_timing(response, _server_timing_header(timings))
        return project

    if not prompt:
        raise bad_request("missing_field", "'prompt' is required")

    # PL28: one YouTube link as the footage, downloaded after init in the
    # background (`_start_source_download`). Either/or with clips.
    youtube = _parse_clip_urls(body.get("clipUrls"), clips, remote_clips)

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

    # Init settings — top-level, workflow-agnostic knobs forwarded to project/init.py.
    #
    # Why this block exists separately from `aiVideoIntake`: the intake_setting_args
    # list built below is appended to the init argv UNCONDITIONALLY, for every
    # workflow (see the `cmd +=` assembly further down) — it is not ai_video-specific
    # despite the body key's name. That misleading name has already cost one review a
    # wrong conclusion (it read `--resolution` as unreachable when it was never gated).
    # New settings go here, under an honest name, rather than growing that block.
    #
    # `aiVideoIntake` keeps working for every key it has ever accepted. Where both
    # spellings supply the same key, `initSettings` wins and the legacy one logs.
    init_settings = body.get("initSettings") or {}
    if not isinstance(init_settings, dict):
        raise bad_request(
            "invalid_field",
            f"'initSettings' must be an object (got {type(init_settings).__name__})",
        )
    # Strict key set. An unrecognised key here is a typo or a version mismatch, and
    # silently ignoring it is precisely the failure this plumbing exists to prevent:
    # a caller sets a knob, nothing complains, and nothing happens either.
    _KNOWN_INIT_SETTINGS = {"resolution", "normalize", "symlinkClips", "derivedFrom"}
    unknown_keys = set(init_settings) - _KNOWN_INIT_SETTINGS
    if unknown_keys:
        raise bad_request(
            "invalid_intake",
            f"unknown initSettings key(s): {', '.join(sorted(unknown_keys))} "
            f"(known: {', '.join(sorted(_KNOWN_INIT_SETTINGS))})",
        )

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
    # `initSettings` wins; `aiVideoIntake.resolution` still works and says so. The
    # log fires only when the legacy key is the one that actually supplied the value
    # — using initSettings correctly must stay silent.
    resolution = init_settings.get("resolution")
    if resolution is None and intake.get("resolution") is not None:
        resolution = intake.get("resolution")
        print(
            "[montaj] DEPRECATED: aiVideoIntake.resolution supplied this run's "
            "resolution; use initSettings.resolution instead."
        )
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

    # --- Flags plumbed for the clips fan-out. initSettings-only: these have never
    # had an aiVideoIntake spelling, so there is no alias to honour. init.py has
    # implemented all three for some time; only the forwarding was missing.
    normalize_mode = init_settings.get("normalize")
    if normalize_mode is not None:
        # Rejected here rather than left to init.py: argparse's choices= would exit
        # nonzero and surface as an opaque init failure, not a 400 naming the field.
        if normalize_mode not in ("eager", "lazy"):
            raise bad_request(
                "invalid_intake",
                f"normalize must be 'eager' or 'lazy' (got {normalize_mode!r})",
            )
        intake_setting_args += ["--normalize", normalize_mode]

    # Nobody chose a normalize mode (neither the caller nor the workflow JSON):
    # run init lazy, so the create request never waits on a colour conversion,
    # and let serve do eager's conversions in the background instead. An
    # explicit choice is left exactly as it was: "eager" still converts inline,
    # and "lazy" (the clips workflow) still means never convert the full source.
    background_normalize = (
        normalize_mode is None and (wf_data or {}).get("normalize") is None
    )
    if background_normalize:
        intake_setting_args += ["--normalize", "lazy"]

    symlink_clips = init_settings.get("symlinkClips")
    if symlink_clips is not None:
        if not isinstance(symlink_clips, bool):
            raise bad_request(
                "invalid_intake",
                f"symlinkClips must be a boolean (got {symlink_clips!r})",
            )
        # store_true downstream: false must append nothing, not "--symlink-clips false".
        if symlink_clips:
            intake_setting_args += ["--symlink-clips"]

    derived_from = init_settings.get("derivedFrom")
    if derived_from is not None:
        if not isinstance(derived_from, str) or not derived_from.strip():
            raise bad_request(
                "invalid_intake",
                f"derivedFrom must be a non-empty string (got {derived_from!r})",
            )
        intake_setting_args += ["--derived-from", derived_from]

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
    # Never encode editing proxies inside the create request. An inline budget
    # of 0 makes init defer every new proxy encode (it still adopts proxies that
    # are already fresh on disk), and `_run_init_subprocess` queues the deferred
    # work on the background proxy queue as soon as init returns. Under the old
    # 300s default an import just below the budget held the create request for
    # the whole batch of encodes. The CLI's own default is unchanged.
    cmd += ["--proxy-inline-max", "0"]

    if clips:
        cmd += ["--clips"] + [str(c) for c in clips]
    elif youtube is not None:
        # The link counts as footage; the clip lands when the download does.
        cmd.append("--canvas")
    elif not remote_clips:
        # No local clips and no remote clips — check workflow's requires_clips to decide how to proceed
        requires_clips = True  # conservative default
        wf_data = read_workflow(workflow)
        if wf_data is not None:
            # A 3D template builds from a model, not footage, unless it says otherwise.
            requires_clips = wf_data.get("requires_clips", wf_data.get("project_type") != "3d")

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
    broadcaster = getattr(request.app.state, "broadcaster", None)
    timings = {}
    project = await _run_init_subprocess(
        cmd,
        broadcaster=broadcaster,
        background_normalize=background_normalize,
        timings=timings,
    )
    _set_server_timing(response, _server_timing_header(timings))
    if youtube is None:
        return project
    # Returned WITH the record, so the editor's first paint has the spinner.
    project_dir = find_project_dir(resolve_workspace(), project.get("id"))
    started = None
    if project_dir is not None:
        async with project_lock_async(project_dir / "project.json"):
            started = _start_source_download(project["id"], project_dir, youtube["url"], youtube["id"], broadcaster)
    if started is None:
        raise server_error("source_download_failed", "Project created but its download could not start")
    return started


@router.get("/projects")
async def list_projects(status: str | None = None):
    workspace = resolve_workspace()
    # A project.json nested in a project's folder (a Compare versions snapshot)
    # is not a project of its own: listed, it showed the project twice.
    found = [p for p in workspace.rglob("project.json") if not is_nested_project_json(p, workspace)]
    # §518: an id claimed by 2+ topmost folders is a duplicate (a copied folder
    # that kept the id). Both copies are listed, and each is flagged so the
    # UI/AI can see which ids collide and where, and tell serve already refuses
    # every read/write for them (find_project_dir raises). Built across all
    # found folders, independent of the `status` filter, so the flag is complete
    # even on a filtered list. Shape is additive: two extra fields on the
    # colliding entries, the array shape unchanged.
    folders_by_id: dict[str, list[str]] = {}
    parsed: list[dict] = []
    for p in sorted(found, key=lambda f: f.stat().st_mtime, reverse=True):
        try:
            proj = json.loads(p.read_text())
        except Exception:
            continue
        if not isinstance(proj, dict):
            continue
        parsed.append(proj)
        pid = proj.get("id")
        if pid:
            folders_by_id.setdefault(pid, []).append(str(p.parent))
    # Seed the resolver's cache from this same scan, so an id flagged below is
    # refused by every per-project route from now on, with no scan in between.
    prime_project_dir_cache({pid: [Path(d) for d in dirs] for pid, dirs in folders_by_id.items()})
    projects = []
    for proj in parsed:
        if status and proj.get("status") != status:
            continue
        folders = folders_by_id.get(proj.get("id"), [])
        if len(folders) > 1:
            proj["duplicate"] = True
            proj["duplicateFolders"] = folders
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
    __slots__ = ("kind", "src", "out", "color_space", "sdr_stretch", "targets", "job_id")

    def __init__(self, kind: str, src: str, out: str, color_space: str,
                 *, sdr_stretch: bool = False) -> None:
        self.kind = kind                  # "proxy" | "normalize"
        self.src = src                    # encode input
        self.out = out                    # artifact this unit produces
        self.color_space = color_space
        # A conversion of an SDR source into an HDR project (PV42). Its output
        # is written back as the items' `normalizedSrc` cache, never as `src`.
        self.sdr_stretch = sdr_stretch
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


CAPTION_LOCK_TIMEOUT = 30.0   # as steps/transform/generate_captions.py STEP_LOCK_TIMEOUT: a finished pipeline is not thrown away over a short wait
_WRITEBACK_TRIES = 30
_WRITEBACK_LOCK_TIMEOUT = 1.0   # per project; a busy one never keeps another held for long
_WRITEBACK_PAUSE_SECONDS = 1.0


def _unit_project_paths(unit) -> list[Path]:
    """The distinct project.json files a look-migration unit writes back to."""
    seen: dict[str, Path] = {}
    for _pid, project_dir, *_rest in unit.targets:
        seen.setdefault(str(project_dir), Path(project_dir) / "project.json")
    return list(seen.values())


_PATIENT_LOCK_TRIES = 3


@contextlib.asynccontextmanager
async def _patient_lock(project_path):
    """`project_lock_async`, asked again a few times when it stays busy, for a
    background task that must not fail over a slow holder. A ProjectLockTimeout
    raised by the body is not retried. The body is synchronous (no await)."""
    for attempt in range(_PATIENT_LOCK_TRIES):
        entered = False
        try:
            async with project_lock_async(project_path):
                entered = True
                yield
            return
        except ProjectLockTimeout:
            if entered or attempt == _PATIENT_LOCK_TRIES - 1:
                raise


async def _fail_source_download_patiently(
    project_id: str, project_dir: Path, url: str, video_id: str, job_id: str, code: str,
    broadcaster: "SSEBroadcaster | None", *, remove_partials: bool, message: str | None = None,
) -> None:
    """Record a failed download without ever raising out of the task. If the
    project stays locked the record is left `downloading` (it resumes at the
    next open, as after a quit) and the job still reports the error."""
    try:
        async with _patient_lock(project_dir / "project.json"):
            _fail_source_download(project_id, project_dir, url, video_id, job_id, code,
                                  broadcaster, remove_partials=remove_partials, message=message)
    except Exception as e:
        logger.warning("Could not record a failed download for %s: %s", project_id, e)
        try:
            set_error(job_id, {"error": code, "message": message or _SOURCE_DOWNLOAD_MESSAGES.get(
                code, _SOURCE_DOWNLOAD_MESSAGES["failed"])})
        except Exception:
            pass


async def _locked_writeback(project_paths, fn):
    """Run the synchronous write-back `fn` with every project's lock already
    held (so its own `project_lock` calls only reenter), waiting for them
    without blocking the event loop. A lock that stays busy is tried again a few
    times, a second apart, before the result is given up on and logged: a proxy
    that took minutes to encode is not thrown away for a short lock wait. No
    await runs while the locks are held."""
    for attempt in range(_WRITEBACK_TRIES):
        try:
            async with contextlib.AsyncExitStack() as stack:
                # Each lock is asked for briefly: a busy second project must not keep
                # the first held for the full wait. On a timeout the stack releases
                # every lock taken and the whole set is tried again.
                for path in sorted(project_paths, key=str):
                    await stack.enter_async_context(
                        project_lock_async(path, timeout=min(_project_lock_mod.DEFAULT_TIMEOUT, _WRITEBACK_LOCK_TIMEOUT)))
                return fn()
        except ProjectReadOnly:
            # A read-only folder stays read-only: retrying is pointless.
            logger.warning("Dropped a background write-back: project folder is read-only (%s)",
                           ", ".join(str(p) for p in project_paths))
            return None
        except ProjectLockTimeout:
            if attempt == _WRITEBACK_TRIES - 1:
                logger.warning("Dropped a background write-back: project busy for %d attempts (%s)",
                               _WRITEBACK_TRIES, ", ".join(str(p) for p in project_paths))
                return None
            await asyncio.sleep(_WRITEBACK_PAUSE_SECONDS)


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
                try:
                    await _warm_proxy_inputs(_look_migration_target_srcs(unit, path))
                    await _locked_writeback(
                        _unit_project_paths(unit), lambda: _apply_look_migration_result(unit, path))
                except Exception:
                    pass  # one bad write-back must not stop the rest of the queue
            try:
                await _locked_writeback(_unit_project_paths(unit), lambda: _settle_background_normalize(unit))
            except Exception:
                pass
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
        # tonemap=None: the proxy driver asks the source's provenance whether
        # to grade it, exactly as a fresh import would; this pass must not
        # second-guess it. unit.src is already the file _proxy_input_for chose.
        await run_proxy_job(unit.job_id, unit.src, out=unit.out, tonemap=None)
    else:
        await run_normalize_job(unit.job_id, unit.src, unit.color_space, out=unit.out)

    job = get_job(unit.job_id) or {}
    if job.get("status") != "done":
        return None
    path = (job.get("result") or {}).get("path")
    return path if path == unit.out else None


def _apply_project_edits(project_path: Path, edits: list[tuple],
                         *, settings: dict | None = None, who=None) -> tuple[dict, str] | None:
    """Apply `(item_id, item_src, field, value)` edits to a project.json — a
    `None` value deletes the field. Each key of `settings` is set in the
    project's `settings` in the same write. Returns the updated (project, json
    text), or None when nothing changed or the file can't be read.

    Serialization: read-modify-write with NO await between the read and the
    write, so under the single asyncio loop that serves this process it cannot
    interleave with PUT /projects/{id} (save_project above uses the same
    discipline) or with another unit's write-back. Re-reading rather than
    dumping a dict held across an await is what keeps a concurrent PUT from
    being clobbered. The rewrite is tmp+os.replace so a crash mid-write can't
    truncate the project (SP3 fix S6's reasoning, as cli/commands/clean.py).

    The project may have changed since the edits were computed: items are
    matched by (id, src), and an item that no longer exists is simply skipped.

    §482: a write-back that would change a field in an open Studio sync clash (or
    with the clash set unsure) is skipped, None, like one with nothing to change;
    the heal finds it again at the next open. `who` is the request a route's own
    write-back belongs to (None: serve's maintenance).
    """
    with project_lock(project_path):
        return _apply_project_edits_locked(project_path, edits, settings, who)


def _apply_project_edits_locked(project_path: Path, edits, settings, who=None):
    try:
        raw = project_path.read_text()
        project = json.loads(raw)
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
    current = project.get("settings")
    if settings and isinstance(current, dict):
        for key, value in settings.items():
            if current.get(key) != value:
                current[key] = value
                changed = True
    if not changed:
        return None
    if not save_guard.maintenance_allows(raw, project, who):
        return None
    try:
        text = _write_project_json(project_path, project)
    except (OSError, ProjectReadOnly):
        return None
    return project, text


def _apply_look_migration_result(unit: _LookMigrationUnit, path: str) -> None:
    """Write `path` back into every project.json waiting on this unit.

    A proxy unit also repoints every OTHER video item in those projects whose
    source maps to the same proxy (`_proxy_items_for`). Targets are matched by
    item id, and ids do not survive the edits that happen while a background
    encode runs: a host that lays the timeline out itself after create (new
    item ids), an agent placing clips, a user dragging a clip from the footage
    bin. Without this those items would never get the proxy that was encoded
    for them.

    A `src` target is a background colour conversion (`_ensure_background_normalize`).
    For an SDR source in an HDR project (`unit.sdr_stretch`) the converted file
    becomes the `normalizedSrc` cache of every item on the source, and `src` and
    `proxySrc` stay on the original, so no proxy is owed. Any other conversion
    swaps every item on the unconverted source to the converted file, then
    queues that file's proxy. The swapped items keep their old `proxySrc` until
    the new proxy lands, so the preview never drops to the 4K master."""
    seen: set[str] = set()
    swapped: set[str] = set()
    for project_id, project_dir, field, item_id, item_src, broadcaster in unit.targets:
        project_path = Path(project_dir) / "project.json"
        if field == "src":
            if str(project_path) in swapped:
                continue
            swapped.add(str(project_path))
            if unit.sdr_stretch:
                result = _apply_project_edits(project_path, _cache_items_for(project_path, unit.src, path))
                if result is not None and broadcaster is not None:
                    broadcaster.publish(project_id, _sse_data_frame(result[1]))
                continue
            result = _apply_project_edits(project_path, _src_items_for(project_path, unit.src, path))
            if result is None:
                continue
            if broadcaster is not None:
                broadcaster.publish(project_id, _sse_data_frame(result[1]))
            try:
                _ensure_current_proxies(project_id, Path(project_dir), result[0], broadcaster)
            except Exception:
                pass
            continue
        edits = [(item_id, item_src, field, path)]
        if unit.kind == "proxy" and str(project_path) not in seen:
            seen.add(str(project_path))
            edits += _proxy_items_for(project_path, unit.out, path)
        result = _apply_project_edits(project_path, edits)
        if result is not None and broadcaster is not None:
            broadcaster.publish(project_id, _sse_data_frame(result[1]))


def _proxy_items_for(project_path: Path, out: str, path: str) -> list[tuple]:
    """`(item_id, item_src, "proxySrc", path)` edits for every video item in
    `project_path` whose canonical proxy is `out` and that does not already
    point at `path`. Best-effort: an unreadable project yields no edits."""
    from lib.proxy import proxy_path_for

    try:
        project = json.loads(project_path.read_text())
    except (OSError, ValueError):
        return []
    edits: list[tuple] = []
    for item in _look_migration_items(project):
        src = item["src"]
        if item.get("proxySrc") == path or not os.path.isabs(src):
            continue
        try:
            if proxy_path_for(_proxy_input_for(src)) != out:
                continue
        except Exception:
            # Including ProbeError (PV57): an item whose provenance cannot be
            # read is not pointed at this proxy, which may be the wrong grade
            # for it. Its own pass reports it and retries.
            continue
        edits.append((item.get("id"), src, "proxySrc", path))
    return edits


_PROBE_FAILURE_HOLD_S = 10.0
_probe_failures_held: dict[str, tuple[float, "Exception"]] = {}
"""src -> (monotonic time, ProbeError) for `_proxy_input_for`. The probe cache
keeps successes only (lib.color_provenance: failures are retried), so without
this the synchronous pass after `_warm_proxy_inputs` would probe a failed file
again ON the event loop, and a timeout there blocks serve for PROBE_TIMEOUT_S
twice over (two tries) per call, and per item when a track item and its
`sources` twin share the file. Held for a few seconds only: the next
operation asks ffprobe again."""


def _proxy_input_for(src: str) -> str:
    """The realpath of the file that the editing proxy of an item whose `src`
    is `src` is encoded from, which also names that proxy. The item's
    provenance decides (lib.color_provenance.proxy_source_for, PV42): a marked
    SDR-origin conversion's proxy comes from its original, anything else's
    from `src`. realpath so every child of a shared lazy source names, and
    races on, the one proxy that serves them all (project/init.py's lazy arm
    does the same). Probes are cached per (file, mtime).

    Raises ProbeError when `src`, or the original its marker names, exists and
    cannot be read (PV57): which file the proxy comes from, and its grade, are
    then unknown. Every caller skips that item, so no proxy is written or
    adopted for it on a guess. A failure is held for _PROBE_FAILURE_HOLD_S."""
    from lib.color_provenance import ProbeError, proxy_source_for

    held = _probe_failures_held.get(src)
    if held is not None:
        if time.monotonic() - held[0] < _PROBE_FAILURE_HOLD_S:
            e = held[1]
            raise ProbeError(e.path, e.reason, e.detail, getattr(e, "errno", None))
        _probe_failures_held.pop(src, None)
    try:
        return os.path.realpath(proxy_source_for(src)[0])
    except ProbeError as e:
        _hold_probe_failure(src, e)
        raise


def _hold_probe_failure(src: str, e: "Exception") -> None:
    if len(_probe_failures_held) >= 1024:
        _probe_failures_held.clear()
    _probe_failures_held[src] = (time.monotonic(), e)


async def _warm_proxy_inputs(srcs) -> None:
    """Resolve `_proxy_input_for` for each of `srcs` off the event loop, a few
    at a time, so the synchronous calls that follow hit the probe cache instead
    of blocking the loop (one ffprobe is about 0.1 s on a phone clip). Never
    raises: a miss only means the later call probes. A FRESH failure is held
    from when the whole warm ends, not from when its own probe failed, so a
    long warm cannot outlast the hold before the pass that follows.

    A failure only READ from an existing hold (no fresh probe: `_proxy_input_for`
    itself raised the cached error without asking ffprobe again) must NOT be
    re-held here. The old code re-held every failure it saw either way, so
    steady activity (a warm every few seconds, well inside the hold) kept
    re-stamping the same hold's expiry to "now" and a file that had become
    readable again stayed skipped forever (PV57 review) — the earlier fix
    made this cheap in the first place, but cheap-and-wrong is still wrong.
    `before`/`is not` tells the two apart: `_hold_probe_failure` always stores
    a fresh `(time, error)` tuple, a new object, so an entry that is still the
    SAME object after the warm was a cache hit, not a new failure."""
    from concurrent.futures import ThreadPoolExecutor
    from lib.color_provenance import ProbeError

    srcs = sorted({s for s in srcs if isinstance(s, str) and os.path.isabs(s)})
    if not srcs:
        return
    before = {s: _probe_failures_held.get(s) for s in srcs}
    failed: dict[str, Exception] = {}

    def _one(src: str) -> None:
        try:
            _proxy_input_for(src)
        except ProbeError as e:
            failed[src] = e  # one unreadable file must not stop the others warming

    def _resolve() -> None:
        with ThreadPoolExecutor(max_workers=min(8, len(srcs))) as pool:
            list(pool.map(_one, srcs))

    try:
        await asyncio.to_thread(_resolve)
    except Exception:
        pass
    for src, e in failed.items():
        if _probe_failures_held.get(src) is before[src]:
            continue  # a cache hit inside this warm, not a fresh failure: do not renew its expiry
        _hold_probe_failure(src, e)


def _probe_failure_entry(src: str, e: "Exception") -> dict:
    """A skipped item's record: the named error (serve.routes.steps.probe_failed_body)
    plus the item `src` whose proxy was skipped. `path` is the file that could
    not be read: `src`, or the original its marker names."""
    from serve.routes.steps import probe_failed_body

    return {**probe_failed_body(e), "src": src}


def _report_probe_failures(project_id: str, broadcaster: "SSEBroadcaster | None", op: str,
                           failures: list[dict], *, log: bool = True) -> None:
    """Surface the files an operation over a project's items could not read
    (PV57): one server-log line, and an `event: probe-failed` SSE frame,
    `{"op": op, "failures": [...]}`, each entry naming at least `path`,
    `reason`, `detail` and `src`. The frame is a named event on purpose: the
    app's EventSource has no listener for it, so nothing a user sees changes
    until a UI reads it, and the `log` event (which the app shows) stays as it
    is. It reaches only clients already subscribed; it is not replayed."""
    if not failures:
        return
    if log:
        named = ", ".join(dict.fromkeys(f"{f['path']} ({f['reason']})" for f in failures))
        print(f"[montaj] {op}: could not read {len(failures)} file(s), their items left as they are: {named}",
              file=sys.stderr, flush=True)
    if broadcaster is not None:
        try:
            broadcaster.publish(
                project_id, f"event: probe-failed\ndata: {json.dumps({'op': op, 'failures': failures})}\n\n")
        except Exception:
            pass


def _video_srcs(project: dict) -> list[str]:
    return [item["src"] for item in _look_migration_items(project)]


def _look_migration_target_srcs(unit: _LookMigrationUnit, path: str) -> list[str]:
    """Every video `src` in the projects `unit` writes back to, plus `path`
    (a conversion swaps items onto it before their proxies are queued). Never
    raises: an unreadable project contributes nothing."""
    srcs = [path]
    for project_dir in {t[1] for t in unit.targets}:
        try:
            srcs += _video_srcs(json.loads((Path(project_dir) / "project.json").read_text()))
        except Exception:
            continue
    return srcs


# ---------------------------------------------------------------------------
# Background colour conversion (serve's default for /api/run)
#
# Eager init conforms every non-conformant clip to the project colour space
# inside the create request, which is minutes for one 4K SDR->HLG clip. When a
# create names no normalize mode, serve runs init LAZY instead (clips staged and
# probed, nothing transcoded, `src` left on the original) and does eager's
# conversions here, on the look-migration queue, writing the end state eager
# would have written on every item using that source. For an SDR source in an
# HDR project that is a cache: `normalizedSrc` names the converted file,
# `normalizedInPoint` is 0 (a full-source conversion), and `src` stays the file
# the user brought in (PV42). Any other conversion swaps `src` to the converted
# file, then queues that file's proxy.
#
# `settings.normalizeInBackground` marks a project that still owes conversions.
# While it is set, opening the project re-runs the pass, which joins a queued
# conversion rather than starting a second one, and restarts any a serve restart
# dropped. It is cleared once nothing for the project is queued or running.
#
# Export does not wait on any of this: render.js's normalize pre-pass conforms
# any clip that is still on its original inline, to the same output path this
# pass writes (lib.normalize's writes are atomic), and reuses the file when a
# conversion already finished.
# ---------------------------------------------------------------------------

BACKGROUND_NORMALIZE_KEY = "normalizeInBackground"


def _src_items_for(project_path: Path, src: str, path: str) -> list[tuple]:
    """`(item_id, item_src, "src", path)` edits swapping every video item whose
    source is `src` (compared by realpath) onto `path`."""
    try:
        project = json.loads(project_path.read_text())
    except (OSError, ValueError):
        return []
    real = os.path.realpath(src)
    edits: list[tuple] = []
    for item in _look_migration_items(project):
        item_src = item["src"]
        if item_src == path or not os.path.isabs(item_src):
            continue
        if os.path.realpath(item_src) == real:
            edits.append((item.get("id"), item_src, "src", path))
    return edits


def _cache_items_for(project_path: Path, src: str, path: str) -> list[tuple]:
    """Edits recording `path`, a full-source conversion of `src`, as the
    `normalizedSrc` cache (with `normalizedInPoint` 0) of every video item whose
    source is `src` (compared by realpath). `src` and `proxySrc` are untouched."""
    try:
        project = json.loads(project_path.read_text())
    except (OSError, ValueError):
        return []
    real = os.path.realpath(src)
    edits: list[tuple] = []
    for item in _look_migration_items(project):
        item_src = item["src"]
        if not os.path.isabs(item_src) or os.path.realpath(item_src) != real:
            continue
        edits.append((item.get("id"), item_src, "normalizedSrc", path))
        edits.append((item.get("id"), item_src, "normalizedInPoint", 0))
    return edits


def _background_normalize_pending(project_dir: str) -> bool:
    """Is a background conversion for this project queued or running?"""
    units = list(_look_migration_queue)
    if _look_migration_current is not None:
        units.append(_look_migration_current)
    return any(
        t[2] == "src" and t[1] == project_dir
        for unit in units for t in unit.targets
    )


def _set_background_normalize(project_path: Path, pending: bool) -> tuple[dict, str] | None:
    """Set or clear the marker (and drop the `normalize: "lazy"` init wrote on
    serve's behalf — the lazy run was serve's choice, not the project's). Same
    no-await read-modify-write as `_apply_project_edits`. None when unchanged."""
    with project_lock(project_path):
        return _set_background_normalize_locked(project_path, pending)


def _set_background_normalize_locked(project_path: Path, pending: bool) -> tuple[dict, str] | None:
    try:
        raw = project_path.read_text()
        project = json.loads(raw)
    except (OSError, ValueError):
        return None
    settings = project.get("settings")
    if not isinstance(settings, dict):
        return None
    changed = False
    if settings.get("normalize") == "lazy":
        del settings["normalize"]
        changed = True
    if pending and settings.get(BACKGROUND_NORMALIZE_KEY) is not True:
        settings[BACKGROUND_NORMALIZE_KEY] = True
        changed = True
    elif not pending and BACKGROUND_NORMALIZE_KEY in settings:
        del settings[BACKGROUND_NORMALIZE_KEY]
        changed = True
    if not changed:
        return None
    if not save_guard.maintenance_allows(raw, project):   # §482: `settings` in an open sync clash
        return None
    try:
        text = _write_project_json(project_path, project)
    except (OSError, ProjectReadOnly):
        return None
    return project, text


def _settle_background_normalize(unit: _LookMigrationUnit) -> None:
    """After a unit finishes (either way), clear the marker on every project it
    converted for that has nothing else queued. A failed conversion clears it
    too: export still conforms that clip inline, and a marker left set would
    re-run a doomed encode on every open."""
    done: set[str] = set()
    for project_id, project_dir, field, _item_id, _item_src, broadcaster in unit.targets:
        if field != "src" or project_dir in done:
            continue
        done.add(project_dir)
        if _background_normalize_pending(project_dir):
            continue
        result = _set_background_normalize(Path(project_dir) / "project.json", False)
        if result is not None and broadcaster is not None:
            broadcaster.publish(project_id, _sse_data_frame(result[1]))


def _is_fresh(out: str, src: str) -> bool:
    """`out` exists and is at least as new as `src` — render.js's own cache test."""
    try:
        return os.path.getmtime(out) >= os.path.getmtime(src)
    except OSError:
        return False


async def _ensure_background_normalize(
    project_id: str,
    project_dir: Path,
    project: dict,
    broadcaster: "SSEBroadcaster | None" = None,
    *,
    created: bool = False,
) -> dict | None:
    """Queue the colour conversion for every video source that is not conformant
    to the project colour space, or write it back at once when the converted file
    is already fresh on disk (see `_apply_look_migration_result` for what the
    write-back is). Runs at create (`created=True`) and on every open of a
    project still carrying the marker. Never awaits an encode. Returns the
    project as last written, or None when nothing changed."""
    from lib.normalize import is_normalized, normalized_output_path, probe_video
    from lib.types.colorspace import DEFAULT_COLOR_SPACE, detect_from_transfer, is_hdr

    settings = project.get("settings") or {}
    if not created and settings.get(BACKGROUND_NORMALIZE_KEY) is not True:
        return None
    color_space = settings.get("colorSpace") or DEFAULT_COLOR_SPACE
    converted_tag = f"_normalized_{color_space}"

    def _cached(item: dict) -> bool:
        """The item already carries its source's fresh SDR-to-HDR conversion as
        its full-source `normalizedSrc` cache."""
        if not is_hdr(color_space):
            return False
        cache = normalized_output_path(item["src"], color_space, tonemapped=False, sdr_stretch=True)
        return item.get("normalizedSrc") == cache and item.get("normalizedInPoint") == 0 \
            and _is_fresh(cache, item["src"])

    # A source already swapped onto a converted file is skipped by name, and an
    # item already carrying its fresh SDR-to-HDR cache is skipped too, so a
    # finished project costs no ffprobe at all.
    srcs = sorted({
        item["src"] for item in _look_migration_items(project)
        if os.path.isabs(item["src"]) and os.path.isfile(item["src"])
        and converted_tag not in os.path.basename(item["src"])
        and not _cached(item)
    })

    def _plan(src: str) -> tuple[str, bool] | None:
        """The converted output `src` needs and whether it is an SDR source
        into this HDR project, or None when it needs none (or can't be read —
        export will try again, and report it)."""
        try:
            info = probe_video(src)
            if info is None or is_normalized(src, info, color_space):
                return None
            tonemapped = is_hdr(detect_from_transfer(info.get("color_transfer"))) \
                and color_space == "sdr_bt709"
            sdr_stretch = not is_hdr(detect_from_transfer(info.get("color_transfer"))) \
                and is_hdr(color_space)
            return normalized_output_path(src, color_space, tonemapped=tonemapped,
                                          sdr_stretch=sdr_stretch), sdr_stretch
        except (Exception, SystemExit):
            return None

    plans = await asyncio.gather(*(asyncio.to_thread(_plan, s) for s in srcs))

    project_path = project_dir / "project.json"
    latest: tuple[dict, str] | None = None
    swapped_now = False
    new_units: list[_LookMigrationUnit] = []
    for src, plan in zip(srcs, plans):
        if plan is None:
            continue
        out, sdr_stretch = plan
        if _is_fresh(out, src):
            if sdr_stretch:
                # A cache, not a new `src`: the proxy is unchanged, none is owed.
                async with project_lock_async(project_path):
                    result = _apply_project_edits(project_path, _cache_items_for(project_path, src, out))
                if result is not None:
                    latest = result
                continue
            async with project_lock_async(project_path):
                result = _apply_project_edits(project_path, _src_items_for(project_path, src, out))
            if result is not None:
                latest, swapped_now = result, True
            continue
        unit = _look_migration_pending("normalize", out)
        if unit is None:
            unit = _LookMigrationUnit("normalize", src, out, color_space, sdr_stretch=sdr_stretch)
            new_units.append(unit)
        if not any(t[2] == "src" and t[1] == str(project_dir) for t in unit.targets):
            unit.targets.append((project_id, str(project_dir), "src", None, src, broadcaster))

    for unit in new_units:
        _look_migration_enqueue(unit)

    if swapped_now:
        try:
            await _warm_proxy_inputs(_video_srcs(latest[0]))
            await _ensure_current_proxies_async(project_id, project_dir, latest[0], broadcaster)
        except Exception:
            pass

    async with project_lock_async(project_path):
        marked = _set_background_normalize(project_path, _background_normalize_pending(str(project_dir)))
    if marked is not None:
        latest = marked
    if latest is not None and broadcaster is not None:
        broadcaster.publish(project_id, _sse_data_frame(latest[1]))
    return latest[0] if latest is not None else None


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


# Strong refs to in-flight detached source-dims tasks (see ensure_source_dims).
_source_dims_task_refs: set = set()

_SOURCE_DIMS_PROBE_CONCURRENCY = 4


def _positive_dim(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


async def ensure_source_dims(
    project_id: str,
    project_dir: Path,
    project: dict,
    broadcaster: "SSEBroadcaster | None" = None,
) -> dict:
    """Backfill `sourceWidth`/`sourceHeight` on video items that lack them, and
    return the project to serve: `project` itself when nothing changed.

    Agent-built projects write clip items without dims (only ingest records
    them), and the editor's export dialog caps resolution at the canvas when
    they are missing. Dims are the rotation-aware display size
    (lib.normalize.probe_video), probed once per unique src off the event loop,
    at most a few at a time. Items whose src is not an existing absolute file,
    or whose probe fails, are left as they are. Nothing is probed or written
    when every item already has dims. The edits land in one
    `_apply_project_edits` write (re-reads project.json, safe against a
    concurrent PUT) and are broadcast over SSE.

    Then, for a project whose canvas is still the default it was created with,
    the footage sets the canvas and frame rate once (`_ensure_canvas_follows_footage`).

    Never raises: a project must always open."""
    try:
        project = await _ensure_source_dims(project_id, project_dir, project, broadcaster) or project
    except Exception:
        pass
    try:
        return await _ensure_canvas_follows_footage(project_id, project_dir, project, broadcaster) or project
    except Exception:
        return project


async def _ensure_canvas_follows_footage(
    project_id: str,
    project_dir: Path,
    project: dict,
    broadcaster: "SSEBroadcaster | None",
) -> dict | None:
    """A project created without footage has `settings.resolutionSource` and
    `settings.fpsSource` of `"default"`. Once a video item (tracks first, then
    sources) carries source dims, the canvas becomes the modal footage size
    (first appearance wins a tie, as at init); a canvas of another aspect keeps
    its aspect and takes the footage's short side (`canvas_for_footage`), first
    turning to the footage's orientation when `settings.aspectSource` is
    `"default"` (nobody chose the aspect). The
    fps becomes the first probeable clip's, in track order. Each marker turns
    `"footage"` in the same write and the setting never changes again. The two
    are independent, and any other marker, or none, is left alone. A failed
    probe changes nothing, so a later open retries.

    The fps needs its own probe (the dims backfill records no rate), done off
    the loop before the write. The write re-reads project.json and decides on
    that copy with no await after it, so a PUT that set an explicit value a
    moment ago is never overwritten."""
    from lib.normalize import probe_video

    project_path = project_dir / "project.json"

    def _read() -> dict | None:
        try:
            current = json.loads(project_path.read_text())
        except (OSError, ValueError):
            return None
        return current if isinstance(current.get("settings"), dict) else None

    current = _read()
    if current is None:
        return None
    settings = current["settings"]
    want_canvas = settings.get("resolutionSource") == SOURCE_DEFAULT
    want_fps = settings.get("fpsSource") == SOURCE_DEFAULT
    if not (want_canvas or want_fps):
        return None
    fps = None
    if want_fps:
        for src in dict.fromkeys(i["src"] for i in _look_migration_items(current)
                                 if isinstance(i["src"], str) and os.path.isabs(i["src"]) and os.path.isfile(i["src"])):
            try:
                info = await asyncio.to_thread(probe_video, src)
            except Exception:
                continue
            # The real rate (frame_rate), never r_frame_rate: an iPhone clip at 29.7 fps reports 120/1.
            fps = fps_from_rate((info or {}).get("frame_rate") or (info or {}).get("r_frame_rate"))
            if fps:
                break

    def _decide(current: dict) -> dict:
        settings = current["settings"]
        edits: dict = {}
        canvas = settings.get("resolution")
        if settings.get("resolutionSource") == SOURCE_DEFAULT:
            footage = modal_dims(
                (item["sourceWidth"], item["sourceHeight"])
                for item in _look_migration_items(current)
                if _positive_dim(item.get("sourceWidth")) and _positive_dim(item.get("sourceHeight"))
            )
            if footage is not None and isinstance(canvas, list) and len(canvas) == 2 and all(_positive_dim(v) for v in canvas):
                # An aspect nobody chose follows the footage's orientation; a chosen one, or a
                # project made before aspectSource existed, keeps its aspect.
                follow = settings.get("aspectSource") == SOURCE_DEFAULT
                edits["resolution"] = canvas_for_footage(canvas, footage, follow_orientation=follow)
                edits["resolutionSource"] = SOURCE_FOOTAGE
        if fps and settings.get("fpsSource") == SOURCE_DEFAULT:
            edits["fps"] = fps
            edits["fpsSource"] = SOURCE_FOOTAGE
        return edits

    # Nothing to change on the copy read above: no lock taken (an open that writes
    # nothing must not wait for one).
    if not _decide(current):
        return None
    # The final read AND the decision happen inside the lock: a PUT that set an
    # explicit value while this waited must not be overwritten.
    async with project_lock_async(project_path):
        current = _read()
        if current is None:
            return None
        edits = _decide(current)
        if not edits:
            return None
        result = _apply_project_edits(project_path, [], settings=edits)
    if result is None:
        return None
    if broadcaster is not None:
        broadcaster.publish(project_id, _sse_data_frame(result[1]))
    return result[0]


async def _ensure_source_dims(
    project_id: str,
    project_dir: Path,
    project: dict,
    broadcaster: "SSEBroadcaster | None",
) -> dict | None:
    from lib.normalize import probe_video

    owed = [
        item for item in _look_migration_items(project)
        if not (_positive_dim(item.get("sourceWidth")) and _positive_dim(item.get("sourceHeight")))
        and isinstance(item["src"], str) and os.path.isabs(item["src"]) and os.path.isfile(item["src"])
    ]
    if not owed:
        return None
    sem = asyncio.Semaphore(_SOURCE_DIMS_PROBE_CONCURRENCY)

    async def _probe(src: str):
        async with sem:
            try:
                info = await asyncio.to_thread(probe_video, src)
            except Exception:
                return src, None
        w = (info or {}).get("display_width")
        h = (info or {}).get("display_height")
        return src, (w, h) if _positive_dim(w) and _positive_dim(h) else None

    probed = dict(await asyncio.gather(*(_probe(src) for src in dict.fromkeys(i["src"] for i in owed))))
    edits: list[tuple] = []
    for item in owed:
        dims = probed.get(item["src"])
        if dims:
            edits.append((item.get("id"), item["src"], "sourceWidth", dims[0]))
            edits.append((item.get("id"), item["src"], "sourceHeight", dims[1]))
    if not edits:
        return None
    async with project_lock_async(project_dir / "project.json"):
        result = _apply_project_edits(project_dir / "project.json", edits)
    if result is None:
        return None
    if broadcaster is not None:
        broadcaster.publish(project_id, _sse_data_frame(result[1]))
    return result[0]


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
      a superseded master out from under a live pointer). A field naming
      this item's master under an EARLIER look's tag (lib/look.py's
      PREVIOUS_MASTER_LOOKS, e.g. `_normalized_sdr_bt709_vivid1.mp4` once
      natural1 is the default) is migrated the same way as an untagged one,
      with no probe: the tag proves it was tone-mapped (PL24). An item whose
      `src` itself is such a master (an eager import) is not re-pointed.

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
    from lib.color_provenance import ProbeError
    from lib.normalize import normalized_output_path, probe_video
    from lib.look import PREVIOUS_MASTER_LOOKS
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
    # Items with no proxySrc at all. Never scheduled from here (a pre-proxy
    # project stays on the manual migration), only ADOPTED: repointed when the
    # proxy is already fresh on disk, or attached to an encode already queued.
    # serve defers every create-time proxy to the background queue, so a save
    # that raced that queue's write-back must heal on the next open.
    proxy_missing: list[dict] = []
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
        elif proxies_enabled and not proxy_src:
            proxy_missing.append(item)

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
            elif normalized_src in {
                normalized_output_path(src, color_space, tonemapped=True, look=old)
                for old in PREVIOUS_MASTER_LOOKS
            }:
                # This item's full-source master under an earlier look (PL24:
                # `_vivid1` once natural1 is the default). The tag proves it
                # was tone-mapped, so no probe; left in place, render would
                # keep the old look while the proxy shows the new one.
                master_candidates.append(item)

    if not proxy_stale and not master_candidates and not proxy_missing:
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
    # The proxy's input (and so its name) is the item's provenance; resolve
    # it off the event loop for the items that need a proxy.
    await _warm_proxy_inputs(item["src"] for item in proxy_stale + proxy_missing)

    # Pass 3 — repoint what already exists, clear + queue what doesn't. Both maps
    # are keyed so the `tracks` item and its `sources` twin (same id, same src)
    # collapse to ONE edit and ONE encode instead of doing everything twice.
    units: dict[tuple, _LookMigrationUnit] = {}
    edits: dict[tuple, str | None] = {}
    probe_failed: dict[str, dict] = {}

    def _input_for(item: dict) -> str | None:
        # An item whose provenance cannot be read (PV57) is skipped: its
        # pointer is neither cleared, repointed nor queued, so it is never
        # pointed at a proxy made or picked on a guess, and the next open looks
        # again. The others carry on, and the skip is reported below.
        try:
            return _proxy_input_for(item["src"])
        except ProbeError as e:
            probe_failed.setdefault(item["src"], _probe_failure_entry(item["src"], e))
            return None

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
        # The file the proxy is encoded from (the item's provenance), as a
        # realpath: see _proxy_input_for.
        real_in = _input_for(item)
        if real_in is None:
            continue
        out = proxy_path_for(real_in)
        if is_proxy_fresh(out, real_in):
            edits[key] = out  # already encoded — just repoint
        else:
            _schedule("proxy", key, real_in, out)

    for item in proxy_missing:
        key = (item.get("id"), item["src"], "proxySrc")
        if key in edits:
            continue
        real_in = _input_for(item)
        if real_in is None:
            continue
        out = proxy_path_for(real_in)
        if is_proxy_fresh(out, real_in):
            edits[key] = out
            continue
        pending = units.get(("proxy", out)) or _look_migration_pending("proxy", out)
        if pending is not None:
            pending.targets.append((project_id, str(project_dir), "proxySrc", key[0], key[1], broadcaster))

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
        async with project_lock_async(project_dir / "project.json"):
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

    # The open's response is the project itself, so the skips go to the log
    # and the probe-failed event (see _report_probe_failures).
    _report_probe_failures(project_id, broadcaster, "look migration", list(probe_failed.values()))
    return result[0] if result is not None else None


_color_provenance_locks: dict[str, asyncio.Lock] = {}
"""One lock per project folder: open, render and a burst of version_frame calls
can all reach the heal at once, and the first-open legacy pass must run once.
The second caller waits, then re-plans from disk, which is cheap."""


async def ensure_project_color_provenance(
    project_id: str,
    project_dir: Path,
    project: dict,
    broadcaster: "SSEBroadcaster | None" = None,
) -> dict:
    """Heal an HDR project whose SDR clips were converted in place before PV42
    (lib.color_provenance.ensure_color_provenance), and return the project to
    serve: `project` itself when nothing changed, otherwise the healed copy.

    The plan (probes and thumbnails) runs off the event loop. When an item will
    change, project.json is first snapshotted into git ("version: before colour
    provenance"); the edits then land in one `_apply_project_edits` write, which
    is broadcast over SSE. A switched item whose original has no fresh proxy
    had `proxySrc` cleared, and its proxy is queued on the look-migration queue.
    `normalizeInBackground`, set when an item was switched, makes the open path
    convert each original into its `normalizedSrc` cache.

    Never raises: a project must always open, and always render."""
    try:
        return await _ensure_project_color_provenance(project_id, project_dir, project, broadcaster) or project
    except Exception:
        return project


async def _ensure_project_color_provenance(
    project_id: str,
    project_dir: Path,
    project: dict,
    broadcaster: "SSEBroadcaster | None",
) -> dict | None:
    from lib.color_provenance import plan_color_provenance
    from lib.types.colorspace import is_hdr

    settings = project.get("settings") or {}
    if not is_hdr(settings.get("colorSpace")):
        return None  # SDR: no probe, no thread
    async with _color_provenance_locks.setdefault(str(project_dir), asyncio.Lock()):
        plan = await asyncio.to_thread(plan_color_provenance, project_dir)
        # Files the heal could not read (PV57), each {pass, id, src, path,
        # reason, detail, blocking}: what depends on a `blocking` one was left
        # as it is and is looked at again next time. This returns the project
        # itself, so they go out as the probe-failed event, before the early
        # return below, since a heal that only deferred has nothing to write.
        # No second log line: the plan already logged one (`colour provenance:
        # could not read ...`).
        _report_probe_failures(project_id, broadcaster, "colour provenance",
                               plan.get("probeFailed") or [], log=False)
        if not plan["edits"] and not plan["settings"]:
            return None
        if plan["edits"]:
            await asyncio.to_thread(_git_commit_sync, project_dir, "version: before colour provenance")
        async with project_lock_async(project_dir / "project.json"):
            result = _apply_project_edits(project_dir / "project.json", plan["edits"], settings=plan["settings"])
        if result is None:
            return None
        if broadcaster is not None:
            broadcaster.publish(project_id, _sse_data_frame(result[1]))

        new_units: list[_LookMigrationUnit] = []
        for owed in plan["proxiesOwed"]:
            unit = _look_migration_pending("proxy", owed["out"]) \
                or next((u for u in new_units if u.out == owed["out"]), None)
            if unit is None:
                unit = _LookMigrationUnit("proxy", owed["input"], owed["out"], settings.get("colorSpace"))
                new_units.append(unit)
            unit.targets.append((project_id, str(project_dir), "proxySrc", owed["id"], owed["src"], broadcaster))
        for unit in new_units:
            _look_migration_enqueue(unit)
        return result[0]


async def _ensure_current_proxies_async(
    project_id: str, project_dir: Path, project: dict, broadcaster: "SSEBroadcaster | None" = None,
) -> dict:
    """`_ensure_current_proxies` for code on the event loop: its write-backs take
    the project lock, so it runs under the async lock (a busy one never blocks
    the loop). May raise ProjectLockTimeout."""
    async with project_lock_async(Path(project_dir) / "project.json"):
        return _ensure_current_proxies(project_id, project_dir, project, broadcaster)


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

    An item whose provenance cannot be read (ProbeError, PV57) is skipped: no
    encode is queued for it, its `proxySrc` is left as it is, and it counts
    toward neither number. The rest carry on. Each unreadable source is listed
    once in `probeFailed` (the named error of
    serve.routes.steps.probe_failed_body, plus the item `src`) and reported
    (`_report_probe_failures`). A later pass (this one again: "Generate
    previews", a save that changes the item) makes the proxy once it reads.

    Never awaits an encode — the background queue delivers write-backs over SSE.
    Returns `{"scheduled": N, "alreadyFresh": M, "probeFailed": [...]}`, both
    counts of unique sources.
    """
    from lib.color_provenance import ProbeError
    from lib.proxy import is_proxy_fresh, proxy_path_for
    from lib.types.colorspace import DEFAULT_COLOR_SPACE

    settings = project.get("settings") or {}
    if settings.get("proxy") is False:
        return {"scheduled": 0, "alreadyFresh": 0, "probeFailed": []}
    color_space = settings.get("colorSpace") or DEFAULT_COLOR_SPACE

    # Group every present, absolute-sourced video item by the ONE proxy path it
    # would use: named after the file it is encoded from, the item's provenance
    # (_proxy_input_for; realpath so a shared lazy source's children collapse
    # to one).
    by_out: dict[str, list[dict]] = {}
    real_by_out: dict[str, str] = {}
    probe_failed: dict[str, dict] = {}
    for item in _look_migration_items(project):
        src = item["src"]
        if not (os.path.isabs(src) and os.path.isfile(src)):
            continue
        if src in probe_failed:
            continue  # its twin (the `sources` entry, a split) already failed
        try:
            real_in = _proxy_input_for(src)
        except ProbeError as e:
            # Unknown input and grade: skip this item rather than encode or
            # adopt a proxy on a guess, which would then be kept until its
            # source changes (proxies are fresh by mtime alone).
            probe_failed[src] = _probe_failure_entry(src, e)
            continue
        out = proxy_path_for(real_in)
        by_out.setdefault(out, []).append(item)
        real_by_out[out] = real_in

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

    failures = list(probe_failed.values())
    _report_probe_failures(project_id, broadcaster, "proxies", failures)
    return {"scheduled": scheduled, "alreadyFresh": already_fresh, "probeFailed": failures}


@router.post("/projects/{project_id}/proxies")
async def ensure_project_proxies(project_id: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    """Generate the missing/stale editing proxies for a project (manual
    migration of pre-proxy projects). Reuses the look-migration queue: nothing
    is encoded in the request — units are queued and land in project.json over
    SSE as they finish. 202 when work was queued, 200 when everything was
    already fresh. Best-effort: housekeeping never 500s the caller.

    `probeFailed` lists the sources skipped because a file could not be read
    (PV57), each the named `probe_failed` error with its `path`, `reason`,
    `detail`, `retryable` and the item `src`. The status stays 200/202: the
    other items were handled, and each skip is named in the body."""
    project = json.loads((project_dir / "project.json").read_text())
    broadcaster = getattr(request.app.state, "broadcaster", None) if request is not None else None
    try:
        await _warm_proxy_inputs(_video_srcs(project))
        result = await _ensure_current_proxies_async(project_id, project_dir, project, broadcaster)
    except Exception:
        result = {"scheduled": 0, "alreadyFresh": 0, "probeFailed": []}
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
async def get_project(project_id: str, request: Request = None, project_dir: Path = Depends(get_project_dir),
                      response: Response = None, fields: str | None = None):
    """The project. `fields=a,b` changes nothing in the body: with the §477 guard on,
    the answer's x-montaj-revisions carries those fields' revisions (all fields when
    `fields` is absent), the ones a later PUT is compared against."""
    seen: dict = {}
    project = await _open_project(project_id, request, project_dir, seen)
    save_guard.get_headers(response, project, fields, seen.get("text"), seen.get("project"))
    return project


_REVISION_FIELD_RE = re.compile(r"[A-Za-z0-9_.-]+")
_REVISION_FIELDS_MAX = 64


@router.get("/projects/{project_id}/revisions")
async def get_project_revisions(project_id: str, response: Response,
                                project_dir: Path = Depends(get_project_dir), fields: str | None = None):
    """§477: the revisions of a project's fields (`fields=a,b`, all top-level ones when
    absent) without opening it. Strictly read-only: no migration, sweep, SSE frame, task or
    lock, so a caller that must not trigger an open (the app's name sync) can use it. 404
    when the engine guard is off, so a caller falls back to the GET."""
    if not project_revisions.engine_guard_enabled():
        raise not_found("not_found", "Revisions are not available")
    names = save_guard.parse_fields(fields)
    if names is not None and (len(names) > _REVISION_FIELDS_MAX
                              or not all(_REVISION_FIELD_RE.fullmatch(n) for n in names)):
        raise bad_request("bad_fields", f"fields must be at most {_REVISION_FIELDS_MAX} names of letters, digits, _ . -")
    # No lock: every project.json write is an atomic rename, so one read sees one whole version.
    try:
        raw = (project_dir / "project.json").read_text()
        project = json.loads(raw)
    except (OSError, ValueError):
        project = None
    if not isinstance(project, dict):
        raise HTTPException(502, detail={
            "error": "project_unreadable",
            "message": "This project's file could not be read",
        })
    normalized = converge(project)  # as a reader sees it; never written here
    if normalized is project:
        revs = project_revisions.revisions_for_text(raw, project, names)
    else:
        revs = project_revisions.revisions_of(normalized, names)
    response.headers["x-montaj-revisions"] = json.dumps(revs, separators=(",", ":"))
    return {"revisions": revs}


async def _open_project(project_id: str, request, project_dir: Path, seen: dict):
    """GET /projects/{id}'s work. Records in `seen` the last text read or written
    with the object parsed from it, so the revisions are hashed once per file version."""
    project_path = project_dir / "project.json"
    raw = project_path.read_text()
    project = json.loads(raw)
    seen.update(text=raw, project=project)
    broadcaster = getattr(request.app.state, "broadcaster", None) if request is not None else None
    # §126: temp files a crash left in the folder and its assets/ (a copy's, a
    # write's), once an hour old, so a project that never copies again is
    # cleaned too. Two listings, never fails the open.
    try:
        sweep_stale_temps(project_dir)
    except Exception:
        pass

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
    # Under the project lock, on a fresh read, so a step's write in another
    # process is not undone by the copy read at the top of this handler (§467).
    # The same pass converges the retired shapes (lib/project_migrate.py: the Lyric video's music_video type and
    # ffmpeg-drawtext render mode) through the same lock and the same maintenance check: a field in an open Studio
    # sync clash is served converged and written at the first open after it closes.
    text = None
    if converge(project) is not project:
        # Only a project that is about to be rewritten takes the lock; an open
        # that writes nothing (the usual one, and any read-only folder) does not.
        try:
            async with project_lock_async(project_path):
                fresh_raw = None
                try:
                    fresh_raw = project_path.read_text()
                    project = json.loads(fresh_raw)
                except (OSError, ValueError):
                    pass
                normalized = converge(project)
                if normalized is not project:
                    # §482: `tracks` in an open Studio sync clash is served converged, not written; the
                    # next open after the clash closes writes it.
                    if save_guard.maintenance_allows(fresh_raw if fresh_raw is not None else raw, normalized):
                        try:
                            text = _write_project_json(project_path, normalized)
                            seen.update(text=text, project=normalized)
                        except (OSError, ProjectReadOnly):
                            pass  # degrade to "not converged yet": a project must always open
                    project = normalized
        except ProjectLockTimeout:
            # A project must always open: serve the converged copy, write nothing.
            project = converge(project)
    if text is not None and broadcaster is not None:
        broadcaster.publish(project_id, _sse_data_frame(text))

    # Heal look-stale artifact pointers before handing the project over. The
    # response is the MIGRATED body — the pass only ever does name/stat work
    # plus a bounded ffprobe pass; every re-encode is queued, never awaited.
    project = await migrate_project_look(project_id, project_dir, project, broadcaster)

    # An HDR project whose SDR clips were converted in place before PV42: put
    # each back on its original. Before the block below, which then converts
    # the originals it switched to. Best-effort, never raises.
    project = await ensure_project_color_provenance(project_id, project_dir, project, broadcaster)

    # Clips written without source dims (agents, PUT) get them probed and saved,
    # so the export dialog can offer the resolutions the footage supports.
    project = await ensure_source_dims(project_id, project_dir, project, broadcaster)

    # A project still owed background colour conversions (see
    # `_ensure_background_normalize`): join what is queued, restart what a serve
    # restart dropped. Best-effort — a project must always open.
    if (project.get("settings") or {}).get(BACKGROUND_NORMALIZE_KEY) is True:
        try:
            project = await _ensure_background_normalize(
                project_id, project_dir, project, broadcaster,
            ) or project
        except Exception:
            pass

    # A YouTube source still `downloading` with no live task: restart it under
    # a new jobId (PL28). Best-effort, never raises. Only a project that is
    # still downloading takes the lock (async: a busy one never freezes the loop).
    record = project.get("sourceDownload")
    if not isinstance(record, dict) or record.get("status") != "downloading":
        return project
    try:
        async with project_lock_async(project_path):
            return _ensure_source_download(project_id, project_dir, project, broadcaster)
    except ProjectLockTimeout:
        return project


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


_LOG_SOURCE_RE = re.compile(r"^[a-z0-9-]{1,64}$")


@router.post("/projects/{project_id}/log", status_code=204)
async def log_status(project_id: str, body: dict = Body(...), request: Request = None):
    message = str(body.get("message", "")).strip()
    if not message:
        raise bad_request("missing_field", "'message' is required")
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    data = {"message": message}
    source = body.get("source")
    if isinstance(source, str) and source != "unknown" and _LOG_SOURCE_RE.fullmatch(source):
        data["source"] = source
    frame = f"event: log\ndata: {json.dumps(data)}\n\n"
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


# lib/normalize.py normalized_output_path: `<stem>_normalized_<colorSpace>`, then
# an optional look tag and `_w203`, then `.mp4`. `<stem>` is the staged original's
# path minus its extension.
_NORMALIZED_MASTER_RE = re.compile(
    r"^(?P<stem>.+)_normalized_(?:%s)(?:_[A-Za-z0-9]+)*\.mp4$"
    % "|".join(re.escape(cs) for cs in ALL_COLOR_SPACES)
)
_CLIP_EXTENSIONS = (".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi")


def _move_into_uploads(src: Path, uploads_dir: Path) -> Path:
    """Move `src` into `uploads_dir` under a name no file there has yet
    (`<stem>_<n><suffix>`, the save_upload() convention, so two back-to-setup
    round-trips never clobber), and return where it landed."""
    uploads_dir.mkdir(parents=True, exist_ok=True)
    target = uploads_dir / src.name
    stem, suffix = target.stem, target.suffix
    counter = 1
    while target.exists():
        target = uploads_dir / f"{stem}_{counter}{suffix}"
        counter += 1
    shutil.move(str(src), str(target))
    return target


def _clip_original(path: Path) -> Path:
    """The file the user brought in, for a clip whose `src` resolves to `path`.

    When init transcodes a clip it points `src` at the conformed master and
    leaves the staged original beside it, referenced by nothing. For a master
    with exactly one `<stem>.<video ext>` sibling, that sibling is the
    original. Anything else returns `path` itself: a master whose original is
    gone is still the only copy of that footage."""
    m = _NORMALIZED_MASTER_RE.match(path.name)
    if not m:
        return path
    stem = m.group("stem")
    candidates = [
        p for p in path.parent.iterdir()
        if p.name.startswith(stem + ".")
        and p.name[len(stem):].lower() in _CLIP_EXTENSIONS
        and p.is_file()
    ]
    return candidates[0] if len(candidates) == 1 else path


def _preserve_path(raw, project_dir_resolved: Path, uploads_dir: Path,
                   preserved: dict[str, str], moved: dict[Path, str],
                   original_of=lambda p: p) -> None:
    """Keep one referenced file through the delete, recording
    `raw -> surviving path` in `preserved`.

    A file inside the project is moved into `uploads_dir`, once however many
    references name it (`moved` is shared across calls). A file outside the
    project is never moved and maps to itself; a symlink inside the project
    maps to the file it points at, since the link itself goes with the
    folder. `original_of` picks the file worth keeping for a path inside the
    project (a clip's staged original over its normalized master)."""
    if not isinstance(raw, str) or not raw or raw in preserved:
        return
    try:
        src = Path(raw)
        if not src.is_file():
            return
        real = src.resolve()
        if not _is_under(real, project_dir_resolved):
            link_dir = Path(os.path.realpath(src.parent))
            preserved[raw] = str(real) if _is_under(link_dir, project_dir_resolved) else raw
            return
        original = original_of(real)
        if original not in moved:
            moved[original] = str(_move_into_uploads(original, uploads_dir))
        preserved[raw] = moved[original]
    except Exception:
        # Best-effort: a single bad file must not block the delete.
        pass


def _preserve_clips(proj: dict, project_dir_resolved: Path, uploads_dir: Path,
                    preserved: dict[str, str], moved: dict[Path, str]) -> None:
    """Keep every video item's footage (`sources` and every track) through the
    delete. Derived files (`proxySrc`, `normalizedSrc`, a normalized master
    whose original is beside it) are not kept: the next create rebuilds them
    from the original."""
    for item in _look_migration_items(proj):
        _preserve_path(item.get("src"), project_dir_resolved, uploads_dir,
                       preserved, moved, original_of=_clip_original)


def _audio_paths(proj: dict) -> list:
    """Every audio file the user brought in: an uploaded music track
    (`storyboard.music.path`), the voiceover and its takes, and every audio
    track item's `src`. A described track has no file and adds nothing."""
    paths: list = []
    music = (proj.get("storyboard") or {}).get("music")
    if isinstance(music, dict):
        paths.append(music.get("path"))
    voiceover = proj.get("voiceover")
    if isinstance(voiceover, dict):
        paths.append(voiceover.get("src"))
        paths.extend(voiceover.get("takes") or [])
    audio = proj.get("audio")
    if isinstance(audio, dict):
        for item in audio.get("tracks") or []:
            if isinstance(item, dict):
                paths.append(item.get("src"))
    return paths


def _preserve_audio(proj: dict, project_dir_resolved: Path, uploads_dir: Path,
                    preserved: dict[str, str], moved: dict[Path, str]) -> None:
    """Keep uploaded music and voiceover files through the delete, by the same
    rules as clips (`_preserve_path`)."""
    for raw in _audio_paths(proj):
        _preserve_path(raw, project_dir_resolved, uploads_dir, preserved, moved)


@router.delete("/projects/{project_id}")
async def delete_project(
    project_id: str,
    preserve_assets: bool = False,
    project_dir: Path = Depends(get_project_dir),
    request: Request = None,
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
    we still rmtree the project. For image and style refs the preserved map
    only includes files that were successfully moved.

    Clips are kept too (`_preserve_clips`): every video item's `src`, across
    `sources` and all tracks, so going back to setup never loses footage. A
    clip outside the project maps to itself (a symlink inside it, to its
    target) and is never moved.

    Uploaded audio is kept by the same rules (`_preserve_audio`): an uploaded
    music track, the voiceover and its takes, and every audio track item.

    §126 (b), first of all: another project using files in this one keeps
    them (`_rescue_dependents`), or nothing is deleted (409).
    """
    from fastapi.responses import Response
    broadcaster = getattr(getattr(getattr(request, "app", None), "state", None), "broadcaster", None)
    # §482: the project itself, and every other project the rescue would patch, against open Studio sync clashes.
    headers = getattr(request, "headers", None)
    who = save_guard.sync_who(headers)
    save_guard.check_sync(who, project_id, everything=True)
    dependents = _dependents_of(project_id, project_dir)
    for other_id, _folder, _other, _wanted in dependents:
        save_guard.check_sync(who, other_id, _SAVE_MEDIA_KEYS)
    await _rescue_dependents(project_id, project_dir, broadcaster, dependents=dependents, who=who)
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
                            preserved[raw] = str(_move_into_uploads(src, uploads_dir))
                        except Exception:
                            # Best-effort: a single bad file must not block the delete.
                            pass

                moved: dict[Path, str] = {}
                _preserve_clips(proj, project_dir.resolve(),
                                resolve_workspace() / "_uploads", preserved, moved)
                _preserve_audio(proj, project_dir.resolve(),
                                resolve_workspace() / "_uploads", preserved, moved)
            except Exception:
                # If project.json is unparseable, fall through to the delete.
                pass

    # §126: while the folder is removed, a save's copy into it stops (no
    # assets/ made again, no copy named or recorded) and its patch is skipped.
    with project_deleting(project_dir):
        # PL28: stop a YouTube download first, so yt-dlp is not writing into the
        # folder being removed.
        await _cancel_source_download(project_id)
        try:
            await _remove_project_dir(project_dir)
        except OSError as e:
            raise server_error("delete_failed", f"Couldn't delete this project: {e}")

    if preserve_assets:
        return {"preserved": preserved}
    return Response(status_code=204)


_DELETE_RETRY_SECONDS = (0.1, 0.1, 0.1)


def _dependents_of(project_id: str, project_dir: Path) -> "list[tuple[str, Path, dict, dict]]":
    """(id, folder, project, `{key: src}`) for every other project in the
    workspace with entries pointing at files inside `project_dir`
    (`borrowed_from`, the save's own rules for what a project borrows). A
    project.json that cannot be read is skipped, as the list skips it."""
    workspace = resolve_workspace()
    try:
        doomed = project_dir.resolve()
    except OSError:
        doomed = project_dir
    out = []
    for path in workspace.rglob("project.json"):
        if is_nested_project_json(path, workspace):
            continue
        folder = path.parent
        try:
            if folder.resolve() == doomed:
                continue
            other = json.loads(path.read_text())
        except (OSError, ValueError, RecursionError):
            continue
        if not isinstance(other, dict) or other.get("id") == project_id:
            continue
        other = normalize_tracks(other)
        wanted = borrowed_from(other, folder, project_dir, workspace)
        if wanted:
            out.append((other.get("id"), folder, other, wanted))
    return out


async def _rescue_dependents(project_id: str, project_dir: Path, broadcaster: "SSEBroadcaster | None",
                             *, dependents=None, who=None) -> None:
    """§126 (b): before a project's folder goes, every other project that
    points at files in it gets its own copies, the way a save copies borrowed
    media (`copy_borrowed_media`, then `_finish_save_copy`'s patch of just
    those entries, announced to an open editor). Measured 2026-10-07: a
    project's outro sound pointed into another project's folder, that project
    was deleted, and the render failed. A save copies new borrowed paths since
    5.24.15; this covers paths saved before that, and anything written past a
    save.

    Unlike a save, the delete waits for every copy to end: the folder must
    outlive them. Nothing is deleted (409) when a dependent is rendering (its
    render already resolved these paths) or when a file could not be copied
    (over the cap, short of disk, an error): the dependent would break. The
    copies already made stay; they are harmless."""
    if dependents is None:
        dependents = _dependents_of(project_id, project_dir)
    if not dependents:
        return
    rendering = [d for d in dependents if d[0] in _active_renders]
    if rendering:
        name = rendering[0][2].get("name") or rendering[0][0]
        raise HTTPException(409, detail={
            "error": "in_use_by_render",
            "message": f"\"{name}\" uses files in this project and is rendering. Try again when it finishes.",
        })
    left: list[str] = []
    for other_id, folder, other, wanted in dependents:
        begin_copies(folder, wanted)   # ended by `_finish_save_copy`, however the copy ends
        task = asyncio.ensure_future(asyncio.to_thread(copy_borrowed_media, wanted, folder))
        _save_copy_tasks.add(task)
        task.add_done_callback(_save_copy_tasks.discard)
        await asyncio.wait({task})
        patched, report = await _finish_save_copy_async(
            other_id, folder, other, wanted, set(wanted), task, broadcaster, who=who)
        if patched is not None and broadcaster is not None:
            _late_save_follow_ups(other_id, folder, other, patched, broadcaster)
        if report.get("warnings"):
            left.append(other.get("name") or other_id)
        print(f"[montaj] delete_project {project_id}: copied {len(report.get('copied', []))} file(s) into "
              f"{other_id}, which used them")
    if left:
        raise HTTPException(409, detail={
            "error": "in_use_not_copied",
            "message": f"\"{left[0]}\" uses files in this project that could not be copied into it, "
                       "so nothing was deleted.",
        })


async def _remove_project_dir(project_dir: Path) -> None:
    """rmtree_force, tried again a few times while the folder is "not empty":
    an entry landed in it while it was being removed (a copy a save started
    before the delete, any other writer), so a delete never leaves half a
    project."""
    for pause in (*_DELETE_RETRY_SECONDS, None):
        try:
            rmtree_force(project_dir)
            return
        except OSError as e:
            if pause is None or e.errno not in (errno.ENOTEMPTY, errno.EEXIST):
                raise
        await asyncio.sleep(pause)


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
        args = [node_bin, str(render_script), "--project-json", str(render_input), "--pdf"]
        if scale is not None:
            args += ["--scale", str(scale)]
        env = node_child_env()
        env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(MONTAJ_ROOT),
            env=env,
            **_detached_kwargs(),
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


def _new_or_changed_video_items(previous: dict, merged: dict) -> list[dict]:
    """Video items (across `tracks` and the `sources` bin — the same two
    groups `_look_migration_items` walks) that are NEW in `merged` or whose
    `src` CHANGED, compared with `previous` (the project as it was on disk
    before this write). Matched by id — the same key `_apply_project_edits`
    write-backs match on — so an item that lands on the same (id, src) it had
    before is never returned even if some OTHER field on it changed.

    An item's `tracks` placement and its `sources` bin twin share the same id
    and src (see `_look_migration_items`'s docstring); the first occurrence
    wins and the twin is skipped, so the caller gets one entry per clip.
    """
    prev_src_by_id: dict[str, str] = {}
    for item in _look_migration_items(previous):
        item_id = item.get("id")
        if item_id is not None:
            prev_src_by_id[item_id] = item.get("src")

    changed: list[dict] = []
    seen: set = set()
    for item in _look_migration_items(merged):
        item_id = item.get("id")
        if item_id in seen:
            continue
        if item_id not in prev_src_by_id or prev_src_by_id[item_id] != item.get("src"):
            changed.append(item)
            seen.add(item_id)
    return changed


async def _queue_previews_for_changed_items(
    project_id: str,
    project_dir: Path,
    previous: dict,
    merged: dict,
    broadcaster: "SSEBroadcaster | None",
) -> None:
    """Best-effort: queue an editor preview (proxy) for every video item this
    save just added or repointed. The save-side counterpart to POST
    /sources's import-time queueing (`_run_ingest_detached`): without this, a
    clip an agent places via a PUT (as opposed to dragging it in through
    import) never gets a proxy queued, so the editor's engine player blocks on
    it forever (`picture = 'preparing'`, `scheduler.ts`'s `engineSrcFor`) until
    someone clicks "Generate previews" by hand.

    Reuses `_ensure_current_proxies`'s own dedupe/skip-if-current logic by
    handing it a cut-down project containing ONLY the new/changed items
    (`_new_or_changed_video_items`), so:
      * an item that already has a current, fresh proxy is not re-queued —
        `is_proxy_fresh` inside `_ensure_current_proxies` decides that; this
        function never duplicates the check.
      * an UNCHANGED item is never even considered, so resaving an old
        project (a rename, a status flip, moving a clip that already has a
        proxy) never starts encoding its whole library — this is what keeps
        "never scheduled from open" (`_migrate_project_look`'s deliberate
        adopt-only behaviour) true for save too.
      * non-video items (images, audio, overlays) are excluded by
        `_look_migration_items` itself, exactly as they are for import.

    Only ever QUEUES — `_ensure_current_proxies` never awaits an encode — and
    never raises: any failure here is logged and swallowed so a save can never
    fail, or even slow down, over this housekeeping.

    Async (PV57 review): `_ensure_current_proxies`'s own probes
    (`_proxy_input_for`) run synchronously, ON the event loop. Warming first,
    off the loop, means the sync pass that follows hits the probe cache/hold
    instead of blocking the loop itself — the same ordering every other
    `_ensure_current_proxies` caller uses (open, "Generate previews", the
    look-migration queue). Without it, a single new item on a stalled file
    blocked serve for about a minute (two 30 s ffprobe tries) on every save.
    """
    try:
        changed_items = _new_or_changed_video_items(previous, merged)
        if not changed_items:
            return
        await _warm_proxy_inputs(it["src"] for it in changed_items if isinstance(it.get("src"), str))
        cutdown = {
            "tracks": [{"id": "t0", "items": changed_items}],
            "sources": [],
            "settings": merged.get("settings"),
        }
        await _ensure_current_proxies_async(project_id, project_dir, cutdown, broadcaster)
    except Exception as e:
        print(f"[montaj] save_project: could not queue previews for {project_id}: {e}")


_SAVE_MEDIA_KEYS = ("tracks", "sources", "assets", "audio")
_SAVE_REPORT_KEYS = ("copied", "warnings")
"""The answer's own fields (§126). Dropped from a body before the merge, so an
editor or agent that saves an answer back never stores them."""
_SAVE_COPY_WAIT_SECONDS = 30.0
"""How long a save waits for the patch of its copies of borrowed media (§126)
before it answers without them. The copy goes on, and its own completion runs
the patch whenever it finishes, also after the request went away."""
_save_copy_tasks: set = set()
"""Every copy a save started, and every late patch's follow-ups, kept until
they finish (a save may stop waiting, or its request may go away)."""


def _plan_save_media(
    project_id: str, existing: dict, merged: dict, project_dir: Path, carries_media: bool,
) -> "tuple[dict, dict]":
    """(`plan_borrowed_media`'s `{key: src}`, the project's earlier failed
    copies it looked at again, `{key: src}`). Nothing when the save carries no
    media key and the project has no failed copy to try again, or when the
    check fails, the workspace's own lookup included (the save never fails
    over it)."""
    try:
        pending = pending_media(project_dir)
        if not carries_media and not pending:
            return {}, {}
        return plan_borrowed_media(existing, merged, project_dir, resolve_workspace(), pending), pending
    except Exception as e:
        print(f"[montaj] save_project: could not check borrowed media for {project_id}: {e}")
        return {}, {}


_PATCH_GONE = "gone"
# The report's private key for the text the patch re-read (§477); a save pops it
# before answering, so it never reaches a client or project.json.
_PATCH_READ_KEY = "_patchRead"
_PATCH_UNREADABLE = "unreadable"
_PATCH_OTHER_PROJECT = "other project"
# §482: the patch would change a field in an open Studio sync clash; kept, like an unreadable file, for the next save.
_PATCH_SYNC_CLASH = "sync clash"


def _patch_copied_media(
    project_path: Path, previous: dict, made: dict, also=(), project_id: "str | None" = None, *, who=None,
) -> "tuple[dict, str, list, str] | str | None":
    """The patch (§126): re-read project.json (in the current tracks shape,
    whatever another writer left), point each entry that is new or changed
    against `previous` (the project before the save), or holds a file of
    `also` (tried again by this save), and still holds a copied file's path at
    its copy, and write. No await between the read and the write, as
    `_apply_project_edits`, and the save's body is never merged again, so a
    write that landed during the copy (an ingest, another save) is kept. None
    when nothing is left to swap; nothing written, and `_PATCH_GONE` when
    project.json is gone, `_PATCH_UNREADABLE` when it can't be read (another
    program part way through writing it: the copies are kept to try again),
    `_PATCH_OTHER_PROJECT` when it is now another project (its id is not
    `project_id`). The tuple's last item is the text the patch re-read (§477:
    a save compares it with the text it wrote, to know whether another write
    landed in between)."""
    with project_lock(project_path):
        try:
            read_text = project_path.read_text()
            project = json.loads(read_text)
        except FileNotFoundError:
            return _PATCH_GONE
        except (OSError, ValueError, RecursionError):
            return _PATCH_UNREADABLE
        if not isinstance(project, dict):
            return _PATCH_UNREADABLE
        if project_id is not None and project.get("id") != project_id:
            return _PATCH_OTHER_PROJECT
        project = normalize_tracks(project)
        copied = apply_borrowed_media(previous, project, made, also)
        if not copied:
            return None
        # §482: the save's follow-up, checked as the save's writer (`who`; none is serve's own).
        if not save_guard.maintenance_allows(read_text, project, who):
            return _PATCH_SYNC_CLASH
        return project, _write_project_json(project_path, project), copied, read_text


def _finish_save_copy(
    project_id: str, project_dir: Path, previous: dict, wanted: dict, also, task: "asyncio.Future",
    broadcaster: "SSEBroadcaster", *, who=None,
) -> "tuple[dict | None, dict]":
    """The copy's completion, on the event loop, once: take its result, run
    the patch, announce it like any write so an open editor picks the copies
    up, and keep what failed, or was copied but not saved, for the next save
    to try again (`settle_copies` drops only what the patch dealt with).
    Nothing at all for a project deleted meanwhile. Returns (the project as
    patched, or None when nothing was swapped; the report)."""
    settled: set = set()
    try:
        if project_gone(project_dir):
            settled = set(wanted)
            return None, {}
        return _finish_copy_and_patch(project_id, project_dir, previous, wanted, also, task, broadcaster, settled,
                                      who=who)
    finally:
        settle_copies(project_dir, wanted, settled)


_FINISH_COPY_LOCK_TRIES = 3


async def _finish_save_copy_async(
    project_id: str, project_dir: Path, previous: dict, wanted: dict, also, task: "asyncio.Future",
    broadcaster: "SSEBroadcaster", *, who=None,
) -> "tuple[dict | None, dict]":
    """`_finish_save_copy` under the async project lock (its patch takes the
    lock; a done-callback or a handler on the loop must not block on it). A lock
    that stays busy is tried a few times; then the copies are kept to try again
    at the next save and the report says so. Never raises over the lock."""
    project_path = Path(project_dir) / "project.json"
    for _ in range(_FINISH_COPY_LOCK_TRIES):
        try:
            async with project_lock_async(project_path):
                return _finish_save_copy(project_id, project_dir, previous, wanted, also, task, broadcaster, who=who)
        except ProjectLockTimeout:
            continue
    print(f"[montaj] save_project: project busy, could not save the copied paths for {project_id}")
    retry_later(project_dir, wanted)
    settle_copies(project_dir, wanted, set())
    return None, {"warnings": [
        f"Copied into the project but not saved: {src} (the project was busy), so the project still depends on it."
        for src in wanted.values()
    ]}


def _finish_copy_and_patch(
    project_id: str, project_dir: Path, previous: dict, wanted: dict, also, task: "asyncio.Future",
    broadcaster: "SSEBroadcaster", settled: set, *, who=None,
) -> "tuple[dict | None, dict]":
    """`_finish_save_copy`'s work; adds to `settled` the keys the patch dealt with."""
    if task.cancelled() or task.exception() is not None:
        why = "the copy was cancelled" if task.cancelled() else task.exception()
        print(f"[montaj] save_project: could not copy borrowed media for {project_id}: {why}")
        made, warnings = {}, [
            f"Not copied into the project: {src} ({why}), so the project still depends on it."
            for src in wanted.values()
        ]
        retry_later(project_dir, wanted)
    else:
        made, warnings = task.result()
    patched, report = None, {}
    if made:
        failed: dict = {}
        why = None
        try:
            result = _patch_copied_media(project_dir / "project.json", previous, made, also, project_id, who=who)
        except Exception as e:
            print(f"[montaj] save_project: could not save the copied paths for {project_id}: {e}")
            result, why = None, e
            failed = {key: src for key, src in wanted.items() if key in made}
        if result is _PATCH_GONE or result is _PATCH_OTHER_PROJECT:
            settled.update(wanted)
            result = None
        elif result is _PATCH_UNREADABLE or result is _PATCH_SYNC_CLASH:
            why = ("project.json could not be read" if result is _PATCH_UNREADABLE
                   else "the project has an open Studio sync clash")
            failed = {key: src for key, src in wanted.items() if key in made}
            result = None
        elif why is None:
            settled.update(made)
        if failed:
            warnings = warnings + [
                f"Copied into the project but not saved: {src} ({why}), so the project still depends on it."
                for src in failed.values()
            ]
            retry_later(project_dir, failed)
        if result is not None:
            patched, text, report["copied"], report[_PATCH_READ_KEY] = result
            try:
                broadcaster.publish(project_id, _sse_data_frame(text))
            except Exception as e:   # written all the same: the report still says so
                print(f"[montaj] save_project: could not announce the copied paths for {project_id}: {e}")
    if warnings:
        report["warnings"] = warnings
    if report:
        print(f"[montaj] save_project {project_id}: copied {len(report.get('copied', []))} borrowed "
              f"file(s), {len(warnings)} left in place")
    return patched, report


def _late_save_follow_ups(
    project_id: str, project_dir: Path, previous: dict, patched: dict, broadcaster: "SSEBroadcaster",
) -> None:
    """What `save_project` does after an in-time patch (queue previews for the
    items it repointed, probe their dims), for a patch that came after the
    save answered: a preview queued for the borrowed path would never land,
    since `_apply_project_edits` matches an item by id AND src. Detached."""
    async def run():
        try:
            await _queue_previews_for_changed_items(project_id, project_dir, previous, patched, broadcaster)
            await ensure_source_dims(project_id, project_dir, patched, broadcaster)
        except Exception as e:
            print(f"[montaj] save_project: follow-ups of a late copy failed for {project_id}: {e}")

    task = asyncio.ensure_future(run())
    _save_copy_tasks.add(task)
    task.add_done_callback(_save_copy_tasks.discard)


async def _copy_and_patch_media(
    project_id: str, project_dir: Path, previous: dict, wanted: dict, also, broadcaster: "SSEBroadcaster",
    follow_ups: bool, on_late=None, *, who=None,
) -> "tuple[dict | None, dict]":
    """After the save's own write: copy `wanted` into the project off the
    event loop, with no lock. The copy's completion runs the patch
    (`_finish_save_copy`) on the loop, exactly once, whenever it finishes,
    and the save waits at most `_SAVE_COPY_WAIT_SECONDS` for that same patch.
    One that comes later (past the wait, or after the request went away) is
    saved and announced all the same, and then runs the save's follow-ups on
    the patched project when `follow_ups`. Returns (the project as patched,
    or None when nothing was swapped in time; the report for the answer).
    `on_late` is called when the save answers before the patch (§477: the
    answer's revisions are then not final). Never raises over the copy: the
    save already stands."""
    outcome = asyncio.get_running_loop().create_future()
    late = False

    async def finish(task):
        try:
            result = await _finish_save_copy_async(project_id, project_dir, previous, wanted, also, task, broadcaster,
                                                   who=who)
        except Exception as e:
            print(f"[montaj] save_project: could not finish copying borrowed media for {project_id}: {e}")
            result = (None, {"warnings": [
                f"Not copied into the project: {src} ({e}), so the project still depends on it."
                for src in wanted.values()
            ]})
        outcome.set_result(result)
        if late and follow_ups and result[0] is not None:
            _late_save_follow_ups(project_id, project_dir, previous, result[0], broadcaster)

    def finished(task):
        # A done-callback cannot await the lock: a small task takes it and runs the patch.
        finisher = asyncio.ensure_future(finish(task))
        _save_copy_tasks.add(finisher)
        finisher.add_done_callback(_save_copy_tasks.discard)

    begin_copies(project_dir, wanted)   # ended by `_finish_save_copy`, however the copy ends
    task = asyncio.ensure_future(asyncio.to_thread(copy_borrowed_media, wanted, project_dir))
    _save_copy_tasks.add(task)
    task.add_done_callback(_save_copy_tasks.discard)
    task.add_done_callback(finished)   # before any await: the patch runs however this ends
    try:
        return await asyncio.wait_for(asyncio.shield(outcome), _SAVE_COPY_WAIT_SECONDS)
    except asyncio.TimeoutError:
        if outcome.done():
            return outcome.result()
        late = True
        if on_late is not None:
            on_late()
        return None, {"warnings": [
            f"Still copying into the project after {_SAVE_COPY_WAIT_SECONDS:g} s: {src}; saved with this "
            "path for now, and with the copy's once it is done." for src in wanted.values()
        ]}
    except asyncio.CancelledError:
        if not outcome.done():
            late = True
        elif follow_ups and outcome.result()[0] is not None:
            # Patched, and then the request went away before the save resumed.
            _late_save_follow_ups(project_id, project_dir, previous, outcome.result()[0], broadcaster)
        raise


def _merged_for_save(existing: dict, body: dict, *, drop_nulls: bool = False) -> dict:
    """The document a save writes: `existing` with `body` (its report keys already dropped) merged in, every
    rewrite the save makes applied. Pure: reads and writes nothing, so it runs before the checks. `drop_nulls`
    (a trusted Studio sync pull only) drops every top-level key the body sends as null."""
    # Top-level shallow merge: preserve fields not present in the body. Agents
    # (per skills/native/SKILL.md) routinely PUT a partial body like
    # {id, status, tracks} when transitioning pending→draft; without this merge
    # creation-time metadata (name, workflow, editingPrompt, projectType,
    # runCount, settings, profile, …) gets wiped. To explicitly clear a field,
    # callers must send it as null in the body.
    # The answer's own fields (§126: `copied`, `warnings`) never reach
    # project.json, even from a client that saves an answer back.
    merged = {**existing, **body}
    # The editor deletes its last marker/note by sending `markers: null` /
    # `notes: null` (an omitted key would keep the old list through the merge
    # above). Drop the key so a project with none is stored without one.
    # §482: the app's Studio sync pull sends null for every field the merged head
    # no longer has, and the field is deleted, not stored as null (top level only).
    for _key, _value in body.items():
        if _value is None and (drop_nulls or _key in ("markers", "notes")):
            merged.pop(_key, None)
    # Agents routinely PUT a still-legacy `tracks` shape (or a whole project
    # they hand-built). Normalize before writing so a server write never leaves
    # legacy tracks on disk: a no-op (same object back) when already
    # normalized or when `tracks` is absent/null, so the shallow-merge and
    # explicit-null-clears-a-field semantics above are untouched.
    merged = converge(merged)
    # A save that picks a resolution or fps is the user's (or an agent's) choice: pin it
    # so footage never overrides it. A body whose settings leave the
    # marker out keeps the stored one.
    if isinstance(body.get("settings"), dict) and isinstance(merged.get("settings"), dict):
        old_settings = existing.get("settings") if isinstance(existing.get("settings"), dict) else {}
        new_settings = dict(merged["settings"])
        if "resolution" in new_settings and new_settings["resolution"] != old_settings.get("resolution"):
            new_settings["resolutionSource"] = SOURCE_EXPLICIT
        if "fps" in new_settings and new_settings["fps"] != old_settings.get("fps"):
            new_settings["fpsSource"] = SOURCE_EXPLICIT
        # §378: choosing a colour space is the creator's; footage never overrides it.
        if "colorSpace" in new_settings and new_settings["colorSpace"] != old_settings.get("colorSpace"):
            new_settings["colorSpaceSource"] = "explicit"
        for marker in ("resolutionSource", "fpsSource", "aspectSource", "colorSpaceSource"):
            if marker not in new_settings and marker in old_settings:
                new_settings[marker] = old_settings[marker]
        merged["settings"] = new_settings
    return merged


@router.put("/projects/{project_id}")
async def save_project(project_id: str, response: Response, body: dict = Body(...), request: Request = None, project_dir: Path = Depends(get_project_dir)):
    save_started = time.perf_counter()
    if body.get("id") != project_id:
        raise bad_request("id_mismatch", "Body id must match URL id")
    project_path = project_dir / "project.json"
    # The read-merge-write is one section under the project lock (§467): a step in
    # another process rewrites project.json too. No await inside it; the SSE
    # broadcast and the follow-ups run after it is released.
    async with project_lock_async(project_path):
        raw = project_path.read_text()
        existing = json.loads(raw)
        headers = getattr(request, "headers", None)
        # Computed before any check: the merge reads nothing and writes nothing, and the sync check below needs
        # the document exactly as it will be written.
        named = save_guard.changed_fields(body)
        body = {key: value for key, value in body.items() if key not in _SAVE_REPORT_KEYS}
        merged = _merged_for_save(existing, body,
                                  drop_nulls=save_guard.sync_origin_of(headers) == save_guard.SYNC_ORIGIN)
        # §482: a field in an open Studio sync clash refuses the whole save, from anyone but a person, before
        # the revisions are compared. Every field the write really changes counts, not only the body's: a
        # normalisation of a legacy `tracks` the body never named is still a write of `tracks` (review 40, 1).
        # Nothing is read or compared unless the app named its sync state folder.
        save_guard.check_sync_document(headers, project_id, existing, merged, named)
        # §477: a stale or unread field refuses the whole save here, before anything is
        # merged or written. None (and no answer headers) unless the app switched it on.
        # (`body` without its report keys: check_save never counts them as fields either.)
        verdict = save_guard.check_save(headers, body, raw, existing, project=str(project_path))
        prev_status = existing.get("status")
        # Overlay items are checked only when this save carries `tracks`: a delta
        # that leaves tracks alone (a status flip, a rename) must not start failing
        # over an item already on disk. Nothing is written when an item is wrong,
        # and every problem is named in `message`, which is the one field the MCP
        # clients show the agent. Only NEW or CHANGED items are checked (against
        # `existing`, the project as it was before this PUT) — otherwise an item
        # already broken on disk before this validator existed would block every
        # future save of the project forever, even one that doesn't touch it.
        if "tracks" in body:
            overlay_errors = overlay_item_errors(merged, previous=normalize_tracks(existing))
            if overlay_errors:
                raise HTTPException(400, detail={
                    "error": "invalid_overlay_items",
                    "message": "Project not saved. Fix these overlay items: " + "; ".join(overlay_errors),
                    "errors": overlay_errors,
                })
        # §559: an audio entry with no string `src` crashes every render. A new one, or a src taken away, is refused;
        # an old entry that already had none never blocks a save (changed, it saves with a warning).
        audio_warnings = []
        if "audio" in body:
            audio_errors, audio_warnings = audio_track_check(merged, previous=existing)
            if audio_errors:
                raise HTTPException(400, detail={
                    "error": "invalid_audio_tracks",
                    "message": "Project not saved. " + "; ".join(audio_errors),
                    "errors": audio_errors,
                })
        # §126: a new or changed media path into another project's folder, the
        # import staging area or uploads is copied into this project, so deleting
        # that other project (or sweeping the staging area) can never break this
        # one (serve/save_media.py has the rule). Deciding takes stat calls only.
        # The save itself is written as it always was, borrowed paths and all,
        # with no await between its read and its write, and with nothing to copy
        # (the usual save) that is all. Otherwise the copy runs after the write,
        # off the loop and with no lock, and its own completion runs a second
        # synchronous read-modify-write that swaps only the copied paths
        # (`_patch_copied_media`), so a write that landed meanwhile (an ingest,
        # another save) is kept. The answer waits up to _SAVE_COPY_WAIT_SECONDS
        # for that patch; a later one still lands. A copy not saved before (it
        # failed, the project was unreadable at its patch, or serve stopped
        # mid-copy) is tried again here (`pending`), whatever this save carries,
        # unless it is still running in this process. Best-effort:
        # the save never fails over it; the answer says what it did.
        wanted, pending = _plan_save_media(
            project_id, existing, merged, project_dir, any(key in body for key in _SAVE_MEDIA_KEYS))
        text = _write_project_json(project_path, merged)
    if pending:
        # Kept until this save's patch deals with them; one no entry holds, or
        # no longer borrowed, has nothing left to do.
        forget_pending(project_dir, set(pending) - set(wanted))
    retrying = set(wanted) & set(pending)
    # Broadcast immediately — before the git commit so the UI update is instant.
    # Don't rely on the file watcher which can miss updates during SSE reconnect windows.
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    # One publish, so the stamp (a trusted Studio sync pull only) and its frame stay adjacent.
    broadcaster.publish(project_id, save_guard.writer_stamp(verdict) + _sse_data_frame(text))
    # Only relevant when this body could have touched a video item's (id, src),
    # or a copy tried again may repoint one.
    follow_ups = "tracks" in body or "sources" in body or bool(retrying)
    current, media_report = merged, {}
    copy_pending = []
    if wanted:
        patched, media_report = await _copy_and_patch_media(
            project_id, project_dir, existing, wanted, retrying, broadcaster, follow_ups,
            on_late=lambda: copy_pending.append(True), who=save_guard.sync_who(getattr(request, "headers", None)))
        current = patched if patched is not None else merged
    patch_read = media_report.pop(_PATCH_READ_KEY, None) if media_report else None
    if current is not merged and patch_read != text:
        # The patch re-read a file another write had changed since this save wrote it (a
        # human edit during the copy): its revisions are not this writer's to hold. Answer
        # what this save wrote, not final, so the caller re-reads before it saves again.
        save_guard.answer_headers(response, verdict, existing, merged, text, final=False)
    else:
        # A patch that landed is a file version of its own: hashed from the document, not `text`.
        save_guard.answer_headers(response, verdict, existing, current,
                                  text if current is merged else None, final=not copy_pending)
    # Queue editor previews (proxies) for whatever video items this save just
    # added or repointed — an agent placing a clip via PUT (the only way a
    # clip's src reaches disk outside of import) must not leave it stuck on
    # "Preparing preview…" until someone clicks "Generate previews" by hand.
    if follow_ups:
        await _queue_previews_for_changed_items(project_id, project_dir, existing, current, broadcaster)
    # Probe dims for clips this save wrote without them. Detached: the PUT never
    # waits on ffprobe; the heal's SSE frame updates an open editor.
    if follow_ups:
        dims_task = asyncio.create_task(ensure_source_dims(project_id, project_dir, current, broadcaster))
        _source_dims_task_refs.add(dims_task)
        dims_task.add_done_callback(_source_dims_task_refs.discard)
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
    response.headers["Server-Timing"] = f"save;dur={int(round((time.perf_counter() - save_started) * 1000.0))}"
    if audio_warnings:
        media_report = {**media_report, "warnings": [*audio_warnings, *media_report.get("warnings", [])]}
    # The report rides on the answer only, never in project.json.
    return {**current, **media_report} if media_report else current


@router.get("/projects/{project_id}/generated")
async def list_generated(project_id: str, project_dir: Path = Depends(get_project_dir)):
    """The project's files an AI provider made (serve/provenance.py):
    `{"dir": the project folder, "generated": {path relative to it: {provider,
    model, prompt, step, at}}}`, so a host can join the record to the items'
    absolute `src`. `generated` is empty when nothing was recorded. It is the
    ai entries of the project's provenance record, `.provenance.json`'s and the
    older `.generated.json`'s (`provenance.generated`), leaving out any whose
    file is gone or changed size since (GET .../provenance marks those `stale`).
    Read in a thread: it stats every entry's file."""
    return {"dir": str(project_dir), "generated": await asyncio.to_thread(provenance.generated, project_dir)}


def _provenance_refused(e: ValueError) -> HTTPException:
    """A provenance path or entry the record refuses (ProvenanceError), or a
    `provenance` field that is not JSON: 422 naming why."""
    if isinstance(e, provenance.ProvenanceError):
        return HTTPException(422, detail={"error": e.code, "message": str(e)})
    return HTTPException(422, detail={"error": "invalid_entry", "message": f"provenance must be a JSON object: {e}"})


@router.get("/projects/{project_id}/provenance")
async def get_provenance(project_id: str, project_dir: Path = Depends(get_project_dir)):
    """Where each file in the project came from (serve/provenance.py):
    `{"dir": the project folder, "provenance": {path relative to it: {kind, at,
    ...}}}`. `.provenance.json`'s entries, plus the older `.generated.json`'s as
    kind `ai` for each path the new record has none for. An entry whose file is
    gone or changed size since it was recorded says `stale: true` (it is kept;
    the file it described is not the one there now). A file with no entry is
    untagged. Read in a thread: it stats every entry's file."""
    return {"dir": str(project_dir), "provenance": await asyncio.to_thread(provenance.annotated, project_dir)}


@router.post("/projects/{project_id}/provenance")
async def record_project_provenance(project_id: str, request: Request, body: dict = Body(...),
                                    project_dir: Path = Depends(get_project_dir)):
    """Record where one file in the project came from. Body: `{"path": relative
    to the project folder or absolute inside it, "entry": {kind, ...}}` (the
    kinds and their fields: serve/provenance.py). The app records its own
    imports this way (user, library, template, brand_kit, montaj, web). Answers
    `{path: the record's key, entry: as stored}`; a path outside the project or
    an entry the record refuses, or a file that does not exist, is a 422 naming
    why.

    The app's, never the AI's (`save_guard.require_shell`): with the guard on,
    only the window (writer `editor`) and the app's main process (writer `tool`)
    may record; an AI caller, or one without the launch secret, is 403. Not
    `require_editor`, which would refuse the main process's own import paths."""
    save_guard.require_shell(getattr(request, "headers", None))
    # §482: the record is a project file; one in an open Studio sync clash is refused for plain tool too.
    save_guard.check_sync(getattr(request, "headers", None), project_id,
                          files=[f"{provenance.ASSETS_DIR}/{provenance.RECORD_NAME}"])
    try:
        entry = provenance.validate_entry(body.get("entry"))
        key, stored = await asyncio.to_thread(provenance.record_provenance, project_dir, body.get("path"), entry)
    except provenance.ProvenanceError as e:
        raise _provenance_refused(e)
    return {"path": key, "entry": stored}


@router.get("/projects/{project_id}/versions")
async def list_versions(project_id: str, project_dir: Path = Depends(get_project_dir)):
    def _git_log():
        result = subprocess.run(
            ["git", *GIT_SAFE_FLAGS, "log", "--pretty=format:%H|%s|%aI", "--", "project.json"],
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
            ["git", *GIT_SAFE_FLAGS, "log", "--pretty=format:%H|%s|%aI", "--", "project.json"],
            cwd=str(project_dir), capture_output=True, text=True,
        )
        versions = []
        for line in result.stdout.strip().splitlines():
            parts = line.split("|", 2)
            if len(parts) == 3:
                versions.append({"hash": parts[0], "message": parts[1], "timestamp": parts[2]})
        return versions

    return await asyncio.to_thread(_git_log)


def _restore_under_lock(project_dir: Path, restored: dict, headers=None, project_id=None) -> None:
    """A restore's write, blocking (call via asyncio.to_thread): the autosave and the write
    in one hold of the project lock, keeping the current notes."""
    project_path = project_dir / "project.json"
    with project_lock(project_path):
        # §482: a restore replaces the whole project: refused while any clash is open, but for a person's.
        save_guard.check_sync(headers, project_id, everything=True)
        try:
            current_project = json.loads(project_path.read_text())
        except (OSError, ValueError):
            current_project = {}
        if not isinstance(current_project, dict):
            current_project = {}
        run_count = current_project.get("runCount", 1)
        _git_commit_sync(project_dir, f"version: run {run_count} — autosave before restore")
        if current_project.get("notes"):
            restored["notes"] = current_project["notes"]
        else:
            restored.pop("notes", None)
        # A restore never takes a project back to pending (the "No AI connected yet" overlay): the
        # current status stays when the version's is pending and the current one is not.
        cur = current_project.get("status")
        if restored.get("status") == "pending" and cur not in (None, "pending"):
            restored["status"] = cur
        _write_project_json(project_path, restored)


_COMMIT_RE = re.compile(r"^[0-9a-f]{4,64}$")


@router.post("/projects/{project_id}/versions/{commit}/restore")
async def restore_version(project_id: str, commit: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    # low 17: `commit` is handed to `git show <commit>:project.json`; a git revision expression could name
    # another ref or run a pager. Require a plain hex sha.
    if not _COMMIT_RE.fullmatch(commit):
        raise bad_request("invalid_commit", "commit must be a hex sha")
    # §477: a restore replaces the whole project with no compare, so it is the human's.
    save_guard.require_editor(getattr(request, "headers", None))
    project_path = project_dir / "project.json"
    proc = await asyncio.create_subprocess_exec(
        "git", *GIT_SAFE_FLAGS, "show", f"{commit}:project.json",
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
    # restored version is already normalized, matching save_project's rule. The retired shapes converge too
    # (lib/project_migrate.py): every old Lyric video project's history predates their retirement.
    restored = converge(restored)
    # One lock hold, off the event loop: read the project, commit it as the "autosave before
    # restore" version (in the current run's history), then write the restored one. A
    # commit taken before the lock would let an edit land between the two and be lost from
    # history (§477). _git_commit_sync is no-op-safe, so the autosave is a new version only
    # when the working tree has uncommitted edits.
    # Notes are the operator's private review notes, not version content: a restore keeps
    # the current ones rather than swapping in the old commit's (§467).
    await asyncio.to_thread(_restore_under_lock, project_dir, restored, getattr(request, "headers", None), project_id)
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    broadcaster.publish(project_id, f"data: {json.dumps(restored)}\n\n")
    return restored


def _frame_headers(cache_control: str, png: Path) -> dict:
    """Response headers for a version frame. When the sampler clamped the time to
    the version's last frame it left ``<png>.clamped.json``; its ``end`` becomes
    ``X-Montaj-Frame-End`` (seconds). A missing or malformed sidecar adds nothing."""
    headers = {"Cache-Control": cache_control}
    try:
        end = json.loads(Path(f"{png}.clamped.json").read_text())["end"]
        if isinstance(end, (int, float)) and not isinstance(end, bool) and math.isfinite(end) and end > 0:
            headers["X-Montaj-Frame-End"] = repr(float(end))
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return headers


@router.get("/projects/{project_id}/versions/{commit}/frame")
async def version_frame(
    project_id: str,
    commit: str,
    t: float,
    request: Request = None,
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

    # low 17: `commit` reaches `git rev-parse` and `git show <commit>:project.json`; require the 'working'
    # sentinel or a plain hex sha, never an arbitrary git revision expression.
    if commit != "working" and not _COMMIT_RE.fullmatch(commit):
        raise bad_request("invalid_commit", "commit must be 'working' or a hex sha")

    is_working = commit == "working"

    # Validate the commit exists before doing anything expensive. Mirrors the
    # `git show ... returncode != 0 -> not_found` idiom in restore_version, but
    # with rev-parse we can 404 without allocating stdout bytes.
    if not is_working:
        proc = await asyncio.create_subprocess_exec(
            "git", *GIT_SAFE_FLAGS, "rev-parse", "--verify", f"{commit}^{{commit}}",
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
            headers=_frame_headers("public, max-age=31536000, immutable", cache_path),
        )

    # Heal the live project first, for the working copy only (an HDR project whose SDR clips were
    # converted in place before PV42), so a working-copy frame grades each
    # layer by its origin. Never raises.
    try:
        live = json.loads((project_dir / "project.json").read_text())
    except (OSError, ValueError):
        live = None
    if is_working and isinstance(live, dict):
        broadcaster = getattr(getattr(getattr(request, "app", None), "state", None), "broadcaster", None)
        await ensure_project_color_provenance(project_id, project_dir, live, broadcaster)

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
            "git", *GIT_SAFE_FLAGS, "show", f"{commit}:project.json",
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

    env = node_child_env()
    env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)

    cmd = [
        node_bin, str(render_script),
        "--mode", "frame",
        "--project", str(input_json),
        "--at", str(t),
        "--out", str(cache_path),
        "--prefer-proxy",
        "--clamp-to-end",
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
        # The sampler's last stderr line is {"error", "message"}; the pane shows
        # that message, so surface it rather than the raw exit text.
        sampler_msg = None
        for line in reversed(err.strip().splitlines()):
            try:
                m = json.loads(line).get("message")
            except (ValueError, AttributeError):
                continue
            if isinstance(m, str) and m.strip():
                sampler_msg = m.strip()
                break
        raise server_error(
            "render_failed",
            sampler_msg or f"sample-frame.js exit {render_proc.returncode}: {err}",
        )
    if not cache_path.is_file():
        raise server_error("render_failed", "sample-frame.js reported success but no PNG was written")

    # Working-copy frames are the only mutable case — the input state changes
    # with every edit, so browsers/proxies must revalidate on every request.
    cache_header = "no-store" if is_working else "public, max-age=31536000, immutable"
    return FileResponse(
        cache_path,
        media_type="image/png",
        headers=_frame_headers(cache_header, cache_path),
    )


def _rerun_under_lock(project_dir: Path, body: dict, headers=None, project_id=None) -> tuple:
    """A rerun's commit and write, blocking (call via asyncio.to_thread): the commit of the
    completed version and the reset in one hold of the project lock."""
    project_path = project_dir / "project.json"
    with project_lock(project_path):
        # §482: what a rerun writes, in an open Studio sync clash.
        fields = ["status", "runCount", "tracks"]
        if "prompt" in body:
            fields.append("editingPrompt")
        if "workflow" in body:
            fields.append("workflow")
        save_guard.check_sync(headers, project_id, fields)
        fresh = json.loads(project_path.read_text())
        fresh_sources = fresh.get("sources")
        if not fresh_sources:
            raise bad_request("no_sources", "Project has no sources — cannot re-run")
        run_count = fresh.get("runCount", 1)
        version_label = body.get("versionName") or fresh.get("status", "draft")
        _git_commit_sync(project_dir, f"version: run {run_count} — {version_label}")
        # Restore video track to original source clips; drop captions/overlays.
        # `order` is a legacy field: nothing downstream sorts or requires it, so a missing
        # key on an init-created or ingested source degrades to None rather than KeyError.
        source_clips = [{"id": c["id"], "src": c["src"], "order": c.get("order")} for c in fresh_sources]
        updated = {
            **fresh,
            "status": "pending",
            "runCount": run_count + 1,
            "tracks": [{"id": "trk-0", "items": source_clips}],
        }
        if "prompt" in body:
            updated["editingPrompt"] = body["prompt"]
        if "workflow" in body:
            updated["workflow"] = body["workflow"]
        text = _write_project_json(project_path, updated)
    return updated, text


@router.post("/projects/{project_id}/rerun")
async def rerun_project(project_id: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    # §477: a rerun resets the tracks with no compare, so it is the human's.
    save_guard.require_editor(getattr(request, "headers", None))
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    # One lock hold, off the event loop: read the project, commit it as the completed
    # version, then reset it. A commit taken before the lock would let an edit land between
    # the two and be lost from history (§477). The sources and the run count come from this
    # read, so an edit made earlier is kept and a second rerun sees the first one's count (§467).
    updated, text = await asyncio.to_thread(_rerun_under_lock, project_dir, body, getattr(request, "headers", None), project_id)
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    broadcaster.publish(project_id, _sse_data_frame(text))
    return updated


@router.post("/projects/{project_id}/assets")
async def include_profile_asset(project_id: str, body: dict = Body(...), request: Request = None, project_dir: Path = Depends(get_project_dir)):
    """Copy an asset from a profile's asset library into this project.

    Body: {"from": {"profile": <name>, "filename": <name>}}.
    Drafts the change in project.json; the user commits separately via PUT.
    """
    # §477: the human's, with the guard on (no AI tool reaches this route).
    save_guard.require_editor(getattr(request, "headers", None))
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
    # §482: `assets` and the file the copy lands as, in an open Studio sync clash, before the copy (and again
    # under the lock, by the name it really landed on: a clashed file that does not exist here yet is theirs).
    save_guard.check_sync(getattr(request, "headers", None), project_id, ["assets"], files=[filename])

    # Copy into project_dir, reusing the shared helper from project/init.py so
    # the collision-suffix pattern stays in one place.
    dest = Path(_copy_into_workspace(str(src_path), str(project_dir), "asset"))

    # Infer asset type from MIME (image / video / audio / file).
    mime = mimetypes.guess_type(dest.name)[0] or ""
    if   mime.startswith("image/"): asset_type = "image"
    elif mime.startswith("video/"): asset_type = "video"
    elif mime.startswith("audio/"): asset_type = "audio"
    else:                            asset_type = "file"

    async with project_lock_async(project_path):
        try:
            save_guard.check_sync(getattr(request, "headers", None), project_id, ["assets"],
                                  files=[dest.resolve().relative_to(project_dir.resolve()).as_posix()])
        except HTTPException:
            dest.unlink(missing_ok=True)   # the copy made above, new and nobody's yet
            raise
        project = json.loads(project_path.read_text())   # fresh, under the lock
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

        text = _write_project_json(project_path, project)
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
    EXCLUDE = {"manifest.json", "carousel.pdf"}
    # Renders are not cleaned, so the folder can hold slides from an earlier,
    # longer render. When the manifest (written last by the renderer) lists the
    # slides, zip exactly those, in its order. No usable manifest: zip the folder.
    listed = None
    try:
        slides = json.loads((render_dir / "manifest.json").read_text()).get("slides")
        if isinstance(slides, list):
            listed = [s.get("file") if isinstance(s, dict) else None for s in slides]
    except (OSError, ValueError, AttributeError):
        pass
    if listed is not None:
        entries = []
        for name in listed:
            if (not isinstance(name, str) or not name or name in (".", "..")
                    or "/" in name or "\\" in name or Path(name).name != name):
                raise bad_request("invalid_manifest", f"manifest lists an invalid slide file: {name!r}")
            entry = render_dir / name
            if not entry.is_file():
                raise not_found("not_found", f"manifest lists a slide that is not on disk: {name}")
            entries.append(entry)
    else:
        entries = [e for e in sorted(render_dir.iterdir()) if e.is_file() and e.name not in EXCLUDE]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for entry in entries:
            zf.write(entry, arcname=entry.name)
    buf.seek(0)

    project_name = project_dir.name
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=utf-8''{quote(project_name + '-slides.zip')}",
        },
    )


@router.get("/projects/{project_id}/render-pdf")
async def render_pdf(project_id: str, project_dir: Path = Depends(get_project_dir)):
    """Serve <project>/render/carousel.pdf as a download.

    404 when there is no PDF, or when the manifest (written last by the renderer)
    says `pdf` is null or omits it, so a partial render never serves one."""
    render_dir = project_dir / "render"
    pdf_path = render_dir / "carousel.pdf"
    if not pdf_path.is_file():
        raise not_found("not_found", "no carousel pdf")
    try:
        listed = json.loads((render_dir / "manifest.json").read_text()).get("pdf")
    except (OSError, ValueError, AttributeError):
        listed = None
    if listed != "carousel.pdf":
        raise not_found("not_found", "no carousel pdf")
    return FileResponse(
        pdf_path,
        media_type="application/pdf",
        filename=f"{project_dir.name}.pdf",
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
    PNGs (slide_NN.png), and every other file there, manifest.json and
    carousel.pdf included.

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
    request: Request,
    provenance_entry: str | None = Form(None, alias="provenance"),
    project_dir: Path = Depends(get_project_dir),
):
    """Accept a browser file drop scoped to a project, saving it into the
    project's own directory instead of the shared workspace _uploads/ folder.
    Keeps each project self-contained and portable.

    An optional `provenance` form field, the file's entry as JSON (`{kind, ...}`,
    serve/provenance.py), is recorded for the stored file; one the record refuses
    is a 422 and nothing is stored, and with the guard on it is the app's only,
    as POST .../provenance (`save_guard.require_shell`, 403). Without it nothing
    is recorded. A record that cannot be written once the file is stored does not
    fail the upload: the answer carries `provenanceError` instead, for POST
    .../provenance to retry.

    §568: a HEIC, HEIF or TIFF is stored as the JPEG (or PNG) drawable_upload
    makes of it, with its colour profile, and `path` names that; one that cannot
    be converted is a 422 image_unconvertible and nothing is stored."""
    entry = None
    if provenance_entry is not None:
        save_guard.require_shell(getattr(request, "headers", None))
        try:
            entry = provenance.validate_entry(json.loads(provenance_entry))
        except ValueError as e:
            raise _provenance_refused(e)
    # §482: a new file never replaces one, but a name in an open Studio sync clash is still that file's.
    record = [f"{provenance.ASSETS_DIR}/{provenance.RECORD_NAME}"] if entry is not None else []
    save_guard.check_sync(getattr(request, "headers", None), project_id, files=[upload_name(file.filename), *record])
    dest = await drawable_upload(await save_upload(file, project_dir))
    if dest.name != upload_name(file.filename):
        try:   # the de-duplicated or converted name it landed on
            save_guard.check_sync(getattr(request, "headers", None), project_id, files=[dest.name])
        except HTTPException:
            dest.unlink(missing_ok=True)
            raise
    answer = {"path": str(dest)}
    if entry is not None:
        try:
            await asyncio.to_thread(provenance.record_provenance, project_dir, str(dest), entry)
        except Exception as e:
            answer["provenanceError"] = {"error": getattr(e, "code", "not_recorded"), "message": str(e)}
    return answer


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

    Body: {"path": "<absolute path to a readable video file>", "provenance"?:
    {kind, ...}}. The path is typically one just staged via POST /upload-asset
    (browser drop) or picked natively by the client (outside project_dir);
    lib.ingest.ingest_source handles both without a double copy. `provenance`,
    optional, is recorded for the files the clip stores (serve/provenance.py);
    one the record refuses is a 422 before anything runs, and with the guard on it
    is the app's only (`save_guard.require_shell`, 403). Without it nothing is
    recorded.
    """
    path = body.get("path")
    if not isinstance(path, str) or not path:
        raise bad_request("missing_field", "'path' is required")
    entry = None
    if body.get("provenance") is not None:
        save_guard.require_shell(getattr(request, "headers", None))
        try:
            entry = provenance.validate_entry(body["provenance"])
        except provenance.ProvenanceError as e:
            raise _provenance_refused(e)
    if not os.path.isfile(path):
        raise bad_request("invalid_path", f"'{path}' is not a readable file")
    # §482: `sources` in an open Studio sync clash, before anything is staged (and again when it lands).
    who = save_guard.sync_who(getattr(request, "headers", None))
    save_guard.check_sync(who, project_id, ["sources"])

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
        _run_ingest_detached(project_id, project_dir, path, color_space, broadcaster, job,
                             provenance_entry=entry, who=who)
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
        if job.code:
            out.update({"code": job.code, "needed": job.needed, "free": job.free})
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
             "-of", "csv=p=0", ff_path(path)],
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
    who = save_guard.sync_who(getattr(request, "headers", None))
    async with project_lock_async(project_path):
        # §482: the backfill lands in `sources` and its `tracks` twin.
        save_guard.check_sync(who, project_id, ["sources", "tracks"])
        result = _apply_project_edits(
            project_path, [(source_id, src, "sourceDuration", duration)], who=who,
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


# Strong refs to in-flight detached download tasks. asyncio only weakly tracks
# fire-and-forget tasks, so without this a 2GB transfer can be garbage collected
# mid-run with no error surfaced anywhere. Same idiom as steps.py's
# _BACKGROUND_TASKS and _ingest_task_refs above.
_DOWNLOAD_TASKS: set[asyncio.Task] = set()


async def _run_download_to_job(
    job_id: str, downloads: list, project_dir: Path, allowed_hosts: set, *, land_check=None,
) -> None:
    """Run a transfer to completion independent of any client connection.

    A per-item failure is DATA, not a job failure: it lands in the results
    envelope exactly as the sync path's 207 does. Only a raised exception makes
    the job itself an error.
    """
    try:
        # §482: land_check only when there is one, so a call with sync off is exactly as before.
        extra = {"land_check": land_check} if land_check is not None else {}
        results = await fetch_to_disk_async(downloads, project_dir, allowed_hosts, **extra)
        set_done(job_id, {"results": results})
    except Exception as e:
        set_error(job_id, {"error": "download_failed", "message": str(e)})


def _download_land_check(project_id: str, project_dir: Path, headers):
    """§482, review 40: a download is checked again as each file lands, right before its rename and with no await
    between them, so a clash recorded while it downloaded refuses that file (an error item with the refusal, the
    temp file removed). Not under the project lock: the fetches run concurrently in lib/remote_io, which takes no
    project lock, and the rename is the whole write. None (no check, as before) with sync off, for the window and
    for the pull."""
    if not save_guard.sync_checked(headers):
        return None
    who = save_guard.sync_who(headers)
    root = Path(project_dir).resolve()

    def check(dest: Path) -> "dict | None":
        try:
            rel = Path(dest).resolve().relative_to(root).as_posix()
        except (ValueError, OSError):
            return None   # outside the project: validate_project_subpath already refused it
        return save_guard.sync_refusal(project_id, who, files=[rel])

    return check


def _project_relpaths(project_dir: Path, raws) -> list:
    """§482: each path a request names inside the project, as its relpath from the project folder (resolved:
    `..` and links count as where they land), a folder with a trailing `/`. A path that is refused anyway
    (outside the project, empty, absolute) is left to the route's own check."""
    out = []
    root = Path(project_dir).resolve()
    for raw in raws:
        try:
            target = validate_project_subpath(project_dir, raw)
            rel = target.relative_to(root).as_posix()
        except (HTTPException, ValueError, OSError):
            continue
        out.append(rel + "/" if target.is_dir() else rel)
    return out


@router.post("/projects/{project_id}/download")
async def download_assets(
    project_id: str,
    body: dict = Body(...),
    project_dir: Path = Depends(get_project_dir),
    request: Request = None,
):
    """Pull remote files into the project workspace on local disk.

    Body: {"downloads": [{"url": "https://...", "destPath": "assets/img.png",
                          "contentType": "image/png", "sizeBytes": 12345,
                          "method": "GET", "headers": {...}}]}

    Returns 200 when all downloads succeed, 207 Multi-Status when any fail.
    Per-item errors are surfaced in the results list, not as 4xx (per-op failures
    are never request-level).

    An optional `"_async": true` field switches the route from blocking to
    fire-and-forget: it returns 202 {job_id, status: "running"} immediately and
    runs the transfer in a background task, polled via
    GET /projects/{id}/download/jobs/{job_id}. Both guards below still run
    before any job exists, so a bad body or an unset allowlist is still a 4xx.

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
    # §482: a destination in an open Studio sync clash (fetch_to_disk_async validates each path itself).
    headers = getattr(request, "headers", None)
    save_guard.check_sync(headers, project_id, files=_project_relpaths(
        project_dir, [d.get("destPath") for d in downloads if isinstance(d, dict)]))
    land_check = _download_land_check(project_id, project_dir, headers)

    is_async = bool(body.get("_async", False))
    if is_async:
        job_id = create_job()
        task = asyncio.create_task(
            _run_download_to_job(job_id, downloads, project_dir, allowed_hosts, land_check=land_check)
        )
        _DOWNLOAD_TASKS.add(task)
        task.add_done_callback(_DOWNLOAD_TASKS.discard)
        return JSONResponse({"job_id": job_id, "status": "running"}, status_code=202)

    extra = {"land_check": land_check} if land_check is not None else {}
    results = await fetch_to_disk_async(downloads, project_dir, allowed_hosts, **extra)

    any_error = any(r.get("status") == "error" for r in results)
    return JSONResponse(
        status_code=207 if any_error else 200,
        content={"results": results},
    )


@router.get("/projects/{project_id}/download/jobs/{job_id}")
async def get_download_job(
    project_id: str,
    job_id: str,
    project_dir: Path = Depends(get_project_dir),
):
    """Poll a transfer started with {"_async": true}.

    Returns {"status": "running"} | {"status": "done", "result": {"results": [...]}}
    | {"status": "error", "error": {...}}. The done payload is byte-identical to
    what the synchronous path would have returned in its body.

    404 if job_id is unknown: never ran in this process, or the process restarted
    since. Jobs are in-process and ephemeral by design (serve/jobs.py).
    """
    job = get_job(job_id)
    if job is None:
        raise not_found("job_not_found", f"Download job '{job_id}' not found")
    return job


@router.delete("/projects/{project_id}/files")
async def delete_files(
    project_id: str,
    body: dict = Body(...),
    request: Request = None,
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
    # §477: deleting project files is the human's, with the guard on (no AI tool reaches it).
    save_guard.require_editor(getattr(request, "headers", None))
    paths = body.get("paths")
    if not isinstance(paths, list) or not paths:
        raise bad_request("invalid_body", "'paths' must be a non-empty list")
    # §482: a file, or a folder holding one, in an open Studio sync clash refuses the whole request. Checked and
    # deleted under the project lock (review 40: the time-of-check gap); sync off, the window and the pull: no lock.
    headers = getattr(request, "headers", None)
    if save_guard.sync_checked(headers):
        async with project_lock_async(project_dir / "project.json"):
            save_guard.check_sync(headers, project_id, files=_project_relpaths(project_dir, paths))
            results = _delete_project_paths(project_dir, paths)
    else:
        results = _delete_project_paths(project_dir, paths)

    any_error = any(r.get("status") == "error" for r in results)
    return JSONResponse(
        status_code=207 if any_error else 200,
        content={"results": results},
    )


def _delete_project_paths(project_dir: Path, paths: list) -> list:
    """delete_files' deletes, one result per path (no await: one hold of the lock covers them all)."""
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
        # §477: project.json and its lock go only through save_project, never deleted as files.
        # By name (a case-folding filesystem lands project.jſon on project.json) and as the
        # same file on disk, for the given path and the resolved one (a symlink to it).
        if lands_on_project_file(project_dir / raw, target):
            results.append({"path": raw, "status": "error", "error": "project_file_protected"})
            continue
        try:
            if target.is_dir() and not target.is_symlink():
                # rmtree refuses to follow a symlink-to-directory (raises OSError).
                # We want symmetric refusal — never recurse through a symlink.
                rmtree_force(target)
            elif target.exists() or target.is_symlink():
                target.unlink()
            # else: missing — treat as success (idempotent)
            results.append({"path": raw, "status": "deleted"})
        except OSError as e:
            results.append({"path": raw, "status": "error", "error": str(e)})
    return results


async def _render_body(request: Request) -> dict:
    """The optional JSON body of POST /render and /render/estimate:
    { "export": "auto"|"sdr"|"both", "sdrCurve": <curve id>, "name": <output
    basename>, "cover": <seconds>, "fps": <number>, "motionBlur": <1-8> }.
    `fps` and `motionBlur` apply to this render only (§284) and are never
    written to project.json. Absent/empty body → today's behavior
    (render.js's own defaults). Mirrors the rerun route's tolerant-parse
    pattern; a GET-style POST with no body is not an error, and neither is a
    body that is not an object."""
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


# §284: a render's `motionBlur` override, the setting's own range (motion-blur.js MOTION_BLUR_MAX).
_MOTION_BLUR_MAX = 8


def _render_fps(body: dict):
    """The body's `fps` for this render only (§284), or None when absent. A positive finite number."""
    fps = body.get("fps")
    if fps is None:
        return None
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not math.isfinite(fps) or fps <= 0:
        raise HTTPException(422, detail={
            "error": "invalid_argument",
            "message": f"fps must be a positive number (got {fps!r})",
        })
    return fps


def _render_motion_blur(body: dict):
    """The body's `motionBlur` for this render only (§284), or None when absent. An integer from 1 to 8."""
    blur = body.get("motionBlur")
    if blur is None:
        return None
    if isinstance(blur, bool) or not isinstance(blur, int) or not 1 <= blur <= _MOTION_BLUR_MAX:
        raise HTTPException(422, detail={
            "error": "invalid_argument",
            "message": f"motionBlur must be an integer from 1 to {_MOTION_BLUR_MAX} (got {blur!r})",
        })
    return blur


def _validate_render_body(body: dict, *, overrides: bool = True) -> None:
    """422 on an `export` or `sdrCurve` render.js would refuse, and with
    `overrides` (a render, not an estimate) on a bad `fps` or `motionBlur`."""
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
    if overrides:
        _render_fps(body)
        _render_motion_blur(body)


def _converged_render_input(project_dir: Path, project) -> "Path | None":
    """A copy of `project` converged (lib/project_migrate.py) beside its project.json, for render.js, when the file
    is still in a retired shape (never opened since, or its open's write skipped for a Studio sync clash); None when
    it already is current. Beside it, so relative paths resolve and render.js's default output places are
    unchanged; the detached run removes it, as the carousel path's normalized copy."""
    if not isinstance(project, dict):
        return None
    converged = converge(project)
    if converged is project:
        return None
    fd, tmp_name = tempfile.mkstemp(prefix=".render-input-", suffix=".json", dir=str(project_dir))
    with os.fdopen(fd, "w") as f:
        json.dump(converged, f)
    return Path(tmp_name)


def _render_js_args(project_dir: Path, project_path: Path, body: dict, *, overrides: bool = True) -> tuple[list[str], Path]:
    """render.js's arguments for a video render from a validated render body,
    and the MP4 it writes: the project, ``--out output/<name>.mp4`` (the
    video-workflow staging dir that /outputs lists, instead of render.js's
    default render/<name>.mp4), then ``--export``/``--sdr-curve`` when given.
    Shared by the render and estimate routes, so an estimate plans exactly the
    render the same body starts. Creates nothing (the render route makes
    output/ itself).

    `name` picks the output basename, sanitized (see _sanitize_output_name) so
    it can never escape output/."""
    output_dir = project_dir / "output"
    name = body.get("name")
    safe_name = _sanitize_output_name(name, project_dir.name) if isinstance(name, str) else project_dir.name
    output_path = output_dir / f"{safe_name}.mp4"
    if output_path.resolve().parent != output_dir.resolve():
        # Sanitization already forbids path separators, so this should be
        # unreachable — but never write outside output/ regardless.
        raise server_error("invalid_argument", "invalid output name")
    script_args = [str(project_path), "--out", str(output_path)]
    if body.get("export"):
        script_args += ["--export", body["export"]]
    if body.get("sdrCurve"):
        script_args += ["--sdr-curve", body["sdrCurve"]]
    # §284: this render only (the export window's Fast); project.json keeps its
    # own. The estimate passes its own, leniently (_estimate_overrides).
    if not overrides:
        return script_args, output_path
    fps = _render_fps(body)
    if fps is not None:
        script_args += ["--fps", repr(float(fps)) if isinstance(fps, float) else str(fps)]
    blur = _render_motion_blur(body)
    if blur is not None:
        script_args += ["--motion-blur", str(blur)]
    return script_args, output_path


def _estimate_overrides(body: dict) -> list[str]:
    """render.js --estimate's stand-ins for settings the export window has not
    saved yet: ``--resolution WxH`` from a body `resolution` of two positive
    integers, ``--fps N`` from a positive finite number, ``--motion-blur N``
    from an integer from 1 to 8 (§284). Anything absent or malformed is left
    out, and the project's own setting applies."""
    args: list[str] = []
    resolution = body.get("resolution")
    if (
        isinstance(resolution, (list, tuple)) and len(resolution) == 2
        and all(isinstance(v, int) and not isinstance(v, bool) and v > 0 for v in resolution)
    ):
        args += ["--resolution", f"{resolution[0]}x{resolution[1]}"]
    fps = body.get("fps")
    if (
        isinstance(fps, (int, float)) and not isinstance(fps, bool)
        and math.isfinite(fps) and fps > 0
    ):
        args += ["--fps", repr(float(fps)) if isinstance(fps, float) else str(fps)]
    # §284: the export window's Fast, a render's own motion blur.
    blur = body.get("motionBlur")
    if isinstance(blur, int) and not isinstance(blur, bool) and 1 <= blur <= _MOTION_BLUR_MAX:
        args += ["--motion-blur", str(blur)]
    return args


# How long an estimate may take. It probes each source with ffprobe and
# renders nothing, so seconds; past this the app gets no estimate (no warning).
_ESTIMATE_TIMEOUT_S = 60


def _no_estimate(error: str | None = None) -> dict:
    """The estimate route's "no estimate" answer, which the app reads as no warning."""
    out: dict = {"estimate": None, "volumes": []}
    if error:
        out["error"] = error
    return out


def _estimate_error_from(stderr: str, returncode: int | None) -> str:
    """render.js's own failure message (its last JSON line on stderr), else a short tail."""
    for line in reversed(stderr.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                parsed = json.loads(line)
            except ValueError:
                continue
            if isinstance(parsed, dict) and (parsed.get("message") or parsed.get("error")):
                return str(parsed.get("message") or parsed.get("error"))
    tail = stderr.strip().splitlines()[-1:] if stderr.strip() else []
    return tail[0] if tail else f"render.js --estimate exited {returncode}"


@router.post("/projects/{project_id}/render/estimate")
async def render_estimate(project_id: str, request: Request, project_dir: Path = Depends(get_project_dir)):
    """How much disk the render with this body would need, asked before it starts
    (§213), so the export window can warn first.

    Takes POST /render's body, plus optional `resolution` ([width, height]) and
    `fps` that stand in for project settings not saved yet (never written).
    Runs ``render.js --estimate`` with the render's own arguments and
    environment, and returns its JSON:
    ``{"estimate": {"lower": {"tmpBytes", "projectBytes"}, "expected": {...}},
    "volumes": [{"path", "needBytes", "freeBytes"}]}``.

    It writes nothing (no output/ dir, no git snapshot, no colour-provenance
    heal) and never touches the render slot: an estimate during a render
    neither waits for it nor supersedes it. A carousel has no estimate, and any
    failure to estimate is ``{"estimate": null, "volumes": [], "error": ...}``,
    still 200: the app treats no estimate as no warning. A bad `export` or
    `sdrCurve` is the render's own 422.
    """
    project_path = project_dir / "project.json"
    body = await _render_body(request)
    _validate_render_body(body, overrides=False)

    try:
        project = json.loads(project_path.read_text())
    except Exception as e:
        return _no_estimate(f"project.json unreadable: {e}")
    if isinstance(project, dict) and project.get("projectType") == "carousel":
        return _no_estimate()

    script_args, _ = _render_js_args(project_dir, project_path, body, overrides=False)
    render_script = Path(render_runtime_dir()) / "render.js"
    if not render_script.is_file():
        return _no_estimate(f"{render_script.name} not found")
    node_bin = shutil.which("node")
    if not node_bin:
        return _no_estimate("node not found in PATH")

    env = node_child_env()
    env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)
    cmd = [node_bin, str(render_script), *script_args, "--estimate", *_estimate_overrides(body)]
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(MONTAJ_ROOT),
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=_ESTIMATE_TIMEOUT_S)
    except asyncio.TimeoutError:
        if proc is not None:
            try:
                proc.kill()
                await proc.wait()
            except ProcessLookupError:
                pass
        return _no_estimate(f"render.js --estimate took longer than {_ESTIMATE_TIMEOUT_S}s")
    except Exception as e:
        return _no_estimate(f"render.js --estimate could not run: {e}")

    err_text = stderr.decode(errors="replace") if stderr else ""
    if proc.returncode != 0:
        return _no_estimate(_estimate_error_from(err_text, proc.returncode))
    lines = (stdout.decode(errors="replace") if stdout else "").strip().splitlines()
    try:
        result = json.loads(lines[-1])
        estimate, volumes = result["estimate"], result["volumes"]
        if not isinstance(volumes, list) or not all(
            isinstance(estimate.get(k), dict) and isinstance(estimate[k].get("tmpBytes"), (int, float))
            and isinstance(estimate[k].get("projectBytes"), (int, float))
            for k in ("lower", "expected")
        ):
            raise ValueError("unexpected shape")
    except Exception:
        return _no_estimate("render.js --estimate printed no estimate")
    out = {"estimate": estimate, "volumes": volumes}
    # §378: the colour space the picture needs (the stored one unless only a hidden
    # video is HDR), so the export window shows the same Format row the render uses.
    if isinstance(result.get("colorSpace"), str):
        out["colorSpace"] = result["colorSpace"]
        out["hdrVisible"] = bool(result.get("hdrVisible"))
    return out


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

    body = await _render_body(request)
    _validate_render_body(body)

    # Optional poster-frame extraction: `cover` is a timeline timestamp
    # (seconds) to grab as a sidecar JPEG once the render succeeds. Video-only
    # (the carousel branch below never sets output_path, so cover extraction is
    # skipped for carousels regardless of what's in the body).
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
        # Always write carousel.pdf: the app links to it next to the slides zip.
        script_args = ["--project-json", str(render_input), "--pdf"]
        if scale is not None:
            script_args += ["--scale", str(scale)]
    else:
        render_script = Path(render_runtime_dir()) / "render.js"
        script_args, output_path = _render_js_args(project_dir, project_path, body)
        output_path.parent.mkdir(exist_ok=True)
        # Snapshot the current project.json into git before kicking off the
        # detached render, so every export creates a recoverable version.
        # _git_commit_sync is no-op-safe on a clean tree, so back-to-back
        # renders don't spam the history. Carousel already commits on →final;
        # this covers the video path.
        #
        # First heal an HDR project whose SDR clips were converted in place
        # before PV42, so the export grades each layer by its origin.
        broadcaster = getattr(getattr(getattr(request, "app", None), "state", None), "broadcaster", None)
        project = await ensure_project_color_provenance(project_id, project_dir, project, broadcaster)
        run_count = project.get("runCount", 1)
        await asyncio.to_thread(_git_commit_sync, project_dir, f"version: run {run_count} — export")

    if not render_script.is_file():
        raise server_error("not_found", f"{render_script.name} not found")

    node_bin = shutil.which("node")
    if not node_bin:
        raise server_error("not_found", "node not found in PATH")

    env = node_child_env()
    env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)

    # Reserve the slot and kick the render off DETACHED, so it runs to completion
    # even if this SSE connection drops. A multi-minute render streamed through the
    # Hub proxy + Cloudflare tunnel will exceed the tunnel's ~100s wall; the tunnel
    # cuts the long-lived stream, and a render tied to the request lifecycle would
    # be killed mid-flight (the old kill-on-disconnect behaviour). Now the SSE below
    # is a pure *viewer* — a disconnect just stops viewing; the render keeps going,
    # the output lands, and clients reconnect / poll /outputs for it. An actual stop
    # goes through POST /render/cancel.
    # A project still in a retired shape on disk renders converged (see _converged_render_input), never with an old
    # Lyric video's preview overlays drawn over its captions.
    if project_type != "carousel":
        converged_input = _converged_render_input(project_dir, project)
        if converged_input is not None:
            render_input = converged_input
            script_args = [str(converged_input), *script_args[1:]]

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
        # Without this an agent driving a render remotely sees ONLY
        # "Render failed (exit 1)" — the actual cause (render.js's own
        # `fail()` JSON, an ffmpeg error, a missing file) is written to
        # stderr and captured in job.lines, and used to die here. A caller
        # that can't read the log can only guess, which is exactly what
        # happened: four rediagnoses of a project whose only fault was a
        # status the renderer refused.
        if job.lines:
            out["log"] = job.lines[-_RENDER_LOG_TAIL:]
    return out


class CaptionPipelineError(Exception):
    """A caption pipeline step exited non-zero. `message` is the human-readable
    text the SSE path surfaces as an `event: error` frame (and a detached caller
    can record as the job's error). `detail`, when set, is a structured
    refusal (§477's project_changed) and `status_code` the HTTP status it
    answers with where an answer has not already started."""

    def __init__(self, message: str, *, detail: dict = None, status_code: int = 500):
        super().__init__(message)
        self.message = message
        self.detail = detail
        self.status_code = status_code


def _caption_error_frame(e: "CaptionPipelineError") -> str:
    """The SSE `error` frame for a caption pipeline failure. `data` is the message, as every
    consumer reads it. A structured refusal (§477's project_changed) also rides on a
    `detail:` field line holding the same {error, stale, missing, message} the detached
    job's errorDetail answers; an SSE parser ignores a field it does not know."""
    if isinstance(e.detail, dict):
        return f"event: error\ndetail: {json.dumps(e.detail)}\ndata: {e.message}\n\n"
    return f"event: error\ndata: {e.message}\n\n"


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
    return _lib_merge_caption_theme(prev, track)


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
    theme: dict = None,
    who=None,
):
    """Core caption pipeline, shared by the SSE route and (later) a detached
    async caller. Runs build_audio_mix_spec → write mix spec → mix_timeline →
    transcribe → caption, then persists project["captions"] (seeding `theme`
    — a style profile's fontFamily/googleFonts and emphasis colour — into the
    prior track where it lacks a value, then carrying every remaining prior
    theme key forward), writes project.json, and broadcasts the update.

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
    # What this job's result depends on, as read now (§477): compared under the lock
    # before the write, so an audio or caption-text edit made meanwhile is not overwritten.
    fingerprint = caption_input_fingerprint(project) if save_guard.enabled() else None

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
             "--out", str(words_prefix), "--fit-pauses"],
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
            **_detached_kwargs(),
        )

        def kill_tree(p=proc):
            _kill_tree(p)

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
    # Re-read the project first: the AI or the editor may have saved it while
    # the pipeline ran (a translation, any edit), and writing back the copy
    # read at the start would undo that (§244).
    async with project_lock_async(project_path, timeout=CAPTION_LOCK_TIMEOUT):
        try:
            project = json.loads(project_path.read_text())
        except (OSError, ValueError):
            pass
        if fingerprint is not None:
            change = caption_input_change(fingerprint, project)
            if change is not None:
                raise CaptionPipelineError(change["message"], detail=change, status_code=409)
        # §482: checked again as the request's writer, for a clash recorded while whisper ran.
        clash = save_guard.sync_refusal(project_id, who if who is not None else save_guard.MAINTENANCE, ["captions"])
        if clash is not None:
            raise CaptionPipelineError(clash["message"], detail=clash,
                                       status_code=save_guard.sync_exception(clash).status_code)
        prev = seed_prev(project.get("captions") or {}, theme)
        # Theme carried forward, ids minted, translated rows kept and re-cut at
        # their phrase boundaries (lib/caption_translation.py).
        track = finish_regenerated_track(prev, track)
        record_source_language(track, language, project_dir / "_caption_words.json")
        project["captions"] = track
        text = _write_project_json(project_path, project)
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
    With no whisper weight installed it answers 503 `whisper_model_missing`
    and starts nothing.

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
    # §482: `captions` in an open Studio sync clash, before any work starts (and again when it lands).
    who = save_guard.sync_who(getattr(request, "headers", None))
    save_guard.check_sync(who, project_id, ["captions"])

    model = body.get("model") or DEFAULT_WHISPER_MODEL
    # No whisper weight installed (serve starts without one): refuse before
    # reserving the slot, with the same code the whisper steps fail with.
    missing = whisper_model_missing(model)
    if missing:
        raise HTTPException(503, detail={"error": "whisper_model_missing", "message": missing})
    language = body.get("language") or "auto"
    style = body.get("style") or (project.get("captions") or {}).get("style") or "pop"
    # A style profile's caption look (fontFamily/googleFonts + the style's
    # emphasis colour), seeded into the saved track where it doesn't already
    # have a value — see serve/caption_theme.py.
    theme = sanitize_theme(body.get("theme"))

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
            _run_caption_detached(
                project_id, project_dir, project, model, language, style, broadcaster, job,
                theme=theme, who=who,
            )
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
                theme=theme,
                who=who,
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
                yield _caption_error_frame(e)
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

    def write() -> bool:
        save_guard.check_sync(getattr(request, "headers", None), project_id, files=[f"overlays/{name}.jsx"])
        target.parent.mkdir(parents=True, exist_ok=True)
        created = not target.exists()
        target.write_text(jsx_text, encoding="utf-8")
        return created

    # §482: with Studio sync on, under the project lock, the overlay's file in an open sync clash is refused.
    # Off, the write is as it always was (no lock), and no time-of-check gap opens (review 40): the variable is
    # serve's environment, fixed for its life, so with it unset no sidecar exists that serve would honour.
    if save_guard.sync_clash.state_dir():
        async with project_lock_async(project_dir / "project.json"):
            created = write()
    else:
        created = write()

    return JSONResponse(
        content={
            "name": name,
            "path": str(target),
            "bytes": len(body_bytes),
            "created": created,
        },
        status_code=201 if created else 200,
    )


@router.post("/projects/{project_id}/captions/translation")
async def caption_translation(project_id: str, body: dict = Body(...), request: Request = None, project_dir: Path = Depends(get_project_dir)):
    """Write a translated caption row (§244), replace it, or remove it, and/or choose which languages draw.

    Body: {"lang": "es", "phrases": [{"source": <the source words of the
    phrase, in order>, "text": <the translated line>}, ...], "show": ["en", "es"]}.
    `phrases` (with `lang`) covers the caption words in order; the source row is
    re-cut at them and the translated row gets the same start and end per phrase
    (lib/caption_translation.py). `phrases: []` removes that language's row.
    `show` is optional, alone or with `phrases` (applied after it): the languages
    the preview and the render draw, by code ("source" or the source's own code,
    and each translated `lang`); naming them all draws everything.
    Answers {lang, lane, phrases, showLangs, captions}.
    """
    if project_id in _active_caption_jobs:
        raise HTTPException(409, detail={
            "error": "concurrent_caption_job",
            "message": "Captions are being generated for this project. Translate once they are done.",
        })
    if not isinstance(body, dict):
        raise bad_request("bad_body", "Send {lang, phrases} and/or {show}.")
    if "phrases" not in body and "show" not in body:
        raise bad_request("bad_body", "Send {lang, phrases} and/or {show}.")
    project_path = project_dir / "project.json"
    async with project_lock_async(project_path):
        raw = project_path.read_text()
        project = json.loads(raw)
        # §482: `captions` in an open Studio sync clash, before the read check.
        save_guard.check_sync(getattr(request, "headers", None), project_id, ["captions"])
        # §477, with the guard on: the AI and tools must send the captions revision they read
        # (strict); the window's editor is advisory. Guard off: apply_translation's
        # source-words check is the guard, as before.
        save_guard.check_read(getattr(request, "headers", None), raw, project, ["captions"],
                              "Translate captions")
        try:
            captions = project.get("captions")
            if "phrases" in body:
                had = {s.get("lang") for s in (captions or {}).get("segments", []) if is_translation(s)} if isinstance(captions, dict) else set()
                captions = apply_translation(captions, body.get("lang"), body.get("phrases"))
                if body.get("phrases") and body.get("lang") not in had:
                    captions = show_new_language(captions, body.get("lang"))
            if "show" in body:
                captions = apply_show(captions, body.get("show"))
        except TranslationError as e:
            raise bad_request(e.code, e.message)
        project["captions"] = captions
        text = _write_project_json(project_path, project)
    broadcaster: SSEBroadcaster = request.app.state.broadcaster
    broadcaster.publish(project_id, _sse_data_frame(text))
    row = [s for s in captions["segments"] if is_translation(s) and s.get("lang") == body.get("lang")]
    return {
        "lang": body.get("lang"),
        "lane": row[0].get("lane") if row else None,
        "phrases": len(row),
        "showLangs": captions.get("showLangs"),
        "captions": captions,
    }


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
        if job.detail is not None:
            out["errorDetail"] = job.detail
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
