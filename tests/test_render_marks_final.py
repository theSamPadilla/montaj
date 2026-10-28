"""An export marks its project final, first, and renders whatever the write did.

`status` is a label (pending, draft, final): any status renders. Every render
entry sets it to `final` before rendering, so neither the editor nor an agent
has to: serve's render route (the editor's Export, an agent's render, a review
send) and the headless `montaj render`. A write that does not happen (a
storyboard stage, a Studio sync clash, an unreadable file, an error) never
stops the render.
"""
import asyncio
import json
from types import SimpleNamespace

import pytest

import serve.routes.projects as projects_mod
from lib import project_status
from serve.routes.projects import render_project

PID = "55555555-5555-4555-8555-555555555555"


@pytest.fixture(autouse=True)
def _clean_state():
    for s in (projects_mod._active_renders, projects_mod._render_procs, projects_mod._render_jobs,
              projects_mod._render_task_refs):
        s.clear()
    yield
    for s in (projects_mod._active_renders, projects_mod._render_procs, projects_mod._render_jobs,
              projects_mod._render_task_refs):
        s.clear()


class _Broadcaster:
    def __init__(self):
        self.frames = []

    def publish(self, project_id, frame):
        self.frames.append((project_id, frame))


class _Request:
    def __init__(self, broadcaster=None):
        self.query_params = {"async": "1"}
        self.headers = {}
        self.app = SimpleNamespace(state=SimpleNamespace(broadcaster=broadcaster))

    async def is_disconnected(self):
        return False

    async def json(self):
        raise ValueError("no body")


def _project(tmp_path, monkeypatch, **fields):
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "project.json").write_text(json.dumps({"id": PID, "projectType": "video", "name": "Reel", **fields}))
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "render.js").write_text("// stub")
    monkeypatch.setattr(projects_mod, "render_runtime_dir", lambda: str(runtime))
    monkeypatch.setattr(projects_mod.shutil, "which", lambda b: "/usr/bin/node")
    kicked = {}

    async def _fake_detached(project_id, cmd, env, render_input, project_path, job, **kwargs):
        kicked["status_at_render"] = json.loads(project_path.read_text()).get("status")

    monkeypatch.setattr(projects_mod, "_run_render_detached", _fake_detached)
    return project_dir, kicked


def _render(project_dir, broadcaster=None):
    resp = asyncio.run(render_project(PID, _Request(broadcaster), project_dir=project_dir))
    assert resp.status_code == 202
    return json.loads((project_dir / "project.json").read_text())


@pytest.mark.parametrize("status", ["draft", "pending"])
def test_the_render_route_marks_the_project_final_before_it_renders(tmp_path, monkeypatch, status):
    project_dir, kicked = _project(tmp_path, monkeypatch, status=status)
    b = _Broadcaster()
    after = _render(project_dir, b)
    assert after["status"] == "final"
    assert kicked["status_at_render"] == "final", "written before the render reads the project"
    assert after["name"] == "Reel", "nothing else changed"
    assert len(b.frames) == 1 and json.loads(b.frames[0][1][len("data: "):])["status"] == "final"


def test_an_already_final_project_is_not_written(tmp_path, monkeypatch):
    project_dir, kicked = _project(tmp_path, monkeypatch, status="final")
    b = _Broadcaster()
    assert _render(project_dir, b)["status"] == "final"
    assert b.frames == []
    assert kicked["status_at_render"] == "final"


@pytest.mark.parametrize("fields", [
    {"status": "storyboard_ready", "projectType": "ai_video"},
    {"status": "pending", "projectType": "ai_video"},
    {"status": "pending", "workflow": "ai-broll"},
    {"status": "generating"},
    {},
])
def test_a_status_it_must_not_touch_is_left_and_the_project_still_renders(tmp_path, monkeypatch, fields):
    project_dir, kicked = _project(tmp_path, monkeypatch, **fields)
    after = _render(project_dir)
    assert after.get("status") == fields.get("status")
    assert "status_at_render" in kicked, "it rendered"


def test_a_studio_sync_clash_skips_the_write_and_the_project_still_renders(tmp_path, monkeypatch):
    project_dir, kicked = _project(tmp_path, monkeypatch, status="draft")
    monkeypatch.setattr(projects_mod.save_guard, "maintenance_allows", lambda raw, project, who=None: False)
    assert _render(project_dir)["status"] == "draft"
    assert kicked["status_at_render"] == "draft"


def test_a_failing_write_never_stops_the_render(tmp_path, monkeypatch):
    project_dir, kicked = _project(tmp_path, monkeypatch, status="draft")

    def _boom(*a, **k):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(projects_mod, "mark_final_locked", _boom)
    assert _render(project_dir)["status"] == "draft"
    assert kicked["status_at_render"] == "draft"


def test_an_invalid_request_marks_nothing(tmp_path, monkeypatch):
    project_dir, _ = _project(tmp_path, monkeypatch, status="draft")
    req = _Request()
    req.query_params = {"async": "1", "scale": "9"}
    with pytest.raises(Exception):
        asyncio.run(render_project(PID, req, project_dir=project_dir))
    assert json.loads((project_dir / "project.json").read_text())["status"] == "draft"


# ── The headless `montaj render` ────────────────────────────────────────────

def test_the_cli_render_marks_the_project_final_before_it_hands_over_to_node(tmp_path, monkeypatch):
    import project.render as cli_render
    path = tmp_path / "project.json"
    path.write_text(json.dumps({"id": "p", "status": "draft", "settings": {"resolution": [64, 64]}, "tracks": []}))
    seen = {}

    def _exec(file, cmd, env):
        seen["status"] = json.loads(path.read_text())["status"]
        raise SystemExit(0)

    monkeypatch.setattr(cli_render.os, "execvpe", _exec)
    monkeypatch.setattr(cli_render, "render_runtime_dir", lambda: str(tmp_path))
    with pytest.raises(SystemExit):
        cli_render.main(project_path=str(path))
    assert seen["status"] == "final"


def test_mark_final_never_raises_and_leaves_an_unreadable_file_alone(tmp_path):
    path = tmp_path / "project.json"
    path.write_text("{not json")
    assert project_status.mark_final(path) is False
    assert path.read_text() == "{not json"
    assert project_status.mark_final(tmp_path / "missing.json") is False
