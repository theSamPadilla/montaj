"""§585: the AI captioning again never overwrites a person's caption lines. Each generated line carries `auto`, a stamp of
its text; a line whose text no longer matches its stamp, or with none on a track that has stamps, is the person's, and
generate_captions keeps it and regenerates around it (lib/caption_marks.py)."""
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib.caption_marks import is_persons, keep_persons, stamp, stamp_all  # noqa: E402


def W(*spec):
    return [{"word": w, "start": s, "end": e} for w, s, e in spec]


def seg(i, *spec, auto=True, **kw):
    words = W(*spec)
    s = {"id": i, "text": " ".join(w["word"] for w in words), "start": words[0]["start"], "end": words[-1]["end"],
         "words": words, **kw}
    if auto:
        s["auto"] = stamp(s["text"])
    return s


def test_the_stamp_is_of_the_text_with_its_spacing_evened():
    assert stamp("hello  there ") == stamp("hello there") and len(stamp("x")) == 12
    assert stamp("hello there") != stamp("Hello there")


def test_a_line_is_the_persons_when_its_text_left_its_stamp_or_it_has_none():
    line = seg("a", ("one", 0, 1), ("two", 1, 2))
    assert not is_persons(line)
    assert is_persons({**line, "text": "one too"})
    assert is_persons({k: v for k, v in line.items() if k != "auto"})
    assert not is_persons({"id": "t", "text": "uno", "lang": "es", "translationOf": ["a"], "start": 0, "end": 2})


def test_stamp_all_stamps_every_line_but_translations():
    segs = stamp_all([{"text": "a b", "start": 0, "end": 1}, {"text": "uno", "lang": "es", "translationOf": ["x"]}])
    assert segs[0]["auto"] == stamp("a b") and "auto" not in segs[1]


# -- keep_persons: what a re-run writes ----------------------------------------------------------------------------

PREV = [seg("cap-0", ("this", 0, 0.5), ("may", 0.5, 1.0)),
        seg("cap-1", ("seen", 1.0, 1.5), ("Unitree", 1.5, 2.0)),
        seg("cap-2", ("just", 2.0, 2.5), ("announced", 2.5, 3.0))]
NEW = [seg("cap-0", ("this", 0, 0.5), ("may", 0.5, 1.0)),
       seg("cap-1", ("seen", 1.0, 1.5), ("uni", 1.5, 1.7), ("3", 1.7, 2.0)),
       seg("cap-2", ("just", 2.0, 2.5), ("announced", 2.5, 3.0))]


def test_a_person_edited_line_is_kept_and_the_new_line_over_it_is_dropped():
    prev = [dict(s) for s in PREV]
    prev[1] = {**prev[1], "text": "seen UNITREE", "words": W(("seen", 1.0, 1.5), ("UNITREE", 1.5, 2.0))}
    out, kept = keep_persons(prev, [dict(s) for s in NEW])
    assert [s["text"] for s in out] == ["this may", "seen UNITREE", "just announced"]
    assert [s["id"] for s in kept] == ["cap-1"] and out[1] is kept[0]


def test_a_new_line_overlapping_a_kept_one_keeps_only_its_words_outside_it():
    # the person's line covers 1.4-2.6; the new lines run across it
    persons = {"id": "mine", "text": "my own words", "start": 1.4, "end": 2.6,
               "words": W(("my", 1.4, 1.8), ("own", 1.8, 2.2), ("words", 2.2, 2.6))}
    prev = [PREV[0], persons, PREV[2]]
    new = [seg("cap-0", ("this", 0, 0.5), ("may", 0.5, 1.0), ("be", 1.0, 1.3), ("the", 1.3, 1.6)),
           seg("cap-1", ("funniest", 1.6, 2.4), ("demo", 2.4, 2.8), ("ever", 2.8, 3.2))]
    out, kept = keep_persons(prev, new)
    # a word is the new line's when its middle is outside the kept line ("demo", 2.4-2.8, is), and it is clamped clear
    assert [(s["text"], s["start"], s["end"]) for s in out] == [
        ("this may be", 0, 1.3), ("my own words", 1.4, 2.6), ("demo ever", 2.6, 3.2)]
    assert out[2]["words"][0] == {"word": "demo", "start": 2.6, "end": 2.8}
    assert [s["id"] for s in out] == ["cap-0", "mine", "cap-1"]
    for s in out:
        if s["id"] != "mine":
            assert s["auto"] == stamp(s["text"]), "a trimmed new line is the AI's: stamped again"


def test_a_kept_line_inside_a_new_one_splits_it_into_two_with_a_fresh_id():
    persons = {"id": "mine", "text": "HEY", "start": 1.0, "end": 1.5, "words": W(("HEY", 1.0, 1.5))}
    new = [seg("cap-0", ("a", 0, 0.5), ("b", 0.5, 1.0), ("c", 1.0, 1.5), ("d", 1.5, 2.0), ("e", 2.0, 2.5))]
    out, _ = keep_persons([PREV[0], persons], new)
    assert [(s["id"], s["text"]) for s in out] == [("cap-0", "a b"), ("mine", "HEY"), ("cap-1", "d e")]


def test_a_person_split_line_keeps_both_halves():
    # the person split cap-1 in the editor: both halves carry the stamp of the whole, so neither matches
    whole = PREV[1]
    a = {**whole, "id": "cap-1", "text": "seen", "end": 1.5, "words": whole["words"][:1]}
    b = {**whole, "id": "cap-9", "text": "Unitree", "start": 1.5, "words": whole["words"][1:]}
    out, kept = keep_persons([PREV[0], a, b, PREV[2]], [dict(s) for s in NEW])
    assert [s["text"] for s in out] == ["this may", "seen", "Unitree", "just announced"]
    assert sorted(s["id"] for s in kept) == ["cap-1", "cap-9"]


def test_a_line_the_person_added_is_kept():
    added = {"id": "x", "text": "(laughs)", "start": 3.1, "end": 3.6}
    out, kept = keep_persons(PREV + [added], [dict(s) for s in NEW])
    assert out[-1] is added and kept == [added] and len(out) == 4


def test_an_unstamped_old_track_is_not_guarded():
    old = [{k: v for k, v in s.items() if k != "auto"} for s in PREV]
    old[1]["text"] = "edited"
    out, kept = keep_persons(old, [dict(s) for s in NEW])
    assert kept == [] and [s["text"] for s in out] == [s["text"] for s in NEW]


def test_a_new_lines_id_never_takes_a_kept_lines():
    persons = {"id": "cap-5", "text": "mine", "start": 9, "end": 10}
    new = [seg("cap-5", ("other", 0, 1))]
    out, _ = keep_persons([PREV[0], persons], new)
    assert sorted(s["id"] for s in out) == ["cap-0", "cap-5"] and out[0]["text"] == "other" and out[0]["id"] == "cap-0"


def test_another_lane_is_not_in_the_way():
    persons = {"id": "mine", "text": "top", "start": 0, "end": 3, "lane": 1}
    out, kept = keep_persons([PREV[0], persons], [dict(s) for s in NEW])
    assert len(out) == 4 and kept == [persons]


def test_a_kept_lines_translation_is_kept_with_it():
    persons = {"id": "cap-1", "text": "seen UNITREE", "start": 1.0, "end": 2.0, "auto": stamp("seen Unitree")}
    tr = {"id": "cap-1-es", "text": "visto UNITREE", "lang": "es", "translationOf": ["cap-1"], "start": 1.0, "end": 2.0}
    out, _ = keep_persons([PREV[0], persons, tr, PREV[2]], [dict(s) for s in NEW])
    assert tr in out


# -- the step ------------------------------------------------------------------------------------------------------

STEP_PY = ROOT / "steps" / "transform" / "generate_captions.py"


def _run(tmp_path, monkeypatch, capsys, captions, argv=()):
    spec = importlib.util.spec_from_file_location("generate_captions_marks", STEP_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    pdir = tmp_path / "proj"
    pdir.mkdir()
    path = pdir / "project.json"
    path.write_text(json.dumps({
        "id": "p1", "name": "t", "settings": {"colorSpace": "sdr"}, "captions": captions,
        "tracks": [{"id": "trk-0", "items": [{"id": "c1", "type": "video", "src": str(pdir / "a.mp4"),
                                              "start": 0.0, "end": 4.0, "inPoint": 0.0, "outPoint": 4.0}]}]}))
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: pdir)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a, **k: None)
    monkeypatch.setattr(mod, "whisper_runaway_timeout_for", lambda p: 1)
    monkeypatch.setattr(mod, "ink_pass", lambda p: [])

    def fake_run(cmd, **kw):
        joined = " ".join(cmd)
        if "transcribe.py" in joined:
            (pdir / "_caption_words.json").write_text(json.dumps({"transcription": []}))
        if "caption.py" in joined:
            (pdir / "_caption_track.json").write_text(json.dumps({"style": "pop", "segments": [
                {k: v for k, v in s.items() if k not in ("id", "auto")} for s in NEW]}))
    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["generate_captions.py", "--project-id", "p1", "--script", "", *argv])
    mod.main()
    return json.loads(capsys.readouterr().out.strip().splitlines()[-1]), json.loads(path.read_text())["captions"]


def test_the_step_keeps_a_persons_line_and_names_it(tmp_path, monkeypatch, capsys):
    prev = [dict(s) for s in PREV]
    prev[1] = {**prev[1], "text": "seen UNITREE"}
    answer, cap = _run(tmp_path, monkeypatch, capsys, {"style": "pop", "segments": prev})
    assert [s["text"] for s in cap["segments"]] == ["this may", "seen UNITREE", "just announced"]
    assert answer["keptYours"] == [{"id": "cap-1", "text": "seen UNITREE"}]
    assert all(s["auto"] == stamp(s["text"]) for s in cap["segments"] if s["id"] != "cap-1")
    assert cap["segments"][1]["auto"] == stamp("seen Unitree"), "a kept line keeps its old stamp: still the person's"


def test_replace_edited_replaces_them(tmp_path, monkeypatch, capsys):
    prev = [dict(s) for s in PREV]
    prev[1] = {**prev[1], "text": "seen UNITREE"}
    answer, cap = _run(tmp_path, monkeypatch, capsys, {"style": "pop", "segments": prev}, ["--replace-edited"])
    assert [s["text"] for s in cap["segments"]] == [s["text"] for s in NEW] and "keptYours" not in answer


def test_a_first_run_stamps_every_line(tmp_path, monkeypatch, capsys):
    answer, cap = _run(tmp_path, monkeypatch, capsys, None)
    assert all(s["auto"] == stamp(s["text"]) for s in cap["segments"]) and "keptYours" not in answer


def test_the_step_declares_replace_edited():
    spec = json.loads((ROOT / "steps" / "transform" / "generate_captions.json").read_text())
    assert any(p["name"] == "replace-edited" and p["type"] == "bool" for p in spec["params"])


def test_caption_inks_split_restamps_an_ai_lines_pieces_and_leaves_a_persons_theirs():
    from lib import caption_ink as ci
    ai = seg("a", ("one", 1.0, 1.5), ("two", 1.5, 2.0), ("three", 2.0, 2.5), ("four", 2.5, 3.0))
    pieces = ci.split_pieces(ai, [None, None, "card", "card"])
    assert [p["text"] for p in pieces] == ["one two", "three four"]
    assert all(p["auto"] == stamp(p["text"]) for p in pieces) and not any(is_persons(p) for p in pieces)
    persons = {**ai, "text": "ONE two three four"}
    pieces = ci.split_pieces(persons, [None, None, "card", "card"])
    assert all(is_persons(p) for p in pieces)
    unstamped = {k: v for k, v in ai.items() if k != "auto"}
    assert all("auto" not in p for p in ci.split_pieces(unstamped, [None, None, "card", "card"]))
