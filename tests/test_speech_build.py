"""speech_build: new speech items from the edited speech text (PL44 T8).

The fixture is real speech (tests/fixtures/speech_text/README.md). The word and gap times quoted in
comments are the refined words derive() produces on it (speech_lines.refine over the measured
silences). Most of the fixture's words are glued: whisper words are gapless and refine opens a gap
only where a pause is measured, so A1 has no gap at all and A5/A10 hold uncertain gaps around a
word whisper put inside a pause.
"""
import copy
import json
import os
import re
import shutil
from types import SimpleNamespace

import pytest

from lib.keyframe_curves import EASING_NAMES, sample_track
from lib.speech_build import (HARD_CUT_PAD_S, MIN_PAUSE_S, SNAP_WINDOW_S, Run, items_from_runs, runs_from_rows)
from lib.speech_pauses import silences
from lib.speech_text import derive, parse, render

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "speech_text")
FPS = 30
EPS = 1e-6


def _load(dst):
    shutil.copytree(FIX, dst)
    return json.loads((dst / "project.json").read_text().replace("/FIXTURE", str(dst))), str(dst)


@pytest.fixture(scope="module")
def fx(tmp_path_factory):
    project, pdir = _load(tmp_path_factory.mktemp("sb") / "fx")
    d = derive(project, pdir)
    src = os.path.join(pdir, "speech.mp4")
    words = sorted((w for ln in d.lines.values() for w in ln.words), key=lambda w: w.idx)
    return SimpleNamespace(project=project, pdir=pdir, derived=d, text=render(d, project["id"]), src=src,
                           sils={src: silences(src)}, words=words,
                           uncertain={(i, j) for _, i, j in d.uncertain})


def speech_items(project):
    return project["tracks"][0]["items"]


def build(fx, text, max_pause=None, project=None, derived=None, reserved=()):
    project = project if project is not None else fx.project
    d = derived if derived is not None else fx.derived
    old = copy.deepcopy(speech_items(project))
    _, rows = parse(text)
    runs, rep = runs_from_rows(rows, d, fx.sils, max_pause, old)
    items, prov = items_from_runs(runs, old, FPS, report=rep, sources=project.get("sources"),
                                  reserved_ids=reserved)
    return SimpleNamespace(runs=runs, report=rep, items=items, prov=prov, old=old)


def edit(text, old_row, new_row):
    """Replace one whole row of the Cut section (new_row None deletes it)."""
    lines = text.split("\n")
    assert lines.count(old_row) == 1, old_row
    i = lines.index(old_row)
    if new_row is None:
        del lines[i]
    else:
        lines[i] = new_row
    return "\n".join(lines)


def move_after(text, row, after):
    text = edit(text, row, None)
    lines = text.split("\n")
    lines.insert(lines.index(after) + 1, row)
    return "\n".join(lines)


def times_at(items, src, s):
    """Every new timeline time at which source second s of src plays."""
    return [it["start"] + (s - it["inPoint"]) / it.get("speed", 1) for it in items
            if it.get("src") == src and it.get("inPoint", 0) - EPS <= s <= it.get("outPoint", 0) + EPS]


def pause_after(fx, items, i):
    """Silence heard between word i and word i+1 on the new timeline."""
    a, b = fx.words[i], fx.words[i + 1]
    (ta,), (tb,) = times_at(items, fx.src, a.end), times_at(items, fx.src, b.start)
    return tb - ta


def by_in(items, in_point):
    return next(it for it in items if abs(it.get("inPoint", -1) - in_point) < EPS)


def by_out(items, out_point):
    return next(it for it in items if abs(it.get("outPoint", -1) - out_point) < EPS)


# ---------------------------------------------------------------- invariant


def cut_edges(fx, runs):
    """(edge, hard) for every speech edge the build placed (an edge kept from the old cut is not placed)."""
    out = []
    for r in runs:
        if r.kind != "speech":
            continue
        if r.old_in is None:
            out.append((r.s_in, r.hard_in))
        if r.old_out is None:
            out.append((r.s_out, r.hard_out))
    return out


def assert_cut_invariant(fx, runs, report):
    """A cut never lands inside a refined word. A placed edge is either in a certain gap between two
    consecutive refined words (or at the media's start/end), or it is a counted hard cut sitting at
    a word edge with HARD_CUT_PAD_S. Returns (placed edges, hard cuts)."""
    W = fx.words
    gaps = [(W[i].end, W[i + 1].start) for i in range(len(W) - 1)
            if (i, i + 1) not in fx.uncertain and W[i + 1].start - W[i].end > EPS]   # glued words have no gap
    gaps += [(0.0, W[0].start), (W[-1].end, W[-1].end)]                               # the media's own start and end
    placed = cut_edges(fx, runs)
    hard = 0
    for t, is_hard in placed:
        inside = [w.text for w in W if w.start + EPS < t < w.end - EPS]
        if is_hard:
            hard += 1
            assert any(abs(t - (w.end + HARD_CUT_PAD_S[0])) < EPS or abs(t - (w.start - HARD_CUT_PAD_S[1])) < EPS
                       for w in W), f"hard cut at {t:.4f} is not a word edge with its pad"
            continue
        assert not inside, f"cut at {t:.4f} lands inside {inside} and is not counted as a hard cut"
        assert any(lo - EPS <= t <= hi + EPS for lo, hi in gaps), f"cut at {t:.4f} is not in a certain gap"
    assert hard == sum(r.hard_cuts for r in runs) == report.hard_cuts
    return len(placed), hard


A1 = ("A1 results, of what they once were themselves, and of how they felt and thought and talked, "
      "and what queer enterprises they sometimes engaged")
A1_CUT = ("A1 results, of what they once were themselves, thought and talked, "
          "and what queer enterprises they sometimes engaged")          # "and of how they felt and" (words 7-12) cut


def _glued_edits():
    """Deletions where the words around the cut are glued (no gap) or the gap is uncertain: these must
    hard-cut, and each hard cut must sit at a word edge with its pad."""
    return {
        "a1_words_cut": lambda t: edit(t, A1, A1_CUT),
        "a1_words_cut_with_pause": lambda t: edit(t, A1, A1_CUT.replace("themselves, thought", "themselves, {0.30} thought")),
        "a9_first_word": lambda t: edit(t, 'A9 "No answer."', 'A9 answer."'),
        "a13_her": lambda t: edit(t, "A13 {0.17} The old lady pulled her speckle.", "A13 {0.17} The old lady pulled speckle."),
        "a10_with_uncertain": lambda t: edit(t, 'A10 {0.75} "What\'s gone with {0.27} that boy, I wonder?"',
                                             'A10 {0.75} "What\'s gone {0.27} that boy, I wonder?"'),
        "a5_inside_word_deleted": lambda t: edit(t, "A5 {0.78} 1876 CHAPTER {0.22} I", "A5 {0.78} 1876 CHAPTER"),
        "a3_first_word": lambda t: edit(t, "A3 The Author", "A3 Author"),
    }


@pytest.mark.parametrize("name", sorted(_glued_edits()))
def test_glued_deletions_hard_cut_at_word_edges(fx, name):
    b = build(fx, _glued_edits()[name](fx.text))
    placed, hard = assert_cut_invariant(fx, b.runs, b.report)
    assert hard > 0, f"{name}: a glued or uncertain cut must count as a hard cut"
    print(f"{name}: {placed} placed edges, {hard} hard cuts")


@pytest.mark.parametrize("name,max_pause", [("move_a7_after_a9", None), ("a4_row_deleted", None),
                                            ("a11_pause_025", None), ("repeat_a6_at_end", None),
                                            ("unedited_capped", 0.3)])
def test_cut_invariant_on_other_edits(fx, name, max_pause):
    t = fx.text
    if name == "move_a7_after_a9":
        t = move_after(t, 'A7 {0.45} "Tom!"', 'A9 "No answer."')
    elif name == "a4_row_deleted":
        t = edit(t, "A4 {1.60} Hartford,", None)
    elif name == "a11_pause_025":
        t = edit(t, 'A11 {0.48} "You, Tom!"', 'A11 {0.25} "You, Tom!"')
    elif name == "repeat_a6_at_end":
        t = t.replace("## Unused", 'A6 {0.77} "Tom!"\n\n## Unused')
    b = build(fx, t, max_pause=max_pause)
    placed, hard = assert_cut_invariant(fx, b.runs, b.report)
    assert placed > 0
    print(f"{name}: {placed} placed edges, {hard} hard cuts")


def test_deleting_a_word_between_pauses_makes_no_hard_cut(fx):
    """Every word with a certain gap > 0 on both sides, deleted on its own: 0 hard cuts. On this
    fixture that is A4's only word (the row empties) and either word of A12."""
    W, unc = fx.words, fx.uncertain
    rows = {r.line: r for r in fx.derived.cut if r.kind == "speech"}

    def certain_gap(i, j):
        return 0 <= i and j < len(W) and (i, j) not in unc and W[j].start - W[i].end > EPS

    cases = []
    for line, r in rows.items():
        for k, w in enumerate(r.words):
            if certain_gap(w.idx - 1, w.idx) and certain_gap(w.idx, w.idx + 1):
                cases.append((line, k))
    assert len(cases) >= 2, cases
    for line, k in cases:
        old = next(x for x in fx.text.split("\n") if x.startswith(line + " "))
        toks = old.split()[1:]
        word_toks = [i for i, tk in enumerate(toks) if not re.fullmatch(r"\{[\d.]+\}", tk)]
        del toks[word_toks[k]]
        # two markers left side by side do not parse: keep the first, as an agent deleting the word would
        toks = [tk for i, tk in enumerate(toks)
                if not (i and re.fullmatch(r"\{[\d.]+\}", tk) and re.fullmatch(r"\{[\d.]+\}", toks[i - 1]))]
        b = build(fx, edit(fx.text, old, " ".join([line] + toks)))
        placed, hard = assert_cut_invariant(fx, b.runs, b.report)
        assert placed > 0 and hard == 0, (line, k, b.report.hard_cuts)


# ---------------------------------------------------------------- no-op


def test_unedited_text_rebuilds_the_same_items(fx):
    b = build(fx, fx.text)
    assert b.items == speech_items(fx.project)
    assert [it["id"] for it in b.items] == ["clip-1", "clip-2", "clip-3"]
    r = b.report
    assert (r.hard_cuts, r.cut, r.moved, r.pauses, r.clamped, r.flagged) == (0, [], [], [], [], [])
    assert r.as_dict() == {"cut": [], "moved": [], "pauses": [], "clamped": [], "hardCuts": 0, "flagged": []}


def _split_clip1(fx, kf_b=None, extra_b=None):
    """clip-1 split at the 'themselves,'/'and' boundary (3.08 s) into clip-1a and clip-1b."""
    project = copy.deepcopy(fx.project)
    items = speech_items(project)
    c1 = items[0]
    a = copy.deepcopy(c1)
    bb = copy.deepcopy(c1)
    a.update(id="clip-1a", end=3.08, outPoint=3.08,
             keyframes=[{"prop": "cropX", "points": [{"t": 0, "value": 0, "easing": "ease-in-out"}, {"t": 3.08, "value": 0.3}]}])
    bb.update(id="clip-1b", start=3.08, inPoint=3.08,
              keyframes=kf_b if kf_b is not None else [{"prop": "cropX", "points": [{"t": 0, "value": 0.1}]}])
    bb.update(extra_b or {})
    items[0:1] = [a, bb]
    return project, derive(project, fx.pdir)


def test_unedited_split_item_stays_split(fx):
    project, d = _split_clip1(fx)
    text = render(d, project["id"])
    assert text.count("\nA1 ") == 2
    b = build(fx, text, project=project, derived=d)
    assert b.items == speech_items(project)


def test_a_row_split_in_two_stays_one_item(fx):
    t = edit(fx.text, "A13 {0.17} The old lady pulled her speckle.", "A13 {0.17} The old lady\nA13 pulled her speckle.")
    b = build(fx, t)
    assert b.items == speech_items(fx.project)


# ---------------------------------------------------------------- pauses


def test_pause_shortened_to_025_keeps_exactly_025(fx):
    # A11's lead-in is the 0.477 s gap between "wonder?"" (41) and ""You," (42), inside clip-3
    b = build(fx, edit(fx.text, 'A11 {0.48} "You, Tom!"', 'A11 {0.25} "You, Tom!"'))
    assert abs(pause_after(fx, b.items, 41) - 0.25) <= 0.001
    assert b.report.hard_cuts == 0
    assert b.report.pauses == [{"line": "A11", "from": 0.48, "to": 0.25}]
    assert b.report.clamped == []
    assert [it["id"] for it in b.items] == ["clip-1", "clip-2", "clip-3", "clip-3-s2"]


def test_pause_raised_to_2_is_clamped_to_the_source_and_reported(fx):
    b = build(fx, edit(fx.text, 'A11 {0.48} "You, Tom!"', 'A11 {2.00} "You, Tom!"'))
    assert abs(pause_after(fx, b.items, 41) - (fx.words[42].start - fx.words[41].end)) <= 0.001
    assert b.report.clamped == [{"line": "A11", "asked": 2.0, "kept": 0.48}]
    assert b.items == speech_items(fx.project)


def test_deleted_marker_leaves_the_minimum_pause(fx):
    b = build(fx, edit(fx.text, 'A11 {0.48} "You, Tom!"', 'A11 "You, Tom!"'))
    assert abs(pause_after(fx, b.items, 41) - MIN_PAUSE_S) <= 0.001
    assert b.report.pauses == [{"line": "A11", "from": 0.48, "to": 0.08}]


def test_max_pause_caps_only_the_pauses_the_text_did_not_change(fx):
    t = edit(fx.text, 'A12 {0.66} "No {0.46} answer."', 'A12 {0.50} "No {0.46} answer."')
    b = build(fx, t, max_pause=0.3)
    assert abs(pause_after(fx, b.items, 41) - 0.3) <= 0.001     # A11 {0.48}, unedited: capped
    assert abs(pause_after(fx, b.items, 44) - 0.3) <= 0.001     # A12 internal {0.46}, unedited: capped
    assert abs(pause_after(fx, b.items, 43) - 0.5) <= 0.001     # A12 lead-in edited to 0.50: kept
    assert abs(pause_after(fx, b.items, 45) - 0.174) <= 0.001   # A13 {0.17}, under the cap
    # the A8/A9 join (clip-2 tail 0.174 + clip-3 lead-in 0.073) is under the cap: crossfade kept
    c2, c3 = by_out(b.items, 19.7), by_in(b.items, 20.1)
    assert abs(c3["start"] - (c2["end"] - 0.2)) < EPS


def test_max_pause_never_splits_an_uncertain_gap(fx):
    # the 0.765 s gap 29-30 follows "I", which whisper placed inside a pause: capped, it stays whole
    b = build(fx, fx.text, max_pause=0.3)
    W = fx.words
    assert abs(pause_after(fx, b.items, 29) - (W[30].start - W[29].end)) <= 0.001
    assert b.report.hard_cuts == 0


def test_uncertain_gap_takes_hard_cut_pads_when_the_inside_word_is_deleted(fx):
    # "I" (word 29) is the word whisper placed inside a pause; deleting it hard-cuts both sides
    b = build(fx, edit(fx.text, "A5 {0.78} 1876 CHAPTER {0.22} I", "A5 {0.78} 1876 CHAPTER"))
    W = fx.words
    assert b.report.hard_cuts == 2
    edges = sorted(t for t, _ in cut_edges(fx, b.runs))
    assert edges == pytest.approx(sorted([W[28].end + HARD_CUT_PAD_S[0], W[30].start - HARD_CUT_PAD_S[1]]), abs=EPS)


def test_shortening_a_pause_next_to_an_inside_word_keeps_the_gap_whole(fx):
    # A5's {0.22} is the gap 28-29 around "I", spoken somewhere inside it: no cut, reported as unsure
    b = build(fx, edit(fx.text, "A5 {0.78} 1876 CHAPTER {0.22} I", "A5 {0.78} 1876 CHAPTER {0.10} I"))
    assert b.report.hard_cuts == 0
    assert len(b.items) == len(fx.project["tracks"][0]["items"])
    assert any(c.get("unsure") is True and c["line"] == "A5" for c in b.report.clamped), b.report.clamped


def test_kept_inside_word_keeps_its_whole_gap_at_the_cut(fx):
    # "I" kept, the word after it deleted: the edge sits at the next word's start, not inside the gap
    b = build(fx, edit(fx.text, 'A6 {0.77} "Tom!"', None))
    W = fx.words
    edges = [t for t, _ in cut_edges(fx, b.runs)]
    assert any(abs(t - W[30].start) <= EPS for t in edges), edges


# ---------------------------------------------------------------- deleted trailing / leading words keep their silence


def _kept_silence_after_word(fx, b, i):
    """Source silence kept between word i (end of its run, plus any silence-only runs) and the run that
    starts the next row: edge pad after word i plus the silence-only pieces."""
    W = fx.words
    r1 = next(r for r in b.runs if i in r.words)
    k = b.runs.index(r1) + 1
    kept = r1.s_out - W[i].end
    mids = []
    while k < len(b.runs) and not b.runs[k].words:
        kept += b.runs[k].s_out - b.runs[k].s_in
        mids.append(b.runs[k])
        k += 1
    return kept, mids, b.runs[k]


def test_deleted_trailing_word_leaves_its_silence_to_the_tail_marker(fx):
    # A8 "Tom!" (word 32) is deleted; A7 (word 31) asks for a 0.17 tail. In clip-2 the silence that
    # followed the deleted word runs to its outPoint 19.7 (0.174). The asked 0.17 is kept, not clamped.
    t = edit(edit(fx.text, 'A7 {0.45} "Tom!"', 'A7 {0.45} "Tom!" {0.17}'), 'A8 "Tom!" {0.17}', None)
    b = build(fx, t)
    W = fx.words
    # the join's pause is the tail 0.17 plus A9's unchanged lead-in (the 0.073 s before word 33)
    kept, mids, nxt = _kept_silence_after_word(fx, b, 31)
    assert len(mids) == 1 and abs(mids[0].s_in - W[32].end) <= EPS
    assert abs(kept - 0.17) <= 0.001, kept
    assert not b.report.clamped, b.report.clamped
    placed, hard = assert_cut_invariant(fx, b.runs, b.report)


def test_deleted_leading_word_leaves_its_silence_to_the_lead_in_marker(fx):
    # the symmetric case: A9's first word (word 33) deleted, A9 keeps "answer." with a 0.30 lead-in. The
    # old item clip-3 opened with 0.073 of silence before the deleted word; word 33 -> 34 are glued.
    t = edit(fx.text, 'A9 "No answer."', 'A9 {0.30} answer."')
    b = build(fx, t)
    W = fx.words
    r = next(r for r in b.runs if 34 in r.words)
    k = b.runs.index(r)
    kept = W[34].start - r.s_in
    mids = []
    while k > 0 and not b.runs[k - 1].words:
        k -= 1
        kept += b.runs[k].s_out - b.runs[k].s_in
        mids.append(b.runs[k])
    assert len(mids) == 1 and abs(mids[0].s_out - W[33].start) <= EPS
    # all the silence there is on this side is kept: the pad (0.02) plus the old item's 0.073 lead-in;
    # the join also carries clip-2's tail (0.174), so the clamp reports 0.174 + 0.093 kept of 0.474 asked
    assert abs(kept - (HARD_CUT_PAD_S[1] + 0.073)) <= 0.001, kept
    assert [c["line"] for c in b.report.clamped] == ["A9"], b.report.clamped
    assert abs(b.report.clamped[0]["kept"] - (0.174 + kept)) <= 0.011
    assert_cut_invariant(fx, b.runs, b.report)


def test_constants():
    assert (SNAP_WINDOW_S, HARD_CUT_PAD_S, MIN_PAUSE_S) == (0.15, (0.04, 0.02), 0.08)


# ---------------------------------------------------------------- carried state


def _old_segment_bounds(track):
    pts = track["points"]
    return [(pts[i]["t"], pts[i + 1]["t"], pts[i].get("easing")) for i in range(len(pts) - 1)]


def assert_keyframes_hold(old_item, new_items, prop):
    """The keyframed value at every kept frame is unchanged, except inside an eased segment a cut
    split (linear there, exact at its ends). Returns the number of frames compared."""
    old_tr = next(t for t in old_item["keyframes"] if t["prop"] == prop)
    speed = old_item.get("speed", 1)
    n_cmp = 0
    for it in new_items:
        if it.get("src") != old_item["src"] or not (old_item["inPoint"] - EPS <= it["inPoint"] < old_item["outPoint"]):
            continue
        new_tr = next(t for t in it["keyframes"] if t["prop"] == prop)
        off = (it["inPoint"] - old_item["inPoint"]) / speed
        dur = it["end"] - it["start"]
        split = [(a, b) for a, b, e in _old_segment_bounds(old_tr)
                 if e not in (None, "linear", "hold") and (a < off - EPS < b or a < off + dur - EPS < b)]
        frames = [n / FPS - it["start"] for n in range(int(it["start"] * FPS), int(it["end"] * FPS) + 2)]
        frames = [t for t in frames if -EPS <= t <= dur + EPS]
        for t in frames + [0.0, dur]:
            u = off + t
            if t not in (0.0, dur) and any(a - EPS <= u <= b + EPS for a, b in split):
                continue
            assert abs(sample_track(new_tr, t) - sample_track(old_tr, u)) <= 1e-9, (it["id"], prop, t, u)
            n_cmp += 1
    return n_cmp


def test_crop_keyframes_unchanged_at_kept_frames(fx):
    project = copy.deepcopy(fx.project)
    c1 = speech_items(project)[0]
    c1["keyframes"] += [
        {"prop": "cropY", "points": [{"t": 0, "value": 0}, {"t": 6.0, "value": 0.4}, {"t": 10.1, "value": 0.1}]},
        {"prop": "cropW", "points": [{"t": 0, "value": 0.5, "easing": "hold"}, {"t": 4.0, "value": 0.3, "easing": "ease"},
                                     {"t": 9.0, "value": 0.4, "easing": "ease-out"}, {"t": 10.1, "value": 0.5}]},
    ]
    assert {p.get("easing", "linear") for tr in c1["keyframes"] for p in tr["points"]} >= {"linear", "hold", "ease-in-out"}
    assert set(EASING_NAMES) >= {"hold", "ease-in-out"}
    b = build(fx, edit(fx.text, A1, A1_CUT), project=project)
    pieces = [it for it in b.items if it["id"].startswith("clip-1")]
    assert [it["id"] for it in pieces] == ["clip-1", "clip-1-s2"]
    n = sum(assert_keyframes_hold(c1, pieces, p) for p in ("cropX", "cropY", "cropW"))
    assert n > 300


def test_crossfade_survives_an_edit_elsewhere(fx):
    b = build(fx, edit(fx.text, A1, A1_CUT))
    c2, c3 = by_in(b.items, 10.7), by_in(b.items, 20.1)
    assert abs(c3["start"] - (c2["end"] - 0.2)) < EPS
    assert (c2["id"], c3["id"]) == ("clip-2", "clip-3")


def test_crossfade_overlap_never_exceeds_the_previous_piece(fx):
    # clip-2's last piece is 0.1 s long and clip-3 follows with its old 0.2 s crossfade: the overlap is
    # clamped to the piece, so the next item never starts before the previous one does
    old = copy.deepcopy(speech_items(fx.project))
    runs = [Run(fx.src, 19.6, 19.7, 0, "A8", old_out="clip-2"),
            Run(fx.src, 20.1, 21.0, 1, "A9", old_in="clip-3")]
    items, _ = items_from_runs(runs, old, FPS)
    assert items[0]["start"] == 0.0 and abs(items[0]["end"] - 0.1) < EPS
    assert items[1]["start"] >= items[0]["start"] - EPS
    assert items[1]["start"] >= 0.0


def test_hard_cut_edges_are_rounded_like_item_times(fx):
    # "were" (1.87-2.14) is glued to its neighbours: 1.87 + 0.04 is 1.9100000000000001 unrounded
    assert "once were themselves" in fx.text
    b = build(fx, fx.text.replace("once were themselves", "once themselves", 1))
    edges = [t for t, hard in cut_edges(fx, b.runs) if hard]
    assert len(edges) == 2 and all(t == round(t, 6) for t in edges), edges


def test_crossfade_dropped_when_item3_first_word_is_cut(fx):
    b = build(fx, edit(fx.text, 'A9 "No answer."', 'A9 answer."'))
    c2 = by_in(b.items, 10.7)
    c3 = next(it for it in b.items if it["id"] == "clip-3")
    assert c3["inPoint"] > 20.1
    assert abs(c3["start"] - c2["end"]) < EPS


def test_normalized_src_kept_only_when_full(fx):
    project = copy.deepcopy(fx.project)
    c1, c2 = speech_items(project)[0], speech_items(project)[1]
    c1.update(normalizedSrc="/conv/full.mp4", normalizedInPoint=0)
    c2.update(normalizedSrc="/cache/window.mp4")
    t = edit(edit(fx.text, A1, A1_CUT), "A4 {1.60} Hartford,", None)
    b = build(fx, t, project=project)
    p1 = [it for it in b.items if it["id"].startswith("clip-1")]
    p2 = [it for it in b.items if it["id"].startswith("clip-2")]
    assert len(p1) == 2 and len(p2) == 2
    assert all(it["normalizedSrc"] == "/conv/full.mp4" and it["normalizedInPoint"] == 0 for it in p1)
    assert all("normalizedSrc" not in it and "normalizedInPoint" not in it for it in p2)
    # an item rebuilt whole keeps even a window cache: the window is still exactly its range
    assert build(fx, fx.text, project=project).items[1]["normalizedSrc"] == "/cache/window.mp4"


def test_carried_fields_and_dropped_fields_flagged(fx):
    project = copy.deepcopy(fx.project)
    c2 = speech_items(project)[1]
    c2.update(scale=1.2, offsetX=0.1, volume=0.5, muted=False, proxySrc="/p.mp4", sourceDuration=30.0,
              remove_bg=True, nobg_src="/nobg.mov", transition={"type": "cut"})
    b = build(fx, edit(fx.text, "A4 {1.60} Hartford,", None), project=project)
    for it in (x for x in b.items if x["id"].startswith("clip-2")):
        assert (it["scale"], it["offsetX"], it["volume"], it["muted"], it["proxySrc"], it["sourceDuration"]) == \
               (1.2, 0.1, 0.5, False, "/p.mp4", 30.0)
        assert "nobg_src" not in it and "transition" not in it
    flags = [f for f in b.report.flagged if f["kind"] == "fields_dropped"]
    assert flags and all(f["fields"] == ["nobg_src", "remove_bg"] for f in flags)


def test_speed_scales_durations_and_keyframe_offsets(fx):
    project = copy.deepcopy(fx.project)
    items = speech_items(project)
    c2, c3 = items[1], items[2]
    c2.update(speed=2, end=10.1 + 4.5,
              keyframes=[{"prop": "scale", "points": [{"t": 0, "value": 1}, {"t": 4.5, "value": 2}]}])
    c3.update(start=14.4, end=14.4 + 9.9)
    d = derive(project, fx.pdir)
    text = render(d, project["id"])
    assert build(fx, text, project=project, derived=d).items == items
    b = build(fx, edit(text, "A4 {1.60} Hartford,", None), project=project, derived=d)
    pieces = [it for it in b.items if it["id"].startswith("clip-2")]
    assert len(pieces) == 2
    for it in pieces:
        assert abs((it["end"] - it["start"]) - (it["outPoint"] - it["inPoint"]) / 2) < EPS
        tr = it["keyframes"][0]
        u = (it["inPoint"] - c2["inPoint"]) / 2
        assert abs(sample_track(tr, 0) - sample_track(c2["keyframes"][0], u)) <= 1e-9


def test_run_spanning_two_items_takes_the_first_and_flags_it(fx):
    project, d = _split_clip1(fx, extra_b={"scale": 1.5})
    text = render(d, project["id"])
    rows = [x for x in text.split("\n") if x.startswith("A1 ")]
    t = edit(edit(text, rows[0], A1), rows[1], None)
    b = build(fx, t, project=project, derived=d)
    first = b.items[0]
    assert (first["id"], first["inPoint"], first["outPoint"]) == ("clip-1a", 0.0, 10.1)
    assert "scale" not in first
    assert first["keyframes"][0]["points"][0] == {"t": 0.0, "value": 0, "easing": "ease-in-out"}
    kinds = {f["kind"]: f for f in b.report.flagged}
    assert kinds["keyframes_merged"]["items"] == ["clip-1a", "clip-1b"]
    assert kinds["state_merged"]["fields"] == ["scale"]


# ---------------------------------------------------------------- ids, provenance, special rows


def test_ids_pieces_repeats_and_unused_lines(fx):
    t = edit(fx.text, "A4 {1.60} Hartford,", None).replace("## Unused", 'A6 {0.77} "Tom!"\n\n## Unused')
    b = build(fx, t, reserved={"clip-2-s2"})
    ids = [it["id"] for it in b.items]
    assert ids == ["clip-1", "clip-2", "clip-2-s3", "clip-3", "clip-2-s4"]
    assert len(set(ids)) == len(ids)
    assert b.prov["clip-2-s4"]["repeat"] is True and b.prov["clip-2"]["repeat"] is False
    assert b.prov["clip-2-s3"]["old_id"] == "clip-2"
    # a line no old item played (clip-3 removed): sp-<line>-<n>, props of the nearest old item, no keyframes
    project = copy.deepcopy(fx.project)
    del speech_items(project)[2]
    d = derive(project, fx.pdir)
    text = render(d, project["id"])
    assert "\nA13 The old lady pulled her speckle." in text.split("## Unused")[1]
    t = text.replace("\n\n## Unused", "\nA13 The old lady pulled her speckle.\n\n## Unused", 1)
    b = build(fx, t, project=project, derived=d)
    new = b.items[-1]
    assert new["id"] == "sp-A13-1" and b.prov["sp-A13-1"]["old_id"] is None
    assert (new["sourceWidth"], new["type"], new["src"]) == (64, "video", fx.src)
    assert "keyframes" not in new
    assert new["inPoint"] == pytest.approx(fx.words[45].end) and new["outPoint"] == pytest.approx(30.0)


def test_gap_image_and_no_speech_rows(fx):
    project = copy.deepcopy(fx.project)
    items = speech_items(project)
    items.append({"id": "img", "type": "image", "src": os.path.join(fx.pdir, "photo.png"), "start": 32.0, "end": 35.0})
    items.append({"id": "lp", "type": "video", "loop": True, "src": fx.src, "start": 35.0, "end": 36.0,
                  "inPoint": 1.0, "outPoint": 2.0})
    d = derive(project, fx.pdir)
    text = render(d, project["id"])
    assert build(fx, text, project=project, derived=d).items == items
    t = edit(text, "-- gap 3.20", "-- gap 1.00")
    t = edit(t, "-- image photo.png 3.00", "-- image photo.png 2.00")
    lines = t.split("\n")
    lines.remove("-- A 1.00-2.00 no speech")
    lines.insert(lines.index("## Cut") + 2, "-- A 1.00-2.00 no speech")
    b = build(fx, "\n".join(lines), project=project, derived=d)
    lp = b.items[0]
    assert {k: v for k, v in lp.items() if k not in ("start", "end")} == {k: v for k, v in items[-1].items() if k not in ("start", "end")}
    assert (lp["start"], lp["end"]) == (0.0, 1.0)
    img = next(it for it in b.items if it["id"] == "img")
    c3 = next(it for it in b.items if it["id"] == "clip-3")
    assert img["start"] == pytest.approx(c3["end"] + 1.0) and img["end"] - img["start"] == pytest.approx(2.0)


def test_unknown_special_row_is_refused(fx, capsys):
    t = fx.text.replace("\n\n## Unused", "\n-- A 5.00-6.00 no speech\n\n## Unused", 1)
    _, rows = parse(t)
    with pytest.raises(SystemExit):
        runs_from_rows(rows, fx.derived, fx.sils, None, copy.deepcopy(speech_items(fx.project)))
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "unknown_row" and "5.00-6.00" in err["message"]


def test_report_cut_and_moved(fx):
    t = move_after(edit(fx.text, "A4 {1.60} Hartford,", None), 'A7 {0.45} "Tom!"', 'A9 "No answer."')
    r = build(fx, t).report
    w = fx.words[26]
    assert r.cut == [{"line": "A4", "words": "Hartford,", "seconds": round(w.end - w.start, 2)}]
    assert r.moved == ["A7"]
