"""§660: POST /api/projects/{id}/mix-loudness, the export mix's loudness for the editor preview.

Fixtures are generated with ffmpeg lavfi under tmp; the measurement runs the real
render/mix-loudness.js against them.
"""
import copy
import json
import math
import subprocess
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from lib.common import ffmpeg_bin
from serve import mix_loudness as ml
from serve.common import get_project_dir
from serve.server import app

PID = "mix-loudness-proj"


def _ff(*args):
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", *args], check=True)


def _doc(loudness=-14):
    doc = {
        "id": PID, "name": "n", "status": "draft",
        "settings": {"resolution": [64, 64], "fps": 30},
        "tracks": [
            {"id": "trk-0", "items": [
                {"id": "c1", "type": "video", "src": "clip.mp4", "start": 0, "end": 2, "inPoint": 0, "outPoint": 2,
                 "offsetX": 0},
            ]},
            {"id": "trk-1", "items": [
                {"id": "o1", "type": "overlay", "src": "title.jsx", "start": 0, "end": 1, "props": {"text": "hi"}},
            ]},
        ],
        "audio": {"tracks": [
            {"id": "vo", "src": "vo.wav", "start": 0.25, "end": 1.75, "volume": 1.0},
            {"id": "music", "src": "music.wav", "start": 0, "end": 2, "volume": 0.5, "ducking": {"enabled": True}},
        ]},
    }
    if loudness is not None:
        doc["settings"]["loudness"] = loudness
    return doc


@pytest.fixture
def project(tmp_path):
    d = tmp_path / PID
    d.mkdir()
    _ff("-f", "lavfi", "-i", "testsrc=duration=2:size=64x64:rate=30", "-f", "lavfi", "-i", "sine=f=330:r=48000:d=2",
        "-af", "volume=0.05", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        str(d / "clip.mp4"))
    _ff("-f", "lavfi", "-i", "anoisesrc=c=pink:r=48000:a=0.03:d=1.5", "-ac", "2", str(d / "vo.wav"))
    _ff("-f", "lavfi", "-i", "sine=f=220:r=48000:d=2", "-af", "volume=0.1", "-ac", "2", str(d / "music.wav"))
    # The export refuses a missing overlay file; the measurement never bundles it.
    (d / "title.jsx").write_text("export default () => null\n")
    return d


def _write(d: Path, doc: dict) -> None:
    (d / "project.json").write_text(json.dumps(doc))


@pytest.fixture
def client(project):
    ml._reset()
    app.dependency_overrides[get_project_dir] = lambda: project
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_project_dir, None)
        ml._reset()


def _post(client):
    r = client.post(f"/api/projects/{PID}/mix-loudness")
    assert r.status_code == 200, r.text
    return r.json()


def _until_settled(client, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        body = _post(client)
        if body["status"] != "running":
            return body
        time.sleep(0.1)
    raise AssertionError("mix loudness never settled")


def test_off_without_a_loudness_target(client, project):
    _write(project, _doc(loudness=None))
    assert _post(client) == {"status": "off"}
    assert not ml._running


def test_running_then_ready_then_cached(client, project):
    _write(project, _doc())
    assert _post(client)["status"] == "running"
    body = _until_settled(client)
    assert body["status"] == "ready", body
    assert body["targetI"] == -14
    assert math.isfinite(body["inputI"]) and -70 < body["inputI"] < -14
    assert body["gainDb"] == pytest.approx(body["targetI"] - body["inputI"], abs=0.01)
    # The same mix answers at once, from the cache, with no job.
    assert _post(client) == body
    assert not ml._running


def test_a_lane_volume_change_measures_again(client, project):
    _write(project, _doc())
    first = _until_settled(client)
    doc = _doc()
    doc["audio"]["tracks"][0]["volume"] = 2.0
    _write(project, doc)
    assert _post(client)["status"] == "running"
    second = _until_settled(client)
    assert second["inputI"] > first["inputI"]


def test_cache_key_follows_the_mix_and_nothing_else(project):
    base = _doc()
    key = ml.cache_key(base, project)

    def changed(edit):
        doc = copy.deepcopy(base)
        edit(doc)
        return ml.cache_key(doc, project)

    # What the mix is made of.
    assert changed(lambda d: d["audio"]["tracks"][0].update(volume=0.5)) != key
    assert changed(lambda d: d["audio"]["tracks"][1]["ducking"].update(enabled=False)) != key
    assert changed(lambda d: d["tracks"][0]["items"][0].update(muted=True)) != key
    assert changed(lambda d: d["tracks"][0]["items"][0].update(end=1.5)) != key
    assert changed(lambda d: d["tracks"][0].update(volume=0.5)) != key
    assert changed(lambda d: d["settings"].update(loudness=-16)) != key
    # What it is not.
    assert changed(lambda d: d.update(name="renamed")) == key
    assert changed(lambda d: d["tracks"][0]["items"][0].update(offsetX=0.3)) == key
    assert changed(lambda d: d["tracks"][1]["items"][0]["props"].update(text="bye")) == key
    assert changed(lambda d: d["settings"].update(resolution=[1080, 1920])) == key


def test_cache_key_follows_a_source_edited_on_disk(project):
    doc = _doc()
    key = ml.cache_key(doc, project)
    _ff("-f", "lavfi", "-i", "sine=f=440:r=48000:d=2", "-ac", "2", str(project / "music.wav"))
    assert ml.cache_key(doc, project) != key
