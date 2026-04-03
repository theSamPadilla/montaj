"""Tests for steps/caption.py — pure Python, no external dependencies."""
import json
import pytest
from tests.conftest import run_step, assert_file_output, assert_error


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
