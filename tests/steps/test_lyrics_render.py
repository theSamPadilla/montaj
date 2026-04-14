"""Tests for steps/lyrics_render.py"""
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from tests.conftest import run_step, assert_file_output, assert_error, HAS_FFMPEG

# ---------------------------------------------------------------------------
# Import build_drawtext_filters directly from the step module
# ---------------------------------------------------------------------------

_STEP_PATH = Path(__file__).parent.parent.parent / "steps" / "lyrics_render.py"


def _load_step():
    spec = importlib.util.spec_from_file_location("lyrics_render", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_step()
build_drawtext_filters = _mod.build_drawtext_filters


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def captions_json(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("captions")
    path = d / "captions.json"
    data = {
        "segments": [
            {
                "text": "hello world",
                "start": 0.5,
                "end": 2.5,
                "words": [
                    {"word": "hello", "start": 0.5, "end": 1.2},
                    {"word": "world", "start": 1.2, "end": 2.5},
                ],
            }
        ]
    }
    path.write_text(json.dumps(data))
    return path


@pytest.fixture(scope="module")
def test_audio(tmp_path_factory) -> Path:
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg not available")
    d = tmp_path_factory.mktemp("audio")
    out = d / "song.mp3"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
            "-t", "3",
            "-c:a", "libmp3lame",
            str(out),
        ],
        check=True, capture_output=True,
    )
    return out


# ---------------------------------------------------------------------------
# Pure-logic tests
# ---------------------------------------------------------------------------

def test_build_drawtext_single_word_segment():
    segments = [
        {
            "text": "hello",
            "start": 0.0,
            "end": 1.0,
            "words": [{"word": "hello", "start": 0.0, "end": 1.0}],
        }
    ]
    filters = build_drawtext_filters(segments, fontsize=72, color="white",
                                     x="(w-tw)/2", y="(h-th)/2")
    assert len(filters) == 1
    assert "hello" in filters[0]
    assert "between(t,0.0,1.0)" in filters[0]


def test_build_drawtext_multi_word_accumulation():
    """4 words → 4 non-overlapping states with accumulated text."""
    words = [
        {"word": "one",   "start": 0.0, "end": 0.5},
        {"word": "two",   "start": 0.5, "end": 1.0},
        {"word": "three", "start": 1.0, "end": 1.5},
        {"word": "four",  "start": 1.5, "end": 2.0},
    ]
    segments = [{"text": "one two three four", "start": 0.0, "end": 2.0, "words": words}]
    filters = build_drawtext_filters(segments, fontsize=48, color="white",
                                     x="0", y="0")
    assert len(filters) == 4

    # Check accumulation: each filter should have one more word than the previous
    assert "text='one'" in filters[0]
    assert "text='one two'" in filters[1]
    assert "text='one two three'" in filters[2]
    assert "text='one two three four'" in filters[3]

    # Check non-overlapping windows
    assert "between(t,0.0,0.5)" in filters[0]
    assert "between(t,0.5,1.0)" in filters[1]
    assert "between(t,1.0,1.5)" in filters[2]
    assert "between(t,1.5,2.0)" in filters[3]


def test_build_drawtext_escapes_apostrophe():
    """Apostrophes must be shell-escaped using quote termination, not replaced with U+2019."""
    segments = [
        {
            "text": "don't stop",
            "start": 0.0,
            "end": 2.0,
            "words": [
                {"word": "don't", "start": 0.0, "end": 1.0},
                {"word": "stop",  "start": 1.0, "end": 2.0},
            ],
        }
    ]
    filters = build_drawtext_filters(segments, fontsize=72, color="white",
                                     x="0", y="0")
    # The shell-style escape sequence must be present
    assert r"'\''" in filters[0], f"Shell-style apostrophe escape not found in: {filters[0]}"
    # Typographic apostrophe must NOT be used
    assert "\u2019" not in filters[0], "Typographic apostrophe U+2019 should not be used"


def test_build_drawtext_multiple_segments():
    """2 segments × 2 words = 4 filters total."""
    segments = [
        {
            "text": "hello world",
            "start": 0.0,
            "end": 2.0,
            "words": [
                {"word": "hello", "start": 0.0, "end": 1.0},
                {"word": "world", "start": 1.0, "end": 2.0},
            ],
        },
        {
            "text": "foo bar",
            "start": 3.0,
            "end": 5.0,
            "words": [
                {"word": "foo", "start": 3.0, "end": 4.0},
                {"word": "bar", "start": 4.0, "end": 5.0},
            ],
        },
    ]
    filters = build_drawtext_filters(segments, fontsize=72, color="white",
                                     x="0", y="0")
    assert len(filters) == 4


def test_build_drawtext_escapes_colon():
    mod = _load_step()
    segments = [{
        "text": "note: something",
        "start": 0.0, "end": 2.0,
        "words": [
            {"word": "note:",     "start": 0.0, "end": 1.0},
            {"word": "something", "start": 1.0, "end": 2.0},
        ]
    }]
    filters = mod.build_drawtext_filters(segments, fontsize=72, color="white",
                                          x="(w-tw)/2", y="h*0.4")
    # Colons in text must be escaped so they don't break the filter option chain
    # Use [-1] because "drawtext=" itself contains "text=", giving multiple split parts
    text_part = filters[0].split("text=")[-1].split(":enable=")[0]
    assert "\\:" in text_part or r"\:" in text_part


def test_build_drawtext_skips_empty_words():
    """Segments with no words produce no filters."""
    segments = [
        {"text": "", "start": 0.0, "end": 1.0, "words": []},
        {"text": "hi", "start": 1.0, "end": 2.0, "words": [{"word": "hi", "start": 1.0, "end": 2.0}]},
    ]
    filters = build_drawtext_filters(segments, fontsize=72, color="white",
                                     x="0", y="0")
    assert len(filters) == 1
    assert "hi" in filters[0]


# ---------------------------------------------------------------------------
# Integration tests (require ffmpeg)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_renders_without_background_video(captions_json, test_audio, tmp_path):
    out = tmp_path / "render.mp4"
    proc = run_step(
        "lyrics_render.py",
        "--captions", str(captions_json),
        "--audio",    str(test_audio),
        "--preview-duration", "2",
        "--out", str(out),
    )
    result = assert_file_output(proc)
    assert result.suffix == ".mp4"
    assert result.stat().st_size > 0


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_renders_with_background_video(captions_json, test_audio, test_video, tmp_path):
    out = tmp_path / "render_bg.mp4"
    proc = run_step(
        "lyrics_render.py",
        "--captions", str(captions_json),
        "--audio",    str(test_audio),
        "--input",    str(test_video),
        "--preview-duration", "2",
        "--out", str(out),
    )
    result = assert_file_output(proc)
    assert result.stat().st_size > 0


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_preview_duration_limits_output(captions_json, test_audio, tmp_path):
    out = tmp_path / "preview.mp4"
    proc = run_step(
        "lyrics_render.py",
        "--captions", str(captions_json),
        "--audio",    str(test_audio),
        "--preview-duration", "1",
        "--out", str(out),
    )
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert out.exists() and out.stat().st_size > 0


def test_missing_captions_errors(tmp_path):
    proc = run_step(
        "lyrics_render.py",
        "--captions", "/nonexistent/captions.json",
        "--audio",    "/nonexistent/song.mp3",
    )
    assert_error(proc, "file_not_found")


def test_missing_audio_errors(captions_json, tmp_path):
    proc = run_step(
        "lyrics_render.py",
        "--captions", str(captions_json),
        "--audio",    "/nonexistent/song.mp3",
    )
    assert_error(proc, "file_not_found")
