"""§558 E2: lib/take_select.py picks one take per section by the select-takes skill's rules."""
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

from lib.take_select import Unit, select  # noqa: E402
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


def test_short_lines_merge_only_when_adjacent():
    texts = ['"Tom!"', '"Tom!"', '"Tom!"', '"No answer."', LINES[0], '"No answer."']
    sel = select(units(*texts), is_filler)
    assert sel.kept == [2, 3, 4, 5]


def test_a_filler_only_unit_is_dropped():
    sel = select(units("Um.", LINES[0]), is_filler)
    assert sel.kept == [1] and sel.losers == [0]


def test_an_abandoned_opening_run_into_the_next_sentence_is_deleted():
    texts = ["Then drag it onto the timeline.", "Then drag it onto Trim the start so it opens on the action."]
    us = units(*texts)
    us[1].breaks = {4}                      # a pause before "Trim"
    sel = select(us, is_filler)
    assert kept_text(texts, sel) == texts[:1] + ["Trim the start so it opens on the action."]
    assert sel.abandoned == [1]


def test_a_shared_opener_of_two_sentences_is_not_an_abandoned_take():
    texts = ["I want to show you the editor.", "I want to Talk about it later."]
    sel = select(units(*texts), is_filler)
    assert sel.abandoned == [] and sel.drop == {}


# ── never cut: sentences that repeat words but are not retakes (review 2) ───
# Each case is a run of sentences one speaker said in one clip; every word must survive.
FILLERS = ["This part is filler one.", "Here is another thought.", "Something else entirely.",
           "Moving on to the next step.", "One more aside here."]
NEVER_CUT = {
    "and-then list": ["You open the app and then you pick a clip and then you trim it and then you export."],
    "you want twice": ["You want to pick the clip you want to edit first."],
    "a lot of": ["A lot of people use it and a lot of them love it."],
    "anaphora": ["We shall fight on the beaches, we shall fight on the landing grounds, we shall fight in the fields."],
    "lo que (es)": ["Lo que más me gusta es lo que hace con el audio."],
    "the more": ["The more you edit, the more you learn."],
    "if you": ["If you want it, if you need it, just buy it."],
    "this is": ["This is it, this is the one I wanted."],
    "never never": ["Never, never, never give up."],
    "best part": ["The best part is the price.", "The best part is the speed."],
    "cut your": ["You can cut your clips in one click.", "You can cut your audio in one click.",
                 "You can cut your captions in one click."],
    "reason": ["The reason I love it is that it is fast.", "The reason I love it is that it is cheap."],
    "puedes (es)": ["Puedes cortar tus clips en un clic.", "Puedes cortar tu audio en un clic."],
    "proper noun": ["We launched it on Monday at noon.", "We launched it on Product Hunt the next week."],
    "product name": ["Then I opened the app.", "Then I opened the Montaj editor and trimmed it."],
    "refrain": ["This is the way we do it.", *FILLERS, "This is the way we do it."],
    "callback": ["Here's the thing.", *FILLERS, "Here's the thing about pricing."],
    "short then longer": ["I built an app.", "It took a year.", "I built an app that edits videos for you."],
    "question grows": ["What if you could edit faster?", "What if you could edit faster and cheaper?"],
    "first and best": ["The first one is the simplest.", "The first one is the easiest."],
}


@pytest.mark.parametrize("name", sorted(NEVER_CUT))
def test_never_cut(name):
    texts = NEVER_CUT[name]
    sel = select(units(*texts), is_filler)
    assert kept_text(texts, sel) == texts, name
    assert sel.losers == [] and sel.abandoned == []


def test_a_stutter_of_a_whole_clause_is_cut_by_design():
    """The accepted residual: a clause said whole twice in a row reads as a stutter and keeps the last."""
    text = "never give up, never give up, never give up on your dream"
    sel = select(units(text), is_filler)
    assert kept_text([text], sel) == ["never give up on your dream"]


def test_a_cut_off_word_retake_is_cut():
    text = "and always on mo- and always on mode called Kyros"
    sel = select(units(text), is_filler)
    assert kept_text([text], sel) == ["and always on mode called Kyros"]


def test_an_abandoned_opening_needs_a_break_before_the_new_sentence():
    texts = ["Then drag it onto the timeline.", "Then drag it onto Trim the start so it opens on the action."]
    no_break = select(units(*texts), is_filler)
    assert kept_text(texts, no_break) == texts
    us = units(*texts)
    us[1].breaks = {4}
    sel = select(us, is_filler)
    assert kept_text(texts, sel) == texts[:1] + ["Trim the start so it opens on the action."]


def test_a_retake_far_away_in_another_clip_still_joins():
    us = [Unit(LINES[0].split(), clip="A"), *[Unit(t.split(), clip="A") for t in FILLERS], Unit(LINES[0].split(), clip="B")]
    sel = select(us, is_filler)
    assert len(sel.kept) == 1 + len(FILLERS) and sel.kept[0] == len(us) - 1


def test_a_later_longer_take_wins_over_fewer_flaws():
    """Takes that differ in words: the last complete one wins (a spoken correction), whatever the flaws."""
    us = [Unit("It costs twenty dollars.".split()),
          Unit("It costs twenty dollars a month.".split(), fillers=1, hesitations=1)]
    sel = select(us, is_filler)
    assert sel.kept == [1]


def test_an_immediate_longer_retake_of_a_period_sentence_replaces_it():
    texts = ["I built an app.", "I built an app that edits videos for you."]
    sel = select(units(*texts), is_filler)
    assert kept_text(texts, sel) == texts[1:]
