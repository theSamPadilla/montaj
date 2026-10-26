"""PL89i (52's kung fu fix 3): "but in all, but in all seriousness" and "but then there is, but then there is this part"
survived the cut. Whisper wrote each phrase once and held a short word over the second saying ("all" 0.81 s; "then"
0.57 s and "there" 0.70 s), so the plan's text had no repeat to tag. cut now hears a slow phrase's own audio again
and, when that hearing has more words and still holds the phrase's words in order, puts them in the transcript, so
repeat? and retake? fire as for any other repeat. The hearings below are whisper's, measured on the kung fu clips."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import speech_rehear as rh  # noqa: E402


def _entries(words):
    return [{"text": f" {t}", "offsets": {"from": round(a * 1000), "to": round(b * 1000)}, "run": 0} for t, a, b in words]


E1 = [("But", 0.82, 0.96), ("in", 0.96, 1.19), ("all", 1.19, 2.00), ("seriousness,", 2.25, 2.95), ("this", 3.0, 3.2)]
D8 = [("But", 26.36, 26.58), ("then", 26.58, 27.15), ("there", 27.15, 27.85), ("is", 27.85, 28.38), ("this", 28.38, 29.04),
      ("part.", 29.04, 29.73), ("Yeah,", 31.78, 31.86)]
# whisper over each window (source seconds), as heard on IMG_1155 and IMG_1154
HEARD = {
    (0.72, 2.10): [("but", 0.82, 1.10), ("in", 1.10, 1.18), ("all", 1.18, 1.44), ("but", 1.44, 1.79), ("in", 1.79, 2.03), ("all", 2.03, 2.10)],
    (26.26, 29.83): [("But", 26.36, 26.39), ("then", 26.39, 27.03), ("there", 27.03, 27.25), ("is", 27.25, 27.46), ("this", 27.46, 28.73), ("part...", 28.73, 29.83)],
    (27.1, 29.83): [("-", 27.1, 27.2), ("There", 27.2, 27.75), ("is,", 27.75, 28.09), ("but", 28.09, 28.38), ("then", 28.38, 28.63),
                    ("there", 28.63, 29.01), ("is", 29.01, 29.16), ("this", 29.16, 29.48), ("part.", 29.48, 29.83)],
}


def window(start, end):
    key = min(HEARD, key=lambda k: abs(k[0] - start) + abs(k[1] - end))
    assert abs(key[0] - start) < 0.06 and abs(key[1] - end) < 0.06, (start, end)
    return HEARD[key]


def test_a_phrase_with_a_short_word_held_long_is_slow_and_ordinary_speech_is_not():
    assert rh.slow_phrases(_entries(E1)) == [(0, 2)]
    assert rh.slow_phrases(_entries(D8)) == [(0, 5)]
    plain = [("the", 1.0, 1.15), ("robot", 1.15, 1.6), ("dents", 1.6, 2.0), ("a", 2.0, 2.05), ("car.", 2.05, 2.6)]
    assert rh.slow_phrases(_entries(plain)) == []
    paused = [("It's", 0.0, 0.2), ("so", 0.2, 0.4), ("funny,", 0.4, 1.8), ("dude.", 1.85, 2.4)]    # held before its comma
    assert rh.slow_phrases(_entries(paused)) == []


def test_a_cut_hears_the_longest_held_phrases_first(tmp_path):
    side = tmp_path / "IMG_1155.json"
    side.write_text(json.dumps({"transcription": _entries(E1), "montaj": {"by": "runs"}}))
    assert rh.candidates(str(side)) == [(0.81, 0, 2, 1.38)]
    side.write_text(json.dumps({"transcription": _entries(E1)}))
    assert rh.candidates(str(side)) == [], "never a transcript montaj did not make by runs"


def test_the_second_hearing_of_the_phrase_brings_the_repeat_back():
    got = rh.rehear_phrase(window, E1[0:3])
    assert [t for t, _, _ in got] == ["but", "in", "all", "but", "in", "all"]


def test_when_the_whole_phrase_is_heard_once_again_its_held_word_on_is_heard_alone():
    got = rh.rehear_phrase(window, D8[0:6])
    assert [t for t, _, _ in got] == ["But", "then", "There", "is,", "but", "then", "there", "is", "this", "part."]


def test_a_hearing_that_loses_or_changes_the_words_is_never_taken():
    lost = lambda s, e: [("And", s, s + 0.2), ("I'll...", s + 0.2, e)]
    assert rh.rehear_phrase(lost, E1[0:3]) is None
    # a second saying only repeats the phrase's own words: a word whisper made up ("X") is never put in
    made_up = lambda s, e: [("X", s, s + 0.1), ("But", s + 0.1, s + 0.3), ("in", s + 0.3, s + 0.5), ("all", s + 0.5, e)]
    assert rh.rehear_phrase(made_up, E1[0:3]) is None


def test_the_transcript_takes_the_new_words_and_keeps_a_copy(tmp_path):
    src = tmp_path / "IMG_1155.MOV"
    src.write_bytes(b"")
    sidecar = tmp_path / "IMG_1155.json"
    doc = {"transcription": _entries(E1), "montaj": {"input": "file", "offsets": "source", "by": "runs", "runs": [[0.8, 3.2]]}}
    sidecar.write_text(json.dumps(doc))
    out = rh.rehear_file(str(sidecar), str(src), window, budget=rh.Budget())
    assert out == [{"clip": "IMG_1155.MOV", "at": 0.82, "was": "But in all", "heard": "but in all but in all"}]
    words = [e["text"].strip() for e in json.loads(sidecar.read_text())["transcription"]]
    assert words == ["but", "in", "all", "but", "in", "all", "seriousness,", "this"]
    assert (tmp_path / "IMG_1155.full.json").exists(), "the transcript as it was is kept"
    assert rh.rehear_file(str(sidecar), str(src), window, budget=rh.Budget()) == [], "heard once: nothing slow is left"


def test_a_transcript_montaj_did_not_make_by_runs_is_never_rewritten(tmp_path):
    src = tmp_path / "a.mov"
    src.write_bytes(b"")
    sidecar = tmp_path / "a.json"
    sidecar.write_text(json.dumps({"transcription": _entries(E1)}))
    before = sidecar.read_text()
    assert rh.rehear_file(str(sidecar), str(src), window, budget=rh.Budget()) == []
    assert sidecar.read_text() == before


def test_the_budget_bounds_the_hearings():
    b = rh.Budget(phrases=1, seconds=30.0)
    assert b.take(1.3) and not b.take(1.3)
    b = rh.Budget(phrases=6, seconds=2.0)
    assert b.take(1.5) and not b.take(1.0)
