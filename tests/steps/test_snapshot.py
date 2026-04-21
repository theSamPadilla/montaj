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


# --- --at (point-in-time) mode --------------------------------------------

def test_snapshot_at_extracts_single_frame(test_video, tmp_path):
    out = tmp_path / "frame.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video), "--at", "1.5", "--out", str(out))
    path = assert_file_output(proc)
    assert path == out
    assert out.suffix in (".jpg", ".jpeg")


def test_snapshot_at_auto_output_path(test_video):
    proc = run_step("snapshot.py", "--input", str(test_video), "--at", "0.5")
    path = assert_file_output(proc)
    # Default path encodes the timestamp.
    assert "_at_0.50" in path.name


def test_snapshot_at_zero(test_video, tmp_path):
    """Boundary: --at 0 should work (first frame)."""
    out = tmp_path / "first.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video), "--at", "0", "--out", str(out))
    assert_file_output(proc)


def test_snapshot_at_rejects_out_of_range(test_video, tmp_path):
    # test_video is 3 seconds; --at 10 should reject.
    out = tmp_path / "bad.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video), "--at", "10", "--out", str(out))
    assert_error(proc, "invalid_at")


def test_snapshot_at_rejects_negative(test_video, tmp_path):
    out = tmp_path / "bad.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video), "--at", "-1", "--out", str(out))
    assert_error(proc, "invalid_at")


def test_snapshot_at_conflicts_with_frames(test_video, tmp_path):
    out = tmp_path / "bad.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video),
                    "--at", "1.0", "--frames", "5", "--out", str(out))
    assert_error(proc, "invalid_args")


def test_snapshot_at_conflicts_with_cols(test_video, tmp_path):
    out = tmp_path / "bad.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video),
                    "--at", "1.0", "--cols", "2", "--out", str(out))
    assert_error(proc, "invalid_args")


def test_snapshot_at_conflicts_with_start(test_video, tmp_path):
    out = tmp_path / "bad.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video),
                    "--at", "1.0", "--start", "0.5", "--out", str(out))
    assert_error(proc, "invalid_args")
