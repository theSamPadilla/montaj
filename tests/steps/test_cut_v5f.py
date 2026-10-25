"""§577 cut, the review of b6aa796e (lib/speech_repair), its probes ported: synthetic tones, invented words, whisper's
second run stubbed (tests/steps/test_cut_v5e.whisper_hears). What they hold:
- B1: a phrase whisper's first run wrote twice (a loop) and the second run hears once: the copy with no sound is the
  EARLIER saying, so the retake rule keeps the real one;
- B2: the merge reaches three good words each side, so a neighbour stamped late or early takes the new time and is
  never added a second time;
- B3: the refiner's stamp carries the repaired words, so a plan and an apply that read different words are stale;
- a corrupt cache, a raising or malformed second run, a clean transcript, short tokens, music and a 30 min take."""
import json
import os
import re
import shutil

import pytest

from lib import speech_energy as se
from lib import speech_repair as sr
from lib.speech_lines import Word
from tests import cut_checks
from tests.steps import test_cut as tc
from tests.steps import test_cut_v5 as v5
from tests.steps import test_cut_v5e as e
import steps.edit.cut as cc

ROOM = -57.0
said_on = e.said_on
_fresh_cache = e._fresh_cache          # each test its own temp folder (autouse)

S1 = "we start the demo now.".split()
S2 = "and then a small box passes those commands on.".split()
S4 = "the team described this as telepresence.".split()
S5 = "it works really well.".split()
S6 = "and that is how the whole thing came together for all of us in the end.".split()


def lost(d, script):
    return [w for w, x, y, _ in script if v5.cover(d, x, y) < 0.5]


def tones(script):
    return [(x, y, db) for _, x, y, db in script]


# ── B1: whisper's loop ───────────────────────────────────────────────────────────────────────────────────────────

def loop_case():
    a, _ = said_on(0.5, S1)
    b, _ = said_on(4.0, S4)
    c, t = said_on(7.0, S5)
    g, end = said_on(t + 0.8, S6)
    script = a + b + c + g
    words = [(w, x, round(y + 0.04, 3)) for w, x, y, _ in a]
    words += [(w, 2.40, 2.40) for w in S4[:5]] * 2              # 'the team described this as' twice, collapsed
    words += [(w, x, round(y + 0.04, 3)) for w, x, y, _ in b[5:]]
    words += [(w, x, round(y + 0.04, 3)) for w, x, y, _ in c + g]
    return script, words, round(end + 0.8, 2)


def test_a_looped_phrase_keeps_the_real_saying(tmp_path, monkeypatch):
    script, words, end = loop_case()
    e.stubbed(monkeypatch, script)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones(script), end, words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == S1 + S4 + S5 + S6, (said, text)
    assert lost(d, script) == [], tc.kept_iv(d)
    # the removed saying is the copy with no sound, before the real one
    raw = __import__("lib.speech_lines", fromlist=["load_words"]).load_words(str(d / "vo.json"))
    ref = se.Refiner(0.45, retranscribe=cut_checks.RETRANSCRIBE, retranscribe_tag="en")
    ref("vo", str(d / "vo.mov"), raw)
    texts = [w.text for w in ref.raw["vo"]]
    first = len(S1)
    assert texts[first:first + 10] == S4[:5] * 2, texts
    assert all(w.end - w.start < 0.03 for w in ref.raw["vo"][first:first + 5]), ref.raw["vo"][first:first + 10]


def test_a_looped_phrase_with_no_second_run_loses_no_sound(tmp_path, monkeypatch):
    script, words, end = loop_case()
    d = v5.project(tmp_path, monkeypatch, [("vo", tones(script), end, words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert lost(d, script) == [], tc.kept_iv(d)


# ── B2: a neighbour stamped late or early ─────────────────────────────────────────────────────────────────────

def drift_case(late=0.6, gap=0.2):
    a, _ = said_on(0.5, S1)
    b, t = said_on(4.0, S2)
    c, t2 = said_on(t + gap - 0.04, S4)
    f, end = said_on(t2 + 1.0, S5)
    script = a + b + c + f
    words = [(w, x, round(y + 0.04, 3)) for w, x, y, _ in a]
    words += [(w, 2.40, 2.40) for w in S2]
    words += [(w, round(x + late, 3), round(y + late + 0.04, 3)) for w, x, y, _ in c]
    words += [(w, x, round(y + 0.04, 3)) for w, x, y, _ in f]
    return script, words, round(end + 0.8, 2)


@pytest.mark.parametrize("late", [0.0, 0.35, 0.6, 0.9])
def test_a_late_neighbour_is_never_added_twice(tmp_path, monkeypatch, late):
    script, words, end = drift_case(late)
    e.stubbed(monkeypatch, script)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones(script), end, words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == S1 + S2 + S4 + S5, (said, text)
    assert not re.search(r"\bthe team the team\b", text), text
    assert lost(d, script) == []
    v5.checked(d, plan, applied, before, [("vo", x, y) for _, x, y, _ in script])


def test_an_early_neighbour_before_is_never_added_twice(tmp_path, monkeypatch):
    a, t = said_on(0.5, S1)
    b, t2 = said_on(t + 0.16, S2)
    f, t3 = said_on(t2 + 1.0, S5)
    g, end = said_on(t3 + 0.8, S6)
    script = a + b + f + g
    words = [(w, round(x - 0.6, 3), round(y - 0.6, 3)) for w, x, y, _ in a]       # early, still voiced
    words += [(w, 2.40, 2.40) for w in S2]
    words += [(w, x, round(y + 0.04, 3)) for w, x, y, _ in f + g]
    e.stubbed(monkeypatch, script)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones(script), round(end + 0.8, 2), words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == S1 + S2 + S5 + S6, (said, text)
    assert text.count("demo now.") == 1, text
    assert lost(d, script) == []
    v5.checked(d, plan, applied, before, [("vo", x, y) for _, x, y, _ in script])


# ── B3: plan and apply read different words ───────────────────────────────────────────────────────────────────

def _drop_cache():
    folder = sr._cache_folder()
    if folder and os.path.isdir(folder):
        shutil.rmtree(os.path.dirname(folder))


def test_a_cache_gone_and_a_failing_second_run_at_the_apply_is_stale(tmp_path, monkeypatch, capsys):
    script, words, end = e.broken()
    e.stubbed(monkeypatch, script)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones(script), end, words)], room=ROOM)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    _drop_cache()
    monkeypatch.setattr(cc, "transcribe_file", tc._no_second_whisper(lambda *a, **k: None))
    assert tc.refused(d, "--plan", plan["plan"], monkeypatch=monkeypatch, capsys=capsys) == "stale_plan"


def test_a_plan_made_without_the_second_run_and_applied_with_it_is_stale(tmp_path, monkeypatch, capsys):
    script, words, end = e.broken()
    d = v5.project(tmp_path, monkeypatch, [("vo", tones(script), end, words)], room=ROOM)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    e.stubbed(monkeypatch, script)
    assert tc.refused(d, "--plan", plan["plan"], monkeypatch=monkeypatch, capsys=capsys) == "stale_plan"


def test_the_stamp_and_the_cache_key_name_the_repair_and_the_model():
    r = se.Refiner(0.45, retranscribe=lambda *a: None, retranscribe_tag="en|x")
    assert r.stamp != se.Refiner(0.45).stamp and sr.STAMP in r.stamp and se.Refiner.stamp == se.Refiner.STAMP
    assert sr._cache_key("/x.mov", [(1.0, 2.0)], "en|tiny") != sr._cache_key("/x.mov", [(1.0, 2.0)], "en|large")
    folder = sr._cache_folder()
    assert folder and oct(os.stat(folder).st_mode & 0o777) == "0o700"
    assert oct(os.stat(os.path.dirname(folder)).st_mode & 0o777) == "0o700"


@pytest.mark.parametrize("cache", ["kept", "gone_apply_fails"])
def test_a_loop_plan_applies_only_against_the_words_it_read(tmp_path, monkeypatch, capsys, cache):
    script, words, end = loop_case()
    e.stubbed(monkeypatch, script)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones(script), end, words)], room=ROOM)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    if cache == "kept":
        applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
        assert applied["mode"] == "applied" and lost(d, script) == [], tc.kept_iv(d)
    else:
        _drop_cache()
        monkeypatch.setattr(cc, "transcribe_file", tc._no_second_whisper(lambda *a, **k: None))
        assert tc.refused(d, "--plan", plan["plan"], monkeypatch=monkeypatch, capsys=capsys) == "stale_plan"


# ── failure paths ─────────────────────────────────────────────────────────────────────────────────────────────

OLD = [Word(0, "we", "we", 0.5, 0.8)] + [Word(1 + k, t, t, 2.0, 2.0) for k, t in enumerate(["get", "back", "up"])] + \
    [Word(4, "go.", "go", 9.0, 9.4)]


def _keeps_of(lay, words):
    """The keeps repair asks the second run for (its window's voiced runs, padded and joined)."""
    asked = []
    sr.repair(words, lay, "x.mov", lambda m, keeps: asked.append(list(keeps)) or None)
    return asked[0]


def test_a_corrupt_cache_entry_is_read_as_none(tmp_path):
    lay = e._lay([(0.5, 0.8), (4.0, 6.0), (9.0, 9.4)])
    keeps = _keeps_of(lay, OLD)
    folder = sr._cache_folder()
    for bad in ({"a": 1}, [["and", "x", 1.0]], [["and", 1.0]]):
        with open(os.path.join(folder, sr._cache_key("x.mov", keeps, "") + ".json"), "w") as f:
            json.dump(bad, f)
        out, rep = sr.repair(OLD, lay, "x.mov", lambda m, k: [("and", 4.0, 4.4)])
        assert [w.text for w in out][:2] == ["we", "and"] and "error" not in rep[0], (bad, out, rep)


def test_a_second_run_that_raises_or_writes_bad_json_changes_nothing(monkeypatch):
    lay = e._lay([(0.5, 0.8), (4.0, 6.0), (9.0, 9.4)])

    def boom(*a):
        raise RuntimeError("x")
    out, rep = sr.repair(OLD, lay, "x.mov", boom)
    assert [w.text for w in out] == [w.text for w in OLD] and rep[0]["error"], rep
    monkeypatch.setattr(cc, "transcribe_file", lambda spec, out, m, l: open(out + ".json", "w").write("{bad"))
    run = cc._retranscriber("tiny", "en")
    assert run("/m.mov", [(1, 2)]) is None and run.last_error, run.last_error
    monkeypatch.setattr(cc, "transcribe_file",
                        lambda spec, out, m, l: open(out + ".json", "w").write('{"transcription": []}'))
    run = cc._retranscriber("tiny", "es")
    assert run("/m.mov", [(1, 2)]) == [] and run.last_error == "whisper heard no words there"


def test_some_windows_failing_are_named_beside_the_ones_transcribed_again(tmp_path, monkeypatch):
    """Two broken windows, the second run failing on one: the answer names both."""
    script, words, end = e.broken()
    shift = end + 1.0
    script2 = script + [(w, round(x + shift, 3), round(y + shift, 3), db) for w, x, y, db in script]
    words2 = words + [(w, round(x + shift, 3), round(y + shift, 3)) for w, x, y in words]
    fake, calls = e.whisper_hears(script2)

    def flaky(input_path, out=None, model=None, language="en", **kw):
        if json.loads(open(input_path).read())["keeps"][0][0] > shift:
            cc.fail("whisper_failed", "stub: second window fails")
        return fake(input_path, out, model, language)
    monkeypatch.setattr(cc, "transcribe_file", flaky)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones(script2), round(2 * end + 1.0, 2), words2)], room=ROOM)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    w = " | ".join(plan.get("warnings", []))
    assert "transcribed 1 stretch(es) again" in w and "1 more could not be" in w and "transcribing it again failed" in w, w


# ── detection and cost ────────────────────────────────────────────────────────────────────────────────────────

def test_clean_fast_speech_and_short_tokens_are_never_broken():
    lay = e._lay([(0.5, 10.0)], 12.0)
    ws = [Word(k, "a", "a", 0.5 + 0.12 * k, 0.62 + 0.12 * k) for k in range(70)]
    assert sr.stretches(ws, lay) == []
    ws2 = ws[:10] + [Word(10 + k, t, t, 1.8 + 0.02 * k, 1.82 + 0.02 * k) for k, t in enumerate("1 2 3".split())] + \
        [Word(13 + k, "a", "a", 1.9 + 0.12 * k, 2.02 + 0.12 * k) for k in range(20)]
    assert sr.stretches(ws2, lay) == []


def test_words_a_second_run_hears_over_music_are_never_added():
    """Zero-length lyrics over 15 s of music: the window is found, but what the second run hears there does not read
    as speech (made-up words: long ones), so nothing is added and the answer names it."""
    lay = e._lay([(0.5, 2.0), (3.0, 20.0)], 22.0)
    wm = [Word(0, "hi", "hi", 0.5, 0.9), Word(1, "there.", "there", 1.0, 1.9)] + \
        [Word(2 + k, "la", "la", 5.0, 5.0) for k in range(3)] + [Word(5, "bye.", "bye", 19.0, 19.5)]
    assert sr.stretches(wm, lay)
    out, rep = sr.repair(wm, lay, "m.mov", lambda m, k: [("oh", 3.0, 6.0), ("baby", 6.0, 10.0), ("yeah", 10.0, 14.0)])
    assert [w.text for w in out] == [w.text for w in wm] and "music" in rep[0]["error"], rep


def test_a_take_broken_throughout_costs_one_whisper_run_a_window():
    runs = [(3.0 * k + 0.25, 3.0 * k + 2.75) for k in range(600)]
    lay = e._lay(runs, 1801.0)
    w30 = [Word(0, "hi", "hi", 0.25, 0.6)] + [Word(1 + k, "w", "w", 1.0, 1.0) for k in range(4000)] + \
        [Word(4001, "end.", "end", 1797.25, 1797.6)]
    calls = []
    sr.repair(w30, lay, "x.mov", lambda m, keeps: calls.append(len(keeps)) or None)
    assert len(calls) == len(sr.stretches(w30, lay)) == 1, calls


# ── ucla B88: first-run words kept in the middle of a new sentence, on one instant with a removed word ────────────

B2 = "a small computer underneath passes those commands to the actual robot motors.".split()
B3 = "it can follow you get back up on its own and even walk around the room. the team describe this as".split()
B4 = "telepresence basically a videophone.".split()


def b88(at=0.0):
    """The real B shape (the dump of B 88), invented sound. S1 on its sound; B2 said at 5.0; B4 on its own sound at
    10.5. Whisper's first run leaves B2 out and writes B3 over its place: 'it can follow ... and' over 2.0-4.6 in the
    silence, 'even walk around' collapsed to no length, 'the' stretched over B2's onset, 'room. the team' collapsed,
    'describe' stretched over B2's sound and the silence after it, 'this as' in that silence. B3's real sound is later, past the
    window (here never said: its words have no sound to take). The second run hears B2, whose 'to' and 'the' match
    first-run words by chance."""
    a, _ = said_on(0.5 + at, S1)
    b, _ = said_on(5.0 + at, B2)
    c, end = said_on(10.5 + at, B4)
    script = a + b + c
    words = [(w, x, round(y + 0.04, 3)) for w, x, y, _ in a]
    words += [(w, round(2.0 + at + 0.24 * k, 3), round(2.24 + at + 0.24 * k, 3)) for k, w in enumerate(B3[:11])]
    t = round(4.7 + at, 3)
    words += [(w, t, t) for w in ("even", "walk", "around")]
    words += [("the", t, round(6.3 + at, 3))]                    # stretched over B2's onset
    t = round(6.3 + at, 3)
    words += [(w, t, t) for w in ("room.", "the", "team")]
    words += [("describe", t, round(9.6 + at, 3)), ("this", round(9.6 + at, 3), round(9.9 + at, 3)),
              ("as", round(9.9 + at, 3), round(10.2 + at, 3))]
    words += [(w, x, round(y + 0.04, 3)) for w, x, y, _ in c]
    return script, words, round(end + 0.8, 2)


def test_ucla_b88_plans_and_plays_what_it_says(tmp_path, monkeypatch):
    """The plan is written and plan equals apply: no first-run word kept in the middle of B2 on one instant with a
    removed word; B2 plays whole."""
    script, words, end = b88()
    e.stubbed(monkeypatch, script)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones(script), end, words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert all(v5.cover(d, x, y) > 0.99 for _, x, y, _ in script[len(S1):len(S1) + len(B2)]), tc.kept_iv(d)
    assert " ".join(B2) in " ".join(said), said
    v5.checked(d, plan, applied, before, [("vo", x, y) for _, x, y, _ in script])


def test_a_repair_and_a_later_loop_in_one_take_cross_their_indexes(tmp_path, monkeypatch):
    """The orchestrator's case: a stretch repaired early in the take (words added: every later index moves) and a
    whisper loop in a later stretch (its phantom copy), with the B88 shape after both. The plan is written, plan
    equals apply, and each stretch's report names its own phantoms."""
    s1, w1, end1 = e.broken()
    s2, w2, end2 = loop_case()
    sh = end1 + 0.5
    s3, w3, end3 = b88(at=sh + end2 + 0.5)
    script = s1 + [(w, round(x + sh, 3), round(y + sh, 3), db) for w, x, y, db in s2] + s3
    words = w1 + [(w, round(x + sh, 3), round(y + sh, 3)) for w, x, y in w2] + w3
    e.stubbed(monkeypatch, script)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones(script), end3, words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert applied["mode"] == "applied"
    from lib.speech_lines import load_words
    ref = se.Refiner(0.45, retranscribe=cut_checks.RETRANSCRIBE, retranscribe_tag="en")
    ref("vo", str(d / "vo.mov"), load_words(str(d / "vo.json")))
    rep = ref.repaired["vo"]
    assert len(rep) >= 3 and all("error" not in r for r in rep), rep
    for r in rep:                       # each stretch's phantoms lie in its own part of the merged words
        lo = min((x["phantom"][0] for x in rep if x["phantom"] and x["words"][0] > r["words"][0]), default=1e9)
        assert all(p < lo for p in r["phantom"]), rep
    assert rep[1]["phantom"], rep       # the loop's copy


def test_words_of_no_length_never_share_an_instant():
    """B88's refusal: a kept word of no length on the instant a removed word starts put the cut on the kept one,
    which then played on neither side. place() gives every word INAUDIBLE_S at least, in order."""
    lay = e._lay([(0.5, 2.0)], 4.0)
    ws = [Word(0, "we", "we", 0.5, 1.0), Word(1, "go", "go", 1.0, 1.5)] + \
        [Word(2 + k, t, t, 1.5, 1.5) for k, t in enumerate(["room.", "the", "team"])] + [Word(5, "now.", "now", 1.5, 2.0)]
    placed, kind = se.place(ws, lay)
    zero = [p for p in placed[2:5]]
    assert len({round(p.start, 6) for p in zero}) == 3, placed
    assert all(a.end <= b.start + 1e-9 for a, b in zip(placed, placed[1:])), placed
    assert all(p.end - p.start >= se.INAUDIBLE_S - 1e-9 for p in placed), placed


# ── ucla B, real3 v9: a run left in silence whose sound is under a later saying's words ────────────────────────────

X = "it can follow you get back up".split()
T1 = "the team described this as".split()
T2 = "the team described this as telepresence.".split()


def misplaced(off=0.0):
    """S1 on its sound; B2 said at 5.0 (whisper's first run leaves it out); X said at 10.5; T1 (a retake of T2) at
    13.0; T2 at 16.0. The first run writes X over 2.0-4.5 in the silence, then T1's words ON X's sound (10.5-12.0:
    the wrong words, on sound, so no stretch shows there), and T2 on its own sound. The repair hears B2 between S1 and
    T1; X stays in silence; the clear retake then removes T1's row, standing on X's sound."""
    a, _ = said_on(0.5, S1)
    b, _ = said_on(5.0, B2)
    x, _ = said_on(10.5, X)
    t1, _ = said_on(13.0, T1)
    t2, end = said_on(16.0, T2)
    script = a + b + x + t1 + t2
    words = [(w, xx, round(y + 0.04, 3)) for w, xx, y, _ in a]
    words += [(w, round(2.0 + 0.36 * k, 3), round(2.36 + 0.36 * k, 3)) for k, w in enumerate(X)]
    words += [(w, round(10.5 + 0.3 * k, 3), round(10.8 + 0.3 * k, 3)) for k, w in enumerate(T1)]
    words += [(w, round(xx + off, 3), round(y + off + 0.04, 3)) for w, xx, y, _ in t2]   # off: T2's first-run drift
    return script, words, round(end + off + 0.8, 2)


@pytest.mark.parametrize("off", [0.0, 1.5, 3.0])
def test_words_left_in_silence_take_their_sound_from_under_a_later_saying(tmp_path, monkeypatch, off):
    """After the repair, X's words are looked for past the repaired window (one more whisper run, up to an anchor:
    T2 where the first run put it; with T2's first-run times off by 1.5 or 3 s there is no such anchor, and the
    whole window is merged, the second run hearing T2 after X in order). X takes its sound, T1 takes its own, and
    the clear retake removes only T1's audio: no word lost."""
    script, words, end = misplaced(off)
    calls = e.stubbed(monkeypatch, script)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones(script), end, words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == S1 + B2 + X + T2, (said, text)
    xs = script[len(S1) + len(B2):len(S1) + len(B2) + len(X)]
    t1s = script[len(S1) + len(B2) + len(X):len(S1) + len(B2) + len(X) + len(T1)]
    assert all(v5.cover(d, xx, y) > 0.99 for _, xx, y, _ in xs), tc.kept_iv(d)
    assert all(v5.cover(d, xx + 0.01, y - 0.01) < 0.02 for _, xx, y, _ in t1s), tc.kept_iv(d)
    assert len(calls) == 2, calls                       # the repair, then one extension
    w = " | ".join(plan.get("warnings", []))
    assert "found 4 word(s) left in silence again past 10.5 s" in w, w      # X[:3] the repair already heard
    v5.checked(d, plan, applied, before, [("vo", t[1], t[2]) for t in script if t not in t1s])


def test_an_extension_with_no_anchor_moves_nothing_and_says_so():
    """The second run past the window never comes back to where the first run put its words: nothing moves."""
    lay = e._lay([(0.5, 2.0), (5.0, 8.9), (10.5, 12.6)], 16.0)
    ws = [Word(0, "we", "we", 0.5, 1.0), Word(1, "go.", "go", 1.0, 2.0)] + \
        [Word(2 + k, t, t, 2.1 + 0.4 * k, 2.5 + 0.4 * k) for k, t in enumerate(["zin", "zan", "zon", "zun", "zen", "zyn"])] + \
        [Word(8, "the", "the", 10.5, 10.8), Word(9, "end.", "end", 10.8, 11.1)]

    def again(media, keeps):
        if keeps[0][0] < 5.0:
            return [("a", 5.0, 5.3), ("box", 5.4, 5.7), ("is", 5.8, 6.1), ("here.", 6.2, 6.5)]
        return [("zin", 10.5, 10.8), ("zan", 10.9, 11.2), ("off", 11.3, 11.6)]
    out, rep = sr.repair(ws, lay, "x.mov", again)
    ext = rep[0].get("extension")
    assert ext and ext["error"].startswith("no anchor"), rep
    assert [w.text for w in out][-2:] == ["the", "end."], out
