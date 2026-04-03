"""Tests for steps/resize.py"""
import sys
from pathlib import Path
import pytest
from tests.conftest import run_step, assert_file_output, assert_error

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "lib"))
import common


def _dimensions(path):
    w = int(common.ffprobe_value(str(path), "stream=width", "v:0"))
    h = int(common.ffprobe_value(str(path), "stream=height", "v:0"))
    return w, h


def test_resize_9_16(test_video, tmp_path):
    out = tmp_path / "resized.mp4"
    proc = run_step("resize.py", "--input", str(test_video), "--ratio", "9:16", "--out", str(out))
    assert_file_output(proc)
    w, h = _dimensions(out)
    assert w == 1080
    assert h == 1920


def test_resize_1_1(test_video, tmp_path):
    out = tmp_path / "resized.mp4"
    proc = run_step("resize.py", "--input", str(test_video), "--ratio", "1:1", "--out", str(out))
    assert_file_output(proc)
    w, h = _dimensions(out)
    assert w == h


def test_resize_16_9(test_video, tmp_path):
    out = tmp_path / "resized.mp4"
    proc = run_step("resize.py", "--input", str(test_video), "--ratio", "16:9", "--out", str(out))
    assert_file_output(proc)
    w, h = _dimensions(out)
    assert w == 1920
    assert h == 1080


def test_resize_auto_output_path(test_video):
    proc = run_step("resize.py", "--input", str(test_video), "--ratio", "1:1")
    assert_file_output(proc)


def test_resize_missing_input():
    proc = run_step("resize.py", "--input", "/no/file.mp4", "--ratio", "9:16")
    assert_error(proc, "file_not_found")
