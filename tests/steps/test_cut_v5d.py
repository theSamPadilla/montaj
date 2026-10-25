"""§577 cut, the review of 6f7af80c and the kungfu refusal: the opus reviewer's probes ported (synthetic tones,
invented words), the real clip that refused itself replayed from its layer-1 dump with invented words, a drift fuzz with
repeated clauses and fillers, and a 30-minute timing check. Decisions they hold (2026-10-25):
- a run `_chain` places is FOLDED: kept in the text, offered inaudible?, folded inside a breath, so removing it cuts no
  voiced audio; the free sound it found plays as the heard word's beside it on the same voiced run;
- never a filler in a chain, nor in the zero-stamp share; at a source's end, (a) and the chain need TAIL_FREE_S of free
  sound a word (a made-up tail over a click stays inaudible);
- a sliver the apply drops is dropped in the plan too, tagged inaudible? when its whisper span holds sound;
- a run of inaudible words parked in the breath of the sound before them that repeats two words in a row of its line
  opens a line of its own (the apply aligns a row to the last match in its line, so a kept "or get" never plays
  another saying's parked "or get")."""
import random
import re
import time

import pytest

from lib import speech_energy as se
from lib.speech_lines import Word, load_words
from lib.speech_units import filler_test
from tests import cut_checks
from tests.steps import test_cut as tc
from tests.steps import test_cut_v5 as v5

ROOM = -57.0
EN_FILLER = filler_test("en")


def summary(d, name="vo"):
    raw = load_words(str(d / f"{name}.json"))
    ref = se.Refiner(0.45, is_filler=EN_FILLER)
    placed, _, _ = ref(name, str(d / f"{name}.mov"), raw)
    return [(w.text, round(p.start, 3), round(p.end, 3), k) for w, p, k in zip(raw, placed, ref.kinds[name])]


def covered(d, a, b):
    return round(v5.cover(d, a, b), 3)


def run_all(tmp_path, monkeypatch, tones, total, words, room=ROOM):
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, total, words)], room=room)
    pl = summary(d)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    fails = cut_checks.check(d, before, (), (plan, applied))
    cut = text.split("\n## Cut\n")[1] if "\n## Cut\n" in text else text
    return d, pl, plan, text, cut, said, fails


# ── the reviewer's probes ────────────────────────────────────────────────────────────────────────────────────

def test_a_chained_silent_run_is_folded_and_its_removal_is_text_only(tmp_path, monkeypatch):
    """Probe 1, under the decision: 'zin zan' in a silence, a sound with no word ('um', untranscribed) 1.4 s on. The
    chain folds them (kept, offered inaudible?, FOLD_S each inside a breath): 'back' keeps its own tone (the free
    sound plays as its), and deleting them from the plan cuts no voiced audio."""
    tones = [(0.50, 0.76, -15.0), (0.80, 1.06, -15.0), (3.00, 3.26, -15.0), (3.50, 3.65, -18.0), (3.90, 4.16, -15.0)]
    words = [("we", 0.50, 0.80), ("went", 0.80, 1.10), ("zin", 1.50, 1.80), ("zan", 1.80, 2.10),
             ("back", 3.00, 3.30), ("home.", 3.90, 4.20)]
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, 5.0, words)], room=ROOM)
    pl = summary(d)
    k = {t: kk for t, _, _, kk in pl}
    back = next(p for p in pl if p[0] == "back")
    assert k["zin"] == k["zan"] == "folded" and all(b - a <= se.FOLD_S + 1e-6 for t, a, b, _ in pl
                                                    if t in ("zin", "zan")), pl
    assert back[1] <= 3.05 and back[2] >= 3.2, pl
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    assert "zin zan" in plan.get("cut", "") and "inaudible?" in plan.get("cut", ""), plan.get("cut")
    applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    whole = tc.kept_iv(d)
    # the same plan with "zin zan" deleted plays the same audio
    (tmp_path / "b").mkdir()
    d2 = v5.project(tmp_path / "b", monkeypatch, [("vo", tones, 5.0, words)], room=ROOM)
    tc.run(d2, monkeypatch=monkeypatch)
    head, body = (d2 / "cut-plan.md").read_text().split("\n## Cut\n", 1)
    cut_part, rest = body.split("\n## Unused", 1)
    assert " zin zan" in cut_part, cut_part
    (d2 / "cut-plan.md").write_text(head + "\n## Cut\n" + cut_part.replace(" zin zan", "", 1) + "\n## Unused" + rest)
    tc.run(d2, "--plan", str(d2 / "cut-plan.md"), monkeypatch=monkeypatch)
    assert "zin" not in tc.said_text(d2)
    gone = sum(b - a for a, b in whole) - sum(b - a for a, b in tc.kept_iv(d2))
    # at most the breath their folds sit in goes (room, no voiced frame); every tone, the free one too, still plays
    assert gone <= se.BREATH_S + 1e-3 and all(covered(d2, a, b) > 0.99 for a, b, _ in tones), (whole, tc.kept_iv(d2))


def test_a_chain_never_moves_a_removed_fillers_sound_onto_a_kept_word(tmp_path, monkeypatch):
    """Probe 2: a click with no word, a transcribed 'um' (removed) between it and a silent run: no chain through the
    filler, so its own sound goes with it and the kept words keep theirs."""
    tones = [(0.50, 0.76, -15.0), (0.85, 0.95, -20.0), (1.10, 1.30, -15.0), (1.60, 1.86, -15.0), (1.90, 2.16, -15.0),
             (4.50, 4.76, -15.0), (4.80, 5.06, -15.0)]
    words = [("so", 0.50, 0.80), ("um", 1.10, 1.35), ("we", 1.60, 1.90), ("went", 1.90, 2.20),
             ("zin", 3.00, 3.30), ("zan", 3.30, 3.60), ("back", 4.50, 4.80), ("home.", 4.80, 5.10)]
    d, pl, plan, text, cut, said, fails = run_all(tmp_path, monkeypatch, tones, 6.0, words)
    assert covered(d, 1.12, 1.28) < 0.05, ("the removed filler's own sound plays", tc.kept_iv(d), pl)
    assert covered(d, 1.60, 1.86) > 0.99 and covered(d, 1.90, 2.16) > 0.99, ("a kept word's sound is cut", pl)


def test_a_zero_stamped_false_start_removes_only_its_own_sound(tmp_path, monkeypatch):
    """Probe 3: a broken-off 'we built...' stamped from 0.00, the rest stretched over all the sound. The run and its
    host split at the edge between two bursts, so every tone plays whole or not at all."""
    tones = [(1.20, 1.46, -15.0), (1.50, 1.76, -15.0),
             (2.40, 2.66, -15.0), (2.70, 2.96, -15.0), (3.00, 3.26, -15.0), (3.30, 3.56, -15.0)]
    words = [("we", 0.00, 0.30), ("built...", 0.30, 1.10),
             ("we", 1.20, 1.90), ("built", 1.90, 2.60), ("a", 2.60, 3.00), ("robot.", 3.00, 3.70)]
    d, pl, plan, text, cut, said, fails = run_all(tmp_path, monkeypatch, tones, 4.6, words)
    assert not fails, fails
    for a, b, _ in tones:
        c = covered(d, a + 0.01, b - 0.01)
        assert c < 0.02 or c > 0.98, ("a tone cut in its middle", a, c, tc.kept_iv(d), pl)


def test_an_on_own_false_start_control(tmp_path, monkeypatch):
    tones = [(1.20, 1.46, -15.0), (1.50, 1.76, -15.0),
             (2.40, 2.66, -15.0), (2.70, 2.96, -15.0), (3.00, 3.26, -15.0), (3.30, 3.56, -15.0)]
    words = [("we", 1.20, 1.50), ("built...", 1.50, 2.40),
             ("we", 2.40, 2.70), ("built", 2.70, 3.00), ("a", 3.00, 3.30), ("robot.", 3.30, 3.60)]
    d, pl, plan, text, cut, said, fails = run_all(tmp_path, monkeypatch, tones, 4.6, words)
    assert not fails, fails


def test_a_made_up_tail_over_a_click_is_still_removed(tmp_path, monkeypatch):
    """Probe 4: 'thank you.' after the clip's last sound, a 0.1 s click (no word) in that room: under TAIL_FREE_S a
    word, so neither (a) nor the chain gives it to them."""
    tones = [(0.50, 0.76, -15.0), (0.80, 1.06, -15.0), (1.10, 1.36, -15.0), (1.40, 1.66, -15.0), (2.60, 2.70, -20.0)]
    words = [("we", 0.50, 0.80), ("built", 0.80, 1.10), ("a", 1.10, 1.40), ("robot.", 1.40, 1.70),
             ("thank", 3.60, 3.90), ("you.", 3.90, 4.20)]
    d, pl, plan, text, cut, said, fails = run_all(tmp_path, monkeypatch, tones, 5.0, words)
    assert "thank" not in said and "you." not in said, (said, pl)


def test_a_retake_shifted_two_seconds_early_keeps_the_last_saying_and_its_sound(tmp_path, monkeypatch):
    """Probe 5: 'press the red button now.' twice, whisper shifting the second 1.2 s early into the pause. The
    second's words are folded beside its sound (never faint for it), the free sound plays as its 'now.', and the sure
    retake keeps the last saying: the first saying's sound goes."""
    a = [(0.5 + 0.3 * k, 0.76 + 0.3 * k, -15.0) for k in range(5)]
    b = [(3.6 + 0.3 * k, 3.86 + 0.3 * k, -15.0) for k in range(5)]
    toks = "press the red button now.".split()
    words = [(t, round(x, 3), round(x + 0.3, 3)) for t, (x, _, _) in zip(toks, a)]
    words += [(t, round(x - 1.2, 3), round(x - 0.9, 3)) for t, (x, _, _) in zip(toks, b)]
    d, pl, plan, text, cut, said, fails = run_all(tmp_path, monkeypatch, a + b, 6.0, words)
    assert said == toks, said
    assert all(covered(d, x + 0.01, y - 0.01) < 0.02 for x, y, _ in a), ("the removed take's sound plays", pl)
    assert all(covered(d, x + 0.01, y - 0.01) > 0.98 for x, y, _ in b), (tc.kept_iv(d), pl)
    assert not fails, fails


def test_a_loud_word_left_as_a_sliver_never_fails_the_plan(tmp_path, monkeypatch):
    """Probe 6: 'we um so um went home.' with 'so' spilling into the next 'um' (its span holds sound): the apply drops
    it as a soundless sliver, so the plan does too, offered (inaudible?), and plan equals apply."""
    tones = [(0.50, 0.76, -15.0), (0.80, 1.06, -15.0), (1.40, 1.66, -15.0), (1.70, 1.96, -15.0), (2.00, 2.26, -15.0)]
    words = [("we", 0.50, 0.80), ("um", 0.80, 1.10), ("so", 1.10, 1.43), ("um", 1.43, 1.70),
             ("went", 1.70, 2.00), ("home.", 2.00, 2.30)]
    d, pl, plan, text, cut, said, fails = run_all(tmp_path, monkeypatch, tones, 3.0, words)
    in_plan = bool(re.search(r"\bso\b", cut.split("## Unused")[0]))
    assert in_plan == ("so" in said), ("plan != apply", in_plan, said)


def test_a_zero_stamped_filler_never_cuts_the_first_words_head(tmp_path, monkeypatch):
    """Probe 7: 'um' stamped at 0.00 over the room, no sound of its own: left out of the zero-stamp share."""
    tones = [(1.20, 1.46, -15.0), (1.50, 1.76, -15.0), (1.80, 2.06, -15.0), (2.10, 2.36, -15.0)]
    words = [("um", 0.00, 0.30), ("so", 1.20, 1.50), ("we", 1.50, 1.80), ("went", 1.80, 2.10), ("home.", 2.10, 2.40)]
    d, pl, plan, text, cut, said, fails = run_all(tmp_path, monkeypatch, tones, 3.2, words)
    assert covered(d, 1.20, 1.46) > 0.98, ("the first word's head is cut with the filler", tc.kept_iv(d), pl)


def test_a_zero_stamped_filler_with_its_own_sound(tmp_path, monkeypatch):
    """Probe 7b: the same filler with its own sound right before 'so': it takes that sound (a), and goes with it."""
    tones = [(1.00, 1.18, -18.0), (1.20, 1.46, -15.0), (1.50, 1.76, -15.0), (1.80, 2.06, -15.0), (2.10, 2.36, -15.0)]
    words = [("um", 0.00, 0.30), ("so", 1.20, 1.50), ("we", 1.50, 1.80), ("went", 1.80, 2.10), ("home.", 2.10, 2.40)]
    d, pl, plan, text, cut, said, fails = run_all(tmp_path, monkeypatch, tones, 3.2, words)
    assert covered(d, 1.20, 1.46) > 0.98, ("the first word's head is cut with the filler", tc.kept_iv(d), pl)


# ── the kungfu clip that refused itself (real dump, invented words) ────────────────────────────────────────────

# (word, whisper start, whisper end, peak in the span, engine's placed start, end, kind) of the real clip's words
# 85-115, from its layer-1 dump on c35298d8 (speech -17.3, room -58.2; voiced 29.64-32.51, 33.42-35.54,
# 40.74-43.16), shifted by -29 s. The clause 'and if you move or get scared it needs to adjust' said as retakes, its
# first words each time in silence.
CLIP_E = [
    ("ka", 30.31, 30.47, -17.6, 30.310, 30.470, "heard"), ("tu", 30.47, 30.80, -11.5, 30.470, 30.790, "heard"),
    ("ri", 30.80, 30.87, -51.0, 30.800, 30.870, "quiet"), ("sa", 30.87, 31.11, -53.6, 30.870, 31.110, "quiet"),
    ("pell", 31.11, 31.43, -21.6, 31.140, 31.430, "heard"), ("ka", 31.43, 31.58, -16.4, 31.430, 31.580, "heard"),
    ("lo", 31.58, 31.99, -10.7, 31.580, 31.990, "heard"), ("meeno", 31.99, 32.38, -12.0, 31.990, 32.380, "heard"),
    ("tu", 32.38, 32.62, -23.9, 32.380, 32.510, "heard"), ("ri", 32.62, 32.78, -55.3, 0, 0, "inaudible"),
    ("sa", 32.78, 33.02, -56.3, 0, 0, "inaudible"), ("pell", 33.02, 33.34, -55.6, 0, 0, "inaudible"),
    ("ka", 33.34, 33.50, -20.7, 33.420, 33.500, "heard"), ("lo", 33.50, 33.75, -16.6, 33.500, 33.750, "heard"),
    ("meeno", 33.75, 34.22, -12.9, 33.750, 34.220, "heard"), ("fo", 34.22, 34.45, -17.8, 34.220, 34.450, "heard"),
    ("dunna", 34.45, 34.84, -19.5, 34.450, 34.840, "heard"), ("ve", 34.84, 34.98, -18.6, 34.840, 34.980, "heard"),
    ("bralick", 34.98, 37.40, -16.5, 34.980, 35.540, "heard"), ("tu", 37.40, 37.87, -54.5, 0, 0, "inaudible"),
    ("ri", 37.87, 38.22, -54.9, 0, 0, "inaudible"), ("sa", 38.22, 38.64, -54.9, 0, 0, "inaudible"),
    ("pell", 38.64, 39.29, -54.5, 0, 0, "inaudible"), ("ka", 39.29, 39.59, -55.1, 0, 0, "inaudible"),
    ("lo", 39.59, 40.06, -54.9, 0, 0, "inaudible"), ("meeno", 40.06, 40.99, -15.7, 40.740, 40.990, "heard"),
    ("fo", 40.99, 41.31, -13.0, 40.990, 41.310, "heard"), ("dunna", 41.31, 42.09, -12.6, 41.310, 42.090, "heard"),
    ("ve", 42.09, 43.25, -16.3, 42.090, 43.160, "heard"), ("bralick", 43.25, 43.67, -55.1, 0, 0, "share"),
    ("zo.", 43.67, 44.30, -54.5, 0, 0, "share")]
OFF = 29.0


def clip_e():
    words, tones = [], []
    for w, a, b, pk, p0, p1, kind in CLIP_E:
        words.append((w, round(a - OFF, 3), round(b - OFF, 3)))
        if kind == "heard":
            tones.append((round(p0 - OFF, 3), round(p1 - OFF, 3), pk))
        elif kind == "quiet":
            tones.append((round(a - OFF, 3), round(b - OFF, 3), pk))
    return tones, words, round(words[-1][2] + 1.0, 2)


def test_the_kungfu_clips_repeated_clause_plans_and_plays_what_it_says(tmp_path, monkeypatch):
    """The real refusal: the second saying's 'or get' (97/98) kept, its retake dropped, while the third saying's 'or
    get' (108/109, inaudible, parked in the breath after 'adjust') shared that row's line, so the apply aligned the
    row to them. Now the parked run is a line of its own: the plan is written, its 'ka lo' row plays its own sound,
    and plan equals apply (the backstop)."""
    tones, words, total = clip_e()
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, total, words)], room=-58.0)
    pl = summary(d)
    assert [k for *_, k in pl[19:25]] == ["inaudible"] * 6, pl[19:25]
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    rows = tc.sections(text)[0]
    row = next(r for r in rows if re.match(r"^A\d+ ka lo \[4\.4\]$", r))
    assert row, rows
    assert covered(d, 33.42 - OFF, 33.75 - OFF) > 0.99, tc.kept_iv(d)
    assert not cut_checks.check(d, before, (), (plan, applied)), cut_checks.check(d, before, (), (plan, applied))


def test_a_parked_inaudible_run_repeating_its_lines_words_is_a_line_of_its_own():
    env = [-60.0] * 400
    for k in list(range(30, 60)) + list(range(60, 90)) + list(range(250, 300)):
        env[k] = -15.0
    ws = [Word(0, "ka", "ka", 0.3, 0.6), Word(1, "lo", "lo", 0.6, 0.9), Word(2, "ka", "ka", 1.2, 1.5),
          Word(3, "lo", "lo", 1.5, 1.8), Word(4, "meeno.", "meeno", 2.5, 3.0)]
    ref = se.Refiner(0.45)
    lay = se.layer1(__file__, env, 0.45)
    placed, kind = se.place(ws, lay, ref.breath)
    ref.layers["a"], ref.raw["a"], ref.placed["a"], ref.kinds["a"] = lay, ws, placed, kind
    assert kind[2] == kind[3] == "inaudible", kind
    assert 2 in ref._line_breaks("a"), ref._line_breaks("a")
    # a parked run that repeats no word of its line stays in it (its * row, as before)
    ws2 = [Word(0, "ka", "ka", 0.3, 0.6), Word(1, "lo", "lo", 0.6, 0.9), Word(2, "tu", "tu", 1.2, 1.5),
           Word(3, "ri", "ri", 1.5, 1.8), Word(4, "meeno.", "meeno", 2.5, 3.0)]
    placed, kind = se.place(ws2, lay, ref.breath)
    ref.layers["b"], ref.raw["b"], ref.placed["b"], ref.kinds["b"] = se.layer1(__file__, env, 0.45), ws2, placed, kind
    assert 2 not in ref._line_breaks("b"), ref._line_breaks("b")


# ── the drift fuzz with repeated clauses and fillers ─────────────────────────────────────────────────────────────

FILLERS = ("um", "uh")


def clause_fuzz(seed, drift=3.0):
    """2-4 clauses of 3-6 words, each said 1-3 times back to back (retakes), a filler now and then with its own short
    tone; whisper's starts drift up to `drift` s each way, in order (never past the clip's last sound), the first
    1-3 words stamped from 0.0."""
    rnd = random.Random(9000 + seed)
    vocab = rnd.sample(v5.VOCAB, 24)
    clauses = [vocab[6 * c:6 * c + rnd.randint(3, 6)] for c in range(rnd.randint(2, 4))]
    toks, tones, t = [], [], round(rnd.uniform(0.8, 2.0), 2)
    for cl in clauses:
        for _ in range(rnd.choice((1, 1, 2, 3))):
            for k, w in enumerate(cl):
                if k and rnd.random() < 0.12:
                    f = rnd.choice(FILLERS)
                    toks.append(f)
                    tones.append((t, round(t + 0.18, 2), -20.0))
                    t = round(t + 0.24, 2)
                dur = rnd.choice((0.15, 0.22, 0.3))
                toks.append(w + ("." if k + 1 == len(cl) else ""))
                tones.append((t, round(t + dur, 2), rnd.choice((-12.0, -15.0, -18.0))))
                t = round(t + dur + rnd.choice((0.02, 0.05, 0.1)), 2)
            t = round(t + rnd.choice((0.3, 0.6, 1.2, 2.0)), 2)
    end = round(t + 1.0, 2)
    n, first = len(toks), rnd.randint(1, 3)
    starts, gap = [], 0.12        # whisper's words are never mostly zero-length (that reads as made-up words: b-roll)
    limit = tones[-1][1] - 0.05   # never past the clip's last sound (a made-up tail, removed on purpose)
    for k in range(n):
        if k < first:
            s = round(k * min(0.3, tones[0][0] / (first + 1)), 3)
        else:
            s = max(0.0, tones[k][0] + rnd.uniform(-drift, drift))
        if starts:
            s = max(s, starts[-1] + gap)
        starts.append(round(min(s, limit - gap * (n - 1 - k)), 3))
    for k in range(1, n):
        starts[k] = round(max(starts[k], starts[k - 1] + 0.01), 3)
    words = []
    for k, tok in enumerate(toks):
        b = starts[k + 1] if k + 1 < n else min(end - 0.05, max(starts[k] + 0.2, tones[k][1]))
        words.append((tok, starts[k], round(b, 3)))
    end = round(max(end, words[-1][2] + 0.3), 2)
    return clauses, tones, words, end


@pytest.mark.parametrize("seed", range(80))
def test_the_clause_drift_fuzz_plans_settles_and_passes_the_checks(tmp_path, monkeypatch, seed):
    """Retakes and fillers under seconds of drift: the plan is always written (plan equals apply: the backstop), no
    filler plays, no word whose whisper span holds sound is found inaudible (b), and every cut_checks column is 0.
    (Whether every clause survives is not asserted: under drift some silent runs look exactly like made-up words.)"""
    clauses, tones, words, end = clause_fuzz(seed)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, end, words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    plain = [w.rstrip(".") for w in said]
    assert not any(w in FILLERS for w in plain), said
    raw = load_words(str(d / "vo.json"))
    ref = se.Refiner(0.45, is_filler=EN_FILLER)
    ref("vo", str(d / "vo.mov"), raw)
    lay = ref.layers["vo"]
    assert not [w.text for w, k in zip(raw, ref.kinds["vo"]) if k == "inaudible" and se.span_voiced(lay, w)]
    v5.checked(d, plan, applied, before)


# ── timing: a 30-minute source ───────────────────────────────────────────────────────────────────────────────

def test_a_thirty_minute_source_places_in_at_most_twice_the_time_without_the_ordered_passes(monkeypatch, tmp_path):
    """Lines of 8 words, a 1.5 s pause holding 2 made-up silent words, an untranscribed blip inside every line (so
    _chain reaches every run): the placement takes at most twice what it takes with _ordered and _chain switched off
    (the e4ba9136 placement), plus 0.3 s."""
    rnd = random.Random(1)
    fr = se.FRAME_S
    total = 30 * 60
    env = [-57.0 + rnd.uniform(-1, 1) for _ in range(int(total / fr))]
    words, t, idx = [], 0.5, 0

    def tone(a, b, db=-15.0):
        for k in range(int(a / fr), min(len(env), int(b / fr))):
            env[k] = db
    while t + 5 < total:
        for k in range(8):
            if k == 4:
                tone(t + 0.1, t + 0.2, -20.0)
                t += 0.3
            tone(t, t + 0.26)
            words.append(Word(idx, f"word{idx}", f"word{idx}", round(t, 3), round(t + 0.3, 3)))
            idx += 1
            t += 0.3
        words.append(Word(idx, "zin", "zin", round(t + 0.3, 3), round(t + 0.6, 3)))
        words.append(Word(idx + 1, "zan", "zan", round(t + 0.6, 3), round(t + 0.9, 3)))
        idx += 2
        t += 1.5
    dummy = tmp_path / "dummy.bin"
    dummy.write_text("x")
    monkeypatch.setattr(se, "envelope", lambda media: env)

    runs = []

    def timed(again=None):
        ref = se.Refiner(0.45, is_filler=EN_FILLER, retranscribe=again)
        t0 = time.perf_counter()
        ref("vo", str(dummy), words)
        return time.perf_counter() - t0
    # §577's broken-stretch search too (whisper's second run would cost one run a broken voiced run; none here)
    new = min(timed(lambda m, a, b: runs.append((a, b))) for _ in range(2))
    assert runs == []
    monkeypatch.setattr(se, "_ordered", lambda *a, **k: None)
    monkeypatch.setattr(se, "_chain", lambda *a, **k: None)
    base = min(timed() for _ in range(2))
    assert new <= 2 * base + 0.3, (new, base)
