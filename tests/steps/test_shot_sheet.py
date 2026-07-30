"""Tests for the shot_sheet step."""
import json
import subprocess

import pytest

from tests.conftest import HAS_FFMPEG, run_step

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")


@pytest.fixture(scope="module")
def multi_shot_video(tmp_path_factory):
    # Luma-separated colours — see the note in test_detect_shots.py. red/green
    # are luma-identical to the scene filter and would yield 2 shots, not 3.
    out = tmp_path_factory.mktemp("shot_sheet") / "three_shots.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2",
        "-f", "lavfi", "-i", "color=c=white:s=320x240:d=2",
        "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=2",
        "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
        "-map", "[v]", "-r", "30", "-pix_fmt", "yuv420p", str(out),
    ], check=True, capture_output=True)
    return out


@pytest.fixture(scope="module")
def shots_json(multi_shot_video, tmp_path_factory):
    out = tmp_path_factory.mktemp("shot_sheet_spec") / "shots.json"
    proc = run_step("detect_shots.py", "--input", str(multi_shot_video), "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    return out


def test_shot_sheet_emits_index_and_sheets(multi_shot_video, shots_json, tmp_path):
    proc = run_step("shot_sheet.py", "--input", str(multi_shot_video),
                    "--shots", str(shots_json), "--out-dir", str(tmp_path))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)

    assert len(data["sheets"]) >= 1
    for sheet in data["sheets"]:
        assert (tmp_path / sheet["path"]).exists() or __import__("pathlib").Path(sheet["path"]).exists()

    # 3 shots x 3 frames = 9 tiles, every one mapped back to its shot.
    tiles = [t for sheet in data["sheets"] for t in sheet["tiles"]]
    assert len(tiles) == 9
    assert sorted({t["shot_index"] for t in tiles}) == [1, 2, 3]
    for t in tiles:
        assert t["frame_index"] in (0, 1, 2)
        assert isinstance(t["row"], int) and isinstance(t["col"], int)


def test_shot_sheet_respects_frames_per_shot(multi_shot_video, shots_json, tmp_path):
    proc = run_step("shot_sheet.py", "--input", str(multi_shot_video),
                    "--shots", str(shots_json), "--out-dir", str(tmp_path),
                    "--frames-per-shot", "1")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    tiles = [t for sheet in data["sheets"] for t in sheet["tiles"]]
    assert len(tiles) == 3
    assert all(t["frame_index"] == 0 for t in tiles)


def test_shot_sheet_splits_across_sheets(multi_shot_video, shots_json, tmp_path):
    """max-tiles forces more than one sheet and tiles stay uniquely mapped."""
    proc = run_step("shot_sheet.py", "--input", str(multi_shot_video),
                    "--shots", str(shots_json), "--out-dir", str(tmp_path),
                    "--max-tiles", "4")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert len(data["sheets"]) == 3  # 9 tiles, 4 per sheet -> 4 + 4 + 1
    tiles = [(t["shot_index"], t["frame_index"])
             for sheet in data["sheets"] for t in sheet["tiles"]]
    assert len(tiles) == len(set(tiles)) == 9


def test_shot_sheet_missing_shots_file_fails(multi_shot_video, tmp_path):
    proc = run_step("shot_sheet.py", "--input", str(multi_shot_video),
                    "--shots", "/nonexistent/shots.json", "--out-dir", str(tmp_path))
    assert proc.returncode == 1
    assert json.loads(proc.stderr.strip().splitlines()[-1])["error"] == "file_not_found"
