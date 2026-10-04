"""speech_edit's feel: `natural` (the default) and `tight` (the cut speech_edit made before feels existed).

`tight` is held byte for byte to the build and the apply as they were before `feel` existed. The golden
tests/goldens/speech_edit_tight.json was recorded from montaj 5.23.1 (170fd59d), before the change, on
the edits BUILD_CASES and APPLY_CASES replay here. Record it again only when tight's output is meant to
change: `python -m tests.test_speech_feel` records feel="tight" from the code on disk.

The fixture is the real speech of tests/fixtures/speech_text (its README); word times quoted below are
the refined words derive() gives on it (see tests/test_speech_build.py).
"""
import copy
import dataclasses
import inspect
import json
import os
import shutil
import subprocess
from types import SimpleNamespace

import pytest

from lib import speech_apply
from lib.speech_build import FEELS, items_from_runs, runs_from_rows
from lib.speech_pauses import silences
from lib.speech_text import derive, parse, render
from tests.test_speech_build import (A1, _glued_edits, assert_cut_invariant, cut_edges, edit, move_after,
                                     pause_after)

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "speech_text")
GOLDEN = os.path.join(os.path.dirname(__file__), "goldens", "speech_edit_tight.json")
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@local"]
FPS = 30
EPS = 1e-6
NATURAL, TIGHT = FEELS["natural"], FEELS["tight"]


def _copy(dst):
    shutil.copytree(FIX, dst)
    pj = os.path.join(dst, "project.json")
    with open(pj) as f:
        raw = f.read().replace("/FIXTURE", str(dst))
    with open(pj, "w") as f:
        f.write(raw)
    return json.loads(raw), str(dst)


def _fx(dst):
    project, pdir = _copy(dst)
    d = derive(project, pdir)
    src = os.path.join(pdir, "speech.mp4")
    words = sorted((w for ln in d.lines.values() for w in ln.words), key=lambda w: w.idx)
    return SimpleNamespace(project=project, pdir=pdir, derived=d, text=render(d, project["id"]), src=src,
                           sils={src: silences(src)}, words=words, uncertain={(i, j) for _, i, j in d.uncertain})


@pytest.fixture(scope="module")
def fx(tmp_path_factory):
    return _fx(tmp_path_factory.mktemp("feel") / "fx")


def _canon(pdir, obj) -> str:
    """JSON with the copy's folder put back to the fixture's placeholder, so two copies compare equal."""
    return json.dumps(obj, sort_keys=True).replace(str(pdir), "/FIXTURE")


# ---------------------------------------------------------------- the edits


def _edits():
    """name -> (edit of the text, max_pause). The glued edits are test_speech_build's own."""
    out = {name: (fn, None) for name, fn in _glued_edits().items()}
    out.update({
        "unedited": (lambda t: t, None),
        "unedited_capped_030": (lambda t: t, 0.3),
        "move_a7_after_a9": (lambda t: move_after(t, 'A7 {0.45} "Tom!"', 'A9 "No answer."'), None),
        "a2_row_deleted": (lambda t: edit(t, "A2 in.", None), None),
        "a4_row_deleted": (lambda t: edit(t, "A4 {1.60} Hartford,", None), None),
        "a6_row_deleted": (lambda t: edit(t, 'A6 {0.77} "Tom!"', None), None),
        "a11_pause_025": (lambda t: edit(t, 'A11 {0.48} "You, Tom!"', 'A11 {0.25} "You, Tom!"'), None),
        "a11_pause_200": (lambda t: edit(t, 'A11 {0.48} "You, Tom!"', 'A11 {2.00} "You, Tom!"'), None),
        "a11_marker_deleted": (lambda t: edit(t, 'A11 {0.48} "You, Tom!"', 'A11 "You, Tom!"'), None),
        "a12_lead_050_capped_030": (lambda t: edit(t, 'A12 {0.66} "No {0.46} answer."', 'A12 {0.50} "No {0.46} answer."'), 0.3),
        "a12_no_and_markers_deleted": (lambda t: edit(t, 'A12 {0.66} "No {0.46} answer."', 'A12 answer."'), None),
        "a12_row_deleted": (lambda t: edit(t, 'A12 {0.66} "No {0.46} answer."', None), None),
        "a13_pulled_deleted": (lambda t: edit(t, "A13 {0.17} The old lady pulled her speckle.",
                                              "A13 {0.17} The old lady her speckle."), None),
        "a5_pause_010": (lambda t: edit(t, "A5 {0.78} 1876 CHAPTER {0.22} I", "A5 {0.78} 1876 CHAPTER {0.10} I"), None),
        "a8_deleted_trailing": (lambda t: edit(edit(t, 'A7 {0.45} "Tom!"', 'A7 {0.45} "Tom!" {0.17}'),
                                               'A8 "Tom!" {0.17}', None), None),
        "a9_deleted_leading": (lambda t: edit(t, 'A9 "No answer."', 'A9 {0.30} answer."'), None),
        "repeat_a6_at_end": (lambda t: t.replace("## Unused", 'A6 {0.77} "Tom!"\n\n## Unused'), None),
    })
    return out


BUILD_CASES = sorted(_edits())
APPLY_CASES = ["a1_words_cut", "a4_row_deleted", "a11_marker_deleted", "move_a7_after_a9", "unedited_capped_030"]


def _times(items, src, s):
    """Every new timeline time at which source second s of src plays."""
    return [it["start"] + (s - it["inPoint"]) / it.get("speed", 1) for it in items
            if it.get("src") == src and it.get("inPoint", 0) - EPS <= s <= it.get("outPoint", 0) + EPS]


def build(fx, text, max_pause=None, derived=None, **kw):
    old = copy.deepcopy(fx.project["tracks"][0]["items"])
    _, rows = parse(text)
    runs, rep = runs_from_rows(rows, derived if derived is not None else fx.derived, fx.sils, max_pause, old, **kw)
    items, prov = items_from_runs(runs, old, FPS, report=rep, sources=fx.project.get("sources"))
    return SimpleNamespace(runs=runs, report=rep, items=items, prov=prov)


def build_snapshot(fx, name, **kw) -> str:
    fn, max_pause = _edits()[name]
    b = build(fx, fn(fx.text), max_pause, **kw)
    return _canon(fx.pdir, {"runs": [dataclasses.asdict(r) for r in b.runs], "report": b.report.as_dict(),
                            "items": b.items, "prov": b.prov})


def apply_snapshot(tmp, name, **kw) -> str:
    """The whole apply on a fresh git copy: its result, the project.json it wrote and the text it wrote."""
    project, pdir = _copy(tmp)
    for args in (["init", "-q"], ["add", "project.json"], ["commit", "-q", "-m", "init"]):
        subprocess.run([*GIT, *args], cwd=pdir, capture_output=True, check=True)
    fn, max_pause = _edits()[name]
    text = fn(render(derive(project, pdir), project.get("name") or project["id"]))
    result = speech_apply.apply(os.path.join(pdir, "project.json"), text, preview=False, max_pause=max_pause, **kw)
    with open(os.path.join(pdir, "project.json"), encoding="utf-8") as f:
        written = f.read()
    with open(os.path.join(pdir, "speech-text.md"), encoding="utf-8") as f:
        written_text = f.read()
    return _canon(pdir, {"result": result, "project.json": written, "speech-text.md": written_text})


def record(tmp_root, **kw):
    """Write the golden from the code on disk. kw: the feel to record (none before feels existed)."""
    fx = _fx(os.path.join(tmp_root, "fx"))
    golden = {"build": {n: build_snapshot(fx, n, **kw) for n in BUILD_CASES},
              "apply": {n: apply_snapshot(os.path.join(tmp_root, "apply-" + n), n, **kw) for n in APPLY_CASES}}
    os.makedirs(os.path.dirname(GOLDEN), exist_ok=True)
    with open(GOLDEN, "w", encoding="utf-8") as f:
        json.dump(golden, f, indent=1, sort_keys=True)
        f.write("\n")


@pytest.fixture(scope="module")
def golden():
    with open(GOLDEN, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- tight is today's cut


@pytest.mark.parametrize("name", BUILD_CASES)
def test_tight_build_is_byte_identical_to_before_feel(fx, golden, name):
    assert build_snapshot(fx, name, feel="tight") == golden["build"][name]


@pytest.mark.parametrize("name", APPLY_CASES)
def test_tight_apply_is_byte_identical_to_before_feel(tmp_path, golden, name):
    assert apply_snapshot(tmp_path / "p", name, feel="tight") == golden["apply"][name]


def test_tight_keeps_the_old_constants():
    assert (TIGHT.min_pause, TIGHT.floor, TIGHT.max_pause, TIGHT.hard_cut_pad) == (0.08, 0.0, None, (0.04, 0.02))


# ---------------------------------------------------------------- natural is the default


def test_natural_is_the_default():
    assert inspect.signature(runs_from_rows).parameters["feel"].default == "natural"
    assert inspect.signature(speech_apply.apply).parameters["feel"].default == "natural"
    assert (NATURAL.min_pause, NATURAL.floor, NATURAL.max_pause, NATURAL.hard_cut_pad) == (0.18, 0.18, 0.45, (0.08, 0.05))


def test_no_feel_builds_what_natural_builds(fx):
    t = edit(fx.text, 'A11 {0.48} "You, Tom!"', 'A11 "You, Tom!"')
    assert build(fx, t).items == build(fx, t, feel="natural").items != build(fx, t, feel="tight").items


def test_unknown_feel_is_refused(fx, capsys):
    with pytest.raises(SystemExit):
        build(fx, fx.text, feel="loose")
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["error"] == "invalid_param"


# ---------------------------------------------------------------- natural keeps more silence at a join


def test_deleted_marker_keeps_018_natural_and_008_tight(fx):
    # A11's lead-in is the 0.477 s gap between "wonder?"" (41) and ""You," (42)
    t = edit(fx.text, 'A11 {0.48} "You, Tom!"', 'A11 "You, Tom!"')
    assert abs(pause_after(fx, build(fx, t, feel="tight").items, 41) - 0.08) <= 0.001
    b = build(fx, t, feel="natural")
    assert abs(pause_after(fx, b.items, 41) - 0.18) <= 0.001
    assert {"line": "A11", "from": 0.48, "to": 0.18} in b.report.pauses   # the rest are the 0.45 cap


def test_deleted_word_and_its_markers_keep_018_natural_and_008_tight(fx):
    # A12 '"No' (44) and both its markers deleted: "Tom!"" (43) joins "answer."" (45) across certain gaps
    # of 0.656 and 0.461 s
    t = edit(fx.text, 'A12 {0.66} "No {0.46} answer."', 'A12 answer."')
    for feel, want in (("tight", 0.08), ("natural", 0.18)):
        b = build(fx, t, feel=feel)
        (ta,), (tb,) = _times(b.items, fx.src, fx.words[43].end), _times(b.items, fx.src, fx.words[45].start)
        assert abs((tb - ta) - want) <= 0.001, (feel, tb - ta)
        assert b.report.hard_cuts == 0


def _opened(fx, gap):
    """The fixture's derive with word 7 ("and", glued in A1) given a certain `gap` on each side, so deleting
    it makes a join no marker ever sat at, with 2 * gap of silence beside it. The gaps start at 3.0 s,
    clear of the measured silence that ends at 2.994 s, so no edge snaps."""
    d = copy.deepcopy(fx.derived)
    times = {6: {"end": 3.0}, 7: {"start": 3.0 + gap, "end": 3.12 + gap}, 8: {"start": 3.12 + 2 * gap}}
    new = {w.idx: dataclasses.replace(w, **times.get(w.idx, {})) for ln in d.lines.values() for w in ln.words}
    d.lines = {k: dataclasses.replace(ln, words=tuple(new[w.idx] for w in ln.words)) for k, ln in d.lines.items()}
    for r in d.cut:
        r.words = [new[w.idx] for w in r.words]
    return d


@pytest.mark.parametrize("gap,tight_kept,natural_kept", [
    (0.10, 0.10, 0.18),    # tight: the larger of the two gaps; natural: the floor, held by the 0.20 s there is
    (0.03, 0.03, 0.06),    # natural: all 0.06 s there is, never more
])
def test_natural_floors_a_join_the_text_set_no_pause_for(fx, gap, tight_kept, natural_kept):
    d = _opened(fx, gap)
    t = edit(fx.text, A1, A1.replace("themselves, and of", "themselves, of"))

    def kept(feel):
        b = build(fx, t, derived=d, feel=feel)
        r = next(r for r in b.runs if 6 in r.words)
        n = b.runs[b.runs.index(r) + 1]
        assert 8 in n.words and not (r.hard_out or n.hard_in) and b.report.hard_cuts == 0
        return (r.s_out - 3.0) + ((3.12 + 2 * gap) - n.s_in)

    assert abs(kept("tight") - tight_kept) <= 0.001
    assert abs(kept("natural") - natural_kept) <= 0.001


def test_the_floor_never_crosses_a_word(fx):
    # A13 "pulled" (49) deleted: 0.079 s of certain gap after "lady" (48), none before "her" (50). The floor
    # takes what the gap has and hard-cuts the glued side; nothing lands inside a kept word.
    t = edit(fx.text, "A13 {0.17} The old lady pulled her speckle.", "A13 {0.17} The old lady her speckle.")
    b = build(fx, t, feel="natural")
    W = fx.words
    r = next(r for r in b.runs if 48 in r.words)
    n = b.runs[b.runs.index(r) + 1]
    assert abs(r.s_out - W[49].start) <= EPS and not r.hard_out
    assert n.hard_in and abs(n.s_in - (W[50].start - NATURAL.hard_cut_pad[1])) <= EPS


# ---------------------------------------------------------------- max pause


def test_natural_caps_unchanged_pauses_at_045(fx):
    b = build(fx, fx.text, feel="natural")
    assert abs(pause_after(fx, b.items, 41) - 0.45) <= 0.001     # A11 {0.48}
    assert abs(pause_after(fx, b.items, 43) - 0.45) <= 0.001     # A12 {0.66}
    assert abs(pause_after(fx, b.items, 44) - 0.45) <= 0.001     # A12 internal {0.46}
    assert abs(pause_after(fx, b.items, 45) - 0.174) <= 0.001    # A13 {0.17}, under the cap


def test_explicit_max_pause_wins_under_natural(fx):
    lower = build(fx, fx.text, max_pause=0.3, feel="natural")
    assert abs(pause_after(fx, lower.items, 41) - 0.3) <= 0.001
    higher = build(fx, fx.text, max_pause=0.6, feel="natural")
    assert abs(pause_after(fx, higher.items, 41) - 0.477) <= 0.001     # under 0.6: whole, though over 0.45
    assert abs(pause_after(fx, higher.items, 43) - 0.6) <= 0.001


def test_a_written_pause_wins_over_the_natural_cap_and_floor(fx):
    up = build(fx, edit(fx.text, 'A12 {0.66} "No {0.46} answer."', 'A12 {0.60} "No {0.46} answer."'), feel="natural")
    assert abs(pause_after(fx, up.items, 43) - 0.6) <= 0.001
    down = build(fx, edit(fx.text, 'A11 {0.48} "You, Tom!"', 'A11 {0.10} "You, Tom!"'), feel="natural")
    assert abs(pause_after(fx, down.items, 41) - 0.10) <= 0.001


# ---------------------------------------------------------------- hard-cut pads


def test_natural_pads_an_uncertain_hard_cut(fx):
    # "I" (29) is the word whisper placed inside a pause; deleting it hard-cuts both sides
    t = edit(fx.text, "A5 {0.78} 1876 CHAPTER {0.22} I", "A5 {0.78} 1876 CHAPTER")
    W = fx.words
    for feel in (TIGHT, NATURAL):
        b = build(fx, t, max_pause=2.0, feel="natural" if feel is NATURAL else "tight")   # no cap: the pads alone
        assert b.report.hard_cuts == 2
        edges = sorted(x for x, _ in cut_edges(fx, b.runs))
        assert edges == pytest.approx([W[28].end + feel.hard_cut_pad[0], W[30].start - feel.hard_cut_pad[1]], abs=EPS)


# a6_row_deleted keeps the whole uncertain gap after the inside word "I", an edge the invariant does not
# model (on either feel); test_speech_build's test_kept_inside_word_keeps_its_whole_gap_at_the_cut holds it.
@pytest.mark.parametrize("name", [n for n in BUILD_CASES if n != "a6_row_deleted"])
def test_natural_never_cuts_inside_a_word(fx, name):
    """test_speech_build's invariant, on natural's pads: a placed edge is in a certain gap, or a counted
    hard cut at a word edge with natural's pad."""
    fn, max_pause = _edits()[name]
    b = build(fx, fn(fx.text), max_pause, feel="natural")
    placed, hard = assert_cut_invariant(fx, b.runs, b.report, pad=NATURAL.hard_cut_pad)
    if name in _glued_edits():
        assert hard > 0


def test_natural_pads_reach_further_into_a_deleted_glued_word(fx):
    # A13 "her" (50, 29.51 to 29.69) deleted between glued words: a glued join has no silence to keep, so
    # both pads sit inside the deleted word. Natural plays 0.13 s of its 0.18 s, tight 0.06 s.
    t = edit(fx.text, "A13 {0.17} The old lady pulled her speckle.", "A13 {0.17} The old lady pulled speckle.")
    her = fx.words[50]
    for feel, want in (("tight", 0.06), ("natural", 0.13)):
        b = build(fx, t, feel=feel)
        heard = sum(max(0.0, min(r.s_out, her.end) - max(r.s_in, her.start)) for r in b.runs if r.kind == "speech")
        assert abs(heard - want) <= 0.001, (feel, heard)
        assert {"line": "A13", "words": "her", "seconds": 0.18} in b.report.cut


# ---------------------------------------------------------------- the apply


def test_apply_threads_feel_through(tmp_path):
    a = json.loads(apply_snapshot(tmp_path / "n", "a11_marker_deleted", feel="natural"))
    b = json.loads(apply_snapshot(tmp_path / "t", "a11_marker_deleted", feel="tight"))
    assert {"line": "A11", "from": 0.48, "to": 0.18} in a["result"]["pauses"]
    assert b["result"]["pauses"] == [{"line": "A11", "from": 0.48, "to": 0.08}]


if __name__ == "__main__":
    import tempfile

    root = tempfile.mkdtemp()
    try:
        record(root, feel="tight")
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print(f"recorded {GOLDEN}")
