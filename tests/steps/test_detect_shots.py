"""Tests for the detect_shots step."""
import json
import subprocess

import pytest

from tests.conftest import HAS_FFMPEG, run_step

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")


@pytest.fixture(scope="module")
def multi_shot_video(tmp_path_factory):
    """A 6s video made of three 2s segments with well-separated luma.

    Colours must differ in LUMA, not just hue — ffmpeg's scene filter works on
    luminance. `red` (Y≈76) and `green` (Y≈75) are nearly identical to it and
    produce a scene score of 0.0 at their boundary; this was verified against
    a real ffmpeg run. black (Y≈16) / white (Y≈235) / gray (Y≈128) are
    unambiguous and yield cuts at exactly 2.0s and 4.0s.
    """
    out = tmp_path_factory.mktemp("detect_shots") / "three_shots.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2",
        "-f", "lavfi", "-i", "color=c=white:s=320x240:d=2",
        "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=2",
        "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
        "-map", "[v]", "-r", "30", "-pix_fmt", "yuv420p", str(out),
    ], check=True, capture_output=True)
    return out


def test_detect_shots_finds_three_shots(multi_shot_video):
    proc = run_step("detect_shots.py", "--input", str(multi_shot_video))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)

    assert data["input"] == str(multi_shot_video)
    assert len(data["shots"]) == 3

    for i, shot in enumerate(data["shots"]):
        assert shot["index"] == i + 1
        assert shot["duration"] == pytest.approx(shot["end"] - shot["start"], abs=1e-6)
        assert "motion_mean" in shot
        assert "motion_peak" in shot

    # Shots tile the timeline with no gaps and no overlap.
    assert data["shots"][0]["start"] == 0.0
    for a, b in zip(data["shots"], data["shots"][1:]):
        assert a["end"] == b["start"]
    assert data["shots"][-1]["end"] == pytest.approx(6.0, abs=0.2)

    # Flat colour fields are static.
    for shot in data["shots"]:
        assert shot["motion_mean"] < 0.01


def test_detect_shots_min_shot_merges_short_segments(multi_shot_video):
    """With --min-shot longer than each segment, boundaries collapse."""
    proc = run_step("detect_shots.py", "--input", str(multi_shot_video),
                    "--min-shot", "5.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert len(data["shots"]) == 1
    assert data["shots"][0]["start"] == 0.0


def test_detect_shots_writes_out_file(multi_shot_video, tmp_path):
    out = tmp_path / "shots.json"
    proc = run_step("detect_shots.py", "--input", str(multi_shot_video),
                    "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert proc.stdout.strip() == str(out)
    data = json.loads(out.read_text())
    assert len(data["shots"]) == 3


def test_detect_shots_missing_file_fails():
    proc = run_step("detect_shots.py", "--input", "/nonexistent/nope.mp4")
    assert proc.returncode == 1
    assert json.loads(proc.stderr.strip().splitlines()[-1])["error"] == "file_not_found"
