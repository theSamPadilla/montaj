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


# --- output folder that doesn't exist yet ---------------------------------

def test_snapshot_grid_creates_missing_output_dir(test_video, tmp_path):
    out = tmp_path / "missing" / "sub" / "out.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video), "--out", str(out))
    assert_file_output(proc)
    assert out.exists()


def test_snapshot_at_creates_missing_output_dir(test_video, tmp_path):
    out = tmp_path / "missing" / "sub" / "out.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video), "--at", "1.0", "--out", str(out))
    assert_file_output(proc)
    assert out.exists()


# --- several --at: one labelled sheet of the source (PL89) -----------------
# A paid run took 13 snapshots of one b-roll source to find its moments; its one try at a list of times was refused.

def _sheet_size(path):
    from PIL import Image
    with Image.open(path) as im:
        return im.size


def test_snapshot_several_at_make_one_labelled_sheet(test_video, tmp_path):
    out = tmp_path / "moments.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video), "--at", "0.5", "--at", "2.5", "--at", "1", "--out", str(out))
    path = assert_file_output(proc)
    assert path == out
    w, h = _sheet_size(out)
    assert w > h, "three tiles side by side in one row"
    one = tmp_path / "one.jpg"
    run_step("snapshot.py", "--input", str(test_video), "--at", "0.5", "--out", str(one))
    assert _sheet_size(one) != (w, h), "one --at is still the single full frame"


def test_snapshot_several_at_take_cols(test_video, tmp_path):
    out = tmp_path / "grid.jpg"
    proc = run_step("snapshot.py", "--input", str(test_video), "--cols", "2",
                    "--at", "0.2", "--at", "0.8", "--at", "1.4", "--at", "2.0", "--out", str(out))
    assert_file_output(proc)
    w, h = _sheet_size(out)
    assert h > w / 2, "two rows of two"


def test_snapshot_several_at_default_path_names_the_span(test_video):
    proc = run_step("snapshot.py", "--input", str(test_video), "--at", "0.5", "--at", "2")
    path = assert_file_output(proc)
    assert "_at_0.50-2.00" in path.name


def test_snapshot_several_at_check_each_time_and_the_window_args(test_video, tmp_path):
    out = tmp_path / "bad.jpg"
    assert_error(run_step("snapshot.py", "--input", str(test_video), "--at", "1", "--at", "10", "--out", str(out)), "invalid_at")
    assert_error(run_step("snapshot.py", "--input", str(test_video), "--at", "1", "--at", "2", "--start", "0", "--out", str(out)), "invalid_args")
    too_many = sum((["--at", str(round(i * 0.05, 2))] for i in range(37)), [])
    assert_error(run_step("snapshot.py", "--input", str(test_video), *too_many, "--out", str(out)), "invalid_args")


def test_snapshot_sheet_labels_are_drawn_big_enough_for_the_preview(tmp_path):
    # The sheet comes back as a 768 px preview: its labels are drawn at SHEET_LABEL_PX, not Pillow's small default.
    import sys
    from pathlib import Path
    from PIL import Image
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
    from sheet import tile_sheet, LABEL_H
    frame = tmp_path / "f.png"
    Image.new("RGB", (64, 36), (10, 10, 10)).save(frame)
    small, big = tmp_path / "small.png", tmp_path / "big.png"
    tile_sheet([str(frame)] * 2, [1.0, 2.0], 2, 320, str(small))
    tile_sheet([str(frame)] * 2, [1.0, 2.0], 2, 320, str(big), label_px=30)
    assert Image.open(big).size[1] - Image.open(small).size[1] == int(30 * 1.3) - LABEL_H
