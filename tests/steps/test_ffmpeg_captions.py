"""Tests for steps/ffmpeg_captions.py"""
import pytest
from tests.conftest import run_step, assert_file_output, assert_error


def test_ffmpeg_captions_center(test_video, tmp_path):
    out = tmp_path / "captions.mp4"
    proc = run_step("ffmpeg_captions.py", "--input", str(test_video),
                    "--text", "Hello World", "--position", "center", "--out", str(out))
    assert_file_output(proc)


def test_ffmpeg_captions_bottom(test_video, tmp_path):
    out = tmp_path / "captions.mp4"
    proc = run_step("ffmpeg_captions.py", "--input", str(test_video),
                    "--text", "Lower Third", "--position", "bottom", "--out", str(out))
    assert_file_output(proc)


def test_ffmpeg_captions_custom_fontsize(test_video, tmp_path):
    out = tmp_path / "captions.mp4"
    proc = run_step("ffmpeg_captions.py", "--input", str(test_video),
                    "--text", "Big Text", "--fontsize", "72", "--out", str(out))
    assert_file_output(proc)


def test_ffmpeg_captions_auto_output_path(test_video):
    proc = run_step("ffmpeg_captions.py", "--input", str(test_video), "--text", "Test")
    out = assert_file_output(proc)
    assert "_ffmpeg_captions" in out.name


def test_ffmpeg_captions_missing_input():
    proc = run_step("ffmpeg_captions.py", "--input", "/no/file.mp4", "--text", "hi")
    assert_error(proc, "file_not_found")
