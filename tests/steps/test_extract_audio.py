"""Tests for steps/extract_audio.py"""
import sys
from pathlib import Path
import pytest
from tests.conftest import run_step, assert_file_output, assert_error

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "lib"))
import common


def test_extract_wav(test_video, tmp_path):
    out = tmp_path / "audio.wav"
    proc = run_step("extract_audio.py", "--input", str(test_video), "--format", "wav", "--out", str(out))
    assert_file_output(proc)
    codec = common.ffprobe_value(str(out), "stream=codec_name", "a:0")
    assert codec == "pcm_s16le"


def test_extract_mp3(test_video, tmp_path):
    out = tmp_path / "audio.mp3"
    proc = run_step("extract_audio.py", "--input", str(test_video), "--format", "mp3", "--out", str(out))
    assert_file_output(proc)


def test_extract_auto_output_path(test_video):
    proc = run_step("extract_audio.py", "--input", str(test_video), "--format", "wav")
    out = assert_file_output(proc)
    assert out.suffix == ".wav"


def test_extract_missing_input():
    proc = run_step("extract_audio.py", "--input", "/no/file.mp4", "--format", "wav")
    assert_error(proc, "file_not_found")
