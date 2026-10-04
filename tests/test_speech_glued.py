"""speech_edit on words that run together: a deleted word glued to a kept one is cut at its edge, and a
deletion that changes nothing is flagged, not reported as cut.

Found on a real 60 s talk (montaj 5.23.2). Its transcript has "cool." 44.411-44.781, "I" 44.781-44.841,
"would" 44.841-45.171, "see," 45.171-45.551, "I" 45.551-45.611 and "would" 45.611-45.881, with no gap
between them (lines "... cool.", "I would see, I would", "foresee a new industry"). Writing the middle
row as "I would" deleted "I would see,", but each hard cut's pad (0.04 s after a kept word, 0.02 s
before one) reached into the deleted words. 0.04 s of the first "I" stayed in the cut with its midpoint,
which is what derive() reads, so the text came back with a row "I". Deleting that row rebuilt the same
items, a no-op, while `cut` still listed "I".

The fixture is synthetic: those words at their real offsets, plus "really" before them and "foresee a
new industry" after (the talk's own offsets, 44.021 to 47.551), and one measured silence before
"foresee" so it starts a line of its own as it does in the talk. Lines are A1 "really cool.", A2 "I would
see, I would", A3 "foresee a new industry"; the one item plays A1 and A2 and stops before that silence,
so natural's 0.45 s cap has no pause to shorten. There is no media: build tests pass the silences to
derive(), apply tests stand them in for the measurement.
"""
import copy
import json
import os
import subprocess
from types import SimpleNamespace

import pytest

from lib import speech_apply, speech_text
from lib.speech_build import FEELS, items_from_runs, runs_from_rows
from lib.speech_text import derive, parse, render
from tests.test_speech_build import edit

WORDS = [("really", 44021, 44411), ("cool.", 44411, 44781), ("I", 44781, 44841), ("would", 44841, 45171),
         ("see,", 45171, 45551), ("I", 45551, 45611), ("would", 45611, 45881), ("foresee", 45881, 46781),
         ("a", 46781, 46841), ("new", 46841, 47031), ("industry", 47031, 47551)]
# The second "I" with no length, as whisper gives on synthesized speech (tests/fixtures/speech_text/README.md):
# nothing of it lies between "see," and "would", so deleting it cannot change the cut.
ZERO_I = WORDS[:5] + [("I", 45551, 45551), ("would", 45551, 45881)] + WORDS[7:]
SILS = [(45.881, 46.5)]
IN, OUT = 43.9, 45.95
FPS = 30
EPS = 1e-6
FEEL_NAMES = sorted(FEELS)
A2 = "A2 I would see, I would"
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@local"]


def _item(iid, a, b, start):
    return {"id": iid, "type": "video", "src": None, "start": round(start, 6), "end": round(start + (b - a), 6),
            "inPoint": a, "outPoint": b, "sourceWidth": 64, "sourceHeight": 64}


def _project(pdir, words=WORDS, spans=((IN, OUT),)):
    """Write the sidecar and project.json into pdir; spans are the speech items' (inPoint, outPoint)."""
    os.makedirs(pdir, exist_ok=True)
    src = os.path.join(pdir, "talk.mp4")
    with open(os.path.join(pdir, "talk.json"), "w", encoding="utf-8") as f:
        json.dump({"transcription": [{"text": " " + t, "offsets": {"from": a, "to": b}} for t, a, b in words]}, f)
    items, start = [], 0.0
    for n, (a, b) in enumerate(spans, 1):
        it = _item(f"clip-{n}", a, b, start)
        it["src"] = src
        items.append(it)
        start = it["end"]
    project = {"version": "0.2", "id": "glued", "status": "draft", "workflow": "glued", "editingPrompt": "fixture",
               "settings": {"resolution": [64, 64], "fps": FPS}, "tracks": [{"id": "trk-0", "items": items}]}
    with open(os.path.join(pdir, "project.json"), "w", encoding="utf-8") as f:
        json.dump(project, f, indent=2)
    return project, src


def _fx(pdir, words=WORDS, spans=((IN, OUT),)):
    project, src = _project(str(pdir), words, spans)
    d = derive(project, str(pdir), sils={src: SILS})
    ws = sorted((w for ln in d.lines.values() for w in ln.words), key=lambda w: w.idx)
    return SimpleNamespace(project=project, pdir=str(pdir), src=src, derived=d, words=ws,
                           text=render(d, project["id"]))


@pytest.fixture
def fx(tmp_path):
    return _fx(tmp_path / "fx")


def build(fx, text, feel):
    old = copy.deepcopy(fx.project["tracks"][0]["items"])
    _, rows = parse(text)
    runs, rep = runs_from_rows(rows, fx.derived, {fx.src: SILS}, None, old, feel=feel)
    items, _ = items_from_runs(runs, old, FPS, report=rep)
    return SimpleNamespace(runs=runs, report=rep, items=items, old=old)


def rows_of(fx, items):
    """The speech rows derive() gives on these items, words only: what the agent reads next."""
    p = copy.deepcopy(fx.project)
    p["tracks"][0]["items"] = items
    d = derive(p, fx.pdir, sils={fx.src: SILS})
    return [" ".join([r.line] + [w.text for w in r.words]) for r in d.cut if r.kind == "speech"]


def heard(runs, w):
    """Seconds of word w the new cut plays."""
    return sum(max(0.0, min(r.s_out, w.end) - max(r.s_in, w.start)) for r in runs if r.kind == "speech")


def test_the_fixture_reads_like_the_talk(fx):
    assert rows_of(fx, fx.project["tracks"][0]["items"]) == ["A1 really cool.", A2]
    W = fx.words
    assert all(W[i + 1].start == W[i].end for i in range(1, 6))     # "cool." to the second "would": no gap


# ---------------------------------------------------------------- the first edit


@pytest.mark.parametrize("feel", FEEL_NAMES)
def test_deleting_glued_words_removes_all_of_them(fx, feel):
    b = build(fx, edit(fx.text, A2, "A2 I would"), feel)
    W = fx.words
    assert [heard(b.runs, W[i]) for i in (2, 3, 4)] == [0.0, 0.0, 0.0]
    assert b.report.cut == [{"line": "A2", "words": "I would see,", "seconds": 0.77}]
    assert b.report.flagged == [] and b.report.hard_cuts == 2
    # each side is cut at the kept word's own edge: no gap there for a pad
    assert sorted(t for r in b.runs for t in (r.s_in, r.s_out) if W[1].end - 0.1 < t < W[5].start + 0.1) == \
        pytest.approx([W[1].end, W[5].start], abs=EPS)
    assert rows_of(fx, b.items) == ["A1 really cool.", "A2 I would"]


# ---------------------------------------------------------------- one glued word


@pytest.mark.parametrize("feel", FEEL_NAMES)
@pytest.mark.parametrize("row,gone,after", [
    ("A2 would see, I would", 2, ["A1 really cool.", "A2 would see, I would"]),
    ("A2 I would see, would", 5, ["A1 really cool.", "A2 I would see,", "A2 would"]),
])
def test_deleting_one_glued_word_removes_it(fx, feel, row, gone, after):
    # each "I" is 0.06 s, shorter than the two pads together (0.04 + 0.02): before the fix the pads met
    # inside it, the join stayed whole and nothing was cut
    b = build(fx, edit(fx.text, A2, row), feel)
    assert heard(b.runs, fx.words[gone]) == 0.0
    assert b.items != b.old
    assert b.report.cut == [{"line": "A2", "words": "I", "seconds": 0.06}]
    assert b.report.flagged == [] and b.report.hard_cuts == 2
    assert rows_of(fx, b.items) == after


# ---------------------------------------------------------------- natural never plays more than tight


@pytest.mark.parametrize("row", ["A2 I would", "A2 would see, I would", "A2 I would see, would", "A2 I would I would",
                                 "A2 see, I would"])
def test_natural_plays_no_more_of_a_deleted_word_than_tight(fx, row):
    t = edit(fx.text, A2, row)
    tight, natural = build(fx, t, "tight"), build(fx, t, "natural")
    kept = {i for r in natural.runs for i in r.words}
    gone = [w for w in fx.words if w.idx not in kept]
    assert gone
    for w in gone:
        assert heard(natural.runs, w) <= heard(tight.runs, w) + EPS
        assert heard(tight.runs, w) == 0.0, (w.text, heard(tight.runs, w))   # every word here is glued


# ---------------------------------------------------------------- a deletion that changes nothing


@pytest.mark.parametrize("feel", FEEL_NAMES)
def test_a_deletion_that_changes_nothing_is_flagged_not_cut(tmp_path, feel):
    fx = _fx(tmp_path / "zero", words=ZERO_I)
    b = build(fx, edit(fx.text, A2, "A2 I would see, would"), feel)
    assert b.items == b.old
    assert b.report.cut == [] and b.report.hard_cuts == 0
    assert b.report.flagged == [{"kind": "no_gap", "line": "A2", "words": "I"}]


@pytest.mark.parametrize("feel", FEEL_NAMES)
def test_a_flagged_word_leaves_the_rest_of_the_deletion_in_cut(tmp_path, feel):
    # "I would see, I" deleted, the zero-length "I" among them: the rest is cut, the "I" is flagged
    fx = _fx(tmp_path / "zero", words=ZERO_I)
    b = build(fx, edit(fx.text, A2, "A2 would"), feel)
    assert b.report.cut == [{"line": "A2", "words": "I would see,", "seconds": 0.77}]
    assert b.report.flagged == [{"kind": "no_gap", "line": "A2", "words": "I"}]
    assert rows_of(fx, b.items) == ["A1 really cool.", "A2 I would"]


# ---------------------------------------------------------------- the apply


def _git_project(pdir, words=WORDS, spans=((IN, OUT),)):
    project, _ = _project(str(pdir), words, spans)
    for args in (["init", "-q"], ["add", "project.json"], ["commit", "-q", "-m", "init"]):
        subprocess.run([*GIT, *args], cwd=pdir, capture_output=True, check=True)
    return os.path.join(str(pdir), "project.json")


@pytest.fixture
def measured(monkeypatch):
    """The apply measures silences from the media; there is none here, so stand SILS in for the measurement."""
    monkeypatch.setattr(speech_text, "silences", lambda path, *a, **k: list(SILS))


def _text(path):
    with open(path, encoding="utf-8") as f:
        project = json.load(f)
    return render(derive(project, os.path.dirname(path)), project["id"])


@pytest.mark.parametrize("feel", FEEL_NAMES)
def test_apply_deletes_glued_words_and_the_text_drops_them(tmp_path, measured, feel):
    path = _git_project(tmp_path / "p")
    r = speech_apply.apply(path, edit(_text(path), A2, "A2 I would"), preview=False, max_pause=None, feel=feel)
    assert r["applied"] is True and r["noop"] is False
    assert r["cut"] == [{"line": "A2", "words": "I would see,", "seconds": 0.77}]
    assert r["flagged"] == [] and r["hardCuts"] == 2
    assert r["text"].count("\nA2 ") == 1 and "\nA2 I would\n" in r["text"], r["text"]


@pytest.mark.parametrize("feel", FEEL_NAMES)
def test_apply_removes_the_i_a_523_cut_kept(tmp_path, measured, feel):
    # The project as 5.23.2 left it after the first edit: "cool." ran on 0.04 s into the deleted "I" and
    # the next item opened 0.02 s before the kept "I". Deleting the row "A2 I" was a no-op; now it cuts.
    path = _git_project(tmp_path / "p", spans=((IN, 44.821), (45.531, OUT)))
    text = _text(path)
    assert "\nA2 I\n" in text
    r = speech_apply.apply(path, edit(text, "A2 I", None), preview=False, max_pause=None, feel=feel)
    assert r["applied"] is True and r["noop"] is False
    assert r["cut"] == [{"line": "A2", "words": "I", "seconds": 0.06}] and r["flagged"] == []
    assert "\nA2 I\n" not in r["text"]
    with open(path, encoding="utf-8") as f:
        first = json.load(f)["tracks"][0]["items"][0]
    assert first["outPoint"] == pytest.approx(44.781, abs=EPS)


@pytest.mark.parametrize("feel", FEEL_NAMES)
def test_apply_never_returns_a_silent_noop(tmp_path, measured, feel):
    path = _git_project(tmp_path / "p", words=ZERO_I)
    r = speech_apply.apply(path, edit(_text(path), A2, "A2 I would see, would"), preview=False, max_pause=None,
                           feel=feel)
    assert r["applied"] is False and r["noop"] is True
    assert r["cut"] == [] and r["hardCuts"] == 0
    assert r["flagged"] == [{"kind": "no_gap", "line": "A2", "words": "I"}]
