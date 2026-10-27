"""§559 part 2: a save that writes an `audio.tracks` entry without a string `src` is
refused (such an entry crashes every render); a save that leaves audio alone, or
re-sends an entry already on disk unchanged, is never refused."""
import json

import pytest
from starlette.testclient import TestClient

from serve.common import get_project_dir
from serve.server import app

PID = "audio-src-proj"
GOOD = {"id": "a0", "src": "/abs/music.mp3", "start": 0}
BAD = {"id": "a1", "items": []}


class _StubBroadcaster:
    def publish(self, *a, **k):
        pass


def _make(tmp_path, audio):
    project_dir = tmp_path / PID
    project_dir.mkdir()
    doc = {"id": PID, "name": "n", "status": "pending", "tracks": [{"id": "trk-0", "items": []}]}
    if audio is not None:
        doc["audio"] = audio
    (project_dir / "project.json").write_text(json.dumps(doc))
    return project_dir


@pytest.fixture
def client_for(tmp_path):
    def make(audio):
        project_dir = _make(tmp_path, audio)
        app.state.broadcaster = _StubBroadcaster()
        app.dependency_overrides[get_project_dir] = lambda: project_dir
        return TestClient(app, raise_server_exceptions=False), project_dir
    try:
        yield make
    finally:
        app.dependency_overrides.pop(get_project_dir, None)


def _put(client, **body):
    return client.put(f"/api/projects/{PID}", json={"id": PID, **body})


def _disk(project_dir):
    return json.loads((project_dir / "project.json").read_text())


def test_new_audio_entry_without_src_is_refused_and_named(client_for):
    client, project_dir = client_for({"tracks": [GOOD]})
    before = (project_dir / "project.json").read_text()
    resp = _put(client, audio={"tracks": [GOOD, {"id": "a1", "items": []}]})
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["error"] == "invalid_audio_tracks"
    assert "audio.tracks[1] has no src" in detail["message"]
    assert "an audio track is {id, src: <absolute path>, start" in detail["message"]
    assert (project_dir / "project.json").read_text() == before


def test_non_string_src_is_refused(client_for):
    client, _ = client_for(None)
    resp = _put(client, audio={"tracks": [{"id": "a0", "src": 5}]})
    assert resp.status_code == 400
    assert "audio.tracks[0] has no src" in resp.json()["detail"]["message"]


def test_good_audio_saves(client_for):
    client, project_dir = client_for(None)
    assert _put(client, audio={"tracks": [GOOD]}).status_code == 200
    assert _disk(project_dir)["audio"]["tracks"] == [GOOD]


def test_save_not_touching_audio_works_over_existing_bad_entry(client_for):
    client, project_dir = client_for({"tracks": [BAD]})
    assert _put(client, name="renamed").status_code == 200
    assert _disk(project_dir)["audio"]["tracks"] == [BAD]


def test_resending_the_existing_bad_entry_unchanged_is_not_refused(client_for):
    client, project_dir = client_for({"tracks": [BAD]})
    resp = _put(client, audio={"tracks": [BAD, GOOD]})
    assert resp.status_code == 200, resp.text


def test_changing_the_bad_entry_without_fixing_it_is_refused(client_for):
    client, _ = client_for({"tracks": [BAD]})
    resp = _put(client, audio={"tracks": [{"id": "a1", "items": [], "volume": 1}]})
    assert resp.status_code == 400
