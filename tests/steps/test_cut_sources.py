"""§558 cut on audio speech, the review's cases (09's s558-cut-ext review): fades at joins, the audible window,
the default source for a talking head, ids, overlapping voices. Helpers are test_cut's."""
import json
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_cut import (FIX, SOURCE_S, audio_project, git, make_project, narration, plan_and_apply,  # noqa: E402
                      refused, retake_transcript, run, stub_transcribe)  # noqa: F401
from lib.speech_source import JOIN_FADE_IN, JOIN_FADE_OUT  # noqa: E402


def _edit(d, fn):
    p = json.loads((d / "project.json").read_text())
    fn(p)
    (d / "project.json").write_text(json.dumps(p, indent=2))
    git(d, "commit", "-qam", "edit")


def test_the_narrations_own_fades_stay_on_its_ends_and_every_cut_gets_the_join_fade(tmp_path, monkeypatch):
    d = audio_project(tmp_path)
    _edit(d, lambda p: p["audio"]["tracks"][1].update(fadeIn=1.0, fadeOut=2.0))
    plan_and_apply(d, monkeypatch)
    vo = narration(json.loads((d / "project.json").read_text()))
    assert len(vo) > 2 and vo[0]["fadeIn"] == 1.0                      # its intro fade, at its start
    assert all(a["fadeOut"] == JOIN_FADE_OUT for a in vo[:-1])
    assert all(a["fadeIn"] == JOIN_FADE_IN for a in vo[1:])


def test_only_the_audible_window_of_an_audio_item_is_cut(tmp_path, monkeypatch):
    """An item plays to min(outPoint, inPoint + end - start): narration past `end` was never heard."""
    d = audio_project(tmp_path)
    _edit(d, lambda p: p["audio"]["tracks"][1].update(end=8.0))      # outPoint stays the whole file
    plan_and_apply(d, monkeypatch)
    vo = narration(json.loads((d / "project.json").read_text()))
    assert vo and max(a["outPoint"] for a in vo) <= 8.0 + 1e-6


def test_an_untranscribed_talking_head_with_a_short_voiceover_item_still_cuts_the_video(tmp_path, stub_transcribe,
                                                                                        monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    shutil.copy(FIX / "speech.mp4", d / "intro-vo.mp4")
    _edit(d, lambda p: p.update(audio={"tracks": [{"id": "ivo", "type": "voiceover", "src": str(d / "intro-vo.mp4"),
                                                   "start": 0.0, "end": 3.0, "inPoint": 0.0, "outPoint": 3.0}]}))
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert "track trk-0" in Path(plan["plan"]).read_text()


def test_a_voiceovers_pieces_never_take_an_id_in_use(tmp_path, monkeypatch):
    d = audio_project(tmp_path, voiceover=True)
    shutil.copy(FIX / "speech.mp4", d / "bed.mp4")
    _edit(d, lambda p: p.update(audio={"tracks": [{"id": "vo", "type": "music", "src": str(d / "bed.mp4"),
                                                   "start": 0.0, "end": 5.0, "inPoint": 0.0, "outPoint": 5.0}]}))
    plan, _ = run(d, "--speech", "voiceover", monkeypatch=monkeypatch)
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    ids = [a["id"] for a in json.loads((d / "project.json").read_text())["audio"]["tracks"]]
    assert len(ids) == len(set(ids)) and "vo" in ids


def test_two_voices_at_once_in_one_source_are_refused(tmp_path, monkeypatch, capsys):
    """Read as one track, the second voice would be taken for retakes of the first."""
    d = audio_project(tmp_path)
    shutil.copy(FIX / "speech.mp4", d / "narration2.mp4")
    (d / "narration2.json").write_text((d / "narration.json").read_text())

    def two(p):
        a = p["audio"]["tracks"][1]
        p["audio"]["tracks"].append({**a, "id": "vo-2", "src": str(d / "narration2.mp4"), "start": 2.0,
                                     "end": SOURCE_S + 2.0})
    _edit(d, two)
    assert refused(d, monkeypatch=monkeypatch, capsys=capsys) == "invalid_params"
    assert not (d / "cut-plan.md").exists()
