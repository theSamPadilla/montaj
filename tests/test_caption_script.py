"""generate_captions spells caption words from the person's script (lib/caption_script.py): the script's words are laid
onto the transcript's timings. Kung fu bench run: the transcriber wrote "uni 3" for Unitree, "dense" for dents and a
doubled "a", and the agent spent 3 caption runs and 6 caption reads fixing them by hand."""
import importlib.util
import json

import pytest
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib.caption_script import align  # noqa: E402


def W(*spec):
    return [{"word": w, "start": s, "end": e} for w, s, e in spec]


def words_of(out):
    return [w["word"] for w in out]


def test_the_scripts_spelling_on_the_transcripts_timings():
    heard = W(("seen", 2.0, 2.4), ("you", 2.4, 2.5), ("uni", 2.5, 2.8), ("3", 2.8, 3.0), ("just", 3.0, 3.3),
              ("announced", 3.3, 4.0))
    out, n = align(heard, "seen. Unitree just announced")
    # "you" is not in the script: it stays as heard; "uni 3" becomes one word over both timings
    assert words_of(out) == ["seen.", "you", "Unitree", "just", "announced"]
    assert out[2] == {"word": "Unitree", "start": 2.5, "end": 3.0}
    assert [(w["start"], w["end"]) for w in out if w["word"] != "Unitree"] == [(2.0, 2.4), (2.4, 2.5), (3.0, 3.3), (3.3, 4.0)]
    assert n == 1


def test_a_misheard_word_takes_the_scripts_word():
    heard = W(("the", 9.2, 9.3), ("robot", 9.3, 9.6), ("dense", 9.6, 9.9), ("a", 9.9, 10.0), ("car", 10.0, 10.3))
    out, n = align(heard, "In the demo, the robot dents a car, throws flying elbows")
    assert words_of(out) == ["the", "robot", "dents", "a", "car,"]
    assert out[2] == {"word": "dents", "start": 9.6, "end": 9.9} and n == 1


def test_a_stutter_the_script_has_once_is_one_word():
    heard = W(("want", 18.497, 18.735), ("a", 18.735, 18.814), ("a", 18.843, 18.893), ("robot", 18.893, 19.16))
    out, n = align(heard, "you absolutely want a robot around")
    assert words_of(out) == ["want", "a", "robot"]
    assert out[1] == {"word": "a", "start": 18.735, "end": 18.893} and n == 1


def test_case_and_punctuation_alone_are_not_counted():
    heard = W(("this", 0, 0.2), ("may", 0.2, 0.4), ("be", 0.4, 0.5), ("i've", 0.5, 0.8))
    out, n = align(heard, "This may be... I've")
    assert words_of(out) == ["This", "may", "be...", "I've"] and n == 0


def test_words_the_speaker_said_that_are_not_in_the_script_stay_as_heard():
    heard = W(("so", 0, 0.2), ("basically", 0.2, 0.6), ("the", 0.6, 0.7), ("robot", 0.7, 1.0), ("fell", 1.0, 1.3))
    out, n = align(heard, "The robot fell over.")
    assert words_of(out) == ["so", "basically", "The", "robot", "fell"] and n == 0


def test_a_paraphrase_is_not_replaced_by_script_words_never_said():
    heard = W(("it", 0, 0.2), ("was", 0.2, 0.4), ("really", 0.4, 0.7), ("slow", 0.7, 1.0), ("too", 1.0, 1.2),
              ("so", 1.2, 1.4))
    out, n = align(heard, "It was moving at a crawl, so")
    assert words_of(out) == ["It", "was", "really", "slow", "too", "so"] and n == 0


def test_script_words_not_said_are_not_added_and_times_never_change_order():
    heard = W(("kung", 4.6, 4.8), ("fu", 4.8, 5.0), ("bodyguard", 5.0, 5.6))
    out, n = align(heard, "a humanoid kung-fu bodyguard, and honestly")
    assert words_of(out) == ["kung-fu", "bodyguard,"]
    assert out[0] == {"word": "kung-fu", "start": 4.6, "end": 5.0}
    assert all(a["end"] <= b["start"] + 1e-9 for a, b in zip(out, out[1:]))
    assert n == 1


def test_one_heard_word_for_two_script_words_splits_its_time():
    heard = W(("its", 1.0, 1.2), ("megawatt", 1.2, 1.8))
    out, n = align(heard, "It's Mega Watt")
    assert words_of(out) == ["It's", "Mega", "Watt"]
    assert out[1]["start"] == 1.2 and out[2]["end"] == 1.8 and out[1]["end"] == out[2]["start"]
    assert n == 2


def test_a_word_that_sounds_alike_is_corrected():
    heard = W(("robot", 9.3, 9.6), ("dance", 9.6, 9.9), ("a", 9.9, 10.0), ("car", 10.0, 10.3))
    out, n = align(heard, "the robot dents cars, throws flying elbows")
    assert words_of(out) == ["robot", "dents", "a", "car,"] and n == 1   # "car" as said, with the comma of the script's "cars,"


@pytest.mark.parametrize("said,script", [
    ("it is supposed to protect", "it's supposed to be protecting"),   # an inflection and a contraction, as said
    ("was going really slow", "was going so slowly"),
    ("that kid would have been", "that kid's would've been"),
    ("something that we need", "something to have to need"),
    ("right here when there's", "right here while there's"),
    ("this may be the", "this might be the"),
])
def test_what_the_speaker_said_differently_from_the_script_stays_as_heard(said, script):
    heard = [{"word": w, "start": i, "end": i + 1} for i, w in enumerate(said.split())]
    out, n = align(heard, script)
    assert [_k(w["word"]) for w in out] == [_k(w) for w in said.split()] and n == 0


def _k(w):
    import re
    return re.sub(r"[^a-z0-9]", "", w.lower())


def test_no_script_or_an_empty_one_changes_nothing():
    heard = W(("a", 0, 1))
    assert align(heard, "") == (heard, 0)
    assert align(heard, None) == (heard, 0)
    assert align([], "hello") == ([], 0)


def test_extra_fields_on_a_heard_word_are_kept():
    heard = [{"word": "dense", "start": 1, "end": 2, "p": 0.4}]
    out, _ = align(heard, "dents")
    assert out == [{"word": "dents", "start": 1, "end": 2, "p": 0.4}]


# -- the step ------------------------------------------------------------------------------------------------------

STEP_PY = ROOT / "steps" / "transform" / "generate_captions.py"


def test_the_step_takes_a_script_and_answers_corrected(tmp_path, monkeypatch, capsys):
    spec = importlib.util.spec_from_file_location("generate_captions_script", STEP_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    pdir = tmp_path / "proj"
    pdir.mkdir()
    path = pdir / "project.json"
    path.write_text(json.dumps({
        "id": "p1", "name": "t", "settings": {"colorSpace": "sdr"},
        "tracks": [{"id": "trk-0", "items": [{"id": "c1", "type": "video", "src": str(pdir / "a.mp4"),
                                              "start": 0.0, "end": 4.0, "inPoint": 0.0, "outPoint": 4.0}]}]}))
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: pdir)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a, **k: None)
    monkeypatch.setattr(mod, "whisper_runaway_timeout_for", lambda p: 1)
    monkeypatch.setattr(mod, "ink_pass", lambda p: [])
    seen = {}

    def fake_run(cmd, **kw):
        joined = " ".join(cmd)
        if "transcribe.py" in joined:
            entries = [("seen", 0, 400), ("uni", 400, 700), ("3", 700, 900), ("just", 900, 1200), ("announced", 1200, 1900)]
            (pdir / "_caption_words.json").write_text(json.dumps({"transcription": [
                {"text": f" {w}", "offsets": {"from": a, "to": b}} for w, a, b in entries]}))
        if "caption.py" in joined:
            words = json.loads((pdir / "_caption_words.json").read_text())["transcription"]
            seen["words"] = [e["text"].strip() for e in words]
            (pdir / "_caption_track.json").write_text(json.dumps({"style": "pop", "segments": [
                {"text": " ".join(seen["words"]), "start": 0.0, "end": 1.9,
                 "words": [{"word": e["text"].strip(), "start": e["offsets"]["from"] / 1000, "end": e["offsets"]["to"] / 1000}
                           for e in words]}]}))
    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["generate_captions.py", "--project-id", "p1",
                                      "--script", "Seen. Unitree just announced a humanoid."])
    mod.main()
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert seen["words"] == ["Seen.", "Unitree", "just", "announced"]
    assert out["corrected"] == 1
    cap = json.loads(path.read_text())["captions"]
    assert "corrected" not in cap, "the count is the answer's, never the project's"
    assert [w["word"] for w in cap["segments"][0]["words"]] == ["Seen.", "Unitree", "just", "announced"]


def test_the_step_declares_script():
    spec = json.loads((ROOT / "steps" / "transform" / "generate_captions.json").read_text())
    assert any(p["name"] == "script" and p["type"] == "string" for p in spec["params"])


def _step_run(tmp_path, monkeypatch, capsys, argv_extra, project_extra):
    spec = importlib.util.spec_from_file_location("generate_captions_script2", STEP_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    pdir = tmp_path / "proj"
    pdir.mkdir()
    (pdir / "project.json").write_text(json.dumps({
        "id": "p1", "name": "t", "settings": {"colorSpace": "sdr"}, **project_extra,
        "tracks": [{"id": "trk-0", "items": [{"id": "c1", "type": "video", "src": str(pdir / "a.mp4"),
                                              "start": 0.0, "end": 4.0, "inPoint": 0.0, "outPoint": 4.0}]}]}))
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: pdir)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a, **k: None)
    monkeypatch.setattr(mod, "whisper_runaway_timeout_for", lambda p: 1)
    monkeypatch.setattr(mod, "ink_pass", lambda p: [])

    def fake_run(cmd, **kw):
        joined = " ".join(cmd)
        if "transcribe.py" in joined:
            entries = [("the", 0, 300), ("robot", 300, 700), ("dance", 700, 1000), ("a", 1000, 1100), ("car", 1100, 1500)]
            (pdir / "_caption_words.json").write_text(json.dumps({"transcription": [
                {"text": f" {w}", "offsets": {"from": a, "to": b}} for w, a, b in entries]}))
        if "caption.py" in joined:
            words = json.loads((pdir / "_caption_words.json").read_text())["transcription"]
            (pdir / "_caption_track.json").write_text(json.dumps({"style": "pop", "segments": [
                {"text": " ".join(e["text"].strip() for e in words), "start": 0.0, "end": 1.5,
                 "words": [{"word": e["text"].strip(), "start": e["offsets"]["from"] / 1000, "end": e["offsets"]["to"] / 1000}
                           for e in words]}]}))
    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["generate_captions.py", "--project-id", "p1", *argv_extra])
    mod.main()
    return json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def test_the_step_spells_from_the_editing_prompt_by_default(tmp_path, monkeypatch, capsys):
    prompt = "Edit this video to follow the script:\n<Setup>\nIn the demo, the robot dents cars.\n<Play the clip>\n"
    out = _step_run(tmp_path, monkeypatch, capsys, [], {"editingPrompt": prompt})
    assert out["corrected"] == 1 and out["segments"][0]["text"] == "the robot dents a car."


def test_an_empty_script_turns_it_off_and_no_prompt_answers_no_count(tmp_path, monkeypatch, capsys):
    out = _step_run(tmp_path, monkeypatch, capsys, ["--script", ""], {"editingPrompt": "the robot dents cars"})
    assert "corrected" not in out and out["segments"][0]["text"] == "the robot dance a car"


def test_no_prompt_and_no_script_answers_no_count(tmp_path, monkeypatch, capsys):
    out = _step_run(tmp_path, monkeypatch, capsys, [], {})
    assert "corrected" not in out


# PL89 review (M4): the editing prompt is the script plus instructions. Captions spell from the script part only, and a
# word said twice is one word only where the script has it, once, at that place: "had had", "no no" said and not in the
# script are the speaker's words, both kept.
def test_the_script_is_the_prompts_script_part_without_its_notes_or_lead_in():
    from lib.caption_script import script_of
    prompt = ("Edit this video to follow the script:\n<Hook>\nThis might be the funniest demo.\n<Play the clip>\n"
              "Yeah, I don't think so.\n-----\nYou have context, just make it look awesome in the video.")
    got = script_of({"editingPrompt": prompt})
    assert "This might be the funniest demo." in got and "Yeah, I don't think so." in got
    assert "awesome" not in got and "context" not in got, got
    assert "Edit this video" not in got and "Hook" not in got and "Play the clip" not in got, got
    assert script_of({"editingPrompt": "Tight cuts, remove filler.\n"}) == "Tight cuts, remove filler.", "no ----- line: the whole prompt"


def test_a_doubled_word_the_script_does_not_have_there_is_kept_twice():
    out, n = align(W(("we", 0.0, 0.2), ("had", 0.2, 0.4), ("had", 0.4, 0.6)), "We")
    assert words_of(out) == ["We", "had", "had"] and n == 0, words_of(out)
    out, n = align(W(("robot", 0.0, 0.2), ("no", 0.2, 0.4), ("no", 0.4, 0.6), ("fell", 0.6, 1.0)), "robot fell")
    assert words_of(out) == ["robot", "no", "no", "fell"] and n == 0, words_of(out)


def test_a_stutter_before_a_script_word_is_still_one_word():
    heard = W(("the", 0.0, 0.1), ("the", 0.15, 0.3), ("robot", 0.3, 0.7), ("so", 0.8, 0.9), ("so", 0.95, 1.1))
    out, n = align(heard, "the robot")
    assert words_of(out) == ["the", "robot", "so", "so"], words_of(out)
    assert out[0]["start"] == 0.0 and n == 1
