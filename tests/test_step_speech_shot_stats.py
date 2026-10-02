"""transcribe.speech_stats and detect_shots.cuts_per_min: pure functions, no ffmpeg or whisper."""
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "lib"))
sys.path.insert(0, str(ROOT / "steps" / "speech"))
sys.path.insert(0, str(ROOT / "steps" / "media"))
import detect_shots  # noqa: E402
import transcribe  # noqa: E402


def _w(text, start_ms, end_ms):
    return {"text": text, "offsets": {"from": start_ms, "to": end_ms}}


def test_three_words_over_1_5s_is_120_wpm():
    data = {"transcription": [_w(" one", 0, 500), _w(" two", 500, 1000), _w(" three", 1000, 1500)]}
    assert transcribe.speech_stats(data) == {"word_count": 3, "speech_s": 1.5, "wpm": 120.0}


def test_punctuation_only_entries_are_not_words():
    data = {"transcription": [_w(" ,", 0, 100), _w(" hi", 200, 700), _w(" .", 700, 800), _w(" 42", 700, 1200)]}
    s = transcribe.speech_stats(data)
    assert s["word_count"] == 2 and s["speech_s"] == 1.0 and s["wpm"] == 120.0


def test_span_runs_from_first_counted_word_to_last_counted_word():
    data = {"transcription": [_w(" ...", 0, 3000), _w(" a", 3000, 3500), _w(" b", 3500, 4000), _w(" .", 4000, 9000)]}
    assert transcribe.speech_stats(data)["speech_s"] == 1.0


def test_one_word_with_zero_span_is_wpm_0():
    s = transcribe.speech_stats({"transcription": [_w(" hi", 1000, 1000)]})
    assert s == {"word_count": 1, "speech_s": 0.0, "wpm": 0}


def test_empty_list_gives_zeros():
    assert transcribe.speech_stats({"transcription": []}) == {"word_count": 0, "speech_s": 0.0, "wpm": 0}
    assert transcribe.speech_stats({}) == {"word_count": 0, "speech_s": 0.0, "wpm": 0}


def test_wpm_rounds_to_one_decimal():
    data = {"transcription": [_w(" a", 0, 100), _w(" b", 100, 100), _w(" c", 100, 7000)]}
    s = transcribe.speech_stats(data)
    assert s["wpm"] == round(3 / (7.0 / 60), 1)


def test_cuts_per_min():
    assert detect_shots.cuts_per_min([{}] * 15, 60) == 14.0
    assert detect_shots.cuts_per_min([{}], 60) == 0.0
    assert detect_shots.cuts_per_min([{}] * 15, 0) == 0.0
    assert detect_shots.cuts_per_min([], 60) == 0.0
    assert detect_shots.cuts_per_min([{}] * 4, 45.5) == round(3 / (45.5 / 60), 1)
