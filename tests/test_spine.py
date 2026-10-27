"""Run 5 (2b, from kung fu run 4): after a cut, the agent read the tracks 4 times to learn where each talking-head
piece sits and what it says before placing b-roll. lib/spine gives that in the answer: each speech-track item with its
timeline start and end and the words it plays; GET /api/projects/<id>/spine serves it, read-only."""
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from lib import spine  # noqa: E402


def words(*spec):
    """A whisper sidecar of (text, start, end) in seconds."""
    return {"transcription": [{"text": " " + t, "offsets": {"from": int(a * 1000), "to": int(b * 1000)},
                               "timestamps": {"from": "", "to": ""}} for t, a, b in spec]}


def project_dir(tmp_path):
    d = tmp_path / "p"
    d.mkdir()
    (d / "talk.mp4").write_bytes(b"x")
    (d / "talk.json").write_text(json.dumps(words(("Hey", 0.2, 0.5), ("everyone,", 0.5, 0.9), ("welcome", 1.0, 1.4),
                                                  ("back.", 1.4, 1.8), ("Today", 5.0, 5.3), ("we", 5.3, 5.4),
                                                  ("cook.", 5.4, 5.9))))
    (d / "broll.mp4").write_bytes(b"x")
    p = {"id": "p1", "version": "0.2", "status": "draft", "settings": {"fps": 30}, "tracks": [
        {"id": "trk-0", "items": [
            {"id": "a", "type": "video", "src": str(d / "talk.mp4"), "start": 0.0, "end": 1.7, "inPoint": 0.1, "outPoint": 1.8},
            {"id": "b", "type": "video", "src": "talk.mp4", "start": 1.7, "end": 2.7, "inPoint": 4.95, "outPoint": 5.95},
            {"id": "c", "type": "video", "src": str(d / "broll.mp4"), "start": 2.7, "end": 4.0, "inPoint": 0.0, "outPoint": 1.3},
        ]},
        {"id": "trk-b", "items": [{"id": "r1", "type": "video", "src": str(d / "broll.mp4"), "start": 0.5, "end": 1.5,
                                   "inPoint": 3.0, "outPoint": 4.0}]},
    ]}
    (d / "project.json").write_text(json.dumps(p))
    return d, p


def test_each_speech_item_has_its_times_and_the_words_it_plays(tmp_path):
    d, p = project_dir(tmp_path)
    got = spine.spine(p, str(d))
    assert got == [
        {"id": "a", "start": 0.0, "end": 1.7, "src": "talk.mp4", "said": "Hey everyone, welcome back."},
        {"id": "b", "start": 1.7, "end": 2.7, "src": "talk.mp4", "said": "Today we cook."},
        {"id": "c", "start": 2.7, "end": 4.0, "src": "broll.mp4", "said": ""},
    ]


def test_only_the_words_the_item_plays(tmp_path):
    d, p = project_dir(tmp_path)
    p["tracks"][0]["items"][0]["outPoint"] = 1.0          # stops before "welcome back."
    assert spine.spine(p, str(d))[0]["said"] == "Hey everyone,"


def test_an_empty_timeline_has_no_spine(tmp_path):
    d, p = project_dir(tmp_path)
    p["tracks"] = [{"id": "trk-0", "items": []}]
    assert spine.spine(p, str(d)) == []


def test_the_route_serves_it_read_only(tmp_path):
    from serve.server import app
    from serve.common import get_project_dir
    d, p = project_dir(tmp_path)
    before = (d / "project.json").read_bytes()
    app.dependency_overrides[get_project_dir] = lambda: d
    try:
        r = TestClient(app).get("/api/projects/p1/spine")
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200, r.text
    assert r.json()["spine"][1]["said"] == "Today we cook."
    assert (d / "project.json").read_bytes() == before
