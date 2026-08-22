"""POST /api/projects/<id>/rerun must write tracks in the current shape.

Rerun used to emit a third, obsolete track shape — `{"id", "type", "clips"}` —
that predates v0.2 and that no reader understands: anything iterating a track's
items walked the dict's KEYS. It now writes the object shape, so the restored
video track is actually readable.
"""
import json
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve.server import app
from serve.sse import SSEBroadcaster
from lib.project_tracks import track_items


client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setattr("serve.routes.projects.resolve_workspace", lambda: tmp_path)
    if not hasattr(app.state, "broadcaster"):
        app.state.broadcaster = SSEBroadcaster()
    return tmp_path


def _write_project(workspace: Path) -> str:
    pid = str(uuid.uuid4())
    d = workspace / "rerun-me"
    d.mkdir(parents=True)
    (d / "project.json").write_text(json.dumps({
        "version": "0.2",
        "id": pid,
        "status": "final",
        "workflow": "default",
        "editingPrompt": "test",
        "settings": {"resolution": [1080, 1920], "fps": 30},
        "sources": [
            {"id": "clip-0", "src": "./clips/a.mp4", "order": 0},
            {"id": "clip-1", "src": "./clips/b.mp4", "order": 1},
        ],
        # A finished run: primary track edited down, plus an overlay track.
        "tracks": [
            {"id": "trk-0", "items": [
                {"id": "clip-0-seg-1", "type": "video", "src": "./clips/a.mp4",
                 "start": 0.0, "end": 2.0},
            ]},
            {"id": "captions", "items": [], "volume": 0.5},
        ],
        "assets": [],
        "audio": {},
    }))
    return pid


def test_rerun_restores_sources_in_the_object_track_shape(workspace, monkeypatch):
    monkeypatch.setattr("serve.routes.projects._git_commit_sync", lambda *a, **k: None)
    pid = _write_project(workspace)

    resp = client.post(f"/api/projects/{pid}/rerun", json={})
    assert resp.status_code == 200, resp.text
    updated = resp.json()

    assert updated["tracks"] == [
        {"id": "trk-0", "items": [
            {"id": "clip-0", "src": "./clips/a.mp4", "order": 0},
            {"id": "clip-1", "src": "./clips/b.mp4", "order": 1},
        ]},
    ]
    # …and readers see the source clips, not a dict's keys.
    assert [c["id"] for c in track_items(updated)[0]] == ["clip-0", "clip-1"]

    on_disk = json.loads((workspace / "rerun-me" / "project.json").read_text())
    assert on_disk["tracks"] == updated["tracks"]
    assert on_disk["status"] == "pending"
