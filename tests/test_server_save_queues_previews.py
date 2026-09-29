"""`PUT /projects/{id}` (save_project) queues editor previews (proxies) for
video items an agent just added or repointed.

Before this, a clip placed into a project via PUT (as opposed to dragged in
through POST /sources, which already queues via `_run_ingest_detached`) never
got a proxy queued. The editor's engine player then blocks on it forever
(`picture = 'preparing'`, `scheduler.ts`'s `engineSrcFor`) until someone clicks
"Generate previews" by hand.

`_queue_previews_for_changed_items` / `_new_or_changed_video_items` fix that by
handing `_ensure_current_proxies` (the same function the manual "Generate
previews" route and import both use) a cut-down project containing ONLY the
video items whose (id, src) is NEW or CHANGED compared with the project as it
was on disk before this write. These tests monkeypatch `_ensure_current_proxies`
itself (same convention as tests/test_server_sources.py) to capture what it's
called with, so they exercise the new diffing logic without touching any real
proxy-encode machinery.

Conventions follow tests/test_server_projects_save_validation.py: a real
project.json on tmp_path, get_project_dir overridden, TestClient against the
real app.
"""
import json
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import serve.routes.projects as projects_mod
from serve.common import get_project_dir
from serve.server import app

PID = "save-queues-previews-proj"


class _StubBroadcaster:
    def publish(self, *a, **k):
        pass


def _video(item_id, src, **over):
    item = {"id": item_id, "type": "video", "src": src, "start": 0.0, "end": 2.0}
    item.update(over)
    return item


def _tracks(*items):
    return [{"id": "trk-0", "items": list(items)}]


@pytest.fixture
def project(tmp_path):
    project_dir = tmp_path / PID
    project_dir.mkdir()
    original = {
        "id": PID,
        "name": "n",
        "status": "pending",
        "settings": {"colorSpace": "sdr_bt709"},
        "tracks": [{"id": "trk-0", "items": []}],
        "sources": [],
    }
    (project_dir / "project.json").write_text(json.dumps(original))
    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        yield client, project_dir
    finally:
        app.dependency_overrides.pop(get_project_dir, None)


def _put(client, tracks, **extra):
    return client.put(f"/api/projects/{PID}", json={"id": PID, "tracks": tracks, **extra})


def _seed_disk(project_dir, tracks):
    """Write `tracks` straight to project.json, bypassing the PUT route —
    simulates the project as it existed before the save under test."""
    on_disk = json.loads((project_dir / "project.json").read_text())
    on_disk["tracks"] = tracks
    (project_dir / "project.json").write_text(json.dumps(on_disk))


def _capture_ensure_current_proxies(monkeypatch):
    """Replace `_ensure_current_proxies` with a spy that records the cut-down
    project it's handed, instead of doing any real freshness check or encode."""
    calls = []

    def fake(project_id, project_dir_arg, cutdown_project, broadcaster):
        calls.append(cutdown_project)
        return {"scheduled": 0, "alreadyFresh": 0}

    monkeypatch.setattr(projects_mod, "_ensure_current_proxies", fake)
    return calls


def _queued_id_src_pairs(calls):
    assert len(calls) == 1, f"expected exactly one _ensure_current_proxies call, got {len(calls)}"
    items = calls[0]["tracks"][0]["items"]
    return [(i["id"], i["src"]) for i in items]


# ---------------------------------------------------------------------------
# 1. A new video item queues exactly that item.
# ---------------------------------------------------------------------------

def test_new_video_item_queues_exactly_that_item(project, monkeypatch):
    client, project_dir = project
    calls = _capture_ensure_current_proxies(monkeypatch)

    resp = _put(client, _tracks(_video("clip-1", "/a.mp4")))

    assert resp.status_code == 200, resp.text
    assert _queued_id_src_pairs(calls) == [("clip-1", "/a.mp4")]


# ---------------------------------------------------------------------------
# 2. Changing an item's src queues it.
# ---------------------------------------------------------------------------

def test_changed_src_queues_item(project, monkeypatch):
    client, project_dir = project
    _seed_disk(project_dir, _tracks(_video("clip-1", "/a.mp4")))
    calls = _capture_ensure_current_proxies(monkeypatch)

    resp = _put(client, _tracks(_video("clip-1", "/b.mp4")))

    assert resp.status_code == 200, resp.text
    assert _queued_id_src_pairs(calls) == [("clip-1", "/b.mp4")]


# ---------------------------------------------------------------------------
# 3. Resaving unchanged items queues nothing.
# ---------------------------------------------------------------------------

def test_unchanged_item_queues_nothing(project, monkeypatch):
    client, project_dir = project
    _seed_disk(project_dir, _tracks(_video("clip-1", "/a.mp4")))
    calls = _capture_ensure_current_proxies(monkeypatch)

    # Re-save the identical item, alongside an unrelated field change (a
    # rename) — the kind of save a status flip or metadata edit produces.
    resp = _put(client, _tracks(_video("clip-1", "/a.mp4")), name="renamed")

    assert resp.status_code == 200, resp.text
    assert calls == []


def test_second_new_item_beside_unchanged_one_queues_only_the_new_one(project, monkeypatch):
    client, project_dir = project
    _seed_disk(project_dir, _tracks(_video("clip-1", "/a.mp4")))
    calls = _capture_ensure_current_proxies(monkeypatch)

    resp = _put(client, _tracks(_video("clip-1", "/a.mp4"), _video("clip-2", "/c.mp4")))

    assert resp.status_code == 200, resp.text
    assert _queued_id_src_pairs(calls) == [("clip-2", "/c.mp4")]


def test_non_video_item_is_never_queued(project, monkeypatch):
    client, project_dir = project
    calls = _capture_ensure_current_proxies(monkeypatch)

    image = {"id": "img-1", "type": "image", "src": "/a.png", "start": 0.0, "end": 2.0}
    resp = _put(client, _tracks(image))

    assert resp.status_code == 200, resp.text
    assert calls == []


# ---------------------------------------------------------------------------
# 4. A queueing exception does not fail the save.
# ---------------------------------------------------------------------------

def test_queueing_exception_does_not_fail_save(project, monkeypatch):
    client, project_dir = project

    def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(projects_mod, "_ensure_current_proxies", boom)

    resp = _put(client, _tracks(_video("clip-1", "/a.mp4")))

    assert resp.status_code == 200, resp.text
    on_disk = json.loads((project_dir / "project.json").read_text())
    assert on_disk["tracks"][0]["items"][0] == {
        "id": "clip-1", "type": "video", "src": "/a.mp4", "start": 0.0, "end": 2.0,
    }
