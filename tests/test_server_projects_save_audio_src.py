"""§559 part 2: a save that writes a NEW `audio.tracks` entry without a string `src`, or takes away an entry's src, is
refused (such an entry crashes every render). A save that leaves audio alone, re-sends an entry already on disk, or
changes other fields of an old entry that already had no src is never refused: the last saves with a warning."""
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


def test_moving_an_old_entry_that_already_had_no_src_saves_with_a_warning(client_for):
    # 2b, 2026-10-26: a person's save (or a shift) that only moves an old entry with no src adds no new bad data, and
    # refusing it would lock them out of their own project. It saves, and the answer says the entry won't play.
    client, project_dir = client_for({"tracks": [GOOD, {"id": "a1", "start": 2}]})
    resp = _put(client, audio={"tracks": [GOOD, {"id": "a1", "start": 3, "volume": 0.5}]})
    assert resp.status_code == 200, resp.text
    assert _disk(project_dir)["audio"]["tracks"][1] == {"id": "a1", "start": 3, "volume": 0.5}
    assert "audio.tracks[1] still has no src; it won't play" in resp.json()["warnings"]
    assert "warnings" not in _disk(project_dir)


def test_an_old_entry_moved_to_another_index_is_still_the_same_entry(client_for):
    client, _ = client_for({"tracks": [{"id": "a1", "start": 2}, GOOD]})
    resp = _put(client, audio={"tracks": [GOOD, {"id": "a1", "start": 9}]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["warnings"] == ["audio.tracks[1] still has no src; it won't play"]


def test_a_save_that_removes_a_good_src_is_refused(client_for):
    client, _ = client_for({"tracks": [GOOD]})
    for bad in ({"id": "a0", "start": 0}, {"id": "a0", "src": "", "start": 0}, {"id": "a0", "src": 3, "start": 0}):
        resp = _put(client, audio={"tracks": [bad]})
        assert resp.status_code == 400, bad
        assert "audio.tracks[0] has no src" in resp.json()["detail"]["message"]


def test_an_old_id_less_entry_with_no_src_moved_in_place_saves_with_a_warning(client_for):
    client, _ = client_for({"tracks": [{"start": 1}]})
    resp = _put(client, audio={"tracks": [{"start": 4}]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["warnings"] == ["audio.tracks[0] still has no src; it won't play"]
