"""Run 5 (2b, from kung fu run 4): the agent placed 16 b-roll items by seconds, read the times back and re-timed them.
POST /api/projects/<id>/phrase-times turns word anchors into timeline seconds, as place reads a phrase
(lib/phrase_at): {phrase or word, occurrence (the nth saying in timeline order, default 1) or take}. Read-only."""
import json
import sys
from pathlib import Path

import pytest
from starlette.testclient import TestClient

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "steps"))
from test_place import CLEAN_TAKE_S, RESTART_TAKE_S, UM_TAKE_S, make_project  # noqa: E402

from serve.common import get_project_dir  # noqa: E402
from serve.server import app  # noqa: E402


def times(d, anchors):
    app.dependency_overrides[get_project_dir] = lambda: d
    try:
        r = TestClient(app).post("/api/projects/place-fixture/phrase-times", json={"anchors": anchors})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200, r.text
    return r.json()["times"]


def test_each_anchor_is_the_nth_saying_on_the_timeline(tmp_path):
    d = make_project(tmp_path)
    before = (d / "project.json").read_bytes()
    got = times(d, [{"phrase": "three times faster", "occurrence": 1}, {"phrase": "three times faster", "occurrence": 2},
                    {"phrase": "three times faster", "occurrence": 3}, {"phrase": "three times faster"}])
    assert [g["start"] for g in got] == pytest.approx([UM_TAKE_S, RESTART_TAKE_S, CLEAN_TAKE_S, UM_TAKE_S], abs=0.01)
    assert all(g["said"] == 3 and g["end"] > g["start"] for g in got)
    assert (d / "project.json").read_bytes() == before


def test_a_word_is_a_one_word_phrase_and_a_take_picks_by_place_s_rule(tmp_path):
    d = make_project(tmp_path)
    got = times(d, [{"word": "phone"}, {"phrase": "three times faster", "take": "clean"}])
    assert got[0]["text"] == "phone" and got[0]["start"] > CLEAN_TAKE_S
    assert got[1]["start"] == pytest.approx(CLEAN_TAKE_S, abs=0.01)


def test_an_anchor_not_said_or_past_its_sayings_answers_why_beside_the_others(tmp_path):
    d = make_project(tmp_path)
    got = times(d, [{"phrase": "not in this video"}, {"phrase": "three times faster", "occurrence": 4}, {"word": "phone"}])
    assert "not said" in got[0]["error"]
    assert "said 3 times" in got[1]["error"]
    assert "start" in got[2]
