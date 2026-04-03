"""Tests for steps/normalize.py"""
import pytest
from tests.conftest import run_step, assert_file_output, assert_error


def test_normalize_youtube(test_video, tmp_path):
    out = tmp_path / "norm.mp4"
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "youtube", "--out", str(out))
    assert_file_output(proc)


def test_normalize_podcast(test_video, tmp_path):
    out = tmp_path / "norm.mp4"
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "podcast", "--out", str(out))
    assert_file_output(proc)


def test_normalize_custom_lufs(test_video, tmp_path):
    out = tmp_path / "norm.mp4"
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "custom", "--lufs", "-16", "--out", str(out))
    assert_file_output(proc)


def test_normalize_auto_output_path(test_video):
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "youtube")
    out = assert_file_output(proc)
    assert "_normalized" in out.name


def test_normalize_missing_input():
    proc = run_step("normalize.py", "--input", "/no/file.mp4", "--target", "youtube")
    assert_error(proc, "file_not_found")
