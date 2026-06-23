"""Async render kick, phase tracking, and the /render/status endpoint.

A manual render can be started in async mode (``?async=1``): the handler kicks the
detached worker and returns 202 immediately instead of holding an SSE stream open.
Clients then poll GET /render/status to follow progress (preparing → captions /
rendering → encoding → done) and pick up the output path or error when terminal.

The terminal job is now PERSISTED in ``_render_jobs`` (no longer popped on
completion) so a post-completion status poll can still read it. Reuses the
``_FakeProc``/``_FakeStream`` mocking style from test_render_detach.py.
"""
import asyncio
from pathlib import Path
from unittest.mock import Mock

import pytest

import serve.routes.projects as projects_mod
from serve.routes.projects import (
    _RenderJob,
    _render_phase_for,
    _run_render_detached,
    render_status,
    render_project,
)

PID = "44444444-4444-4444-8444-444444444444"


@pytest.fixture(autouse=True)
def _clean_state():
    projects_mod._active_renders.clear()
    projects_mod._render_procs.clear()
    projects_mod._render_jobs.clear()
    projects_mod._render_task_refs.clear()
    yield
    projects_mod._active_renders.clear()
    projects_mod._render_procs.clear()
    projects_mod._render_jobs.clear()
    projects_mod._render_task_refs.clear()


class _FakeStream:
    """stderr: hands back `lines` then EOF. stdout: returns `blob` on read()."""
    def __init__(self, lines=(), blob=b""):
        self._lines = list(lines)
        self._blob = blob

    async def readline(self):
        return self._lines.pop(0) if self._lines else b""

    async def read(self):
        return self._blob


class _FakeProc:
    def __init__(self, stderr_lines=(), stdout_blob=b"", returncode=0, pid=4242):
        self.stderr = _FakeStream(lines=stderr_lines)
        self.stdout = _FakeStream(blob=stdout_blob)
        self.returncode = returncode
        self.pid = pid
        self.waited = False

    async def wait(self):
        self.waited = True


def _patch_spawn(monkeypatch, proc):
    async def _fake_exec(*args, **kwargs):
        return proc
    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", _fake_exec)


def _reserve(job):
    projects_mod._render_jobs[PID] = job
    projects_mod._active_renders.add(PID)


# ---------------------------------------------------------------------------
# _render_phase_for
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("line,expected", [
    ("[montaj render] bundling segment 2/16 (overlay-1--ov-hook)...", "rendering"),
    ("[montaj render] bundling segment 3/16 (captions)...", "captions"),
    ("[montaj render] rendering with Puppeteer...", "rendering"),
    ("[montaj render] composing final video...", "encoding"),
    ("[montaj compose] concatenating 16 segment(s)...", "encoding"),
    ("some unrelated chatter", None),
    ("", None),
])
def test_render_phase_for(line, expected):
    assert _render_phase_for(line) == expected


def test_render_phase_captions_checked_before_rendering():
    # A captions bundling line must classify as captions, not rendering, even
    # though it also matches "bundling segment".
    line = "[montaj render] bundling segment 9/16 (captions)..."
    assert _render_phase_for(line) == "captions"


# ---------------------------------------------------------------------------
# _run_render_detached persists the terminal job + tracks phase
# ---------------------------------------------------------------------------

def test_detached_render_persists_job_and_sets_phase_done(monkeypatch, tmp_path):
    proc = _FakeProc(
        stderr_lines=[
            b"[montaj render] bundling segment 1/2 (overlay-1)...\n",
            b"[montaj render] composing final video...\n",
        ],
        stdout_blob=b"/scratch/output/render.mp4\n",
        returncode=0,
    )
    _patch_spawn(monkeypatch, proc)
    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"

    asyncio.run(_run_render_detached(PID, ["node", "render.js"], {}, pp, pp, job))

    assert job.status == "done"
    assert job.phase == "done"
    assert job.result == "/scratch/output/render.mp4"
    # The job is NOT popped — it persists for post-completion polling.
    assert projects_mod._render_jobs.get(PID) is job
    # but the proc/slot are still released.
    assert PID not in projects_mod._active_renders
    assert PID not in projects_mod._render_procs


def test_detached_render_phase_reflects_last_marker_mid_run(monkeypatch, tmp_path):
    # stderr ends after a captions bundling line and no encoding line → the
    # last-seen phase is captions when the stream EOFs (returncode nonzero so it
    # never reaches the done override).
    proc = _FakeProc(
        stderr_lines=[
            b"[montaj render] bundling segment 1/4 (overlay-1)...\n",
            b"[montaj render] bundling segment 2/4 (captions)...\n",
        ],
        returncode=1,
    )
    _patch_spawn(monkeypatch, proc)
    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"

    asyncio.run(_run_render_detached(PID, ["node", "render.js"], {}, pp, pp, job))

    assert job.status == "error"
    assert job.phase == "captions"


# ---------------------------------------------------------------------------
# render_status endpoint
# ---------------------------------------------------------------------------

def test_render_status_idle_when_no_job(tmp_path):
    out = asyncio.run(render_status(PID, project_dir=tmp_path))
    assert out == {"status": "idle"}


def test_render_status_running(tmp_path):
    job = _RenderJob()
    job.phase = "rendering"
    projects_mod._render_jobs[PID] = job

    out = asyncio.run(render_status(PID, project_dir=tmp_path))
    assert out == {"status": "running", "phase": "rendering"}


def test_render_status_done_includes_output_path(tmp_path):
    job = _RenderJob()
    job.status, job.phase, job.result = "done", "done", "/p/output/x.mp4"
    projects_mod._render_jobs[PID] = job

    out = asyncio.run(render_status(PID, project_dir=tmp_path))
    assert out == {"status": "done", "phase": "done", "outputPath": "/p/output/x.mp4"}


def test_render_status_error_includes_error(tmp_path):
    job = _RenderJob()
    job.status, job.phase, job.result = "error", "rendering", "Render failed (exit 2)"
    projects_mod._render_jobs[PID] = job

    out = asyncio.run(render_status(PID, project_dir=tmp_path))
    assert out == {"status": "error", "phase": "rendering", "error": "Render failed (exit 2)"}


# ---------------------------------------------------------------------------
# Async kick: handler returns 202 instead of an SSE stream
# ---------------------------------------------------------------------------

class _FakeRequest:
    def __init__(self, query):
        self.query_params = query

    async def is_disconnected(self):
        return False


def _setup_video_project(tmp_path, monkeypatch):
    """Make render_project's non-carousel path runnable without a real subprocess."""
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "project.json").write_text('{"projectType": "video", "name": "My Reel"}')

    # render.js must exist where render_project looks for it.
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "render.js").write_text("// stub")
    monkeypatch.setattr(projects_mod, "render_runtime_dir", lambda: str(runtime))
    monkeypatch.setattr(projects_mod.shutil, "which", lambda b: "/usr/bin/node")

    # Never actually spawn — capture the cmd and leave a never-resolving job.
    captured = {}

    async def _fake_detached(project_id, cmd, env, render_input, project_path, job):
        captured["cmd"] = cmd
        # leave job running (simulates an in-flight render)

    monkeypatch.setattr(projects_mod, "_run_render_detached", _fake_detached)
    return project_dir, captured


def test_async_kick_returns_202(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"})

    resp = asyncio.run(render_project(PID, req, project_dir=project_dir))

    assert resp.status_code == 202
    import json as _json
    body = _json.loads(bytes(resp.body))
    assert body == {"projectId": PID, "status": "running"}
    # the detached worker was kicked and the job is tracked
    assert PID in projects_mod._render_jobs


def test_video_script_args_include_out_into_output_dir(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    cmd = captured["cmd"]
    assert "--out" in cmd
    out_path = cmd[cmd.index("--out") + 1]
    assert out_path.startswith(str(project_dir / "output"))
    assert out_path.endswith(".mp4")
    assert (project_dir / "output").is_dir()


def test_no_async_param_returns_sse_stream(tmp_path, monkeypatch):
    from fastapi.responses import StreamingResponse
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({})

    resp = asyncio.run(render_project(PID, req, project_dir=project_dir))

    assert isinstance(resp, StreamingResponse)
    assert resp.media_type == "text/event-stream"
