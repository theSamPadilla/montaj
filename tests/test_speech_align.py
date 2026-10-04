"""Row-to-line alignment (PL44 T7). Pure logic over hand-made lines; nothing here says anything about whisper."""
import json

import pytest

from lib.speech_align import align, align_row
from lib.speech_lines import Line, Word, norm


def L(lid: str, text: str) -> Line:
    return Line(lid, tuple(Word(i, t, norm(t), float(i), i + 0.5) for i, t in enumerate(text.split())))


def refusal(capsys, fn, *args) -> dict:
    with pytest.raises(SystemExit) as e:
        fn(*args)
    assert e.value.code == 1
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


# ── the listed cases ─────────────────────────────────────────────────────────

def test_retake_aligns_to_the_second_occurrence_in_one_run():
    line = L("A3", "and always on mode and always on mode called kyros")
    assert align("and always on mode called kyros".split(), line) == [4, 5, 6, 7, 8, 9]


def test_duplicate_word_keeps_the_later_one():
    assert align(["the", "cat"], L("A1", "the the cat")) == [1, 2]


def test_case_and_punctuation_are_ignored():
    assert align(["Cloud."], L("A1", "the cloud")) == [1]
    assert align(["cloud"], L("A1", "the Cloud,")) == [1]
    assert align(['"The', "CLOUD!"], L("A1", "the cloud")) == [0, 1]


def test_changed_word_is_refused_naming_it(capsys):
    err = refusal(capsys, align, "the claude is fast".split(), L("A4", "the cloud is fast"))
    assert err["error"] == "changed_words"
    assert "claude" in err["message"]
    assert "A4" in err["message"]
    assert "the cloud is fast" in err["message"]


def test_extra_word_is_refused(capsys):
    err = refusal(capsys, align, "we ship ship on friday".split(), L("A2", "we ship on friday we said"))
    assert err["error"] == "changed_words"
    assert '"ship"' in err["message"]


def test_swapped_words_are_refused(capsys):
    err = refusal(capsys, align, "turn knob the left".split(), L("A5", "turn the knob left"))
    assert err["error"] == "changed_words"
    assert '"the"' in err["message"]


# ── the objective and the join ───────────────────────────────────────────────

def test_fewest_runs_outrank_later_words():
    # (0, 1) is one run; (4, 6) is later but two runs
    assert align(["we", "go"], L("A1", "we go and then we really go")) == [0, 1]


def test_later_words_win_a_tie_on_runs():
    assert align(["go"], L("A1", "go now go")) == [2]


def test_two_word_join_matches_when_no_single_word_does():
    assert align(["andit", "works"], L("A1", "and it works")) == [0, 1, 2]


def test_a_single_word_match_is_preferred_over_a_join():
    # the join (1, 2) is later, but it is only tried when single words cannot align the row
    assert align(["andit"], L("A1", "andit and it")) == [0]


def test_a_join_must_keep_the_words_in_order(capsys):
    err = refusal(capsys, align, ["andit"], L("A1", "it and"))
    assert err["error"] == "changed_words"


def test_empty_tokens_are_dropped():
    assert align(["", "--", "the", "...", "cat"], L("A1", "the cat")) == [0, 1]


def test_a_row_with_no_words_keeps_nothing():
    assert align(["", "..."], L("A1", "the cat")) == []


# ── align_row: ids and neighbouring lines ────────────────────────────────────

LINES = {ln.id: ln for ln in (L("A1", "we built it"), L("A2", "and it shipped on friday"), L("B1", "hello there"))}


def test_align_row_aligns_against_the_named_line():
    assert align_row("A2", "and it shipped".split(), LINES) == [0, 1, 2]


def test_unknown_line_is_refused(capsys):
    err = refusal(capsys, align_row, "A9", ["we"], LINES)
    assert err["error"] == "unknown_line"
    assert "A9" in err["message"]


def test_row_running_into_the_next_line_hints_a_split(capsys):
    err = refusal(capsys, align_row, "A1", "we built it and it shipped".split(), LINES)
    assert err["error"] == "changed_words"
    assert "A2" in err["message"] and "split" in err["message"].lower()
    assert '"we built it"' in err["message"] and '"and it shipped"' in err["message"]


def test_row_starting_in_the_previous_line_hints_a_split(capsys):
    err = refusal(capsys, align_row, "A2", "built it and it shipped".split(), LINES)
    assert err["error"] == "changed_words"
    assert "A1" in err["message"] and "split" in err["message"].lower()
    assert '"built it"' in err["message"] and '"and it shipped"' in err["message"]


def test_a_changed_word_in_align_row_gets_no_split_hint(capsys):
    err = refusal(capsys, align_row, "A1", "we bilt it".split(), LINES)
    assert err["error"] == "changed_words"
    assert "bilt" in err["message"]
    assert "split" not in err["message"].lower()
