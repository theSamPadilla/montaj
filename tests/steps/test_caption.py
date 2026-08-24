"""Tests for steps/caption.py — pure Python, no external dependencies."""
import json
import pytest
from tests.conftest import run_step, assert_file_output, assert_error
from steps.lyrics.caption import floor_word_durations, MIN_WORD_DURATION_S


def test_caption_produces_track(transcript_json, tmp_path):
    out = tmp_path / "captions.json"
    proc = run_step("caption.py", "--input", str(transcript_json), "--out", str(out))
    assert_file_output(proc)
    data = json.loads(out.read_text())
    assert "style" in data
    assert "segments" in data
    assert len(data["segments"]) > 0


def test_caption_default_style(transcript_json, tmp_path):
    out = tmp_path / "captions.json"
    run_step("caption.py", "--input", str(transcript_json), "--out", str(out))
    data = json.loads(out.read_text())
    assert data["style"] == "word-by-word"


def test_caption_style_karaoke(transcript_json, tmp_path):
    out = tmp_path / "captions.json"
    run_step("caption.py", "--input", str(transcript_json), "--style", "karaoke", "--out", str(out))
    data = json.loads(out.read_text())
    assert data["style"] == "karaoke"


def test_caption_segment_has_words(transcript_json, tmp_path):
    out = tmp_path / "captions.json"
    run_step("caption.py", "--input", str(transcript_json), "--out", str(out))
    data = json.loads(out.read_text())
    for seg in data["segments"]:
        assert "text" in seg
        assert "start" in seg
        assert "end" in seg
        assert "words" in seg
        assert seg["end"] >= seg["start"]


def test_caption_groups_words(transcript_json, tmp_path):
    out = tmp_path / "captions.json"
    run_step("caption.py", "--input", str(transcript_json), "--out", str(out))
    data = json.loads(out.read_text())
    # 6 words → should produce at least 1 segment
    assert len(data["segments"]) >= 1
    total_words = sum(len(s["words"]) for s in data["segments"])
    assert total_words == 6


def test_caption_auto_output_path(transcript_json):
    proc = run_step("caption.py", "--input", str(transcript_json))
    from tests.conftest import assert_file_output
    out = assert_file_output(proc)
    assert out.name.endswith("_captions.json")


def test_caption_missing_input():
    proc = run_step("caption.py", "--input", "/nonexistent/words.json")
    assert_error(proc, "file_not_found")


# ── floor_word_durations — waterfall matrix ─────────────────────────────────
#
# `MIN_WORD_DURATION_S` is 50ms, in seconds not frames (steps/lyrics/caption.py
# doesn't know the project's fps at this point in the pipeline). The waterfall
# uses a binary donation gate: a shared boundary moves fully or not at all,
# never partially — see floor_word_durations' docstring for why a partial
# donation would reproduce the word-by-word template's invisibility bug.

def _w(start, end, word="w"):
    return {"word": word, "start": start, "end": end}


def test_min_word_duration_is_50ms():
    assert MIN_WORD_DURATION_S == 0.05


def test_floor_empty_list():
    assert floor_word_durations([]) == []


def test_floor_single_word_list_extends_to_the_floor():
    # Pins the n == 1 path: with no words after it, `i + 1 >= n` is already
    # true at i=0, routing a single short word straight into the
    # transcript-final branch -- unconditional extension, same as any other
    # transcript-final word.
    words = [_w(0, 0.02)]
    out = floor_word_durations(words, floor_s=0.05)
    assert out[0]["start"] == pytest.approx(0)
    assert out[0]["end"] == pytest.approx(0.05)


def test_floor_donation_accepted():
    # Worked example from the plan: successor retains 0.400 - 0.050 = 0.350 >= floor.
    words = [_w(0, 0.020), _w(0.020, 0.400)]
    out = floor_word_durations(words, floor_s=0.05)
    assert out[0]["start"] == pytest.approx(0)
    assert out[0]["end"] == pytest.approx(0.050)
    assert out[1]["start"] == pytest.approx(0.050)
    assert out[1]["end"] == pytest.approx(0.400)


def test_floor_successor_retains_exactly_floor_donation_accepted():
    # Pins the INCLUSIVE boundary of the donation gate: the spec says the
    # donation is accepted "iff the successor would retain >= floor_s" -- not
    # "> floor_s". No other test in this matrix distinguishes >= from >, so
    # without this one someone could weaken the operator and the suite would
    # stay green. Constructed so the arithmetic is exact and not float-luck:
    # candidate_boundary = 0 + 0.05 = 0.05; successor_new_dur =
    # 0.10 - 0.05 = 0.05 == floor_s exactly (verified in both Python and the
    # TS runtime -- no representation error at these values). Word 1's own
    # original duration (0.08) is already >= floor, so this case is also
    # clean of the final-word rule: word 1 never enters the "short" branch at
    # all, in either its pre- or post-donation state.
    words = [_w(0, 0.02), _w(0.02, 0.10)]
    out = floor_word_durations(words, floor_s=0.05)
    assert out[0]["start"] == pytest.approx(0)
    assert out[0]["end"] == pytest.approx(0.05)
    assert out[1]["start"] == pytest.approx(0.05)
    assert out[1]["end"] == pytest.approx(0.10)


def test_floor_donation_refused():
    # Successor would retain only 0.060 - 0.050 = 0.010 < floor: refused, word
    # i is left completely unchanged (no partial donation). The plan's
    # worked example writes this pair's outcome as "unchanged" -- read
    # literally against a 2-word list that is genuinely inconsistent, since
    # word 1 here is independently short (0.040 < floor) AND
    # transcript-final, so the separate final-word rule fires on IT too. The
    # "unchanged" in the plan's prose refers to word 0, the subject of the
    # refused donation -- a refused donation confers no immunity on the
    # successor, and the donation-gate guarantee under test is scoped to
    # word 0 only. See test_floor_final_word_at_exactly_floor_duration_unchanged
    # and test_floor_final_word_comfortably_above_floor_unchanged below for the
    # complementary case: a final word that is NOT short is never touched,
    # so "extend unconditionally" means "skip the successor-retention gate
    # once a word already qualified as short", not "always pad the last word".
    words = [_w(0, 0.020), _w(0.020, 0.060)]
    out = floor_word_durations(words, floor_s=0.05)
    assert out[0] == _w(0, 0.020)
    assert out[1]["start"] == pytest.approx(0.020)
    assert out[1]["end"] == pytest.approx(0.070)


def test_floor_final_word_at_exactly_floor_duration_unchanged():
    # Pins the final-word rule's TRIGGER condition, not just its extension.
    # A final word already AT the floor does not qualify as short (the
    # `dur >= floor_s` skip fires first) -- "extend unconditionally" only
    # describes skipping the successor-retention gate once a word is
    # confirmed short; it never means "every transcript's last word gets
    # padded by up to 50ms regardless of its current duration."
    words = [_w(0, 0.5), _w(0.5, 0.55)]  # duration exactly 0.05 == floor
    out = floor_word_durations(words, floor_s=0.05)
    assert out == words


def test_floor_final_word_comfortably_above_floor_unchanged():
    words = [_w(0, 0.5), _w(0.5, 0.62)]  # duration 0.12, well above floor
    out = floor_word_durations(words, floor_s=0.05)
    assert out == words


def test_floor_starved_run_entirely_unchanged():
    # Every donation in this run is refused (each successor would drop below
    # the floor), and the final word isn't short, so the final-word rule
    # never fires. The floor's contract is "never make timing worse" — this
    # run comes back byte-for-byte identical.
    words = [_w(0, 0.02), _w(0.02, 0.04), _w(0.04, 0.06), _w(0.06, 0.11)]
    out = floor_word_durations(words, floor_s=0.05)
    assert out == words


def test_floor_starved_run_rescued_by_trailing_long_word():
    # Same starved run, but the run now ends in a long word. The gate is
    # per-boundary, not per-run: the first two donations are still refused,
    # but the last short word's boundary with the long word IS accepted.
    words = [_w(0, 0.02), _w(0.02, 0.04), _w(0.04, 0.06), _w(0.06, 0.50)]
    out = floor_word_durations(words, floor_s=0.05)
    assert out[0] == _w(0, 0.02)
    assert out[1] == _w(0.02, 0.04)
    assert out[2]["start"] == pytest.approx(0.04)
    assert out[2]["end"] == pytest.approx(0.09)
    assert out[3]["start"] == pytest.approx(0.09)
    assert out[3]["end"] == pytest.approx(0.50)


def test_floor_noncontiguous_extends_into_existing_gap():
    # A gap after word i is spent up to the floor, never touching the
    # successor's start.
    words = [_w(0, 0.020), _w(0.100, 0.200)]
    out = floor_word_durations(words, floor_s=0.05)
    assert out[0]["start"] == pytest.approx(0)
    assert out[0]["end"] == pytest.approx(0.050)
    assert out[1] == _w(0.100, 0.200)


def test_floor_noncontiguous_capped_by_gap_size():
    # The gap is smaller than the deficit — extension is capped at the
    # successor's start, not pushed past it.
    words = [_w(0, 0.020), _w(0.030, 0.200)]
    out = floor_word_durations(words, floor_s=0.05)
    assert out[0]["start"] == pytest.approx(0)
    assert out[0]["end"] == pytest.approx(0.030)
    assert out[1] == _w(0.030, 0.200)


def test_floor_transcript_final_word_extended_unconditionally():
    # No successor and (at the flatten point) no seg_end to clamp against —
    # the last word borders trailing silence, so it's extended unconditionally.
    words = [_w(0, 0.400), _w(0.400, 0.420)]
    out = floor_word_durations(words, floor_s=0.05)
    assert out[0] == _w(0, 0.400)
    assert out[1]["start"] == pytest.approx(0.400)
    assert out[1]["end"] == pytest.approx(0.450)


def test_floor_already_long_words_untouched():
    words = [_w(0, 0.5), _w(0.5, 1.0), _w(1.0, 1.8)]
    out = floor_word_durations(words, floor_s=0.05)
    assert out == words


def test_floor_never_creates_overlap():
    matrices = [
        [_w(0, 0.020), _w(0.020, 0.400)],
        [_w(0, 0.020), _w(0.020, 0.060)],
        [_w(0, 0.02), _w(0.02, 0.04), _w(0.04, 0.06), _w(0.06, 0.11)],
        [_w(0, 0.02), _w(0.02, 0.04), _w(0.04, 0.06), _w(0.06, 0.50)],
        [_w(0, 0.020), _w(0.100, 0.200)],
        [_w(0, 0.020), _w(0.030, 0.200)],
        [_w(0, 0.400), _w(0.400, 0.420)],
    ]
    for words in matrices:
        out = floor_word_durations(words, floor_s=0.05)
        for i in range(len(out) - 1):
            assert out[i]["end"] <= out[i + 1]["start"] + 1e-9, words


def test_floor_never_introduces_a_gap_where_words_were_flush():
    # word-by-word.jsx falls back to rendering the segment's LAST word when no
    # word matches the current time. A gap introduced mid-segment would make
    # the caption visibly jump to its final word and back — a visibly wrong
    # frame, not merely suboptimal timing. The waterfall must never do this:
    # it only ever moves a shared boundary forward together, and the
    # non-contiguous branch only ever shrinks an existing gap.
    matrices = [
        [_w(0, 0.020), _w(0.020, 0.400)],
        [_w(0, 0.020), _w(0.020, 0.060)],
        [_w(0, 0.02), _w(0.02, 0.04), _w(0.04, 0.06), _w(0.06, 0.11)],
        [_w(0, 0.02), _w(0.02, 0.04), _w(0.04, 0.06), _w(0.06, 0.50)],
        [_w(0, 0.400), _w(0.400, 0.420)],
    ]
    for words in matrices:
        flush_before = [
            words[i]["end"] == words[i + 1]["start"] for i in range(len(words) - 1)
        ]
        out = floor_word_durations(words, floor_s=0.05)
        for i, was_flush in enumerate(flush_before):
            if was_flush:
                assert out[i]["end"] == out[i + 1]["start"], words


def test_floor_does_not_mutate_input():
    words = [_w(0, 0.020), _w(0.020, 0.400)]
    snapshot = [dict(w) for w in words]
    floor_word_durations(words, floor_s=0.05)
    assert words == snapshot


def test_caption_step_applies_floor_end_to_end(tmp_path):
    # Two adjacent short words (20ms each) whose donation should be accepted:
    # word 0 gets floored to 50ms and word 1's start moves with it.
    transcript = {
        "transcription": [
            {"text": "a", "offsets": {"from": 0,   "to": 20}},
            {"text": "b", "offsets": {"from": 20,  "to": 500}},
        ]
    }
    src = tmp_path / "words.json"
    src.write_text(json.dumps(transcript))
    out = tmp_path / "captions.json"
    proc = run_step("caption.py", "--input", str(src), "--out", str(out))
    assert_file_output(proc)
    data = json.loads(out.read_text())
    words = data["segments"][0]["words"]
    assert words[0]["start"] == pytest.approx(0)
    assert words[0]["end"] == pytest.approx(0.05)
    assert words[1]["start"] == pytest.approx(0.05)
    assert words[1]["end"] == pytest.approx(0.5)
