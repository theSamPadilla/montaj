"""Tests for steps/lyrics/lyrics_sync.py: model selection and lyric alignment."""
import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
_STEP_PATH = REPO_ROOT / "steps" / "lyrics" / "lyrics_sync.py"


def _load_step():
    spec = importlib.util.spec_from_file_location("lyrics_sync_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Stop(Exception):
    pass


def test_default_model_is_turbo():
    assert _load_step().WHISPER_MODEL == "large-v3-turbo-q5_0"


def test_model_goes_through_resolve_whisper_model(tmp_path, monkeypatch):
    """lyrics_sync picks its weight via resolve_whisper_model, so a requested
    model that is not installed falls back like every other whisper step."""
    mod = _load_step()
    audio = tmp_path / "vocals.wav"
    audio.write_bytes(b"x")
    lyrics = tmp_path / "lyrics.txt"
    lyrics.write_text("hello world\n")

    calls = []

    def fake_resolve(model, language):
        calls.append((model, language))
        raise _Stop()

    monkeypatch.setattr(mod, "resolve_whisper_model", fake_resolve)
    monkeypatch.setattr(sys, "argv", [
        "lyrics_sync.py", "--input", str(audio), "--lyrics", str(lyrics),
        "--model", "base.en", "--language", "es",
    ])
    with pytest.raises(_Stop):
        mod.main()
    assert calls == [("base.en", "es")]


# ── alignment: pure functions, no whisper ─────────────────────────────────────
# Made-up lyrics. A1 and A2 are verse lines; B1..B3 are a chorus that repeats.
A1 = "red lights over the water"
B1 = "we keep on running"
B2 = "tell me what you want"
B3 = "tell me what you need"
A2 = "cold hands in the morning"
CHORUS = [B1, B2, B3]
SONG = [A1, *CHORUS, A2, *CHORUS]

# Whisper mishears one word of the first chorus and A2's last word, so the
# second chorus is the only exact copy. Longest-block-first matching gave that
# copy to the FIRST written chorus and everything after collapsed onto the end.
MISHEARD = {(2, 4): "won't", (4, 4): "mornin'"}


def _groups(lines):
    return [line.split() for line in lines]


def _heard(lines, misheard=MISHEARD):
    """Whisper words for `lines`: line k at 4k s, words 0.5 s apart, 0.4 s long."""
    words = []
    for k, line in enumerate(lines):
        for i, w in enumerate(line.split()):
            start = 4.0 * k + 0.5 * i
            words.append({"word": misheard.get((k, i), w), "start": start, "end": start + 0.4})
    return words


def _assert_in_own_slot(segments, n_heard):
    """Each of the first `n_heard` lines starts inside its own 4 s slot."""
    starts = [s["start"] for s in segments]
    off = [(k, s) for k, s in enumerate(starts[:n_heard]) if not 4 * k <= s < 4 * k + 4]
    assert not off, f"lines outside their slot (line, start): {off}; all line starts: {starts}"


def _assert_word_starts_non_decreasing(segments):
    starts = [w["start"] for s in segments for w in s["words"]]
    back = [(k, starts[k - 1], starts[k]) for k in range(1, len(starts)) if starts[k] < starts[k - 1]]
    assert not back, f"word starts go backwards (index, prev, this): {back}"


def test_a_repeated_chorus_lands_on_its_own_audio():
    """The tie that broke the song: every line lands in its own slot."""
    segs = _load_step().align(_groups(SONG), _heard(SONG))
    assert len(segs) == len(SONG)
    _assert_in_own_slot(segs, len(SONG))
    _assert_word_starts_non_decreasing(segs)


def test_detect_window_spans_first_anchor_to_last():
    assert _load_step().detect_window(_heard(SONG), _groups(SONG)) == (0.0, 30.4)


def test_chorus_written_three_times_heard_twice():
    """Tie order: the unheard third chorus must not take the second chorus's
    audio. Backtracking that prefers the diagonal on a tie gives the audio to
    the LAST written copy and squeezes chorus 2 in before it."""
    segs = _load_step().align(_groups(SONG + CHORUS), _heard(SONG))
    assert len(segs) == len(SONG) + len(CHORUS)
    _assert_in_own_slot(segs, len(SONG))
    _assert_word_starts_non_decreasing(segs)


def test_whisper_words_after_the_lyrics_cost_nothing():
    """Free trailing end: an ad-lib that repeats the last line after the song
    (heard at 32 s) must not pull the written last line off its own audio."""
    segs = _load_step().align(_groups(SONG), _heard(SONG + [B3]))
    _assert_in_own_slot(segs, len(SONG))
    _assert_word_starts_non_decreasing(segs)


def test_symbols_and_cyrillic_never_anchor():
    """`♪`, `—` and `&` normalize to '' and '' matches nothing, so they never
    match each other; a Cyrillic line keeps its letters and so never matches a
    symbol either (it used to normalize to '' and take whisper's `♪`)."""
    mod = _load_step()
    assert [mod.normalize(t) for t in ("♪", "—", "&")] == ["", "", ""]
    assert mod.normalize("Привет,") == "привет"

    groups = _groups(["♪", "— &", "привет тёмный мир", A1])
    symbols = [{"word": t, "start": float(k), "end": k + 0.4} for k, t in enumerate(["♪", "&", "—"])]
    real = [{"word": w, "start": 20.0 + 0.5 * i, "end": 20.4 + 0.5 * i} for i, w in enumerate(A1.split())]
    w_words = symbols + real

    assert mod.detect_window(w_words, groups) == (20.0, 22.4)

    segs = mod.align(groups, w_words)
    symbol_times = {(w["start"], w["end"]) for w in symbols}
    took = [(w["word"], w["start"]) for s in segs[:3] for w in s["words"]
            if (w["start"], w["end"]) in symbol_times]
    assert not took, f"lyric words took a whisper symbol's timing: {took}"
    assert [w["start"] for w in segs[3]["words"]] == [20.0, 20.5, 21.0, 21.5, 22.0]

    assert mod._align_tokens(["", "", ""], ["", "", ""]) == {}


def test_no_shared_word_means_no_alignment():
    """Zero anchors: align returns [] so main fails alignment_failed, instead of
    emitting a track of zeros."""
    mod = _load_step()
    groups = _groups(["red lights", "over the water"])
    w_words = [{"word": w, "start": 0.5 * i, "end": 0.5 * i + 0.4}
               for i, w in enumerate("blue moon rising slow".split())]
    assert mod.align(groups, w_words) == []
    assert mod.detect_window(w_words, groups) == (None, None)


def test_a_thousand_words_align_in_under_two_seconds():
    """Size guard for the pure-Python O(n*m) alignment."""
    import random
    import time

    rng = random.Random(7)
    vocab = [f"{a}{b}" for a in ("ba", "do", "ki", "lu", "mo", "ne", "ra", "so", "ti", "vu")
             for b in ("la", "me", "no", "pi", "ru", "sa", "te", "wo", "xi", "zo")]
    lyric = [rng.choice(vocab) for _ in range(1000)]
    heard = [rng.choice(vocab) if rng.random() < 0.1 else w for w in lyric]
    groups = [lyric[k:k + 8] for k in range(0, 1000, 8)]
    w_words = [{"word": w, "start": 0.3 * i, "end": 0.3 * i + 0.25} for i, w in enumerate(heard)]

    mod = _load_step()
    t0 = time.perf_counter()
    segs = mod.align(groups, w_words)
    elapsed = time.perf_counter() - t0
    assert len(segs) == len(groups)
    assert elapsed < 2.0, f"aligning 1000 x 1000 words took {elapsed:.2f} s"
