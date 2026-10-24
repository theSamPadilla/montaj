"""§558 E2: lib/take_select.py picks one take per section by the select-takes skill's rules."""
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

from lib.take_select import SAME_RATIO, Unit, _ratio, select  # noqa: E402
from steps.speech.rm_fillers import filler_matcher  # noqa: E402

_FILLER = filler_matcher("en")


def is_filler(tok):
    return bool(_FILLER.match(tok))


LINES = [
    "Start by picking the clip you want to edit.",
    "Then drag it onto the timeline below.",
    "Trim the start so it opens on the action.",
    "Finally export it at the size your phone wants.",
]


def filler_take(line):
    w = line.split()
    return " ".join([w[0], w[1] + ",", "um,", *w[2:]])


def restart_take(line):
    w = line.split()
    return " ".join([w[0], w[1] + "...", *w])


def units(*texts):
    return [Unit(t.split()) for t in texts]


def kept_text(texts, sel):
    us = units(*texts) if isinstance(texts[0], str) else texts
    out = []
    for i in sel.kept:
        drop = sel.drop.get(i, set())
        out.append(" ".join(w for k, w in enumerate(us[i].words) if k not in drop))
    return out


@pytest.mark.parametrize("split_restart", [False, True])
def test_three_takes_per_line_keeps_the_clean_last_take(split_restart):
    texts = []
    for line in LINES:
        texts.append(filler_take(line))
        if split_restart:   # the restart as its own line ("Start by..." then the full sentence)
            w = line.split()
            texts += [" ".join([w[0], w[1] + "..."]), line]
        else:
            texts.append(restart_take(line))
        texts.append(line)
    sel = select(units(*texts), is_filler)
    assert kept_text(texts, sel) == LINES
    clean = [i for i, t in enumerate(texts) if t in LINES]
    clean_last = [max(i for i in clean if texts[i] == line) for line in LINES]
    assert sel.kept == clean_last
    assert len(sel.losers) == len(texts) - 4


def test_a_truncated_last_take_loses_to_an_earlier_complete_one():
    texts = [LINES[0], "Start by picking the clip", LINES[1]]
    sel = select(units(*texts), is_filler)
    assert sel.kept == [0, 2]


def test_a_take_ending_in_an_ellipsis_is_truncated():
    texts = ["So this is the part where it breaks.", "So this is the part where it..."]
    sel = select(units(*texts), is_filler)
    assert sel.kept == [0]


def test_last_attempt_wins_a_tie():
    texts = [LINES[0], LINES[1], LINES[0]]
    sel = select(units(*texts), is_filler)
    assert sel.kept == [2, 1]     # narrative order: the section of LINES[0] came first


def test_fewer_flaws_beat_recency():
    us = [Unit(LINES[0].split()), Unit(LINES[0].split(), fillers=0, hesitations=2)]
    sel = select(us, is_filler)
    assert sel.kept == [0]


def test_within_take_repeat_keeps_the_final_occurrence():
    text = ("and always on mode, and always on mode called Kyros that basically lets "
            "and always on mode called Kyros")
    sel = select(units(text), is_filler)
    assert kept_text([text], sel) == ["and always on mode called Kyros"]


def test_within_take_restart_from_the_opening_is_cut():
    text = "Start by, start by picking the clip you want to edit."
    sel = select(units(text), is_filler)
    assert kept_text([text], sel) == ["start by picking the clip you want to edit."]


def test_unrelated_lines_are_never_merged():
    texts = [
        "The first one is the simplest.",
        "The second one is the fastest.",
        "You want to edit the clip first.",
        "I think you should try it today.",
        "No answer.",
        "What's gone with that boy, I wonder?",
        "No answer.",
        *LINES,
    ]
    sel = select(units(*texts), is_filler)
    assert sel.kept == list(range(len(texts)))
    assert sel.losers == []
    assert _ratio("the first one is the simplest".split(), "the second one is the fastest".split()) < SAME_RATIO


def test_short_lines_merge_only_when_adjacent():
    texts = ['"Tom!"', '"Tom!"', '"Tom!"', '"No answer."', LINES[0], '"No answer."']
    sel = select(units(*texts), is_filler)
    assert sel.kept == [2, 3, 4, 5]


def test_a_reworded_retake_is_the_same_section():
    texts = ["The first one is the simplest.", "The first one is the easiest."]
    sel = select(units(*texts), is_filler)
    assert sel.kept == [1]


def test_a_filler_only_unit_is_dropped():
    sel = select(units("Um.", LINES[0]), is_filler)
    assert sel.kept == [1] and sel.losers == [0]


def test_an_abandoned_opening_run_into_the_next_sentence_is_deleted():
    texts = ["Then drag it onto the timeline.", "Then drag it onto Trim the start so it opens on the action."]
    sel = select(units(*texts), is_filler)
    assert kept_text(texts, sel) == texts[:1] + ["Trim the start so it opens on the action."]
    assert sel.abandoned == [1]


def test_a_shared_opener_of_two_sentences_is_not_an_abandoned_take():
    texts = ["I want to show you the editor.", "I want to Talk about it later."]
    sel = select(units(*texts), is_filler)
    assert sel.abandoned == [] and sel.drop == {}
