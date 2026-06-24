"""Async caption kick, status polling, and the /captions/status endpoint.

A caption job can be started in async mode (``?async=1``): the handler kicks the
detached worker and returns 202 immediately instead of holding an SSE stream open.
Clients then poll GET /captions/status to follow progress and pick up the caption
track or error when terminal.

The terminal job is PERSISTED in ``_caption_jobs`` (not popped on completion) so
a post-completion status poll can still read it. Mirrors the test style from
test_render_async.py.
"""
import asyncio
import json as _json
from pathlib import Path
from unittest.mock import Mock

import pytest

import serve.routes.projects as projects_mod
from serve.routes.projects import (
    _CaptionJob,
    _caption_jobs,
    _run_caption_detached,
    captions_status,
    generate_captions,
)

PID = "55555555-5555-5555-8555-555555555555"


@pytest.fixture(autouse=True)
def _clean_state():
    projects_mod._active_caption_jobs.clear()
    projects_mod._caption_jobs.clear()
    projects_mod._caption_task_refs.clear()
    yield
    projects_mod._active_caption_jobs.clear()
    projects_mod._caption_jobs.clear()
    projects_mod._caption_task_refs.clear()


# ---------------------------------------------------------------------------
# _CaptionJob initial state
# ---------------------------------------------------------------------------

def test_caption_job_initial_state():
    job = _CaptionJob()
    assert job.status == "running"
    assert job.result is None
    assert job.error is None


# ---------------------------------------------------------------------------
# _run_caption_detached — success path
# ---------------------------------------------------------------------------

def test_run_caption_detached_success(monkeypatch, tmp_path):
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    project = {"name": "test", "tracks": [{"clips": []}]}

    fake_track = {"style": "pop", "segments": []}

    async def fake_pipeline(*args, **kwargs):
        return fake_track

    monkeypatch.setattr(projects_mod, "_run_caption_pipeline", fake_pipeline)

    job = _CaptionJob()
    projects_mod._active_caption_jobs.add(PID)
    projects_mod._caption_jobs[PID] = job

    broadcaster = Mock()
    asyncio.run(_run_caption_detached(
        PID, project_dir, project, "large", "auto", "pop", broadcaster, job
    ))

    assert job.status == "done"
    assert job.result == fake_track
    assert job.error is None
    # Slot released.
    assert PID not in projects_mod._active_caption_jobs
    # Terminal job NOT popped — persists for polling.
    assert projects_mod._caption_jobs.get(PID) is job


# ---------------------------------------------------------------------------
# _run_caption_detached — error paths
# ---------------------------------------------------------------------------

def test_run_caption_detached_pipeline_error(monkeypatch, tmp_path):
    from serve.routes.projects import CaptionPipelineError

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    project = {}

    async def fake_pipeline(*args, **kwargs):
        raise CaptionPipelineError("transcribe failed (exit 1)")

    monkeypatch.setattr(projects_mod, "_run_caption_pipeline", fake_pipeline)

    job = _CaptionJob()
    projects_mod._active_caption_jobs.add(PID)
    broadcaster = Mock()

    asyncio.run(_run_caption_detached(
        PID, project_dir, project, "large", "auto", "pop", broadcaster, job
    ))

    assert job.status == "error"
    assert "transcribe failed" in job.error
    assert PID not in projects_mod._active_caption_jobs


def test_run_caption_detached_value_error(monkeypatch, tmp_path):
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    project = {}

    async def fake_pipeline(*args, **kwargs):
        raise ValueError("no clips in primary track")

    monkeypatch.setattr(projects_mod, "_run_caption_pipeline", fake_pipeline)

    job = _CaptionJob()
    projects_mod._active_caption_jobs.add(PID)
    broadcaster = Mock()

    asyncio.run(_run_caption_detached(
        PID, project_dir, project, "large", "auto", "pop", broadcaster, job
    ))

    assert job.status == "error"
    assert "no clips" in job.error


# ---------------------------------------------------------------------------
# captions_status endpoint
# ---------------------------------------------------------------------------

def test_captions_status_idle_when_no_job(tmp_path):
    out = asyncio.run(captions_status(PID, project_dir=tmp_path))
    assert out == {"status": "idle"}


def test_captions_status_running(tmp_path):
    job = _CaptionJob()
    projects_mod._caption_jobs[PID] = job

    out = asyncio.run(captions_status(PID, project_dir=tmp_path))
    assert out == {"status": "running"}


def test_captions_status_done_includes_track(tmp_path):
    job = _CaptionJob()
    job.status = "done"
    job.result = {"style": "pop", "segments": []}
    projects_mod._caption_jobs[PID] = job

    out = asyncio.run(captions_status(PID, project_dir=tmp_path))
    assert out == {"status": "done", "captions": {"style": "pop", "segments": []}}


def test_captions_status_error_includes_error(tmp_path):
    job = _CaptionJob()
    job.status = "error"
    job.error = "transcribe failed (exit 1)"
    projects_mod._caption_jobs[PID] = job

    out = asyncio.run(captions_status(PID, project_dir=tmp_path))
    assert out == {"status": "error", "error": "transcribe failed (exit 1)"}


# ---------------------------------------------------------------------------
# Async kick: handler returns 202 instead of an SSE stream
# ---------------------------------------------------------------------------

class _FakeRequest:
    def __init__(self, query, app_state=None):
        self.query_params = query
        self.app = Mock()
        self.app.state.broadcaster = app_state or Mock()

    async def is_disconnected(self):
        return False


def _setup_caption_project(tmp_path, monkeypatch):
    """Set up a minimal project dir and patch _run_caption_detached to not run."""
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "project.json").write_text(
        _json.dumps({"name": "Test", "tracks": [{"clips": []}]})
    )

    captured = {}

    async def fake_detached(project_id, proj_dir, project, model, language, style, broadcaster, job):
        captured["called"] = True
        # leave job in running state (simulates in-flight caption)

    monkeypatch.setattr(projects_mod, "_run_caption_detached", fake_detached)
    return project_dir, captured


def test_async_kick_returns_202(tmp_path, monkeypatch):
    project_dir, captured = _setup_caption_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"})

    resp = asyncio.run(generate_captions(PID, req, body={}, project_dir=project_dir))

    assert resp.status_code == 202
    body = _json.loads(bytes(resp.body))
    assert body == {"projectId": PID, "status": "running"}
    # Job is tracked and slot is held.
    assert PID in projects_mod._caption_jobs
    assert PID in projects_mod._active_caption_jobs


def test_async_kick_409_on_concurrent_job(tmp_path, monkeypatch):
    from fastapi import HTTPException
    project_dir, _ = _setup_caption_project(tmp_path, monkeypatch)
    # Simulate an already-running job.
    projects_mod._active_caption_jobs.add(PID)
    req = _FakeRequest({"async": "1"})

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(generate_captions(PID, req, body={}, project_dir=project_dir))

    assert exc_info.value.status_code == 409


def test_no_async_param_returns_sse_stream(tmp_path, monkeypatch):
    from fastapi.responses import StreamingResponse
    project_dir, _ = _setup_caption_project(tmp_path, monkeypatch)
    req = _FakeRequest({})

    resp = asyncio.run(generate_captions(PID, req, body={}, project_dir=project_dir))

    assert isinstance(resp, StreamingResponse)
    assert resp.media_type == "text/event-stream"
