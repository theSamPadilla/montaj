"""Tests for steps/snapshot.py"""
import pytest
from tests.conftest import run_step, assert_file_output, assert_error


def test_snapshot_default(test_video, tmp_path):
    out = tmp_path / "sheet.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video), "--out", str(out))
    assert_file_output(proc)
    assert out.suffix in (".jpg", ".jpeg")


def test_snapshot_custom_grid(test_video, tmp_path):
    out = tmp_path / "sheet.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video), "--cols", "2", "--rows", "2", "--out", str(out))
    assert_file_output(proc)


def test_snapshot_auto_output_path(test_video):
    proc = run_step("snapshot.py", "--input", str(test_video))
    out = assert_file_output(proc)
    assert out.suffix in (".jpg", ".jpeg", ".png")


def test_snapshot_missing_input():
    proc = run_step("snapshot.py", "--input", "/no/file.mp4")
    assert_error(proc, "file_not_found")
