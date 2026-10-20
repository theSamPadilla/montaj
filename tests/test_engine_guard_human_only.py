"""§477: routes that replace project content wholesale without a compare (restore, rerun,
asset include, delete files) are the human's. With the engine guard on, only the window's
editor (the launch secret AND writer editor) may call them; anything else is 403
human_only and nothing changes. Guard off: as before. None of them is on the app's MCP
forward allowlist, so no AI tool reaches them legitimately."""
import json
import subprocess
import threading
import time

import pytest
from starlette.testclient import TestClient

import serve.routes.projects as projects_mod
from lib.project_lock import ProjectLockTimeout, project_lock, write_json_atomic
from serve import save_guard
from serve.common import get_project_dir
from serve.server import app

PID = "human-proj"
SECRET = "5e" * 32
EDITOR = {"x-montaj-shell": SECRET, "x-montaj-writer": "editor"}
HUMAN_ONLY = {"detail": {"error": "human_only", "message": "Only the Montaj window can do this."}}


class _StubBroadcaster:
    def publish(self, *a, **k):
        pass


def _git(d, *args):
    return subprocess.run(["git", "-c", "user.email=a@b", "-c", "user.name=a", *args], cwd=d, check=True,
                          capture_output=True, text=True).stdout.strip()


@pytest.fixture
def proj(tmp_path, monkeypatch):
    saved = dict(save_guard._state)
    d = tmp_path / PID
    d.mkdir()
    write_json_atomic(d / "project.json", {
        "id": PID, "name": "first", "status": "draft", "sources": [{"id": "s1", "src": "/x.mp4"}],
        "tracks": [{"id": "trk-0", "items": [{"id": "human", "type": "video", "src": "/x.mp4", "start": 0, "end": 1}]}],
    })
    (d / "assets").mkdir()
    (d / "assets" / "a.png").write_bytes(b"a")
    _git(d, "init", "-q")
    _git(d, "add", "project.json")
    _git(d, "commit", "-qm", "v1")
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: d
    try:
        yield d
    finally:
        app.dependency_overrides.pop(get_project_dir, None)
        save_guard._state.clear()
        save_guard._state.update(saved)


def _guard(monkeypatch, on=True):
    if on:
        monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    else:
        monkeypatch.delenv("MONTAJ_ENGINE_GUARD", raising=False)
    monkeypatch.delenv("MONTAJ_SHELL_SECRET_STDIN", raising=False)
    save_guard._state.update({"secret": None, "logged": False, "secret_logged": False})
    save_guard._inject_secret_for_tests(SECRET)
    save_guard.startup()


def _calls(d):
    head = _git(d, "rev-parse", "HEAD")
    return {
        "restore": lambda c, h: c.post(f"/api/projects/{PID}/versions/{head}/restore", headers=h),
        "rerun": lambda c, h: c.post(f"/api/projects/{PID}/rerun", json={}, headers=h),
        "assets": lambda c, h: c.post(f"/api/projects/{PID}/assets",
                                      json={"from": {"profile": "!bad", "filename": "a.png"}}, headers=h),
        "delete": lambda c, h: c.request("DELETE", f"/api/projects/{PID}/files",
                                         json={"paths": ["assets/a.png"]}, headers=h),
    }


def _snapshot(d):
    return (d / "project.json").read_bytes(), (d / "assets" / "a.png").exists(), _git(d, "rev-list", "--all")


ROUTES = ["restore", "rerun", "assets", "delete"]
NOT_EDITOR = [
    {},
    {"x-montaj-writer": "editor", "x-montaj-guard": "advisory"},
    {"x-montaj-shell": "a1" * 32, "x-montaj-writer": "editor"},
    {"x-montaj-shell": SECRET, "x-montaj-writer": "ai"},
    {"x-montaj-shell": SECRET, "x-montaj-writer": "tool"},
    {"x-montaj-shell": SECRET},
]


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("headers", NOT_EDITOR)
def test_guard_on_anything_but_the_editor_is_refused_and_nothing_changes(proj, monkeypatch, route, headers):
    _guard(monkeypatch)
    # A human edit after the last version: a restore or rerun would take it away.
    doc = json.loads((proj / "project.json").read_text())
    doc["name"] = "HUMAN NEWEST"
    write_json_atomic(proj / "project.json", doc)
    before = _snapshot(proj)
    resp = _calls(proj)[route](TestClient(app, raise_server_exceptions=False), headers)
    assert resp.status_code == 403, resp.text
    assert resp.json() == HUMAN_ONLY
    assert _snapshot(proj) == before


def test_guard_on_the_editor_may_restore_rerun_include_and_delete(proj, monkeypatch):
    _guard(monkeypatch)
    c = TestClient(app, raise_server_exceptions=False)
    calls = _calls(proj)
    assert calls["delete"](c, EDITOR).status_code == 200
    assert not (proj / "assets" / "a.png").exists()
    assert calls["assets"](c, EDITOR).json()["detail"]["error"] == "invalid_name"   # past the gate
    assert calls["restore"](c, EDITOR).status_code == 200
    assert calls["rerun"](c, EDITOR).status_code == 200
    assert json.loads((proj / "project.json").read_text())["status"] == "pending"


@pytest.mark.parametrize("headers", [{}, {"x-montaj-shell": SECRET, "x-montaj-writer": "ai"}])
def test_guard_off_nothing_changes(proj, monkeypatch, headers):
    _guard(monkeypatch, on=False)
    c = TestClient(app, raise_server_exceptions=False)
    calls = _calls(proj)
    assert calls["delete"](c, headers).status_code == 200
    assert calls["assets"](c, headers).json()["detail"]["error"] == "invalid_name"
    assert calls["restore"](c, headers).status_code == 200
    assert calls["rerun"](c, headers).status_code == 200


def test_restore_takes_its_autosave_inside_the_lock_hold_that_reads_the_project(proj, monkeypatch):
    """The autosave before a restore commits what the restore then replaces: both in one
    lock hold, so an edit cannot land between the commit and the restore's write and be
    lost from history."""
    _guard(monkeypatch, on=False)
    path = proj / "project.json"
    head = _git(proj, "rev-parse", "HEAD")
    doc = json.loads(path.read_text())
    doc["name"] = "edited before the restore"
    write_json_atomic(path, doc)
    seen = {}
    real = projects_mod._git_commit_sync

    def commit_and_probe(project_dir, message):
        def probe():
            try:
                with project_lock(path, timeout=0.05):
                    seen["held"] = False
            except ProjectLockTimeout:
                seen["held"] = True
        t = threading.Thread(target=probe)
        t.start()
        t.join()
        seen.setdefault("messages", []).append(message)
        return real(project_dir, message)
    monkeypatch.setattr(projects_mod, "_git_commit_sync", commit_and_probe)
    resp = TestClient(app, raise_server_exceptions=False).post(f"/api/projects/{PID}/versions/{head}/restore")
    assert resp.status_code == 200, resp.text
    assert seen["held"] is True
    assert any("autosave before restore" in m for m in seen["messages"])
    assert json.loads(_git(proj, "show", "HEAD:project.json"))["name"] == "edited before the restore"
    assert json.loads(path.read_text())["name"] == "first"


def test_rerun_takes_its_autosave_inside_the_lock_hold_that_reads_the_project(proj, monkeypatch):
    """The commit before a rerun's reset and the reset itself share one lock hold."""
    _guard(monkeypatch, on=False)
    path = proj / "project.json"
    doc = json.loads(path.read_text())
    doc["name"] = "edited before the rerun"
    write_json_atomic(path, doc)
    seen = {}
    real = projects_mod._git_commit_sync

    def commit_and_probe(project_dir, message):
        def probe():
            try:
                with project_lock(path, timeout=0.05):
                    seen["held"] = False
            except ProjectLockTimeout:
                seen["held"] = True
        t = threading.Thread(target=probe)
        t.start()
        t.join()
        seen.setdefault("messages", []).append(message)
        return real(project_dir, message)
    monkeypatch.setattr(projects_mod, "_git_commit_sync", commit_and_probe)
    resp = TestClient(app, raise_server_exceptions=False).post(f"/api/projects/{PID}/rerun", json={"versionName": "v-test"})
    assert resp.status_code == 200, resp.text
    assert seen["held"] is True
    assert seen["messages"] == ["version: run 1 — v-test"]
    assert json.loads(_git(proj, "show", "HEAD:project.json"))["name"] == "edited before the rerun"
    body = resp.json()
    assert body["status"] == "pending" and body["runCount"] == 2
    assert body["tracks"] == [{"id": "trk-0", "items": [{"id": "s1", "src": "/x.mp4", "order": None}]}]
    assert json.loads(path.read_text()) == body


def test_rerun_keeps_an_edit_that_lands_just_before_its_lock_in_the_committed_autosave(proj, monkeypatch):
    """Another writer holds the lock when the rerun starts and edits under it: the rerun
    waits, then commits that edit as the version it replaces."""
    _guard(monkeypatch, on=False)
    path = proj / "project.json"
    result = {}

    def rerun():
        result["resp"] = TestClient(app, raise_server_exceptions=False).post(f"/api/projects/{PID}/rerun")

    with project_lock(path):
        t = threading.Thread(target=rerun)
        t.start()
        time.sleep(0.5)
        doc = json.loads(path.read_text())
        doc["name"] = "late edit"
        write_json_atomic(path, doc)
    t.join(15)
    assert result["resp"].status_code == 200, result["resp"].text
    assert json.loads(_git(proj, "show", "HEAD:project.json"))["name"] == "late edit"
    assert _git(proj, "log", "-1", "--format=%s") == "version: run 1 — draft"
    assert json.loads(path.read_text())["name"] == "late edit"
    assert json.loads(path.read_text())["runCount"] == 2
