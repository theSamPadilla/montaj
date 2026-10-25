"""§558 cut: a cut never removes a music or audio track; it moves it and says so (orchestrator). Synthetic tones
over a set room, invented words."""
import json

from tests.steps import test_cut as tc
from tests.steps.test_cut_pass3 import plan_apply

SP = -20.0


def test_music_under_a_removed_opening_moves_to_the_new_start_at_its_full_length(tmp_path, monkeypatch):
    """A voiceover whose first 6.8 s is silence (removed), with a 5 s music track at 0.0: all of the music's span
    is cut. It stays, at the new start, its full length and inPoint unchanged, and the answer warns."""
    spans = [(6.80, 7.10, SP), (7.15, 7.45, SP), (7.50, 7.80, SP), (7.85, 8.15, SP)]
    words = [("you", 6.80, 7.15), ("are", 7.15, 7.50), ("riding", 7.50, 7.85), ("bikes.", 7.85, 8.15)]
    d = tc.tone_project(tmp_path, [("vo", spans, 8.8, words)])
    p = json.loads((d / "project.json").read_text())
    p["audio"] = {"tracks": [{"id": "music", "src": str(d / "vo.mov"), "start": 0.0, "end": 5.0, "inPoint": 0.0,
                              "outPoint": 5.0, "volume": 0.3}]}
    (d / "project.json").write_text(json.dumps(p, indent=2))
    tc.git(d, "commit", "-qam", "music")
    plan, text, applied, said = plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words]
    assert tc.kept_iv(d)[0][0] >= 6.7, tc.kept_iv(d)                       # the opening was cut
    music = json.loads((d / "project.json").read_text())["audio"]["tracks"]
    assert [m["id"] for m in music] == ["music"], music
    m = music[0]
    assert (m["start"], m["end"], m["inPoint"], m["outPoint"]) == (0.0, 5.0, 0.0, 5.0), m
    for answer in (plan, applied):
        assert any("Audio track music moved" in w for w in answer.get("warnings", [])), answer.get("warnings")
