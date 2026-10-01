"""Opening or saving a project backfills missing sourceWidth/sourceHeight on
video items (tracks and sources), so the editor's export dialog can offer the
resolutions the footage supports. Agent-built projects write clips without dims.
"""
import json
import subprocess
import time

import pytest
from starlette.testclient import TestClient

from lib.common import ffmpeg_bin
from serve.common import get_project_dir
from serve.server import app

PID = "source-dims-proj"


class _StubBroadcaster:
    def __init__(self):
        self.frames = []

    def publish(self, project_id, frame):
        self.frames.append((project_id, frame))


def _ffmpeg(*args):
    subprocess.run([ffmpeg_bin(), "-y", "-v", "error", *args], check=True, capture_output=True, timeout=60)


def _clip_file(path, size="3840x2160"):
    _ffmpeg("-f", "lavfi", "-i", f"testsrc=size={size}:rate=10:duration=1",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path))
    return str(path)


def _item(src, **extra):
    return {"id": "clip-0", "type": "video", "src": src, "start": 0, "end": 1, **extra}


def _setup(tmp_path, tracks_item, sources_item):
    project_dir = tmp_path / PID
    project_dir.mkdir()
    proj = {
        "id": PID, "name": "n", "status": "draft",
        "settings": {"resolution": [1080, 1920], "fps": 30},
        "tracks": [{"id": "trk-0", "items": [tracks_item]}],
        "sources": [sources_item],
    }
    (project_dir / "project.json").write_text(json.dumps(proj))
    return project_dir


@pytest.fixture
def client(tmp_path):
    # Context-managed so one event loop outlives each request: a PUT's detached
    # heal task would otherwise die with the per-request loop.
    holder = {}
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: holder["dir"]
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            app.state.broadcaster = _StubBroadcaster()
            yield c, holder
    finally:
        app.dependency_overrides.pop(get_project_dir, None)


def _disk(project_dir):
    return json.loads((project_dir / "project.json").read_text())


def _dims(item):
    return item.get("sourceWidth"), item.get("sourceHeight")


def test_open_backfills_dims_in_tracks_and_sources_and_persists(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "uhd.mp4")
    holder["dir"] = _setup(tmp_path, _item(src), _item(src))
    resp = c.get(f"/api/projects/{PID}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert _dims(body["tracks"][0]["items"][0]) == (3840, 2160)
    assert _dims(body["sources"][0]) == (3840, 2160)
    disk = _disk(holder["dir"])
    assert _dims(disk["tracks"][0]["items"][0]) == (3840, 2160)
    assert _dims(disk["sources"][0]) == (3840, 2160)
    assert app.state.broadcaster.frames, "the heal is broadcast so an open editor updates"


def test_rotated_clip_gets_display_dims(client, tmp_path):
    c, holder = client
    plain = _clip_file(tmp_path / "plain.mp4", size="1920x1080")
    rotated = tmp_path / "rotated.mp4"
    _ffmpeg("-display_rotation", "90", "-i", plain, "-c", "copy", str(rotated))
    holder["dir"] = _setup(tmp_path, _item(str(rotated)), _item(str(rotated)))
    body = c.get(f"/api/projects/{PID}").json()
    assert _dims(body["tracks"][0]["items"][0]) == (1080, 1920)
    assert _dims(_disk(holder["dir"])["sources"][0]) == (1080, 1920)


def test_project_with_dims_is_not_probed_or_written(client, tmp_path, monkeypatch):
    c, holder = client
    src = _clip_file(tmp_path / "uhd.mp4")
    full = {"sourceWidth": 3840, "sourceHeight": 2160}
    holder["dir"] = _setup(tmp_path, _item(src, **full), _item(src, **full))
    path = holder["dir"] / "project.json"
    before, mtime = path.read_bytes(), path.stat().st_mtime_ns

    def boom(*a, **k):
        raise AssertionError("probe_video must not run when every item has dims")
    monkeypatch.setattr("lib.normalize.probe_video", boom)
    assert c.get(f"/api/projects/{PID}").status_code == 200
    assert path.read_bytes() == before and path.stat().st_mtime_ns == mtime


def test_missing_src_file_is_left_alone_and_open_succeeds(client, tmp_path):
    c, holder = client
    gone = str(tmp_path / "gone.mp4")
    holder["dir"] = _setup(tmp_path, _item(gone), _item(gone))
    resp = c.get(f"/api/projects/{PID}")
    assert resp.status_code == 200
    assert _dims(resp.json()["tracks"][0]["items"][0]) == (None, None)
    assert _dims(_disk(holder["dir"])["tracks"][0]["items"][0]) == (None, None)


def test_probe_failure_never_breaks_open(client, tmp_path, monkeypatch):
    c, holder = client
    src = _clip_file(tmp_path / "uhd.mp4")
    holder["dir"] = _setup(tmp_path, _item(src), _item(src))

    def boom(*a, **k):
        raise RuntimeError("ffprobe exploded")
    monkeypatch.setattr("lib.normalize.probe_video", boom)
    resp = c.get(f"/api/projects/{PID}")
    assert resp.status_code == 200
    assert _dims(resp.json()["tracks"][0]["items"][0]) == (None, None)


def test_put_backfills_dims_in_the_background(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "uhd.mp4")
    holder["dir"] = _setup(tmp_path, _item(src, sourceWidth=1, sourceHeight=1), _item(src, sourceWidth=1, sourceHeight=1))
    # An agent PUTs a clip without dims.
    body = {"id": PID, "tracks": [{"id": "trk-0", "items": [_item(src)]}]}
    resp = c.put(f"/api/projects/{PID}", json=body)
    assert resp.status_code == 200, resp.text
    deadline = time.time() + 15
    while time.time() < deadline:
        if _dims(_disk(holder["dir"])["tracks"][0]["items"][0]) == (3840, 2160):
            break
        time.sleep(0.1)
    assert _dims(_disk(holder["dir"])["tracks"][0]["items"][0]) == (3840, 2160)
