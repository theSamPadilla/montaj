"""lib/caption_timing.py: caption word times fitted to the audio's pauses.

The word lists below have the shapes measured on real talking-head speech with
the app's whisper (see the module doc); the timings are invented for the test.
"""
import pytest

from lib.caption_timing import (
    MIN_PAUSE_S, assign_regions, caption_pauses, fit_transcription, fit_words, speech_regions,
)


def W(*spec):
    return [{"text": t, "start": a, "end": b} for t, a, b in spec]


def by_text(words):
    return {w["text"]: w for w in words}


def centred_in(w, pauses):
    mid = (w["start"] + w["end"]) / 2
    return any(a + 1e-6 < mid < b - 1e-6 for a, b in pauses)


def check_invariants(before, after, pauses, duration):
    assert [w["text"] for w in after] == [w["text"] for w in before]
    for w in after:
        assert 0.0 <= w["start"] <= w["end"] <= duration + 1e-9
        assert not centred_in(w, pauses), w
    assert all(after[i]["start"] <= after[i + 1]["start"] + 1e-9 for i in range(len(after) - 1))


# ── pauses and regions ───────────────────────────────────────────────────────

def test_caption_pauses_merges_close_silences_and_drops_short_ones():
    silences = [(0.0, 0.55), (0.67, 0.78), (0.96, 1.03), (1.05, 5.82), (7.15, 7.47), (9.0, 9.1)]
    assert caption_pauses(silences, 10.0) == [(0.0, 0.55), (0.96, 5.82), (7.15, 7.47)]
    assert all(b - a >= MIN_PAUSE_S for a, b in caption_pauses(silences, 10.0))


def test_caption_pauses_clips_to_the_duration():
    assert caption_pauses([(-0.1, 0.5), (9.5, 10.4)], 10.0) == [(0.0, 0.5), (9.5, 10.0)]


def test_speech_regions_are_the_gaps_between_pauses():
    assert speech_regions([(0.0, 1.0), (3.0, 3.5)], 5.0) == [(1.0, 3.0), (3.5, 5.0)]
    assert speech_regions([], 5.0) == [(0.0, 5.0)]


# ── fitting ──────────────────────────────────────────────────────────────────

def test_no_pause_leaves_the_words_unchanged():
    words = W(("Hello", 0.0, 0.5), ("world", 0.5, 1.1))
    assert fit_words(words, [], 2.0) == words


def test_words_spread_over_a_leading_silence_move_onto_the_speech():
    # whisper times "But often at a cost" across 1.7 s of silence at the start.
    words = W(("But", 0.0, 0.34), ("often", 0.34, 0.92), ("at", 0.92, 1.15), ("a", 1.15, 1.65),
              ("cost", 1.65, 1.72), ("of", 1.72, 1.95), ("significant", 1.95, 3.26), ("investment", 3.26, 4.38))
    pauses = [(0.0, 1.66), (4.5, 5.2)]
    out = fit_words(words, pauses, 5.2)
    check_invariants(words, out, pauses, 5.2)
    assert out[0]["start"] == pytest.approx(1.66)
    assert out[-1]["end"] == pytest.approx(4.5)


def test_the_word_after_a_long_pause_starts_where_speech_resumes():
    # "tasks." swallows a 3.6 s pause; "Grippers" is timed 0.4 s after speech resumes.
    words = W(("many", 10.56, 10.82), ("tasks.", 10.82, 15.46), ("Grippers", 15.46, 16.0), ("hit", 16.0, 16.3))
    pauses = [(11.44, 15.04)]
    out = by_text(fit_words(words, pauses, 17.0))
    assert out["tasks."]["end"] <= 11.44 + 1e-9
    assert out["Grippers"]["start"] == pytest.approx(15.04)


def test_a_phrase_final_word_timed_inside_the_pause_stays_before_it():
    # "...become more | dexterous." with "dexterous." timed late, across the pause.
    words = W(("become", 17.17, 17.56), ("more", 17.56, 17.82), ("dexterous.", 17.82, 18.86), ("Think", 18.86, 19.38))
    pauses = [(17.77, 18.53)]
    out = by_text(fit_words(words, pauses, 20.0))
    assert out["dexterous."]["end"] <= 17.77 + 1e-9
    assert out["Think"]["start"] == pytest.approx(18.53)


def test_words_after_the_last_phrase_end_go_after_the_pause():
    # "...investment in | R&D. | The argument": R&D. ends the phrase, "The" starts the next.
    words = W(("in", 4.38, 4.72), ("R&D.", 4.72, 5.0), ("The", 5.0, 5.25), ("argument", 5.25, 5.91), ("is", 5.91, 6.65))
    pauses = [(4.58, 5.59)]
    regions = speech_regions(pauses, 7.0)
    a = assign_regions(words, pauses, 7.0)
    assert [regions[r][0] for r in a] == [0.0, 0.0, 5.59, 5.59, 5.59]


def test_a_phrase_end_at_the_resume_does_not_pull_words_back():
    # "example," starts just before speech resumes (measured: 5.82 against a pause
    # ending 5.8205): it is after the pause, as are the words whisper put inside it.
    words = W(("a", 1.35, 1.69), ("gripper", 1.69, 4.04), ("for", 4.04, 5.82), ("example,", 5.82, 7.55))
    pauses = [(0.0, 0.5), (0.96, 5.83)]
    out = by_text(fit_words(words, pauses, 8.0))
    assert out["a"]["start"] == pytest.approx(5.83)


def test_a_zero_length_word_inside_speech_stays_in_its_region():
    # whisper's "our" 9.74-9.74 sits inside speech; it must not drag "human tools." after the pause.
    words = W(("with", 9.39, 9.74), ("our", 9.74, 9.74), ("human", 9.74, 10.58), ("tools.", 10.58, 11.0),
              ("You", 11.0, 11.2), ("will", 11.2, 11.47))
    pauses = [(10.45, 11.28)]
    out = by_text(fit_words(words, pauses, 12.0))
    assert out["tools."]["end"] <= 10.45 + 1e-9
    assert out["You"]["start"] == pytest.approx(11.28)


def test_a_word_wholly_inside_a_pause_with_no_phrase_end_goes_after_it():
    words = W(("over", 1.0, 1.4), ("there", 2.0, 2.4), ("now", 3.1, 3.5))
    pauses = [(1.5, 3.0)]
    out = by_text(fit_words(words, pauses, 4.0))
    assert out["there"]["start"] == pytest.approx(3.0)
    assert out["over"]["end"] <= 1.5 + 1e-9


def test_region_words_with_no_span_share_it_by_letters():
    words = W(("a", 2.0, 2.0), ("bbb", 2.0, 2.0))
    out = fit_words(words, [(0.0, 1.0)], 3.0)
    assert out[0]["start"] == pytest.approx(1.0)
    assert out[1]["end"] == pytest.approx(3.0)
    assert out[1]["end"] - out[1]["start"] == pytest.approx(3 * (out[0]["end"] - out[0]["start"]))


def test_fit_words_never_mutates_its_input():
    words = W(("x", 0.0, 1.0), ("y", 1.0, 2.0))
    snapshot = [dict(w) for w in words]
    fit_words(words, [(0.2, 0.9)], 2.0)
    assert words == snapshot


# ── whisper JSON entries ─────────────────────────────────────────────────────

def test_fit_transcription_keeps_the_whisper_shape_and_non_word_entries():
    entries = [
        {"text": " Hello", "offsets": {"from": 0, "to": 500}, "timestamps": {}},
        {"text": " world", "offsets": {"from": 600, "to": 1200}},
        {"text": "", "offsets": {"from": 1200, "to": 1200}},
        {"text": " again", "offsets": {"from": 1200, "to": 2800}},
    ]
    out = fit_transcription(entries, [(0.5, 1.5)], 3.0)
    assert [e["text"] for e in out] == [e["text"] for e in entries]
    assert out[0]["offsets"] == {"from": 0, "to": 500}
    assert out[1]["offsets"]["from"] == 1500
    assert all(isinstance(v, int) for e in out for v in e["offsets"].values())
    assert out[2]["offsets"]["from"] == out[2]["offsets"]["to"] == out[1]["offsets"]["to"]
    assert entries[1]["offsets"] == {"from": 600, "to": 1200}  # input untouched
