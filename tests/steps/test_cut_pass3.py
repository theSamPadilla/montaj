"""§558 cut, fix pass 3: islands, the last take of a clear retake, the conservative inaudible rule, and review #3's
probes. Synthetic tones over a set room level, invented words: every level and every pause is known exactly."""
import json
import random
import re

import pytest

from lib import speech_energy
from tests.steps import test_cut as tc

SP = -20.0
ISLAND_S = 0.35
VOCAB = ("apple river candle marble pigeon lantern velvet copper meadow saddle thimble walrus juniper falcon "
         "harbor nickel pepper quartz raven sable tundra umber violet willow yonder zephyr basket cobalt dagger "
         "ember fennel garnet hazel indigo jasper kettle lemon mango nectar olive parsley quill russet sorrel "
         "turnip ukulele vortex wombat").split()


def cover(d, a, b):
    return sum(max(0.0, min(e, b) - max(s, a)) for s, e in tc.kept_iv(d)) / (b - a)


def plan_apply(d, monkeypatch):
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    return plan, text, applied, [w for w, _, _ in tc.played_words(d)]


def short_items(d):
    """Speech items shorter than ISLAND_S on the timeline, as (inPoint, outPoint)."""
    return [(a, b) for a, b in tc.kept_iv(d) if b - a < ISLAND_S - 1e-6]


def assert_no_unwarned_island(d, plan, applied):
    """The compare check: no kept item under ISLAND_S unless a warning names it."""
    warned = " ".join(plan.get("warnings", []) + applied.get("warnings", []))
    short = short_items(d)
    assert not short or "short piece" in warned, (short, tc.kept_iv(d), warned)


def unused_rows(text):
    return tc.sections(text)[1]


# ── review #3 blockers (ported from its probes) ───────────────────────────────

@pytest.mark.parametrize("bleed", [0.0, 0.02])
def test_a_quiet_word_whose_span_holds_one_frame_of_the_next_word_keeps_its_sound(tmp_path, monkeypatch, bleed):
    """R3-B1: 'pigeon' is said softly (-55 dB: 15 dB over the -70 room, under the -46 floor). Whisper's span for it
    runs `bleed` s into 'pepper's onset, as gapless whisper spans often do. Its 0.6 s of sound must play."""
    spans = [(0.30, 0.55, SP), (0.60, 0.85, SP), (0.95, 1.55, -55.0), (1.60, 1.85, SP), (1.90, 2.15, SP),
             (2.20, 2.45, SP)]
    words = [("so", 0.30, 0.60), ("the", 0.60, 0.95), ("pigeon", 0.95, 1.60 + bleed), ("pepper", 1.60 + bleed, 1.90),
             ("is", 1.90, 2.20), ("hot.", 2.20, 2.45)]
    d = tc.tone_project(tmp_path, [("vo", spans, 3.2, words)])
    plan, text, _, said = plan_apply(d, monkeypatch)
    assert cover(d, 0.95, 1.55) > 0.99, (bleed, cover(d, 0.95, 1.55), tc.kept_iv(d), said, text)


@pytest.mark.parametrize("lead", [0.01, 0.03])
def test_a_quiet_word_whose_span_opens_on_the_last_frames_of_the_word_before_keeps_its_sound(tmp_path, monkeypatch,
                                                                                            lead):
    """R3-B1: the same soft 'pigeon', but whisper started its span `lead` s before 'the' ends."""
    spans = [(0.30, 0.55, SP), (0.60, 0.85, SP), (0.95, 1.55, -55.0), (1.60, 1.85, SP), (1.90, 2.15, SP),
             (2.20, 2.45, SP)]
    words = [("so", 0.30, 0.60), ("the", 0.60, 0.85 - lead), ("pigeon", 0.85 - lead, 1.60), ("pepper", 1.60, 1.90),
             ("is", 1.90, 2.20), ("hot.", 2.20, 2.45)]
    d = tc.tone_project(tmp_path, [("vo", spans, 3.2, words)])
    plan, text, _, _ = plan_apply(d, monkeypatch)
    assert cover(d, 0.95, 1.55) > 0.99, (lead, cover(d, 0.95, 1.55), tc.kept_iv(d), text.split("## Cut")[-1])


@pytest.mark.parametrize("dur", [0.03, 0.05, 0.07, 0.09])
def test_a_short_heard_word_between_removed_inaudible_runs_plays(tmp_path, monkeypatch, dur):
    """R3-B2: 'I' (a loud short tone) sits between two runs whisper put over silence. It is heard, so it must play,
    and the plan must keep it."""
    spans = [(0.30, 0.55, SP), (0.60, 0.85, SP), (1.80, 1.80 + dur, SP), (3.00, 3.25, SP), (3.30, 3.55, SP)]
    words = [("alpha", 0.30, 0.60), ("beta", 0.60, 0.90), ("w1", 0.90, 1.30), ("w2", 1.30, 1.80),
             ("I", 1.80, 1.80 + dur), ("w3", 1.80 + dur, 2.40), ("w4", 2.40, 3.00), ("gamma", 3.00, 3.30),
             ("delta.", 3.30, 3.55)]
    d = tc.tone_project(tmp_path, [("vo", spans, 4.2, words)])
    plan, text, _, said = plan_apply(d, monkeypatch)
    assert cover(d, 1.80, 1.80 + dur) > 0.99 and "I" in said, (dur, tc.kept_iv(d), said, text)


@pytest.mark.parametrize("dur", [0.06, 0.08, 0.09, 0.12])
def test_a_short_word_between_two_fillers_plays(tmp_path, monkeypatch, dur):
    """R3-B2: 'we went um I uh guess so.': the fillers go (the mechanical pass); 'I' is said, loud."""
    t = 1.30 + 0.25
    spans = [(0.30, 0.55, SP), (0.60, 0.85, SP), (0.95, 1.25, SP), (t, t + dur, SP),
             (t + dur + 0.05, t + dur + 0.35, SP), (t + dur + 0.45, t + dur + 0.70, SP),
             (t + dur + 0.75, t + dur + 1.0, SP)]
    words = [("we", 0.30, 0.60), ("went", 0.60, 0.95), ("um", 0.95, t), ("I", t, t + dur),
             ("uh", t + dur, t + dur + 0.45), ("guess", t + dur + 0.45, t + dur + 0.75),
             ("so.", t + dur + 0.75, t + dur + 1.0)]
    d = tc.tone_project(tmp_path, [("vo", spans, t + dur + 1.6, words)])
    plan, text, _, said = plan_apply(d, monkeypatch)
    assert cover(d, t, t + dur) > 0.99 and "I" in said, (dur, tc.kept_iv(d), said, text.split("## Cut")[-1])


@pytest.mark.parametrize("dur", [0.07, 0.09])
def test_a_short_word_the_person_keeps_between_words_they_delete_plays(tmp_path, monkeypatch, dur):
    """R3-B2: the person deletes 'gamma' and 'delta' around 'I'. They kept 'I', so it must play."""
    spans, words, t = [], [], 0.30
    for tok, ln in (("alpha", 0.25), ("beta", 0.25), ("gamma", 0.25), ("I", dur), ("delta", 0.25), ("epsilon.", 0.25)):
        spans.append((round(t, 2), round(t + ln, 2), SP))
        words.append([tok, round(t, 2), None])
        t = round(t + ln + 0.03, 2)
    for k in range(len(words)):
        words[k][2] = words[k + 1][1] if k + 1 < len(words) else spans[-1][1]
    d = tc.tone_project(tmp_path, [("vo", spans, t + 0.8, [tuple(w) for w in words])])
    tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    edited = text.replace(" gamma I delta ", " I ")
    assert edited != text, text
    (d / "cut-plan.md").write_text(edited)
    out, _ = tc.run(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch)
    said = [w for w, _, _ in tc.played_words(d)]
    a, b, _ = spans[3]
    assert cover(d, a, b) > 0.99 and said == ["alpha", "beta", "I", "epsilon."], (tc.kept_iv(d), said, out)


@pytest.mark.parametrize("aside_db", [-50.0, -54.0])
def test_a_soft_aside_in_dense_speech_with_no_lead_in_is_kept(tmp_path, monkeypatch, aside_db):
    """R3-B3: dense delivery (0.01 s between words), whisper's first word at 0.0 and its last at the file's end, so
    almost no frame lies outside the words: the room (-70) must still be read as the room. A 3-word aside at
    aside_db (20+ dB over the room) is heard and must play."""
    toks = [f"w{k}" for k in range(24)]
    spans, words, t = [], [], 0.0
    for k, tok in enumerate(toks):
        db = aside_db if 10 <= k < 13 else SP
        spans.append((round(t, 2), round(t + 0.25, 2), db))
        words.append((tok + ("." if k == len(toks) - 1 else ""), round(t, 2), round(t + 0.26, 2)))
        t = round(t + 0.26, 2)
    d = tc.tone_project(tmp_path, [("vo", spans, t, words)])
    plan, text, _, said = plan_apply(d, monkeypatch)
    lost = [(a, b) for a, b, db in spans if cover(d, a, b) < 0.99]
    assert not lost and len(said) == len(toks), (lost, said, plan["removed"], text.split("## Cut")[-1])


# ── review #3 fuzz: whisper drift up to 0.25 s, gapless spans, very short and near-noise tones ──────────────

def _fuzz(seed, levels=(-20, -30, -45, -55, -58), drift=0.25, durs=(0.03, 0.05, 0.08, 0.15, 0.3, 0.6)):
    rnd = random.Random(1000 + seed)
    n = rnd.randint(5, 12)
    toks = rnd.sample(VOCAB, n)
    t = round(rnd.uniform(0.3, 0.9), 2)
    tones = []
    for _ in range(n):
        dur = rnd.choice(durs)
        tones.append((t, round(t + dur, 2), rnd.choice(levels)))
        t = round(t + dur + rnd.choice([0.01, 0.04, 0.1, 0.25, 0.5, 0.9]), 2)
    end = t + 0.8
    starts = []
    for k in range(n):
        s = max(0.0, tones[k][0] + rnd.uniform(-drift, drift))
        if starts:
            s = max(s, starts[-1] + 0.02)
        else:
            s = min(s, tones[0][0])
        starts.append(round(s, 3))
    words = []
    for k, tok in enumerate(toks):
        b = starts[k + 1] if k + 1 < n else min(end - 0.05, max(starts[k] + 0.1, tones[k][1] + rnd.uniform(-0.1, 0.4)))
        if k + 1 == n:
            b = max(b, tones[k][1])
        words.append((tok + ("." if k + 1 == n or rnd.random() < 0.15 else ""), starts[k], round(b, 3)))
    return tones, words, end


# its test is test_cut_v5's drift fuzz, judged by tests/cut_checks.py: v5 cuts the -55 and -58 dB tones under -20 dB
# speech as silence (35 dB or more under it) unless a word is attached to them, so "every tone plays whole" is no
# longer the bar; compare's -46 dB guard is


# ── the conservative inaudible rule (2b, binding) ──────────────────────────────────────────────────────────

def _room_run(db):
    """'we ride the bike all day.' with 'the bike' at `db` (whisper's spans right over their tones, the loud words'
    tones well clear of their spans), a lead-in and a tail of room, so the room's reading is trusted."""
    spans = [(0.40, 0.65, SP), (0.70, 0.95, SP), (1.10, 1.35, db), (1.45, 1.70, db), (1.85, 2.10, SP),
             (2.15, 2.40, SP)]
    words = [("we", 0.40, 0.70), ("ride", 0.70, 1.00), ("the", 1.05, 1.40), ("bike", 1.40, 1.75),
             ("all", 1.85, 2.15), ("day.", 2.15, 2.40)]
    return spans, words


def test_a_run_seven_db_over_the_room_in_a_silence_goes_with_it(tmp_path, monkeypatch):
    """'the bike' at 7 dB over the room (43 dB under the speech), wholly in a silence, 'ride' too short to hold them:
    they go with the silence, tagged inaudible. FINISH v5 protects only what the -46 guard hears (the fix pass kept
    them for being 6 dB over the room; b7639ba5 offered them)."""
    spans, words = _room_run(tc.NOISE_DB + 7)
    d = tc.tone_project(tmp_path, [("vo", spans, 3.2, words)])
    plan, text, _, said = plan_apply(d, monkeypatch)
    assert said == ["we", "ride", "all", "day."], (said, text)
    assert plan["removed"]["inaudible"] == 2, plan


def test_a_run_three_db_over_the_room_for_its_whole_span_is_removed(tmp_path, monkeypatch):
    spans, words = _room_run(tc.NOISE_DB + 3)
    d = tc.tone_project(tmp_path, [("vo", spans, 3.2, words)])
    plan, text, _, said = plan_apply(d, monkeypatch)
    assert said == ["we", "ride", "all", "day."], (said, text)
    assert plan["removed"]["inaudible"] == 2, plan
    assert any(r.endswith(" inaudible]") for r in unused_rows(text)), text


def test_two_words_at_the_rooms_level_in_dense_speech_go_with_their_silence(tmp_path, monkeypatch):
    """v5: no noise reading, so no trust: two words at the room's own level make a silence over max-pause (0.52 s),
    and lie wholly inside it, so they go with it, tagged inaudible. b7639ba5 removed nothing (an untrusted
    reading)."""
    toks = [f"w{k}" for k in range(24)]
    spans, words, t = [], [], 0.0
    for k, tok in enumerate(toks):
        db = tc.NOISE_DB if k in (10, 11) else SP
        spans.append((round(t, 2), round(t + 0.25, 2), db))
        words.append((tok + ("." if k == len(toks) - 1 else ""), round(t, 2), round(t + 0.26, 2)))
        t = round(t + 0.26, 2)
    d = tc.tone_project(tmp_path, [("vo", spans, t, words)])
    plan, text, _, said = plan_apply(d, monkeypatch)
    assert plan["removed"]["inaudible"] == 2 and len(said) == len(toks) - 2, (said, plan, text)
    assert all(cover(d, a, b) > 0.99 for k, (a, b, _) in enumerate(spans) if k not in (10, 11)), tc.kept_iv(d)


# ── P3-1 islands ────────────────────────────────────────────────────────────────────────────────────────────

def test_faint_words_between_pause_cuts_join_their_neighbours(tmp_path, monkeypatch):
    """'so {0.30} how {0.26} much {0.30} should' with 'how' and 'much' faint (-58, 12 dB over the room): dead air
    cut each pause to two breaths and left each faint word as its own 0.2 s item. The pauses are under max-pause:
    they are kept, so the faint words join their neighbours at natural timing."""
    spans = [(0.30, 0.50, SP), (0.80, 1.00, -58.0), (1.26, 1.46, -58.0), (1.76, 2.06, SP), (2.10, 2.35, SP),
             (2.40, 2.65, SP)]
    words = [("so", 0.30, 0.80), ("how", 0.80, 1.26), ("much", 1.26, 1.76), ("should", 1.76, 2.10),
             ("we", 2.10, 2.40), ("pay.", 2.40, 2.65)]
    d = tc.tone_project(tmp_path, [("vo", spans, 3.4, words)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    assert said == ["so", "how", "much", "should", "we", "pay."], (said, text)
    assert all(cover(d, a, b) > 0.99 for a, b, _ in spans), tc.kept_iv(d)
    assert not short_items(d), (tc.kept_iv(d), text)
    cut = " ".join(tc.sections(text)[0])
    assert re.search(r"so \{0\.\d\d\} how \{0\.\d\d\} much", cut), cut      # the plan shows the pauses kept
    assert plan["duration"] == applied["duration"], (plan, applied)


def test_a_faint_island_beside_a_long_pause_is_widened(tmp_path, monkeypatch):
    """The pause after the faint word is over max-pause: that side keeps max-pause, and the item is long enough."""
    spans = [(0.30, 0.50, SP), (0.80, 1.00, -58.0), (2.00, 2.30, SP), (2.35, 2.60, SP)]
    words = [("so", 0.30, 0.80), ("how", 0.80, 2.00), ("should", 2.00, 2.35), ("pay.", 2.35, 2.60)]
    d = tc.tone_project(tmp_path, [("vo", spans, 3.4, words)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    assert said == ["so", "how", "should", "pay."], (said, text)
    assert all(cover(d, a, b) > 0.99 for a, b, _ in spans), tc.kept_iv(d)
    assert_no_unwarned_island(d, plan, applied)
    gaps = [b[1] - a[2] for a, b in zip(tc.played_words(d), tc.played_words(d)[1:])]
    assert max(gaps) <= 0.45 + 0.03, gaps


@pytest.mark.parametrize("where", ["first", "last"])
def test_a_faint_island_at_a_clips_edge_joins_its_one_neighbour(tmp_path, monkeypatch, where):
    """A faint 0.18 s word at -47 opens (or ends) the clip, then a pause cut: it joins the speech beside it."""
    if where == "first":
        spans = [(0.30, 0.48, -47.0), (0.80, 1.05, SP), (1.10, 1.35, SP), (1.40, 1.65, SP)]
        words = [("okay", 0.30, 0.80), ("we", 0.80, 1.10), ("start", 1.10, 1.40), ("now.", 1.40, 1.65)]
    else:
        spans = [(0.30, 0.55, SP), (0.60, 0.85, SP), (0.90, 1.15, SP), (1.45, 1.63, -47.0)]
        words = [("we", 0.30, 0.60), ("start", 0.60, 0.90), ("now", 0.90, 1.45), ("right.", 1.45, 1.63)]
    d = tc.tone_project(tmp_path, [("vo", spans, 2.4, words)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    assert len(said) == 4 and all(cover(d, a, b) > 0.99 for a, b, _ in spans), (said, tc.kept_iv(d), text)
    assert not short_items(d), (tc.kept_iv(d), text)


def test_an_island_is_never_joined_across_a_word_the_person_removed(tmp_path, monkeypatch):
    """The person deletes 'beta' (loud) right after the faint 'how': the island joins across its pause cut only,
    never across the removed word, which stays out."""
    spans = [(0.30, 0.50, SP), (0.80, 1.00, -58.0), (1.10, 1.35, SP), (1.70, 1.95, SP), (2.00, 2.25, SP)]
    words = [("so", 0.30, 0.80), ("how", 0.80, 1.10), ("beta", 1.10, 1.70), ("gamma", 1.70, 2.00),
             ("delta.", 2.00, 2.25)]
    d = tc.tone_project(tmp_path, [("vo", spans, 3.0, words)])
    tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    edited = re.sub(r" beta\b", "", text, count=1)
    assert edited != text
    (d / "cut-plan.md").write_text(edited)
    tc.run(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch)
    said = [w for w, _, _ in tc.played_words(d)]
    assert said == ["so", "how", "gamma", "delta."], (said, tc.kept_iv(d))
    assert cover(d, 1.10, 1.35) < 0.05 and cover(d, 0.80, 1.00) > 0.99, tc.kept_iv(d)


def test_a_dead_breath_island_between_cuts_goes(tmp_path, monkeypatch):
    """No heard word in it: a short kept piece of room between two removed retakes' words is dropped, not widened."""
    d = tc.spoken_project(tmp_path, ["press the red button now. | press the red button now. | press the red button now."])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    assert " ".join(said) == "press the red button now.", (said, text)
    assert not short_items(d), tc.kept_iv(d)


# ── P3-2: the last take of a clear retake, even when the first is faint (kungfu IMG_1151, synthetic) ──────

KUNGFU_WORDS = [("This", 0.0, 0.71), ("may", 0.71, 1.24), ("be", 1.24, 1.59), ("the", 1.59, 2.71),
                ("funniest", 2.71, 3.69), ("demo", 3.69, 4.3), ("I've", 4.3, 5.09), ("ever", 5.09, 6.09),
                ("seen.", 6.09, 8.0),
                ("This", 8.0, 8.61), ("may", 8.61, 9.06), ("be", 9.06, 9.36), ("the", 9.36, 10.71),
                ("funniest", 10.71, 11.04), ("demo", 11.04, 11.69), ("I've", 11.69, 12.24), ("ever", 12.24, 12.85),
                ("seen.", 12.85, 13.96),
                ("Unit", 14.3, 14.6), ("three", 14.6, 14.95), ("is", 14.95, 15.2), ("next.", 15.2, 15.6)]
# the first saying faint (-42 or so, the room at -55), the second loud; its "This" starts 0.23 s before whisper's
# span for it, inside the first saying's "seen."
KUNGFU_TONES = [(0.15, 0.45, -45.8), (0.80, 1.00, -43.0), (1.30, 1.50, -42.0), (1.65, 1.80, -43.0),
                (2.80, 3.40, -42.0), (3.75, 4.10, -41.0), (4.35, 4.60, -42.0), (5.20, 5.50, -37.8),
                (6.20, 6.70, -42.0),
                (7.77, 8.30, -14.0), (8.62, 8.90, -15.1), (9.10, 9.30, -13.1), (9.40, 9.55, -15.0),
                (10.72, 11.00, -14.0), (11.06, 11.40, -15.0), (11.70, 11.95, -16.0), (12.26, 12.60, -15.0),
                (12.90, 13.40, -20.6),
                (14.30, 14.58, -15.0), (14.62, 14.93, -15.0), (14.97, 15.18, -15.0), (15.22, 15.55, -15.0)]


def _loud_cut_inside(d, env, floor):
    """Kept pieces that end (or start) inside loud audio which goes on into audio the cut removed."""
    iv = tc.kept_iv(d)
    kept = lambda t: any(a - 1e-3 <= t <= b + 1e-3 for a, b in iv)  # noqa: E731
    f = speech_energy.FRAME_S
    out = []
    for a, b in iv:
        for edge, inside, outside in ((b, b - 0.02, b + 0.02), (a, a + 0.01, a - 0.03)):
            if 0 <= outside < len(env) * f and not kept(outside) and \
                    speech_energy.peak(env, min(inside, edge), max(inside, edge)) >= floor and \
                    speech_energy.peak(env, min(outside, edge), max(outside, edge)) >= floor:
                out.append((a, b, edge))
    return out


def test_a_faint_first_saying_never_wins_over_the_loud_last_take(tmp_path, monkeypatch):
    monkeypatch.setattr(tc, "NOISE_DB", -55.0)
    d = tc.tone_project(tmp_path, [("kf", KUNGFU_TONES, 16.4, KUNGFU_WORDS)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    second = [w for w, _, _ in KUNGFU_WORDS[9:]]
    assert said == second, (said, text)
    assert all(cover(d, a, b) > 0.99 for a, b, _ in KUNGFU_TONES[9:]), tc.kept_iv(d)
    assert all(cover(d, a, b) < 0.01 for a, b, _ in KUNGFU_TONES[:9]), tc.kept_iv(d)
    rows = unused_rows(text)
    assert all(r.endswith(" retake]") for r in rows), rows                   # the earlier take of a clear retake
    words = " ".join(re.sub(r"\{[\d.]+\}|\[[^]]*\]", "", r).split(None, 1)[1] for r in rows)
    assert " ".join(words.split()) == "This may be the funniest demo I've ever seen.", rows
    env = speech_energy.envelope(str(d / "kf.mov"))
    assert not _loud_cut_inside(d, env, -30.0), (tc.kept_iv(d), text)
    assert_no_unwarned_island(d, plan, applied)


def test_the_kungfu_shape_with_the_last_take_trimmed_by_tidy_is_still_whole(tmp_path, monkeypatch):
    """P3-3: tidy's own energy guard: the second saying's 'This' opens 0.23 s inside whisper's span for the first
    saying's 'seen.'. Its onset plays, so no kept piece starts inside it."""
    monkeypatch.setattr(tc, "NOISE_DB", -55.0)
    d = tc.tone_project(tmp_path, [("kf", KUNGFU_TONES, 16.4, KUNGFU_WORDS)])
    plan_apply(d, monkeypatch)
    assert cover(d, 7.77, 8.30) > 0.99, tc.kept_iv(d)


# ── review #3 should-fix 2 and 3 ────────────────────────────────────────────────────────────────────────────

def test_the_stamp_names_every_constant_that_changes_a_cut():
    for name in ("ISLAND_S", "SILENCE_BELOW_SPEECH_DB", "ATTACHED_BELOW_SPEECH_DB", "BREATH_S", "SENTENCE_END_S",
                 "DRIFT_S", "EDGE_BLEED_FRAMES", "LETTER_S", "WORD_BASE_S", "VIDEO_EDGE_S",
                 "SPEECH_PERCENTILE", "MIN_KEEP_S"):
        assert f"{name}={getattr(speech_energy, name)}" in speech_energy.Refiner.stamp, name


def test_a_plan_that_never_settles_fails_loudly(tmp_path, monkeypatch, capsys):
    from steps.edit import cut as cc
    d = tc.spoken_project(tmp_path, ["we start now and then we stop."])
    monkeypatch.setattr(cc, "_settle", lambda *a, **k: True)
    assert tc.refused(d, monkeypatch=monkeypatch, capsys=capsys) == "plan_unsettled"


# test_an_island_that_can_neither_join_nor_widen_is_kept_and_named: in tests/test_speech_energy.py, on v5's tidy


def test_the_apply_answer_names_a_sliver_it_dropped():
    from steps.edit import cut as cc
    from tests import test_speech_energy as tse
    d = tse._Derived({"a": tse.words(("um", 1.0, 1.04))})
    flagged = [{"kind": "sliver", "letter": "A", "idx": [0], "seconds": 0.12}]
    assert cc._piece_warnings(d, flagged) == ["dropped 1 short piece(s) with no heard word: A1 0.12 s"]
    assert cc._piece_warnings(d, flagged, slivers=False) == []
