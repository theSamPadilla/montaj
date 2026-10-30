"""§631: POST /api/run with `adoptSeed` turns the seed project `id` into the real
project in place (project/init.py --adopt-seed), holding the project's lock while
init runs. Run through the route, init in its real subprocess."""
import hashlib
import json
import threading
import time
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve.server import app
from serve.sse import SSEBroadcaster
import serve.routes.projects as projects_mod
from lib.project_lock import ProjectLockTimeout, project_lock, project_lock_async

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    ws = (tmp_path / "ws").resolve()
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    monkeypatch.setattr("serve.routes.projects.resolve_workspace", lambda: ws)
    monkeypatch.setattr("serve.common.resolve_workspace", lambda: ws)
    monkeypatch.setattr(app.state, "broadcaster", SSEBroadcaster(), raising=False)
    return ws


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _make_seed(ws):
    """A seed as the app makes one: a blank project through the route, then seed
    and a source written into its project.json."""
    seed_id = str(uuid.uuid4())
    r = client.post("/api/run", json={"prompt": "seed", "workflow": "blank", "id": seed_id})
    assert r.status_code == 201, r.text
    pj = next(ws.rglob("project.json"))
    project = json.loads(pj.read_text())
    project.update({
        "seed": True, "status": "draft",
        "sources": [{"id": "take-1", "type": "audio", "src": "take-1.m4a", "kind": "take"}],
    })
    pj.write_text(json.dumps(project, indent=2))
    return seed_id, pj


def _adopt_body(seed_id, **extra):
    return {"prompt": "make it good", "workflow": "blank", "id": seed_id, "adoptSeed": True, **extra}


def test_adopt_keeps_folder_and_sources_and_drops_seed(workspace):
    seed_id, pj = _make_seed(workspace)
    r = client.post("/api/run", json=_adopt_body(seed_id))
    assert r.status_code == 201, r.text
    assert r.json()["id"] == seed_id
    assert [p.parent for p in workspace.rglob("project.json")] == [pj.parent]
    after = json.loads(pj.read_text())
    assert after["id"] == seed_id
    assert "seed" not in after
    assert [s["id"] for s in after["sources"]] == ["take-1"]
    assert r.json() == after or r.json()["id"] == after["id"]


def test_adopt_broadcasts_the_new_project(workspace):
    seed_id, pj = _make_seed(workspace)
    published = []
    app.state.broadcaster.publish = lambda pid, frame: published.append((pid, frame))
    r = client.post("/api/run", json=_adopt_body(seed_id))
    assert r.status_code == 201, r.text
    frames = [f for pid, f in published if pid == seed_id]
    assert frames and '"seed"' not in frames[0] and seed_id in frames[0]


@pytest.mark.parametrize("extra,code,status", [
    ({"adoptSeed": "yes"}, "invalid_field", 400),
    ({"adoptSeed": 1}, "invalid_field", 400),
    ({"projectPath": "x/y"}, "invalid_field", 400),
    ({"clipUrls": ["https://youtu.be/dQw4w9WgXcQ"]}, "invalid_field", 400),
    ({"remoteClips": [{"url": "https://example.com/a.mp4"}]}, "invalid_field", 400),
    ({"remoteAssets": [{"url": "https://example.com/a.png"}]}, "invalid_field", 400),
    ({"workflow": "carousel"}, "adopt_unsupported", 400),
])
def test_refusals_leave_project_json_byte_identical(workspace, extra, code, status):
    seed_id, pj = _make_seed(workspace)
    before = _digest(pj)
    body = _adopt_body(seed_id, **extra)
    if extra.get("workflow") == "carousel":
        body["carouselAspect"] = "4:5"
    r = client.post("/api/run", json=body)
    assert r.status_code == status, r.text
    assert r.json()["detail"]["error"] == code
    assert _digest(pj) == before


def test_adopt_needs_an_id(workspace):
    seed_id, pj = _make_seed(workspace)
    before = _digest(pj)
    body = _adopt_body(seed_id)
    del body["id"]
    r = client.post("/api/run", json=body)
    assert r.status_code == 400 and r.json()["detail"]["error"] == "missing_field"
    assert _digest(pj) == before


def test_adopt_unknown_id_is_404(workspace):
    _make_seed(workspace)
    r = client.post("/api/run", json=_adopt_body(str(uuid.uuid4())))
    assert r.status_code == 404 and r.json()["detail"]["error"] == "adopt_not_found"


def test_adopt_of_a_non_seed_is_400_and_untouched(workspace):
    seed_id, pj = _make_seed(workspace)
    project = json.loads(pj.read_text())
    project.pop("seed")
    pj.write_text(json.dumps(project))
    before = _digest(pj)
    r = client.post("/api/run", json=_adopt_body(seed_id))
    assert r.status_code == 400 and r.json()["detail"]["error"] == "adopt_refused"
    assert _digest(pj) == before


def test_adopt_holds_the_project_lock_while_init_runs(workspace, monkeypatch):
    """A save arriving mid-adopt waits for it: the lock is held across the init
    subprocess, by a thread, so a task on the loop thread cannot reenter it."""
    seed_id, pj = _make_seed(workspace)
    seen = {}
    real = projects_mod.run_subprocess

    async def spy(cmd, **kw):
        # Inside init's run: the lock must be taken by another thread.
        got = threading.Event()

        def probe():
            try:
                with project_lock(pj, timeout=0.2):
                    seen["free"] = True
            except Exception as exc:
                seen["busy"] = type(exc).__name__
            got.set()

        t = threading.Thread(target=probe)
        t.start()
        t.join()
        # And from this very event-loop thread (a PUT or an ingest is such a
        # task): the lock is not reentrant here, it waits and times out.
        try:
            async with project_lock_async(pj, timeout=0.2):
                seen["loop_free"] = True
        except ProjectLockTimeout:
            seen["loop_busy"] = True
        return await real(cmd, **kw)

    monkeypatch.setattr(projects_mod, "run_subprocess", spy)
    r = client.post("/api/run", json=_adopt_body(seed_id))
    assert r.status_code == 201, r.text
    assert seen == {"busy": "ProjectLockTimeout", "loop_busy": True}
    # Released afterwards.
    with project_lock(pj, timeout=1):
        pass


def test_non_adopt_create_is_unchanged(workspace):
    r = client.post("/api/run", json={"prompt": "plain", "workflow": "blank"})
    assert r.status_code == 201, r.text
    assert "seed" not in r.json()
    assert len(list(workspace.rglob("project.json"))) == 1
