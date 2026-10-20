"""GET /api/projects/{id}/revisions: the §477 revisions of a project's fields without a
project open. Strictly read-only: it never takes the lock, writes, sweeps or publishes."""
import json
import os
import threading

import pytest
from starlette.testclient import TestClient

import serve.routes.projects as projects_mod
from lib.project_lock import project_lock, write_json_atomic
from lib.project_revisions import revisions_of
from lib.project_tracks import normalize_tracks
from serve import save_guard
from serve.common import get_project_dir
from serve.server import app

PID = "rev-proj"
_seen = {}


class _Broadcaster:
    def __init__(self):
        self.calls = []

    def publish(self, *a, **k):
        self.calls.append(a)


def _start(monkeypatch, guard=True):
    if guard:
        monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    else:
        monkeypatch.delenv("MONTAJ_ENGINE_GUARD", raising=False)
    monkeypatch.delenv("MONTAJ_SHELL_SECRET_STDIN", raising=False)
    save_guard._state.update({"secret": None, "logged": False, "secret_logged": False})
    save_guard._inject_secret_for_tests("5e" * 32)
    save_guard.startup()


@pytest.fixture
def proj(tmp_path, monkeypatch):
    saved = dict(save_guard._state)
    project_dir = tmp_path / PID
    project_dir.mkdir()
    write_json_atomic(project_dir / "project.json", {
        "id": PID, "name": "first", "status": "draft",
        "tracks": [{"id": "trk-0", "items": []}], "sources": [],
    })
    broadcaster = _Broadcaster()
    app.state.broadcaster = broadcaster

    async def _boom(*a, **k):
        raise AssertionError("the revisions route must not open the project")

    monkeypatch.setattr(projects_mod, "_open_project", _boom)
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    _start(monkeypatch)
    _seen["b"] = broadcaster
    try:
        yield project_dir
    finally:
        app.dependency_overrides.pop(get_project_dir, None)
        save_guard._state.clear()
        save_guard._state.update(saved)


def _client():
    return TestClient(app, raise_server_exceptions=False)


def _disk(d):
    return json.loads((d / "project.json").read_bytes())


def _snapshot(d):
    p = d / "project.json"
    return p.read_bytes(), p.stat().st_mtime_ns, sorted(os.listdir(d))


def test_requested_fields_equal_revisions_of(proj):
    resp = _client().get(f"/api/projects/{PID}/revisions?fields=name,status,missing")
    assert resp.status_code == 200
    want = revisions_of(normalize_tracks(_disk(proj)), ["name", "status", "missing"])
    assert resp.json() == {"revisions": want}
    assert json.loads(resp.headers["x-montaj-revisions"]) == want


def test_no_fields_means_all_top_level(proj):
    resp = _client().get(f"/api/projects/{PID}/revisions")
    doc = normalize_tracks(_disk(proj))
    assert resp.json() == {"revisions": revisions_of(doc)}
    assert set(resp.json()["revisions"]) == set(doc)
    assert json.loads(resp.headers["x-montaj-revisions"]) == resp.json()["revisions"]


def test_writes_nothing_and_never_opens(proj):
    before = _snapshot(proj)
    c = _client()
    assert c.get(f"/api/projects/{PID}/revisions?fields=name").status_code == 200
    assert c.get(f"/api/projects/{PID}/revisions").status_code == 200
    assert _snapshot(proj) == before
    assert _seen["b"].calls == []


def test_legacy_tracks_are_compared_normalised_and_not_written(proj):
    doc = _disk(proj)
    doc["tracks"] = [[{"id": "i1", "type": "video"}]]
    write_json_atomic(proj / "project.json", doc)
    before = _snapshot(proj)
    resp = _client().get(f"/api/projects/{PID}/revisions?fields=tracks")
    assert resp.json()["revisions"] == revisions_of(normalize_tracks(doc), ["tracks"])
    assert resp.json()["revisions"] != revisions_of(doc, ["tracks"])
    assert _snapshot(proj) == before


def test_guard_off_is_a_404(proj, monkeypatch):
    _start(monkeypatch, guard=False)
    resp = _client().get(f"/api/projects/{PID}/revisions?fields=name")
    assert resp.status_code == 404
    assert "x-montaj-revisions" not in resp.headers


def test_corrupt_file_is_a_502(proj):
    (proj / "project.json").write_text("{not json")
    resp = _client().get(f"/api/projects/{PID}/revisions")
    assert resp.status_code == 502
    assert resp.json()["detail"]["error"] == "project_unreadable"


def test_missing_file_is_a_502(proj):
    (proj / "project.json").unlink()
    assert _client().get(f"/api/projects/{PID}/revisions").status_code == 502


def test_non_object_document_is_a_502(proj):
    (proj / "project.json").write_text("[1, 2]")
    assert _client().get(f"/api/projects/{PID}/revisions").status_code == 502


def test_unknown_project_is_a_404(proj, tmp_path, monkeypatch):
    app.dependency_overrides.pop(get_project_dir, None)
    monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path / "empty-ws")
    resp = _client().get("/api/projects/nope/revisions")
    assert resp.status_code == 404


@pytest.mark.parametrize("fields", ["na me", "a/b", "a,,b$", "x" + ",y" * 64])
def test_bad_fields_are_a_400(proj, fields):
    resp = _client().get(f"/api/projects/{PID}/revisions", params={"fields": fields})
    assert resp.status_code == 400


def test_sixty_four_fields_are_fine(proj):
    names = ",".join(f"f{i}" for i in range(64))
    assert _client().get(f"/api/projects/{PID}/revisions", params={"fields": names}).status_code == 200


def test_does_not_wait_for_the_project_lock(proj):
    held, release = threading.Event(), threading.Event()

    def hold():
        with project_lock(proj / "project.json"):
            held.set()
            release.wait(10)

    t = threading.Thread(target=hold)
    t.start()
    assert held.wait(5)
    try:
        out = {}
        w = threading.Thread(target=lambda: out.update(r=_client().get(f"/api/projects/{PID}/revisions?fields=name")))
        w.start()
        w.join(3)
        assert not w.is_alive(), "the route blocked on the project lock"
        assert out["r"].status_code == 200
    finally:
        release.set()
        t.join()
