"""Tests for steps/cut.py"""
import sys
from pathlib import Path
import pytest
from tests.conftest import run_step, assert_file_output, assert_error

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "lib"))
import common


def test_cut_removes_section(test_video, tmp_path):
    out = tmp_path / "cut.mp4"
    # Remove 1 second from a 3-second clip → ~2 seconds
    proc = run_step("cut.py", "--input", str(test_video), "--start", "1.0", "--end", "2.0", "--out", str(out))
    assert_file_output(proc)
    dur = common.get_duration(str(out))
    original = common.get_duration(str(test_video))
    assert dur < original - 0.5


def test_cut_auto_output_path(test_video):
    proc = run_step("cut.py", "--input", str(test_video), "--start", "0.5", "--end", "1.5")
    out = assert_file_output(proc)
    assert "_cut" in out.name


def test_cut_missing_input():
    proc = run_step("cut.py", "--input", "/no/file.mp4", "--start", "0", "--end", "1")
    assert_error(proc, "file_not_found")
