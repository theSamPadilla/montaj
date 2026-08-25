"""Tests for steps/probe.py"""
import subprocess
import sys

import pytest
from tests.conftest import HAS_FFMPEG, REPO_ROOT, run_step, assert_json_output, assert_error

sys.path.insert(0, str(REPO_ROOT / "lib"))
from normalize import probe_video


def test_probe_returns_metadata(test_video):
    proc = run_step("probe.py", "--input", str(test_video))
    data = assert_json_output(proc)
    assert "duration" in data
    assert "streams" in data
    assert "format" in data
    assert abs(data["duration"] - 3.0) < 0.2


def test_probe_video_stream(test_video):
    proc = run_step("probe.py", "--input", str(test_video))
    data = assert_json_output(proc)
    video_streams = [s for s in data["streams"] if s["type"] == "video"]
    assert len(video_streams) == 1
    vs = video_streams[0]
    assert vs["width"] == 640
    assert vs["height"] == 480
    assert vs["codec"] == "h264"


def test_probe_video_stream_display_dims_non_rotated(test_video):
    """Landscape (non-rotated) fixture: display dims == coded dims, rotation 0."""
    proc = run_step("probe.py", "--input", str(test_video))
    data = assert_json_output(proc)
    vs = [s for s in data["streams"] if s["type"] == "video"][0]
    assert vs["display_width"] == vs["width"] == 640
    assert vs["display_height"] == vs["height"] == 480
    assert vs["rotation"] == 0


def test_probe_audio_stream(test_video):
    proc = run_step("probe.py", "--input", str(test_video))
    data = assert_json_output(proc)
    audio_streams = [s for s in data["streams"] if s["type"] == "audio"]
    assert len(audio_streams) == 1


def test_probe_audio_stream_has_no_rotation_fields(test_video):
    """Rotation/display fields are video-only; audio streams must not carry them."""
    proc = run_step("probe.py", "--input", str(test_video))
    data = assert_json_output(proc)
    audio_stream = [s for s in data["streams"] if s["type"] == "audio"][0]
    assert "rotation" not in audio_stream
    assert "display_width" not in audio_stream
    assert "display_height" not in audio_stream


def test_probe_missing_file():
    proc = run_step("probe.py", "--input", "/nonexistent/file.mp4")
    assert_error(proc, "file_not_found")


def test_probe_missing_arg():
    proc = run_step("probe.py")
    assert proc.returncode != 0


# ── rotated fixture ─────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def rotated_video(tmp_path_factory):
    """1920x1080 landscape-coded clip re-muxed with a -90 display rotation tag
    (mirrors an iPhone portrait recording: sensor stores landscape, a
    displaymatrix side_data tag tells players to rotate for display).

    Skips if ffmpeg is unavailable, or if the resulting file doesn't actually
    carry the rotation tag (older ffmpeg without -display_rotation support) —
    a test asserting on a fixture that silently isn't rotated is worse than
    a skip.
    """
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg not available")
    d = tmp_path_factory.mktemp("rotated_video")
    landscape = d / "land.mp4"
    rotated = d / "rot.mp4"

    subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=30",
            "-t", "1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            str(landscape),
        ],
        check=True, capture_output=True,
    )
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-display_rotation", "-90",
            "-i", str(landscape),
            "-c", "copy",
            str(rotated),
        ],
        check=True, capture_output=True,
    )

    # Verify the tag actually landed before handing this to tests.
    info = probe_video(str(rotated))
    if info is None or info.get("rotation") != -90:
        pytest.skip(f"rotated fixture did not carry the expected rotation tag: {info}")

    return rotated


def test_probe_video_stream_display_dims_rotated(rotated_video):
    """Rotated fixture: coded width/height unchanged, display dims swapped."""
    proc = run_step("probe.py", "--input", str(rotated_video))
    data = assert_json_output(proc)
    vs = [s for s in data["streams"] if s["type"] == "video"][0]
    assert vs["width"] == 1920
    assert vs["height"] == 1080
    assert vs["display_width"] == 1080
    assert vs["display_height"] == 1920
    assert vs["rotation"] == -90
