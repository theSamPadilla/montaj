"""§577 cut (lib/speech_energy.place):
- a run of words with no voiced audio anywhere between its neighbours is inaudible;
- (b) a word whose whisper span holds a frame at the speech level less 30 dB is never auto-removed.
Synthetic replicas of the real shapes: tones and noise at set levels, invented words, no real media. Every applied
result is judged by tests/cut_checks.py."""
import re

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


def tags(text, word):
    """The [tags] of the plan rows (## Cut and ## Unused) holding `word`."""
    out = []
    for ln in text.splitlines():
        if re.search(rf"(^|\s){re.escape(word)}(\s|$|\[)", ln):
            out += re.findall(r"\[([^\]]*)\]", ln)
    return out


# ── a run of truly silent words: still inaudible ─────────────────────────────────────────────────────────────

def test_a_run_of_words_with_no_sound_between_its_neighbours_goes_as_inaudible(tmp_path, monkeypatch):
    """'zin zan' stamped in a 2 s silence between two heard words that fit their text, no unclaimed sound between
    them: removed, tagged inaudible."""
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


def test_the_videos_first_word_with_sound_in_its_span_is_never_sent_to_unused(tmp_path, monkeypatch):
    """(b) and the edge rule: the video's first word's span ends 30 ms into the next word's onset (that sound is the
    next word's), so none of it is its own; it holds a frame at the speech level less 30 dB, so it is never removed
    (inaudible, tail or edge): kept in ## Cut."""
    c, t = seq(0.6, "we went out today.".split())
    words = [("so", 0.10, 0.63)] + on_own(c)
    d = v5.project(tmp_path, monkeypatch, [("vo", tones_of(c), round(t + 0.8, 2), words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    cut, unused = tc.sections(text)
    assert said[0] == "so" and not any(re.search(r"\bso\b", r) for r in unused), (said, text)
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


def test_the_stamp_names_the_placement():
    assert se.VERSION.endswith("v6") and "VERSION" not in se._STAMPED       # v6: per-run words, no drift folding
    for name in ("ATTACHED_OVER_ROOM_DB", "LETTER_S", "FOLD_S", "INAUDIBLE_S"):
        assert f"{name}=" in se.Refiner.stamp, name
