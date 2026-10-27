"""§558 cut v5 fix pass (real3 v5a, review A, review B): the two reviewers' probes, ported as tests, each judged by
tests/cut_checks.py (flat.py v2's definitions: the joined timeline, the louder channel, the gated speech level).
Synthetic tones and noise at set levels, invented words."""
import json
import math
import re
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

from lib import speech_energy as se
from lib.common import ffmpeg_bin
from steps.audio import waveform_trim
from tests import cut_checks
from tests.steps import test_cut as tc
from tests.steps import test_cut_v5 as v5
from tests.steps.test_cut_pass3 import apply_without_labeled
from tests.steps.test_cut import stub_transcribe  # noqa: F401  (the fixture)

SP = -20.0


def plan_only(d, monkeypatch, *extra):
    plan, _ = tc.run(d, *extra, monkeypatch=monkeypatch)
    return plan, (d / "cut-plan.md").read_text()


def apply_text(d, monkeypatch, text):
    (d / "cut-plan.md").write_text(text)
    applied, _ = tc.run(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch)
    return applied


def said(d):
    return [w for w, _, _ in tc.played_words(d)]


def rows_of(text):
    body = text.split("\n## Cut")[-1].split("\n## Unused")[0]
    return [ln for ln in body.splitlines() if re.match(r"^[A-Z]+\d+ ", ln)]


def no_overlap(d):
    iv = sorted(tc.kept_iv(d))
    return not [(a, b) for a, b in zip(iv, iv[1:]) if b[0] < a[1] - 1e-3]


# ── A-B1: a line cut at a silence: each piece its own id, each row its own half ─────────────────────────────

def line(first, second, gap=0.55, t=0.3, w=0.25, g=0.05):
    """A line said as `first`, a silence of `gap` (cut, but under the 0.6 s line break), then `second`."""
    tones, words = [], []
    toks = first.split() + second.split()
    for k, _ in enumerate(toks):
        tones.append((round(t, 3), round(t + w, 3), SP))
        t += w + (gap if k == len(first.split()) - 1 else g)
    for k, tok in enumerate(toks):
        b = tones[k + 1][0] if k + 1 < len(toks) else tones[k][1]
        words.append((tok, tones[k][0], b))
    return tones, words, tones[-1][1] + 0.8


def split_project(tmp_path, monkeypatch, first, second):
    tones, words, total = line(first, second)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, total, words)], room=-75.0)
    plan, text = plan_only(d, monkeypatch)
    return d, tones, plan, text


def test_each_piece_of_a_split_line_has_its_own_id(tmp_path, monkeypatch):
    d, tones, plan, text = split_project(tmp_path, monkeypatch, "we went home", "after the show.")
    ids = [r.split()[0] for r in rows_of(text)]
    assert len(ids) == 2 and len(set(ids)) == 2, rows_of(text)


@pytest.mark.parametrize("first, second", [("the red", "the red bus."), ("I think", "I think we should go."),
                                           ("go left", "then go left again."), ("so it was", "late and so it was over."),
                                           ("well", "it went well."), ("and then the", "and then the bike fell.")])
def test_an_unedited_split_line_plays_each_half_once(tmp_path, monkeypatch, first, second):
    """'well | it went well.' played the second 'well.' twice: each row plays its own half, no source twice, and the
    plan's kept words are the words played."""
    d, tones, plan, text = split_project(tmp_path, monkeypatch, first, second)
    applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert no_overlap(d), tc.kept_iv(d)
    kept = " ".join(re.sub(r" \[.*$", "", r).split(" ", 1)[1] for r in rows_of(text))
    assert " ".join(said(d)) == re.sub(r" ?\{[\d.]+\} ?", " ", kept).strip(), (said(d), kept, text)


def test_deleting_the_first_half_plays_only_the_second(tmp_path, monkeypatch):
    d, tones, plan, text = split_project(tmp_path, monkeypatch, "the red car", "the red bus.")
    rows = rows_of(text)
    assert len(rows) == 2, rows
    apply_text(d, monkeypatch, text.replace(rows[0] + "\n", ""))
    assert said(d) == ["the", "red", "bus."], said(d)
    assert v5.cover(d, tones[0][0], tones[2][1]) < 0.01 and v5.cover(d, tones[3][0], tones[5][1]) > 0.99, tc.kept_iv(d)


def test_the_halves_reorder(tmp_path, monkeypatch):
    d, tones, plan, text = split_project(tmp_path, monkeypatch, "we went home", "after the show.")
    rows = rows_of(text)
    apply_text(d, monkeypatch, text.replace(rows[0] + "\n" + rows[1], rows[1] + "\n" + rows[0]))
    assert said(d) == ["after", "the", "show.", "we", "went", "home"], said(d)


def test_a_word_deleted_in_the_second_half(tmp_path, monkeypatch):
    d, tones, plan, text = split_project(tmp_path, monkeypatch, "we went home", "after the big show.")
    rows = rows_of(text)
    apply_text(d, monkeypatch, text.replace(rows[1], rows[1].replace(" big", "", 1)))
    assert said(d) == ["we", "went", "home", "after", "the", "show."], said(d)
    assert v5.cover(d, *tones[5][:2]) < 0.05, tc.kept_iv(d)


def test_the_second_half_deleted(tmp_path, monkeypatch):
    d, tones, plan, text = split_project(tmp_path, monkeypatch, "we went home", "after the show.")
    rows = rows_of(text)
    apply_text(d, monkeypatch, text.replace(rows[1] + "\n", ""))
    assert said(d) == ["we", "went", "home"], said(d)


def test_a_plan_whose_rows_would_play_other_words_is_written_with_a_note(tmp_path, monkeypatch):
    """The backstop: _make_plan compares every row's played source words with the plan's; a preview that would not
    play a kept word (here a tidy made to clip one off) is still written (PL89: never refused), and the answer's
    notes say the plan may not play what it says."""
    real = se.Refiner.tidy

    def clip(self, runs, derived, report=None):
        out = real(self, runs, derived, report)
        first = next(r for r in out if r.kind == "speech")
        first.s_out = first.s_in + 0.12                  # drops the row's later words' sound, keeps their indexes
        return out
    monkeypatch.setattr(se.Refiner, "tidy", clip)
    tones, words, total = line("we went home", "after the show.")
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, total, words)], room=-75.0)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    assert plan["mode"] == "plan" and (d / "cut-plan.md").is_file()
    assert any("may not play exactly what it says" in n for n in plan.get("notes", [])), plan.get("notes")


# ── A-B2 / L-B3: soft real words ────────────────────────────────────────────────────────────────────────────

def heard_tones_play(d, tones, room, skip=()):
    return [(k, a, b, db) for k, (a, b, db) in enumerate(tones) if k not in skip and db >= room + 10
            and v5.cover(d, a, b) < 0.95]


@pytest.mark.parametrize("db", [-52.0, -55.0, -58.0])
def test_the_videos_soft_last_word_goes_to_unused(tmp_path, monkeypatch, db):
    """A soft last word of the video (35+ dB under the speech, under the -46 guard, wholly in a silence) is not
    played: FINISH v5 protects only what the guard hears, so it goes with its silence, tagged inaudible, and one move
    restores it (fix pass: inaudible?, its burst kept)."""
    tones = [(0.30, 0.55, SP), (0.60, 0.85, SP), (0.90, 1.15, SP), (1.20, 1.45, SP), (1.75, 2.05, db)]
    words = [("that", 0.30, 0.60), ("is", 0.60, 0.90), ("all", 0.90, 1.20), ("folks", 1.20, 1.75), ("bye.", 1.75, 2.05)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 3.0, words)], room=-75.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    unused = tc.sections(text)[1]
    assert "bye." not in said_ and any("bye." in r and r.endswith(" inaudible]") for r in unused), (said_, text)
    assert v5.cover(d, 1.75, 2.05) < 0.05, tc.kept_iv(d)
    v5.checked(d, plan, applied, before)


@pytest.mark.parametrize("db", [-52.0, -55.0, -58.0])
def test_the_videos_soft_first_word_goes_to_unused(tmp_path, monkeypatch, db):
    tones = [(0.30, 0.55, db), (0.90, 1.15, SP), (1.20, 1.45, SP), (1.50, 1.75, SP), (1.80, 2.05, SP)]
    words = [("so", 0.30, 0.90), ("we", 0.90, 1.20), ("went", 1.20, 1.50), ("out", 1.50, 1.80), ("today.", 1.80, 2.05)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 3.0, words)], room=-75.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    unused = tc.sections(text)[1]
    assert said_[0] == "we" and any(re.search(r"\bso\b", r) and r.endswith(" inaudible]") for r in unused), text
    v5.checked(d, plan, applied, before)


def test_one_move_restores_the_videos_soft_first_word(tmp_path, monkeypatch):
    tones = [(0.30, 0.55, -55.0), (0.90, 1.15, SP), (1.20, 1.45, SP), (1.50, 1.75, SP), (1.80, 2.05, SP)]
    words = [("so", 0.30, 0.90), ("we", 0.90, 1.20), ("went", 1.20, 1.50), ("out", 1.50, 1.80), ("today.", 1.80, 2.05)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 3.0, words)], room=-75.0)
    plan, text = plan_only(d, monkeypatch)
    head, rest = text.split("\n## Cut\n", 1)
    cut, unused = rest.split("\n## Unused\n", 1)
    row = next(ln for ln in unused.splitlines() if ln.endswith(" inaudible]"))
    assert re.search(r"\bso\b", row), text
    back = re.sub(r" \[[^]]*\]$", "", row)                  # the row's words, tag gone, back in ## Cut in order
    lines = (head + "\n## Cut\n" + back + "\n" + cut + "\n## Unused\n" + unused.replace(row + "\n", "")).splitlines()
    apply_text(d, monkeypatch, "\n".join(lines) + "\n")
    assert said(d) == [w for w, _, _ in words], said(d)


@pytest.mark.parametrize("db", [-55.0, -58.0, -62.0])
@pytest.mark.parametrize("drift", [0.0, 0.12])
def test_a_soft_aside_pair_mid_line(tmp_path, monkeypatch, db, drift):
    """'we won | just kidding | we lost.': the aside 35-42 dB under the speech, under the -46 guard. 'kidding' ends
    where 'we' starts, so it is attached and so, in turn, is 'just': at -55 and -58 (over the attached line,
    max(speech - 40, room + 10) = -60) their sound plays. At -62 it is under that line, and FINISH v5 protects only
    what the guard hears: the silence is cut and the words go with it, tagged inaudible (the fix pass kept them)."""
    tones = [(0.30, 0.55, SP), (0.60, 0.85, SP), (1.40, 1.60, db), (1.65, 1.85, db), (2.50, 2.75, SP), (2.80, 3.05, SP)]
    words = [("we", 0.30, 0.60), ("won", 0.60, 1.40 + drift), ("just", 1.40 + drift, 1.65 + drift),
             ("kidding", 1.65 + drift, 2.50), ("we", 2.50, 2.80), ("lost.", 2.80, 3.05)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 3.8, words)], room=-75.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    if db > -60.0:
        assert {"just", "kidding"} <= set(said_), (said_, text)
        assert not heard_tones_play(d, tones, -75.0), (heard_tones_play(d, tones, -75.0), tc.kept_iv(d))
    else:
        assert not ({"just", "kidding"} & set(said_)) and plan["removed"]["inaudible"] == 2, (said_, text)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones, [0, 1, 4, 5]))


@pytest.mark.parametrize("faint", [-42.0, -45.0])
def test_a_faint_sentence_between_loud_ones_loses_no_word(tmp_path, monkeypatch, faint):
    """L-B3: an off-mic sentence (-42/-45 with speech at -14, room -80) between two loud ones: never removed."""
    sa, wa, ea = tc.spoken(["we start loud and close."], db=-14.0)
    sb, wb, eb = tc.spoken(["someone off the mic says this."], start=ea + 0.8, db=faint)
    sc, wcc, ec = tc.spoken(["and we end loud again."], start=eb + 0.8, db=-14.0)
    tones, words = sa + sb + sc, list(wa) + list(wb) + list(wcc)
    for k in (len(wa) - 1, len(wa) + len(wb) - 1):
        words[k] = (words[k][0], words[k][1], words[k + 1][1])
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, ec + 1.0, words)], room=-80.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert said_ == [w for w, _, _ in words], (said_, text)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones))


def _gain_drop(tmp_path, monkeypatch, db):
    sa, wa, ea = tc.spoken(["the first half is close to the mic and loud."], db=-14.0)
    sb, wb, eb = tc.spoken(["then the gain drops and you still hear every word."], start=ea + 0.8, db=db)
    tones, words = sa + sb, list(wa) + list(wb)
    words[len(wa) - 1] = (words[len(wa) - 1][0], words[len(wa) - 1][1], wb[0][1])
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, eb + 1.0, words)], room=-80.0)
    return d, tones, words


def test_a_gain_drop_to_the_end_loses_no_word(tmp_path, monkeypatch):
    """Review B's probe 6: the gain drops 31 dB for the last sentence (-45, room -80). Every word plays, the last one
    too: the -46 guard hears it, so 2b's (b) does not apply (orchestrator)."""
    d, tones, words = _gain_drop(tmp_path, monkeypatch, -45.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert said_ == [w for w, _, _ in words], (said_, text)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones))


def test_a_last_sentence_under_the_guard_goes_tagged_inaudible(tmp_path, monkeypatch):
    """The mirror: the last sentence at -50 (36 dB under the speech, under the -46 guard): FINISH v5 protects only
    what the guard hears, so the whole sentence is a silence to layer 1 and goes with it, tagged inaudible, one move
    from coming back."""
    d, tones, words = _gain_drop(tmp_path, monkeypatch, -50.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    n = len(tc.spoken(["the first half is close to the mic and loud."], db=-14.0)[1])
    assert said_ == [w for w, _, _ in words][:n], (said_, text)
    assert any(r.endswith(" inaudible]") and "every word." in r for r in tc.sections(text)[1]), text
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones[:n]))


# ── should-fix 3: a filler's removal never takes a neighbour's sound ───────────────────────────────────────────

@pytest.mark.parametrize("over", [0.05, 0.10, 0.15])
def test_a_filler_span_over_the_next_onset_takes_none_of_it(tmp_path, monkeypatch, over):
    tones = [(0.30, 0.55, SP), (0.60, 0.85, SP), (0.95, 1.15, SP), (1.20, 1.55, SP), (1.60, 1.85, SP), (1.90, 2.15, SP)]
    words = [("start", 0.30, 0.60), ("by", 0.60, 0.95), ("um", 0.95, 1.20 + over), ("picking", 1.20 + over, 1.60),
             ("the", 1.60, 1.90), ("clip.", 1.90, 2.15)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 2.9, words)], room=-75.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert "um" not in said_ and not heard_tones_play(d, tones, -75.0, skip={2}), tc.kept_iv(d)


@pytest.mark.parametrize("over", [0.05, 0.10, 0.15])
def test_a_filler_span_over_the_previous_tail_takes_none_of_it(tmp_path, monkeypatch, over):
    tones = [(0.30, 0.55, SP), (0.60, 0.95, SP), (1.00, 1.20, SP), (1.25, 1.55, SP), (1.60, 1.85, SP)]
    words = [("start", 0.30, 0.60), ("picking", 0.60, 0.95 - over), ("um", 0.95 - over, 1.25), ("the", 1.25, 1.60),
             ("clip.", 1.60, 1.85)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 2.6, words)], room=-75.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert "um" not in said_ and not heard_tones_play(d, tones, -75.0, skip={2}), tc.kept_iv(d)


def test_a_sure_retakes_first_saying_running_into_the_second_takes_none_of_it(tmp_path, monkeypatch):
    toks = "press the red button now".split()
    tones, words, t = [], [], 0.3
    for k in range(10):
        tones.append((round(t, 2), round(t + 0.25, 2), SP))
        t += 0.30 if k != 4 else 0.80
    for k in range(10):
        b = tones[k + 1][0] if k + 1 < 10 else tones[k][1]
        words.append(((toks * 2)[k] + ("." if k == 9 else ""), tones[k][0], b))
    words[4] = (words[4][0], words[4][1], tones[5][0] + 0.15)
    words[5] = (words[5][0], tones[5][0] + 0.15, words[5][2])
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, t + 1.0, words)], room=-75.0)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    assert plan["labels"] == {"retake?": 1}, text
    apply_without_labeled(d, monkeypatch, text)                    # the agent takes the first saying
    said_ = said(d)
    assert said_ == toks[:4] + ["now."], said_
    assert not heard_tones_play(d, tones, -75.0, skip=set(range(5))), tc.kept_iv(d)


# ── A-B3: audio is never removed, on a track of its own or another ──────────────────────────────────────────

@pytest.mark.parametrize("where", ["silence", "retake"])
def test_audio_wholly_inside_a_cut_span_is_moved_never_removed(tmp_path, monkeypatch, where):
    if where == "silence":
        tones = [(0.30, 0.60, SP), (0.65, 0.95, SP), (2.95, 3.25, SP), (3.30, 3.60, SP)]
        words = [("we", 0.30, 0.65), ("start", 0.65, 2.95), ("again", 2.95, 3.30), ("now.", 3.30, 3.60)]
        total, a0, a1 = 4.3, 1.5, 1.9
    else:
        toks = "press the red button now".split()
        tones, words, t = [], [], 0.3
        for k in range(10):
            tones.append((round(t, 2), round(t + 0.25, 2), SP))
            t += 0.30 if k != 4 else 0.80
        for k in range(10):
            b = tones[k + 1][0] if k + 1 < 10 else tones[k][1]
            words.append(((toks * 2)[k] + ("." if k == 9 else ""), tones[k][0], b))
        total, a0, a1 = t + 1.0, 0.5, 1.2
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, total, words)], room=-75.0)
    p = json.loads((d / "project.json").read_text())
    p["audio"] = {"tracks": [{"id": "sfx-top", "src": str(d / "vo.mov"), "start": a0, "end": a1, "inPoint": 0.0,
                              "outPoint": a1 - a0, "volume": 0.3}]}
    p["tracks"].append({"id": "trk-a", "items": [{"id": "sfx-lane", "type": "audio", "src": str(d / "vo.mov"),
                                                  "start": a0, "end": a1, "inPoint": 0.0, "outPoint": a1 - a0}]})
    (d / "project.json").write_text(json.dumps(p, indent=2))
    tc.git(d, "commit", "-qam", "audio")
    if where == "retake":            # the agent takes the labeled first saying, which holds all of the audio's span
        plan, _ = tc.run(d, monkeypatch=monkeypatch)
        applied = apply_without_labeled(d, monkeypatch, (d / "cut-plan.md").read_text())
    else:
        plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    after = json.loads((d / "project.json").read_text())
    assert [t["id"] for t in after["audio"]["tracks"]] == ["sfx-top"]
    assert [it["id"] for tr in after["tracks"][1:] for it in tr["items"]] == ["sfx-lane"]
    for it in [after["audio"]["tracks"][0]] + after["tracks"][1]["items"]:
        assert float(it["end"]) > float(it["start"]), it
    if where == "retake":            # all of its span was cut: moved to the next kept moment, and said so
        assert any("sfx-lane" in w for w in applied.get("warnings", [])), applied.get("warnings")


# ── should-fix 1: take breaks read a soft tail as sound ───────────────────────────────────────────────────────

def test_a_repeat_after_a_short_pause_and_a_soft_decay_is_a_labeled_repeat(tmp_path, monkeypatch):
    """'press the red button now' twice, 0.2 s of room between, the first ending in a 0.12 s decay at -52: FINISH v5
    takes back the fix pass's take-span widening, so the decay is no sound to the take rules, the pause is 0.32 s, a
    break, and the clear back-to-back repeat is labeled repeat? again (deleting its words keeps the last saying), as on
    50258c43."""
    toks = "press the red button now".split()
    tones, t = [], 0.3
    for k in range(5):
        tones.append((round(t, 3), round(t + 0.25, 3), SP))
        t += 0.30
    tones.append((tones[-1][1], round(tones[-1][1] + 0.12, 3), -52.0))
    t = tones[-1][1] + 0.2
    for k in range(5):
        tones.append((round(t, 3), round(t + 0.25, 3), SP))
        t += 0.30
    heads = tones[:5] + tones[6:]
    words = [(tok + ("." if k == 9 else ""), heads[k][0], heads[k + 1][0] if k + 1 < 10 else heads[k][1])
             for k, tok in enumerate(toks + toks)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, t + 1.0, words)], room=-75.0)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    assert plan["labels"] == {"repeat?": 1}, text
    edited = re.sub(r"press the red button now \{[\d.]+\} (?=press the red button now\.)", "", text, count=1)
    assert edited != text, text
    apply_text(d, monkeypatch, edited)
    said_ = said(d)
    assert " ".join(said_) == "press the red button now.", said_


def test_a_paraphrase_in_one_line_across_a_pause_plays_both(tmp_path, monkeypatch):
    a, b = "pedal harder on climbs".split(), "on hills you pedal harder.".split()
    tones, t = [], 0.3
    for _ in a:
        tones.append((round(t, 3), round(t + 0.25, 3), SP))
        t += 0.30
    t += 0.45
    for _ in b:
        tones.append((round(t, 3), round(t + 0.25, 3), SP))
        t += 0.30
    toks = a + b
    words = [(tok, tones[k][0], tones[k + 1][0] if k + 1 < len(tones) else tones[k][1]) for k, tok in enumerate(toks)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, t + 1.0, words)], room=-75.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert said_ == toks, said_


# ── review B (layer 1 and the checks) ──────────────────────────────────────────────────────────────────────

def test_a_filler_between_two_pauses_leaves_no_long_flat_across_the_joint(tmp_path, monkeypatch):
    """L-B1: 'so then [0.40] um [0.40] we went.' Removing 'um' joins two 0.40 pauses: the joined timeline holds no
    flat run over max-pause."""
    tones = [(0.30, 0.55, SP), (0.60, 0.85, SP), (1.25, 1.45, SP), (1.85, 2.10, SP), (2.15, 2.40, SP)]
    words = [("so", 0.30, 0.60), ("then", 0.60, 1.25), ("um", 1.25, 1.85), ("we", 1.85, 2.15), ("went.", 2.15, 2.40)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 3.1, words)])
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert "um" not in said_
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones, [0, 1, 3, 4]))


@pytest.mark.parametrize("smack_db", [-40.0, -45.0])
def test_a_lip_smack_alone_in_a_long_pause_is_dropped_and_named(tmp_path, monkeypatch, smack_db):
    """L-B4: a 30 ms smack alone in a 1.5 s pause between sentences is no 0.35 s dead clip: dropped. §577 cut voice: a
    smack cut off from any voice is silence for layer 1, so no wordless piece is left to drop or name (the warning
    names one only when the voice check is off, as for media it cannot read)."""
    tones = [(0.30, 0.55, SP), (0.60, 0.85, SP), (2.45, 2.70, SP), (2.75, 3.00, SP)]
    words = [("we", 0.30, 0.60), ("left.", 0.60, 0.85), ("then", 2.45, 2.75), ("home.", 2.75, 3.00)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 3.7, words)], room=-70.0,
                   bursts={"vo": [(1.60, 1.63, smack_db)]})
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert not [(a, b) for a, b in tc.kept_iv(d) if b <= 2.40 and a >= 0.90], tc.kept_iv(d)
    assert not any("no word" in w for w in plan.get("warnings", [])), plan.get("warnings")
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones))


def test_a_laugh_touching_kept_speech_stays(tmp_path, monkeypatch):
    """L-B4's limit: a short wordless sound right against a kept word (an 'mm', a laugh) is no lone piece: it plays."""
    tones = [(0.30, 0.55, SP), (0.60, 0.85, SP), (0.90, 1.10, -30.0), (2.45, 2.70, SP), (2.75, 3.00, SP)]
    words = [("we", 0.30, 0.60), ("left.", 0.60, 0.88), ("then", 2.45, 2.75), ("home.", 2.75, 3.00)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 3.7, words)], room=-70.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert v5.cover(d, 0.90, 1.10) > 0.99, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones))


def test_a_smack_train_under_a_stretched_word_keeps_no_long_flat(tmp_path, monkeypatch):
    """L-B2: 'the' stretched over 2 s holding only 20 ms smacks at -49 (36 dB under): no flat run over max-pause on
    flat.py's own terms (the check has no exemption)."""
    tones = [(0.30, 0.60, -13.0), (0.65, 0.95, -13.0), (3.05, 3.35, -13.0), (3.40, 3.70, -13.0)]
    words = [("this", 0.30, 0.65), ("is", 0.65, 0.95), ("the", 0.95, 3.05), ("bike", 3.05, 3.40), ("now.", 3.40, 3.70)]
    smacks = [(round(1.0 + 0.3 * k, 2), round(1.02 + 0.3 * k, 2), -49.0) for k in range(7)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 4.4, words)], room=-72.0, bursts={"vo": smacks})
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones))


@pytest.mark.parametrize("pause", [8.0, 14.0])
def test_a_long_silent_ride_between_two_lines_is_cut(tmp_path, monkeypatch, pause):
    """L-B5: under 5% speech, the plain 95th-percentile frame is the room; the gated level reads the speech. (Review
    B's 30 s case is six words in 32 s, which the b-roll rule keeps whole, warned: see the 6-word lines below.)"""
    a = [(0.30, 0.55, SP), (0.60, 0.85, SP), (0.90, 1.15, SP)]
    t2 = 1.15 + pause
    b = [(t2, t2 + 0.25, SP), (t2 + 0.30, t2 + 0.55, SP), (t2 + 0.60, t2 + 0.85, SP)]
    words = [("here", 0.30, 0.60), ("we", 0.60, 0.90), ("go.", 0.90, t2 - 0.5), ("and", t2, t2 + 0.30),
             ("we're", t2 + 0.30, t2 + 0.60), ("back.", t2 + 0.60, t2 + 0.85)]
    d = v5.project(tmp_path, monkeypatch, [("vo", a + b, t2 + 1.5, words)], room=-62.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert sum(y - x for x, y in tc.kept_iv(d)) < 3.0, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", a + b))


@pytest.mark.parametrize("pause", [20.0, 30.0])
def test_under_five_percent_speech_still_cuts_the_long_pause(tmp_path, monkeypatch, pause):
    """Review B's probe 4b: two 6-word lines (speech by cut's own rule, not b-roll) 20-30 s apart, the first's last
    word stretched over the ride."""
    def said_line(t0, toks):
        tones, words, t = [], [], t0
        for w in toks:
            tones.append((round(t, 3), round(t + 0.12, 3), SP))
            words.append((w, round(t, 3), round(t + 0.15, 3)))
            t += 0.15
        return tones, words, t
    ta, wa, ea = said_line(0.3, ["ok", "so", "here", "we", "go", "now."])
    tb, wb, eb = said_line(ea + pause, ["and", "now", "we", "are", "back", "home."])
    wa[-1] = (wa[-1][0], wa[-1][1], tb[0][0] - 0.3)
    d = v5.project(tmp_path, monkeypatch, [("vo", ta + tb, eb + 1.0, wa + wb)], room=-62.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert sum(y - x for x, y in tc.kept_iv(d)) < 3.5, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", ta + tb))


def test_the_gated_speech_level():
    room = [-62.0] * 3000
    speech = [-20.0] * 60
    assert waveform_trim.speech_level(room + speech) == pytest.approx(-20.0)
    assert waveform_trim.speech_level([-62.0] * 100 + [-20.0] * 100) == pytest.approx(-20.0)
    assert waveform_trim.speech_level(room + [-20.0] * 40) == pytest.approx(-62.0)     # under 50 gated frames


def test_a_source_of_digital_silence_is_all_flat():
    lay = se.layer1(__file__, [-120.0] * 200, 0.45)
    assert all(lay.flat) and lay.voiced == []


@pytest.mark.parametrize("room", [-48.0, -52.0])
def test_a_room_near_the_line_is_warned(tmp_path, monkeypatch, room):
    """Should-fix 2: a gusty room within 33 dB of the speech: its pauses can't be trimmed, and the plan says so."""
    tones = [(0.30, 0.55, SP), (0.60, 0.85, SP), (2.85, 3.10, SP), (3.15, 3.40, SP)]
    words = [("we", 0.30, 0.60), ("stop.", 0.60, 0.85), ("and", 2.85, 3.15), ("go.", 3.15, 3.40)]
    gusts = [(round(0.9 + 0.25 * k, 2), round(0.96 + 0.25 * k, 2), room + 6) for k in range(8)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 4.1, words)], room=room, bursts={"vo": gusts})
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    assert any("room" in w and "loud" in w for w in plan.get("warnings", [])), plan.get("warnings")


def stereo_media(path, total, room_db, tones, rate=16000, invert=False, seed=3):
    rnd = np.random.default_rng(seed)
    n = int(total * rate)
    t = np.arange(n) / rate
    s = np.zeros(n)
    for t0, t1, db in tones:
        k0, k1 = int(t0 * rate), min(n, int(t1 * rate))
        s[k0:k1] += np.sin(2 * np.pi * 220 * t[k0:k1]) * 10 ** (db / 20) * math.sqrt(2)
    amp = 10 ** (room_db / 20) * math.sqrt(3)
    x = np.stack([s + rnd.uniform(-1, 1, n) * amp, (-s if invert else s) + rnd.uniform(-1, 1, n) * amp], axis=1)
    pcm = np.clip(np.round(x * 32767), -32767, 32767).astype("<i2")
    wav = Path(str(path) + ".wav")
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=black:s=64x64:r=30:d={total}",
                    "-i", str(wav), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest",
                    str(path)], check=True, capture_output=True)
    wav.unlink()


@pytest.mark.parametrize("room", [-47.0, -49.0])
def test_stereo_engine_and_check_read_the_same_frames(tmp_path, monkeypatch, room):
    """Should-fix 1: one envelope (the louder channel) for the engine and the checks."""
    tones = [(0.30, 0.55, SP), (0.60, 0.85, SP), (2.85, 3.10, SP), (3.15, 3.40, SP)]
    words = [("we", 0.30, 0.60), ("stop.", 0.60, 2.85), ("and", 2.85, 3.15), ("go.", 3.15, 3.40)]
    monkeypatch.setattr(tc, "tone_media", lambda path, sp, total: stereo_media(path, total, room, sp))
    d = tc.tone_project(tmp_path, [("vo", tones, 4.1, words)])
    env = se.envelope(str(d / "vo.mov"))
    db, ref = cut_checks.frames_db(str(d / "vo.mov"))
    assert list(db) == env and ref == waveform_trim.speech_level(env)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones))


def test_a_phase_inverted_stereo_pause_is_seen_by_the_check(tmp_path, monkeypatch):
    tones = [(0.30, 0.55, SP), (0.60, 0.85, SP), (2.85, 3.10, SP), (3.15, 3.40, SP)]
    words = [("we", 0.30, 0.60), ("stop.", 0.60, 2.85), ("and", 2.85, 3.15), ("go.", 3.15, 3.40)]
    monkeypatch.setattr(tc, "tone_media", lambda path, sp, total: stereo_media(path, total, -70.0, sp, invert=True))
    d = tc.tone_project(tmp_path, [("vo", tones, 4.1, words)])
    p = json.loads((d / "project.json").read_text())
    p["tracks"][0]["items"][0].update(inPoint=0.0, outPoint=4.1, start=0.0, end=4.1)
    (d / "project.json").write_text(json.dumps(p))
    assert cut_checks.flat_report(d)["over_max_pause"] >= 1


@pytest.mark.parametrize("rate", [8000, 22050, 44100, 48000])
def test_sample_rates_read_the_same_frames(tmp_path, rate):
    p = tmp_path / "a.mov"
    v5.media(p, 3.7333, -60.0, [(0.303, 0.551, SP), (0.6, 0.85, SP), (2.85, 3.1, SP)], rate=rate)
    env = se.envelope(str(p))
    db, ref = cut_checks.frames_db(str(p))
    assert list(db) == env and ref == waveform_trim.speech_level(env)


def test_clipped_loud_speech(tmp_path, monkeypatch):
    tones = [(0.30, 0.55, 3.0), (0.60, 0.85, 3.0), (2.85, 3.10, 3.0), (3.15, 3.40, 3.0)]
    words = [("we", 0.30, 0.60), ("stop.", 0.60, 2.85), ("and", 2.85, 3.15), ("go.", 3.15, 3.40)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 4.1, words)], room=-40.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert said_ == ["we", "stop.", "and", "go."]
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones))


# ── v5a: attached words keep only their own burst; every flat run is capped; islands strictly 0.35 s ──────────

def test_an_attached_word_over_room_noise_keeps_no_stretched_room(tmp_path, monkeypatch):
    """kungfu's shape: speech -18, room -58 (40 dB under: the old attached line sat at the room). A word stretched over
    1.5 s of room, between kept words, keeps at most its own burst (here none: under the attached line and the guard,
    so it is inaudible and goes), and the joined timeline no flat run over 0.45."""
    tones = [(0.30, 0.60, -18.0), (0.65, 0.95, -18.0), (1.60, 1.80, -50.0), (2.80, 3.10, -18.0), (3.15, 3.45, -18.0)]
    words = [("this", 0.30, 0.65), ("is", 0.65, 1.10), ("so", 1.10, 2.60), ("very", 2.80, 3.15), ("good.", 3.15, 3.45)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 4.2, words)], room=-58.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert said_ == ["this", "is", "very", "good."], (said_, text)
    assert v5.cover(d, 1.10, 2.60) * 1.5 <= 0.45, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones))


@pytest.mark.parametrize("dur", [0.03, 0.12, 0.2, 0.34])
def test_islands_are_strictly_at_least_0_35_s(dur):
    from lib.speech_lines import Word
    env = [-70.0] * 400
    for k in list(range(20, 50)) + list(range(150, 150 + int(round(dur * 100)))) + list(range(330, 360)):
        env[k] = SP
    ws = [Word(0, "a", "a", 0.2, 0.5), Word(1, "I", "i", 1.5, 1.5 + dur), Word(2, "b.", "b", 3.3, 3.6)]
    ref = se.Refiner(0.45)
    lay = se.layer1(__file__, env, 0.45)
    placed, kind = se.place(ws, lay, ref.breath)
    ref.layers["a"], ref.raw["a"], ref.placed["a"], ref.kinds["a"] = lay, ws, placed, kind
    assert all(b - a >= 0.35 for a, b in ref.keeps("a")), ref.keeps("a")


# ── should-fix 4: the apply uses the plan's max-pause and breath, or refuses ───────────────────────────────────

def test_an_apply_with_another_max_pause_or_breath_is_stale(tmp_path, monkeypatch, capsys):
    tones, words, total = line("we went home", "after the show.")
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, total, words)], room=-75.0)
    plan, _ = plan_only(d, monkeypatch)
    assert tc.refused(d, "--plan", plan["plan"], "--max-pause", "0.3", monkeypatch=monkeypatch, capsys=capsys) == \
        "stale_plan"
    assert tc.refused(d, "--plan", plan["plan"], "--breath", "0.1", monkeypatch=monkeypatch, capsys=capsys) == \
        "stale_plan"
    applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert applied["mode"] == "applied"


def test_the_stamp_names_the_reading_constants():
    for name in ("RATE", "_SILENT_DB", "GUARD_DB", "BURST_GAP_S", "ISLAND_TARGET_S", "ATTACHED_OVER_ROOM_DB"):
        assert f"{name}=" in se.Refiner.stamp, name


# ── FINISH v5 (Sam, 2026-10-25) ─────────────────────────────────────────────────────────────────────────────

THRICE_COMMON = "zan pol rik mev tor sul gax fen".split()
THRICE_TAILS = [["lun", "bar"], ["dop"], ["kir", "vam", "sul", "tep."]]


def thrice():
    """The real case's shape, invented words: a clause of about 11 words at -9..-18 dB said three times back to back,
    whisper gapless; in sayings 1 and 2 its last common word ('overmanticles', 13 letters) is soft (peak -48.8, the
    room -72, the speech level about -13) and whisper stretches it 0.93 s and 1.10 s over a silence; each saying
    differs only in its tail."""
    lv = [-9.0, -12.0, -15.0, -18.0, -11.0, -14.0, -17.0, -10.0]
    tones, words, t = [], [], 0.4
    for k in range(3):
        seq = [(w, 0.22, lv[n]) for n, w in enumerate(THRICE_COMMON)]
        seq.append(("overmanticles", 0.3 if k < 2 else 0.4, -48.8 if k < 2 else -13.0))
        seq += [(w, 0.22, -13.0) for w in THRICE_TAILS[k]]
        for w, dur, db in seq:
            st = t
            tones.append((round(st, 3), round(st + dur, 3), db))
            words.append([w, round(st, 3), None])
            t = st + (0.93 if k == 0 else 1.10) if (w == "overmanticles" and k < 2) else st + dur + 0.04
    for k in range(len(words)):
        words[k][2] = words[k + 1][1] if k + 1 < len(words) else tones[k][1]
    return tones, [tuple(w) for w in words], t + 0.8


def test_a_clause_said_three_times_with_a_soft_stretched_word_is_only_labeled(tmp_path, monkeypatch):
    """Only labels (retake? or repeat?), and the unedited plan applies all three sayings (the take rules read the
    placed spans, never widened over soft frames)."""
    tones, words, end = thrice()
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, end, words)], room=-72.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    assert set(plan["labels"]) <= {"retake?", "repeat?"}, plan["labels"]
    assert said_.count("zan") == 3 and said_[-1] == "tep.", (said_, text)


def test_a_quiet_rooms_soft_first_and_last_words_leave_no_long_lead_or_tail(tmp_path, monkeypatch):
    """pov's lead and tail: a quiet room (-72), the first and last whisper words stretched over silence with only
    faint sound under them (-55..-66, under the -46 guard): never protected, so the video opens and ends within
    0.1 s of the speech, and no flat run over max-pause stays."""
    tones = [(0.50, 0.70, -60.0), (0.95, 1.05, -66.0), (1.60, 1.90, -13.0), (1.95, 2.25, -12.0), (2.30, 2.60, -14.0),
             (2.65, 2.95, -13.0), (3.40, 3.60, -55.0), (3.90, 4.00, -64.0)]
    words = [("so", 0.30, 1.60), ("we", 1.60, 1.95), ("went", 1.95, 2.30), ("out", 2.30, 2.65), ("today", 2.65, 3.00),
             ("okay.", 3.00, 4.40)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 5.0, words)], room=-72.0)
    plan, text, applied, said_, before = v5.plan_apply(d, monkeypatch)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones[2:6]))
    iv = tc.kept_iv(d)
    assert iv[0][0] >= 1.60 - 0.10 - 1e-6 and iv[-1][1] <= 2.95 + 0.10 + 1e-6, iv


@pytest.mark.parametrize("transcript", ["retake", "plain"])
def test_the_fixtures_applied_cut_passes_the_raw_flat_check_too(tmp_path, stub_transcribe, monkeypatch, transcript):  # noqa: F811
    """09 and the orchestrator: flat.py v2's raw definition (no burst counted as sound) on the fixture's applied cut
    flags no run over max-pause but one that holds a word the -46 guard hears (fix pass: 0.83 s at source 22.24), and
    cut_checks agrees."""
    stub_transcribe(tc.retake_transcript() if transcript == "retake" else tc.real_transcript())
    d = tc.make_project(tmp_path)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert not cut_checks.raw_runs(d), cut_checks.raw_runs(d)
    assert not cut_checks.flat_report(d)["runs"]
