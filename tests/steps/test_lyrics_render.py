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

_STEP_PATH = Path(__file__).parent.parent.parent / "steps" / "lyrics" / "lyrics_render.py"


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
                                     position="center")
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
                                     position="center", accumulate=True)

    # Accumulate mode produces multi-line filters — one set per word step.
    # Each step has one or more line filters; total count depends on line wrapping.
    assert len(filters) >= 4

    # Check non-overlapping time windows exist
    assert any("between(t,0.0,0.5)" in f for f in filters)
    assert any("between(t,0.5,1.0)" in f for f in filters)
    assert any("between(t,1.0,1.5)" in f for f in filters)
    assert any("between(t,1.5,2.0)" in f for f in filters)


def test_build_drawtext_escapes_apostrophe():
    """Apostrophes are replaced with U+2019 (RIGHT SINGLE QUOTATION MARK) to avoid
    breaking ffmpeg's single-quote filter parser."""
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
                                     position="center")
    # Typographic apostrophe U+2019 is used instead of literal single quote
    assert "\u2019" in filters[0], f"U+2019 apostrophe replacement not found in: {filters[0]}"
    # Literal ASCII apostrophe must not appear unescaped inside the text value
    # (it's used as the drawtext quoting character)
    text_part = filters[0].split("text=")[1].split(":enable=")[0]
    inner = text_part[1:-1]  # strip surrounding single quotes
    assert "'" not in inner, f"Unescaped ASCII apostrophe in text value: {inner}"


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
                                     position="center")
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
                                          position="center")
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
                                     position="center")
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


# --- Windows font candidate --------------------------------------------------

def test_find_fontfile_windows_arial(monkeypatch):
    import ntpath
    from lib.common import ffmpeg_filter_path
    monkeypatch.delenv("SystemRoot", raising=False)
    arial = ntpath.join(r"C:\Windows", "Fonts", "arial.ttf")
    monkeypatch.setattr(_mod, "_isfile", lambda p: p == arial)
    assert _mod._find_fontfile() == arial

    lines = _mod._make_line_filters(
        ["hi"], 0, 1, 40, "white", "(w-text_w)/2", "center", 1080, 48, arial, False)
    expected = ffmpeg_filter_path(arial)
    assert lines[0].startswith(f"drawtext=fontfile={expected}:")


# --- colours are colour names, never filter text (§563) ---------------------

@pytest.mark.parametrize("value", ["white", "black", "#FFCC00", "0xFFCC00", "white@0.5", "#00000080"])
def test_ffmpeg_color_accepts_colour_syntax(value):
    assert _mod._ffmpeg_color(value) == value


@pytest.mark.parametrize("value", ["white,null", "white:x=1", "white;null", "[a]", "white'", "", "white dim"])
def test_ffmpeg_color_refuses_filter_syntax(value):
    import argparse
    with pytest.raises(argparse.ArgumentTypeError):
        _mod._ffmpeg_color(value)


@pytest.mark.parametrize("flag", ["--color", "--bg-color"])
def test_a_colour_with_filter_syntax_fails_in_argparse(captions_json, tmp_path, flag):
    proc = run_step(
        "lyrics_render.py",
        "--captions", str(captions_json),
        "--audio",    str(captions_json),
        flag,         "white,null",
        "--out",      str(tmp_path / "never.mp4"),
    )
    assert proc.returncode == 2
    assert f'argument {flag}: "white,null" is not a colour (e.g. #ffffff or white)' in proc.stderr
    assert not (tmp_path / "never.mp4").exists()


@pytest.mark.parametrize("value, expected", [
    ("#12ab9f", "#12ab9f"), ("white", "white"), ("#fff", "0xFFFFFFFF"),
    ("rgb(255 0 0 / 50%)", "0xFF000080"), ("hsl(120, 100%, 25%)", "0x008000FF"), ("rebeccapurple", "0x663399FF"),
])
def test_a_css_colour_converts_and_an_ffmpeg_colour_is_unchanged(value, expected):
    assert _mod._ffmpeg_color(value) == expected
    assert _mod._text_color(value) == expected
    assert _mod._text_color("auto") == "auto"


def test_an_editor_colour_reaches_drawtext_unchanged():
    segments = [{"start": 0.5, "end": 2.0, "words": [{"word": "hi", "start": 0.5, "end": 2.0}]}]
    filters = build_drawtext_filters(segments, fontsize=72, color=_mod._text_color("#12ab9f"))
    assert filters and all(":fontcolor=#12ab9f:" in f for f in filters)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_renders_with_css_colours(captions_json, test_audio, tmp_path):
    """drawtext's fontcolor and the lavfi background both take the converted values."""
    out = tmp_path / "css.mp4"
    proc = run_step(
        "lyrics_render.py",
        "--captions", str(captions_json),
        "--audio",    str(test_audio),
        "--color",    "rgb(255 0 0 / 50%)",
        "--bg-color", "hsl(120, 100%, 25%)",
        "--preview-duration", "1",
        "--out", str(out),
    )
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert out.exists() and out.stat().st_size > 0
