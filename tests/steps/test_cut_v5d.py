"""§577 cut, the review of 6f7af80c and the kungfu refusal: the opus reviewer's probes ported (synthetic tones,
invented words) and the real clip that refused itself replayed from its layer-1 dump with invented words. Decisions
they hold (2026-10-25):
- a made-up tail over a click after the clip's last word stays inaudible;
- a sliver the apply drops is dropped in the plan too, tagged inaudible? when its whisper span holds sound;
- a run of inaudible words parked in the breath of the sound before them that repeats two words in a row of its line
  opens a line of its own (the apply aligns a row to the last match in its line, so a kept "or get" never plays
  another saying's parked "or get")."""
import re

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

def test_an_on_own_false_start_control(tmp_path, monkeypatch):
    tones = [(1.20, 1.46, -15.0), (1.50, 1.76, -15.0),
             (2.40, 2.66, -15.0), (2.70, 2.96, -15.0), (3.00, 3.26, -15.0), (3.30, 3.56, -15.0)]
    words = [("we", 1.20, 1.50), ("built...", 1.50, 2.40),
             ("we", 2.40, 2.70), ("built", 2.70, 3.00), ("a", 3.00, 3.30), ("robot.", 3.30, 3.60)]
    d, pl, plan, text, cut, said, fails = run_all(tmp_path, monkeypatch, tones, 4.6, words)
    assert not fails, fails


def test_a_made_up_tail_over_a_click_is_still_removed(tmp_path, monkeypatch):
    """Probe 4: 'thank you.' after the clip's last sound, a 0.1 s click (no word) in that room: never their sound."""
    tones = [(0.50, 0.76, -15.0), (0.80, 1.06, -15.0), (1.10, 1.36, -15.0), (1.40, 1.66, -15.0), (2.60, 2.70, -20.0)]
    words = [("we", 0.50, 0.80), ("built", 0.80, 1.10), ("a", 1.10, 1.40), ("robot.", 1.40, 1.70),
             ("thank", 3.60, 3.90), ("you.", 3.90, 4.20)]
    d, pl, plan, text, cut, said, fails = run_all(tmp_path, monkeypatch, tones, 5.0, words)
    assert "thank" not in said and "you." not in said, (said, pl)


def test_a_loud_word_left_as_a_sliver_never_fails_the_plan(tmp_path, monkeypatch):
    """Probe 6: 'we um so um went home.' with 'so' spilling into the next 'um' (its span holds sound): the apply drops
    it as a soundless sliver, so the plan does too, offered (inaudible?), and plan equals apply."""
    tones = [(0.50, 0.76, -15.0), (0.80, 1.06, -15.0), (1.40, 1.66, -15.0), (1.70, 1.96, -15.0), (2.00, 2.26, -15.0)]
    words = [("we", 0.50, 0.80), ("um", 0.80, 1.10), ("so", 1.10, 1.43), ("um", 1.43, 1.70),
             ("went", 1.70, 2.00), ("home.", 2.00, 2.30)]
    d, pl, plan, text, cut, said, fails = run_all(tmp_path, monkeypatch, tones, 3.0, words)
    in_plan = bool(re.search(r"\bso\b", cut.split("## Unused")[0]))
    assert in_plan == ("so" in said), ("plan != apply", in_plan, said)


# ── the kungfu clip that refused itself (real dump, invented words) ────────────────────────────────────────────

# (word, whisper start, whisper end, peak in the span, engine's placed start, end, kind) of the real clip's words
# 85-115, from its layer-1 dump on c35298d8 (speech -17.3, room -58.2; voiced 29.64-32.51, 33.42-35.54,
# 40.74-43.16), shifted by -29 s. The clause 'and if you move or get scared it needs to adjust' said as retakes, its
# first words each time in silence. The dump's 've' spanned 42.09-43.25 over all of 42.09-43.16's sound, 'bralick zo.'
# stamped after it over the room (43.25-44.30); here they lie on their own share of that sound, as per-run
# transcripts give them.
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
    ("ve", 42.09, 42.40, -16.3, 42.090, 42.400, "heard"), ("bralick", 42.40, 42.85, -16.3, 42.400, 42.850, "heard"),
    ("zo.", 42.85, 43.25, -16.3, 42.850, 43.160, "heard")]
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
