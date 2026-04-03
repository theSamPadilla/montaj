"""Tests for steps/trim.py"""
import sys
from pathlib import Path
import pytest
from tests.conftest import run_step, assert_file_output, assert_error

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "lib"))
import common


def test_trim_by_end(test_video, tmp_path):
    out = tmp_path / "trimmed.mp4"
    proc = run_step("trim.py", "--input", str(test_video), "--end", "2.0", "--out", str(out))
    assert_file_output(proc)
    dur = common.get_duration(str(out))
    assert 1.8 <= dur <= 2.2


def test_trim_by_duration(test_video, tmp_path):
    out = tmp_path / "trimmed.mp4"
    proc = run_step("trim.py", "--input", str(test_video), "--start", "0.5", "--duration", "1.5", "--out", str(out))
    assert_file_output(proc)
    dur = common.get_duration(str(out))
    assert 1.3 <= dur <= 1.7


def test_trim_with_start(test_video, tmp_path):
    out = tmp_path / "trimmed.mp4"
    proc = run_step("trim.py", "--input", str(test_video), "--start", "1.0", "--end", "3.0", "--out", str(out))
    assert_file_output(proc)
    dur = common.get_duration(str(out))
    assert 1.8 <= dur <= 2.2


def test_trim_auto_output_path(test_video):
    proc = run_step("trim.py", "--input", str(test_video), "--end", "1.0")
    out = assert_file_output(proc)
    assert "_trimmed" in out.name


def test_trim_no_end_or_duration(test_video):
    proc = run_step("trim.py", "--input", str(test_video))
    assert_error(proc, "invalid_argument")


def test_trim_missing_input():
    proc = run_step("trim.py", "--input", "/no/file.mp4", "--end", "1.0")
    assert_error(proc, "file_not_found")
