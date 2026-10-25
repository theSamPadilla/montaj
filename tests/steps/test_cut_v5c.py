"""§577 cut: whisper's word times drift by SECONDS on a real file (the first words of a clip stamped at 0.00 while the
speech starts later, spans stretched 5-11 s over pauses, whole phrases shifted). Words are placed on layer 1's voiced
audio in ORDER (lib/speech_energy.place):
- (a) a word with no voiced frame in its own span takes the unclaimed voiced audio between its neighbours' placed sound;
- (A) with none there, it takes a letter share of the head (or tail) of its neighbour's sound at a clip edge (its span
  holding only the room) or when that neighbour is long for its own text (LETTER_S);
- (B) otherwise the lone-word fold (kept in ## Cut, offered inaudible?), never sent to ## Unused by the edge rule;
- a run of words with no voiced audio anywhere between its neighbours is still inaudible;
- (b) a word whose whisper span holds a frame at the speech level less 30 dB is never auto-removed.
Synthetic replicas of the real shapes: tones and noise at set levels, invented words, no real media. Every applied
result is judged by tests/cut_checks.py."""
import random
import re

import pytest

from lib import speech_energy as se
from lib.speech_lines import load_words
from tests.steps import test_cut as tc
from tests.steps import test_cut_v5 as v5

ROOM = -57.0
LEVELS = (-13.0, -15.0, -18.0)


def seq(t, toks, dur=0.26, gap=0.04, levels=LEVELS):
    """Tones for `toks` said from t: [(word, start, end, db)], and the time after the last."""
    out = []
    for k, tok in enumerate(toks):
        out.append((tok, round(t, 3), round(t + dur, 3), levels[k % len(levels)]))
        t += dur + gap
    return out, t


def tones_of(*said):
    return [(a, b, db) for s in said for _, a, b, db in s]


def on_own(said, tail=0.04):
    """Whisper words right on their tones (gapless to the next word's start, as whisper writes them)."""
    return [(w, a, round(b + tail, 3)) for w, a, b, _ in said]


def kinds(d, name="vo"):
    raw = load_words(str(d / f"{name}.json"))
    ref = se.Refiner(0.45)
    ref(name, str(d / f"{name}.mov"), raw)
    return {w.text: k for w, k in zip(raw, ref.kinds[name])}


def gone(tagged):
    """A tag of a removed row: "<t> inaudible" (never the offer, "inaudible?")."""
    return any(t == "inaudible" or t.endswith(" inaudible") for t in tagged)


def removed_rows(text):
    return tc.sections(text)[1]


def tags(text, word):
    """The [tags] of the plan rows (## Cut and ## Unused) holding `word`."""
    out = []
    for ln in text.splitlines():
        if re.search(rf"(^|\s){re.escape(word)}(\s|$|\[)", ln):
            out += re.findall(r"\[([^\]]*)\]", ln)
    return out


# ── the clip start: first words stamped at 0.00, the speech from 1.2 s ─────────────────────────────────────

CLIP_TOKS = "maybe you already know that robots can see now.".split()


def clip_start(t0=1.2, step=0.32, toks=CLIP_TOKS):
    """Speech at -13..-18 from t0 to about 4.1 s over a -57 room; whisper puts the first 3 words at 0.00-1.10 (the
    room) and stretches the rest from t0 over all of the sound (6 words over 9 words' tones)."""
    tones, t = [], t0
    for k in range(len(toks)):
        tones.append((round(t, 2), round(t + step - 0.02, 2), LEVELS[k % 3]))
        t += step
    words = [(toks[0], 0.00, 0.30), (toks[1], 0.30, 0.70), (toks[2], 0.70, 1.10)]
    t = t0
    for tok in toks[3:]:
        words.append((tok, round(t, 2), round(t + 0.48, 2)))
        t += 0.48
    return tones, words, round(tones[-1][1] + 0.9, 2)


def test_a_clips_first_words_stamped_at_zero_take_the_head_of_its_sound(tmp_path, monkeypatch):
    """(A) at a clip edge: the three words in the room before the speech are heard on the head of the first heard
    word's sound, in order; every word plays and stays in ## Cut untagged, and the audio from about 1.15 s plays (the
    lead never cuts sound a kept word owns)."""
    tones, words, total = clip_start()
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, total, words)], room=ROOM)
    k = kinds(d)
    assert all(k[w] == "heard" for w in CLIP_TOKS), k
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == CLIP_TOKS, (said, text)
    assert not removed_rows(text), text
    assert not any("inaudible" in t for w in CLIP_TOKS[:3] for t in tags(text, w)), text
    iv = tc.kept_iv(d)
    assert 1.10 <= iv[0][0] <= 1.2 - 0.02 and v5.cover(d, 1.2, tones[-1][1]) > 0.99, iv
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones))


def test_each_clips_first_words_stamped_at_zero_play(tmp_path, monkeypatch):
    """The same in the second clip (the real file's every clip): never removed, the clip's first line kept."""
    tones, words, total = clip_start()
    t2, w2, total2 = clip_start(t0=0.9, toks="check out the old phone mount on this bike.".split())
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, total, words), ("vo2", t2, total2, w2)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words] + [w for w, _, _ in w2], (said, text)
    assert not removed_rows(text), text
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones) + v5.kept_tones("vo2", t2))


# ── a span stretched 11 s over a 9 s pause, its sound at the end ───────────────────────────────────────────

def stretched():
    """'we built a' then a 9 s pause, then 'computer to decide how the robot moves.' (2 s of sound at the end). Whisper
    puts 'computer' in the pause, stretches 'to' 11 s over it to the end of the sound, and stamps the rest after it,
    in the room."""
    a, _ = seq(0.5, "we built a".split())
    b, t = seq(10.5, "computer to decide how the robot moves.".split())
    words = on_own(a) + [("computer", 1.40, 1.70), ("to", 1.70, 12.70), ("decide", 12.70, 12.95),
                         ("how", 12.95, 13.15), ("the", 13.15, 13.30), ("robot", 13.30, 13.55), ("moves.", 13.55, 13.80)]
    return a, b, words, round(t + 1.4, 2)


def test_a_span_stretched_over_a_long_pause_shares_its_sound_in_order(tmp_path, monkeypatch):
    a, b, words, total = stretched()
    d = v5.project(tmp_path, monkeypatch, [("vo", tones_of(a, b), total, words)], room=ROOM)
    k = kinds(d)
    assert all(v == "heard" for v in k.values()), k
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, text)
    assert not removed_rows(text), text
    assert v5.cover(d, 10.5, b[-1][2]) > 0.99, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones_of(a, b)))


# ── a whole phrase shifted 2 s early ─────────────────────────────────────────────────────────────────────────

def shifted():
    a, t = seq(0.5, "first we start".split())
    b, t = seq(t + 2.6, "then the phrase moves".split())
    c, t = seq(t + 0.6, "and it ends.".split())
    words = on_own(a) + [(w, round(x - 2.0, 3), round(y - 2.0 + 0.04, 3)) for w, x, y, _ in b] + on_own(c)
    return a, b, c, words, round(t + 0.8, 2)


def test_a_phrase_shifted_two_seconds_early_takes_its_unclaimed_sound(tmp_path, monkeypatch):
    """(a): the phrase's spans lie in the silence before its sound, which no word holds: the phrase is placed on it in
    order and plays, heard."""
    a, b, c, words, total = shifted()
    d = v5.project(tmp_path, monkeypatch, [("vo", tones_of(a, b, c), total, words)], room=ROOM)
    k = kinds(d)
    assert all(k[w] == "heard" for w, *_ in b), k
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, text)
    assert not removed_rows(text), text
    assert v5.cover(d, b[0][1], b[-1][2]) > 0.99, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones_of(a, b, c)))


def test_a_shifted_phrase_takes_its_own_run_not_the_neighbours(tmp_path, monkeypatch):
    """Placed on the unclaimed run, each word gets a share of it in order; the heard words keep their own sound."""
    a, b, c, words, total = shifted()
    d = v5.project(tmp_path, monkeypatch, [("vo", tones_of(a, b, c), total, words)], room=ROOM)
    raw = load_words(str(d / "vo.json"))
    ref = se.Refiner(0.45)
    placed, _, _ = ref("vo", str(d / "vo.mov"), raw)
    ph = placed[3:7]
    assert ph[0].start >= b[0][1] - 0.05 and ph[-1].end <= b[-1][2] + 0.05, ph
    assert all(x.end <= y.start + 1e-6 for x, y in zip(ph, ph[1:])), ph
    assert placed[2].end <= a[-1][2] + 0.05 and placed[7].start >= c[0][1] - 0.05, placed


# ── a run of truly silent words: still inaudible ─────────────────────────────────────────────────────────────

def test_a_run_of_words_with_no_sound_between_its_neighbours_goes_as_inaudible(tmp_path, monkeypatch):
    """'zin zan' stamped in a 2 s silence between two heard words that fit their text, no unclaimed sound between
    them: removed, tagged inaudible (decision Q4: a LONE such word is folded and offered, so the run is two)."""
    a, t = seq(0.5, "we went".split())
    c, t = seq(t + 2.0, "back home.".split())
    words = on_own(a) + [("zin", a[-1][2] + 0.7, a[-1][2] + 1.0), ("zan", a[-1][2] + 1.0, a[-1][2] + 1.3)] + on_own(c)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones_of(a, c), round(t + 0.8, 2), words)], room=ROOM)
    k = kinds(d)
    assert k["zin"] == k["zan"] == "inaudible", k
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == ["we", "went", "back", "home."], (said, text)
    assert gone(tags(text, "zin")) and gone(tags(text, "zan")), text
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones_of(a, c)))


# ── (B): the lone-word fold, offered, never to ## Unused ─────────────────────────────────────────────────────

def test_a_lone_silent_word_between_heard_words_is_folded_and_offered(tmp_path, monkeypatch):
    """(B): one word in a silence between two heard words that fit their text: folded against its neighbour's sound,
    kept in ## Cut and offered inaudible?, and the neighbour's sound plays from its onset."""
    a, t = seq(0.5, "we went".split())
    c, t = seq(t + 2.0, "back home.".split())
    words = on_own(a) + [("zin", a[-1][2] + 0.7, a[-1][2] + 1.0)] + on_own(c)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones_of(a, c), round(t + 0.8, 2), words)], room=ROOM)
    assert kinds(d)["zin"] == "folded"
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    cut, unused = tc.sections(text)
    assert any(re.search(r"\bzin\b", r) for r in cut) and not any(re.search(r"\bzin\b", r) for r in unused), text
    assert "zin" in said and "zin [inaudible?]" in plan.get("cut", ""), (said, plan.get("cut"))
    assert all(v5.cover(d, x, y) > 0.99 for _, x, y, _ in a + c), tc.kept_iv(d)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones_of(a, c)))


def test_the_videos_first_word_with_sound_in_its_span_is_never_sent_to_unused(tmp_path, monkeypatch):
    """(b) and the edge rule: the video's first word's span ends 30 ms into the next word's onset (that sound is the
    next word's), so none of it is its own; it holds a frame at the speech level less 30 dB, so it is never removed
    (inaudible, tail or edge): kept in ## Cut, at most offered."""
    c, t = seq(0.6, "we went out today.".split())
    words = [("so", 0.10, 0.63)] + on_own(c)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones_of(c), round(t + 0.8, 2), words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    cut, unused = tc.sections(text)
    assert said[0] == "so" and all(r.endswith("?]") for r in unused), (said, text)     # an offer at most
    assert not gone(tags(text, "so")), text
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones_of(c)))


# ── FIX 3: silence-threshold on transcribed clips ───────────────────────────────────────────────────────────

def test_a_silence_threshold_on_speech_clips_is_warned(tmp_path, monkeypatch):
    c, t = seq(0.5, "we went out today.".split())
    d = v5.project(tmp_path, monkeypatch, [("vo", tones_of(c), round(t + 0.8, 2), on_own(c))], room=ROOM)
    plan, _ = tc.run(d, "--silence-threshold", "-42", monkeypatch=monkeypatch)
    msg = ("silence-threshold only changes clips with no transcript; speech clips use their own speech level.")
    assert msg in plan.get("warnings", []), plan.get("warnings")
    plan2, _ = tc.run(d, "--recut", monkeypatch=monkeypatch)
    assert msg not in plan2.get("warnings", []), plan2.get("warnings")


# ── the drift fuzz: per-word drift up to 3 s, first words at 0.0 ─────────────────────────────────────────────

def drift_fuzz(seed, drift=3.0):
    """Loud words (every one a real word the person keeps) in lines with pauses of up to 2.5 s; whisper's starts drift
    up to `drift` s each way, in order (never past the clip's last sound), and the first 1-3 words are stamped from 0.0
    (squeezed into the room before the speech)."""
    rnd = random.Random(5000 + seed)
    n = rnd.randint(6, 14)
    toks = rnd.sample(v5.VOCAB, n)
    t = round(rnd.uniform(0.8, 2.0), 2)
    tones = []
    for k in range(n):
        dur = rnd.choice((0.15, 0.22, 0.3, 0.4))
        tones.append((t, round(t + dur, 2), rnd.choice((-12.0, -15.0, -18.0, -22.0))))
        t = round(t + dur + rnd.choice([0.02, 0.05, 0.1, 0.3, 0.6, 1.2, 2.5]), 2)
    end = round(t + 1.0, 2)
    first = rnd.randint(1, 3)
    starts = []
    for k in range(n):
        if k < first:
            s = round(k * min(0.3, tones[0][0] / (first + 1)), 3)
        else:
            # never wholly after the clip's last sound: words stamped there over the room are whisper's made-up tail,
            # which the tail rule removes on purpose (review A should-fix 5), whatever their text
            s = min(tones[-1][1] - 0.05, max(0.0, tones[k][0] + rnd.uniform(-drift, drift)))
        if starts:
            s = max(s, starts[-1] + 0.02)
        starts.append(round(s, 3))
    words = []
    for k, tok in enumerate(toks):
        b = starts[k + 1] if k + 1 < n else min(end - 0.05, max(starts[k] + 0.2, tones[k][1]))
        words.append((tok + ("." if k + 1 == n else ""), starts[k], round(b, 3)))
    return tones, words, end


@pytest.mark.parametrize("seed", range(80))
def test_the_seconds_drift_fuzz_removes_no_real_word(tmp_path, monkeypatch, seed):
    """Every word is real and loud: none is removed (inaudible, tail, edge), every loud frame plays, and every
    cut_checks column is 0."""
    tones, words, end = drift_fuzz(seed)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones, end, words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, words, tones, text)
    v5.checked(d, plan, applied, before, v5.kept_tones("vo", tones))


def test_the_stamp_names_the_ordered_placement():
    assert se.VERSION.endswith("v5d") and "VERSION" not in se._STAMPED       # v5d: §577 cut voice, 5.36.2
    for name in ("ORDERED_MIN_S", "ATTACHED_OVER_ROOM_DB", "LETTER_S"):
        assert f"{name}=" in se.Refiner.stamp, name
