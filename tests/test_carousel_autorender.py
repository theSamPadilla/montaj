"""Tests for auto-render-on-`final` in serve/routes/projects.save_project.

A carousel reaching `final` should schedule a detached background render; video
projects and non-transitions must not.
"""
import json
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve.server import app
from serve.common import get_project_dir
import serve.routes.projects as projects_mod

client = TestClient(app, raise_server_exceptions=False)

PID = "11111111-1111-4111-8111-111111111111"


class _StubBroadcaster:
    def publish(self, *a, **k):
        pass


def _make_project(tmp_path: Path, project_type: str, status: str) -> Path:
    d = tmp_path / PID
    d.mkdir(parents=True)
    (d / "project.json").write_text(json.dumps({
        "id": PID,
        "projectType": project_type,
        "status": status,
        "runCount": 1,
        "settings": {"resolution": [1080, 1350]},
        "carousel": {"aspect": "portrait"},
        "slides": [],
    }))
    return d


@pytest.fixture
def render_spy(monkeypatch):
    """Replace the detached render with a synchronous spy. The PUT handler CALLS it
    (to build the coroutine) before asyncio.create_task, so the call is recorded
    deterministically without ever spawning node."""
    calls = []

    async def _noop():
        return None

    def _spy(project_id, project_dir, *a, **k):
        calls.append(project_id)
        return _noop()

    monkeypatch.setattr(projects_mod, "_run_carousel_render_detached", _spy)
    monkeypatch.setattr(projects_mod, "_git_commit_sync", lambda *a, **k: None)
    app.state.broadcaster = _StubBroadcaster()
    projects_mod._active_renders.clear()
    yield calls
    projects_mod._active_renders.clear()


def _put(project_dir: Path, body: dict):
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        return client.put(f"/api/projects/{PID}", json=body)
    finally:
        app.dependency_overrides.pop(get_project_dir, None)


def test_carousel_pending_to_final_schedules_render(tmp_path, render_spy):
    d = _make_project(tmp_path, "carousel", "pending")
    r = _put(d, {"id": PID, "status": "final"})
    assert r.status_code == 200
    assert render_spy == [PID]
    assert PID in projects_mod._active_renders  # slot reserved before dispatch


def test_video_to_final_does_not_schedule(tmp_path, render_spy):
    d = _make_project(tmp_path, "video", "pending")
    r = _put(d, {"id": PID, "status": "final"})
    assert r.status_code == 200
    assert render_spy == []


def test_already_final_no_transition_does_not_schedule(tmp_path, render_spy):
    d = _make_project(tmp_path, "carousel", "final")
    r = _put(d, {"id": PID, "status": "final"})
    assert r.status_code == 200
    assert render_spy == []


def test_carousel_to_draft_does_not_schedule(tmp_path, render_spy):
    d = _make_project(tmp_path, "carousel", "pending")
    r = _put(d, {"id": PID, "status": "draft"})
    assert r.status_code == 200
    assert render_spy == []


def test_no_double_schedule_when_already_rendering(tmp_path, render_spy):
    d = _make_project(tmp_path, "carousel", "pending")
    projects_mod._active_renders.add(PID)  # a render is already in flight
    r = _put(d, {"id": PID, "status": "final"})
    assert r.status_code == 200
    assert render_spy == []  # deduped — not scheduled again
