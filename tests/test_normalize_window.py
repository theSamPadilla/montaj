"""Tests for normalize_window() in lib/normalize.py.

normalize_window() is a windowed variant of normalize() that extracts a time
window [in_point, out_point) from the source before re-encoding. It uses
input-level fast seek (-ss before -i) so the output starts at time 0 and is
dense-keyframe (re-encode resets GOP via the same -g/-keyint_min args as
normalize()).
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib.normalize import (
    _build_ffmpeg_cmd,
    normalize_window,
    probe_video,
)

HAS_FFMPEG = shutil.which("ffmpeg") is not None
pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")


# ── helpers ───────────────────────────────────────────────────────────────────

def _ffprobe_stream(path, kind="v"):
    """Return the first stream of `kind` ('v' or 'a')."""
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_streams", "-select_streams", kind, str(path)],
        capture_output=True, text=True, timeout=30,
    )
    if r.returncode != 0:
        return None
    streams = json.loads(r.stdout).get("streams", [])
    return streams[0] if streams else None


def _make_conformant_sdr_video(path: Path, duration=6):
    """Create a conformant SDR h264 yuv420p bt709 video with audio.

    6 seconds by default so we can extract a window from it.
    Uses h264_metadata bsf to stamp bt709 transfer into the bitstream.
    """
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=blue:size=640x360:rate=30:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-bsf:v", "h264_metadata=transfer_characteristics=1:colour_primaries=1:matrix_coefficients=1",
        "-c:a", "aac", "-ar", "48000",
        str(path),
    ], check=True, capture_output=True, timeout=60)


# ── command-construction assertions ───────────────────────────────────────────

def test_build_ffmpeg_cmd_no_pre_input_args(tmp_path):
    """_build_ffmpeg_cmd with no pre_input_args places -i immediately after 'ffmpeg'."""
    src = tmp_path / "src.mp4"
    _make_conformant_sdr_video(src, duration=2)
    out = tmp_path / "out.mp4"
    info = probe_video(str(src))
    assert info is not None

    cmd, _ = _build_ffmpeg_cmd(str(src), str(out), "sdr_bt709", info=info, pre_input_args=[])
    # Should be: ["ffmpeg", "-y", "-i", src, ...]
    assert cmd[0] == "ffmpeg"
    assert cmd[1] == "-y"
    assert cmd[2] == "-i"
    assert cmd[3] == str(src)


def test_build_ffmpeg_cmd_with_pre_input_args_placement(tmp_path):
    """_build_ffmpeg_cmd inserts pre_input_args BEFORE -i <input>."""
    src = tmp_path / "src.mp4"
    _make_conformant_sdr_video(src, duration=2)
    out = tmp_path / "out.mp4"
    info = probe_video(str(src))
    assert info is not None

    pre_args = ["-ss", "1.0000", "-t", "2.0000"]
    cmd, _ = _build_ffmpeg_cmd(str(src), str(out), "sdr_bt709", info=info, pre_input_args=pre_args)

    # Find the index of "-i" in cmd
    i_idx = cmd.index("-i")
    # pre_input_args must appear immediately before -i
    assert cmd[i_idx - len(pre_args):i_idx] == pre_args
    # input path must follow -i
    assert cmd[i_idx + 1] == str(src)


def test_build_ffmpeg_cmd_includes_gop_args(tmp_path):
    """_build_ffmpeg_cmd includes -g and -keyint_min (GOP enforcement)."""
    src = tmp_path / "src.mp4"
    _make_conformant_sdr_video(src, duration=2)
    out = tmp_path / "out.mp4"
    info = probe_video(str(src))
    assert info is not None

    cmd, _ = _build_ffmpeg_cmd(str(src), str(out), "sdr_bt709", info=info)
    assert "-g" in cmd
    assert "-keyint_min" in cmd


def test_build_ffmpeg_cmd_includes_pix_fmt(tmp_path):
    """_build_ffmpeg_cmd includes -pix_fmt in the command."""
    src = tmp_path / "src.mp4"
    _make_conformant_sdr_video(src, duration=2)
    out = tmp_path / "out.mp4"
    info = probe_video(str(src))
    assert info is not None

    cmd, _ = _build_ffmpeg_cmd(str(src), str(out), "sdr_bt709", info=info)
    assert "-pix_fmt" in cmd


def test_normalize_window_ss_and_t_before_input(tmp_path):
    """normalize_window places -ss <in_point> and -t <duration> before -i <input>."""
    src = tmp_path / "src.mp4"
    out = tmp_path / "out.mp4"
    _make_conformant_sdr_video(src, duration=6)
    info = probe_video(str(src))
    assert info is not None

    in_point = 1.0
    out_point = 3.0

    # Monkeypatch subprocess.run to capture cmd without actually running it.
    captured = {}
    import lib.normalize as nm

    original_run = subprocess.run

    def fake_run(cmd, **kwargs):
        if cmd and cmd[0] == "ffmpeg":
            captured["cmd"] = list(cmd)
            # Return a fake successful result
            class FakeResult:
                returncode = 0
                stderr = ""
                stdout = ""
            return FakeResult()
        return original_run(cmd, **kwargs)

    import unittest.mock as mock
    with mock.patch("subprocess.run", side_effect=fake_run):
        normalize_window(str(src), str(out), "sdr_bt709", in_point, out_point, info=info)

    assert "cmd" in captured, "ffmpeg was never called"
    cmd = captured["cmd"]

    # -ss must appear before -i
    assert "-ss" in cmd
    assert "-i" in cmd
    ss_idx = cmd.index("-ss")
    i_idx = cmd.index("-i")
    assert ss_idx < i_idx, f"-ss ({ss_idx}) must be before -i ({i_idx})"

    # -t must appear before -i
    assert "-t" in cmd
    t_idx = cmd.index("-t")
    assert t_idx < i_idx, f"-t ({t_idx}) must be before -i ({i_idx})"

    # Values must be formatted as floats
    assert cmd[ss_idx + 1] == f"{in_point:.4f}"
    expected_duration = max(0.0, out_point - in_point)
    assert cmd[t_idx + 1] == f"{expected_duration:.4f}"

    # -i must be followed by the input path
    assert cmd[i_idx + 1] == str(src)

    # GOP and pix_fmt must be present
    assert "-g" in cmd
    assert "-keyint_min" in cmd
    assert "-pix_fmt" in cmd


# ── integration tests: real ffmpeg output ────────────────────────────────────

def test_normalize_window_output_is_conformant(tmp_path):
    """normalize_window produces a conformant clip (correct pix_fmt, dense GOP)."""
    src = tmp_path / "src.mp4"
    out = tmp_path / "out.mp4"
    _make_conformant_sdr_video(src, duration=6)

    normalize_window(str(src), str(out), "sdr_bt709", 1.0, 4.0)

    assert out.exists(), "output file was not created"
    info = probe_video(str(out))
    assert info is not None
    assert info["pix_fmt"] == "yuv420p"
    assert info["max_keyframe_interval"] <= 2.0, (
        f"keyframe interval {info['max_keyframe_interval']} > 2.0"
    )


def test_normalize_window_output_duration(tmp_path):
    """normalize_window produces a clip approximately (out-in) seconds long."""
    src = tmp_path / "src.mp4"
    out = tmp_path / "out.mp4"
    _make_conformant_sdr_video(src, duration=6)

    in_point = 1.0
    out_point = 4.0
    expected_duration = out_point - in_point  # 3.0s

    normalize_window(str(src), str(out), "sdr_bt709", in_point, out_point)

    assert out.exists()
    # Probe actual duration via ffprobe
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(out)],
        capture_output=True, text=True, timeout=10,
    )
    assert r.returncode == 0
    actual_duration = float(r.stdout.strip())
    # Allow ±0.5s tolerance (keyframe alignment)
    assert abs(actual_duration - expected_duration) <= 0.5, (
        f"expected ~{expected_duration}s, got {actual_duration}s"
    )


def test_normalize_window_zero_duration_clamp(tmp_path):
    """normalize_window clamps negative window (out <= in) to 0.0 duration without crash."""
    src = tmp_path / "src.mp4"
    out = tmp_path / "out.mp4"
    _make_conformant_sdr_video(src, duration=6)
    info = probe_video(str(src))
    assert info is not None

    captured = {}
    import lib.normalize as nm

    original_run = subprocess.run

    def fake_run(cmd, **kwargs):
        if cmd and cmd[0] == "ffmpeg":
            captured["cmd"] = list(cmd)
            class FakeResult:
                returncode = 0
                stderr = ""
                stdout = ""
            return FakeResult()
        return original_run(cmd, **kwargs)

    import unittest.mock as mock
    with mock.patch("subprocess.run", side_effect=fake_run):
        normalize_window(str(src), str(out), "sdr_bt709", 3.0, 1.0, info=info)

    cmd = captured["cmd"]
    t_idx = cmd.index("-t")
    assert cmd[t_idx + 1] == "0.0000"


def test_normalize_window_output_starts_at_zero(tmp_path):
    """normalize_window produces a clip starting at timestamp 0 (lazy-normalize invariant).

    The renderer rebases inPoint=0 relative to the normalized output's start_time.
    If the output doesn't start at 0, this rebase is incorrect. This test locks
    the load-bearing invariant: output.start_time ≈ 0 for all windowed extracts.
    """
    src = tmp_path / "src.mp4"
    out = tmp_path / "out.mp4"
    _make_conformant_sdr_video(src, duration=6)

    in_point = 1.0
    out_point = 4.0
    normalize_window(str(src), str(out), "sdr_bt709", in_point, out_point)

    assert out.exists()
    # Probe the output's start_time via ffprobe format=start_time
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=start_time",
         "-of", "csv=p=0", str(out)],
        capture_output=True, text=True, timeout=10,
    )
    assert r.returncode == 0, f"ffprobe failed: {r.stderr}"
    start_time_str = r.stdout.strip()
    assert start_time_str, "ffprobe returned empty start_time"
    start_time = float(start_time_str)
    # Assert start_time is approximately 0 (within 50ms tolerance).
    # Input-level -ss should produce zero start_time, but allow small rounding errors.
    assert abs(start_time) < 0.05, (
        f"normalize_window output must start at ~0s, got {start_time}s. "
        f"This breaks lazy-normalize's inPoint=0 rebase assumption."
    )
