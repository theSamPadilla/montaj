"""Tests for steps/media/filmstrip.py"""
import json
import subprocess
from pathlib import Path

import pytest

from tests.conftest import HAS_FFMPEG, run_step, assert_error

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")


@pytest.fixture(scope="module")
def twelve_second_video(tmp_path_factory):
    """12s solid-color video. Content is irrelevant -- filmstrip samples a
    uniform time grid, not shot-based, so any decodable video works."""
    out = tmp_path_factory.mktemp("filmstrip") / "twelve.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=12",
        "-r", "30", "-pix_fmt", "yuv420p", str(out),
    ], check=True, capture_output=True)
    return out


def test_filmstrip_tile_count_and_interval(twelve_second_video, tmp_path):
    # interval = max(12/12, 1.0) = 1.0 -> ceil(12/1.0) = 12 tiles.
    proc = run_step("filmstrip.py", "--input", str(twelve_second_video),
                    "--out-dir", str(tmp_path), "--max-tiles", "12", "--min-interval", "1.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert data["interval"] == pytest.approx(1.0)
    tiles = [t for sheet in data["sheets"] for t in sheet["tiles"]]
    assert len(tiles) == 12


def test_filmstrip_min_interval_dominates(twelve_second_video, tmp_path):
    # interval = max(12/1000, 2.0) = 2.0 -> ceil(12/2.0) = 6 tiles.
    proc = run_step("filmstrip.py", "--input", str(twelve_second_video),
                    "--out-dir", str(tmp_path), "--max-tiles", "1000", "--min-interval", "2.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert data["interval"] == pytest.approx(2.0)
    tiles = [t for sheet in data["sheets"] for t in sheet["tiles"]]
    assert len(tiles) == 6


def test_filmstrip_index_maps_every_tile_to_timestamp(twelve_second_video, tmp_path):
    proc = run_step("filmstrip.py", "--input", str(twelve_second_video),
                    "--out-dir", str(tmp_path), "--max-tiles", "12", "--min-interval", "1.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    tiles = [t for sheet in data["sheets"] for t in sheet["tiles"]]
    ts = [t["t"] for t in tiles]
    assert ts == sorted(ts)
    assert ts[0] == pytest.approx(0.0, abs=0.01)
    # Roughly one tile per second across a 12s clip.
    assert ts[-1] == pytest.approx(11.0, abs=0.5)
    for t in tiles:
        assert isinstance(t["row"], int) and isinstance(t["col"], int)


def test_filmstrip_emits_sheet_files(twelve_second_video, tmp_path):
    proc = run_step("filmstrip.py", "--input", str(twelve_second_video),
                    "--out-dir", str(tmp_path), "--max-tiles", "12", "--min-interval", "1.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert len(data["sheets"]) >= 1
    for sheet in data["sheets"]:
        assert Path(sheet["path"]).exists()
        assert Path(sheet["path"]).stat().st_size > 0


def test_filmstrip_reports_top_level_tile_width(twelve_second_video, tmp_path):
    proc = run_step("filmstrip.py", "--input", str(twelve_second_video),
                    "--out-dir", str(tmp_path), "--max-tiles", "6", "--tile-width", "128")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert data["tileWidth"] == 128


def test_filmstrip_partial_final_sheet(twelve_second_video, tmp_path):
    """12 tiles paginated 5 per sheet -> 5, 5, 2. The last sheet is partial
    (2 tiles into a 5-col grid), exercising shot_sheet's nb_frames guard:
    without it, the ffmpeg tile filter would stall waiting for 5 frames that
    will never arrive."""
    proc = run_step("filmstrip.py", "--input", str(twelve_second_video),
                    "--out-dir", str(tmp_path), "--max-tiles", "12", "--min-interval", "1.0",
                    "--cols", "5", "--tiles-per-sheet", "5", "--timeout", "60")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert len(data["sheets"]) == 3
    counts = [len(sheet["tiles"]) for sheet in data["sheets"]]
    assert counts == [5, 5, 2]
    # Partial sheet still gets a valid, non-empty image.
    last_sheet = data["sheets"][-1]
    assert last_sheet["rows"] == 1
    assert Path(last_sheet["path"]).exists()
    assert Path(last_sheet["path"]).stat().st_size > 0

    tiles = [t for sheet in data["sheets"] for t in sheet["tiles"]]
    assert len(tiles) == 12


def test_filmstrip_missing_input_fails(tmp_path):
    proc = run_step("filmstrip.py", "--input", "/no/file.mp4", "--out-dir", str(tmp_path))
    assert_error(proc, "file_not_found")


def test_filmstrip_invalid_max_tiles_rejected(twelve_second_video, tmp_path):
    proc = run_step("filmstrip.py", "--input", str(twelve_second_video),
                    "--out-dir", str(tmp_path), "--max-tiles", "0")
    assert_error(proc, "invalid_param")


def test_filmstrip_invalid_min_interval_rejected(twelve_second_video, tmp_path):
    proc = run_step("filmstrip.py", "--input", str(twelve_second_video),
                    "--out-dir", str(tmp_path), "--min-interval", "0")
    assert_error(proc, "invalid_param")


def test_filmstrip_invalid_cols_rejected(twelve_second_video, tmp_path):
    proc = run_step("filmstrip.py", "--input", str(twelve_second_video),
                    "--out-dir", str(tmp_path), "--cols", "0")
    assert_error(proc, "invalid_param")


def test_filmstrip_invalid_tile_width_rejected(twelve_second_video, tmp_path):
    proc = run_step("filmstrip.py", "--input", str(twelve_second_video),
                    "--out-dir", str(tmp_path), "--tile-width", "0")
    assert_error(proc, "invalid_param")
