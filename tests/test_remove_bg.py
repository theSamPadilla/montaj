"""Tests for steps/remove_bg.py"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
STEP = REPO_ROOT / "steps" / "remove_bg.py"


# ---------------------------------------------------------------------------
# Error-path tests — do NOT require torch
# ---------------------------------------------------------------------------

def test_remove_bg_fails_without_input():
    """Running the step with no arguments should exit non-zero."""
    r = subprocess.run([sys.executable, str(STEP)], capture_output=True, text=True)
    assert r.returncode != 0


def test_remove_bg_fails_missing_file(tmp_path):
    """Running the step with a nonexistent file should exit non-zero.

    If torch is available, we expect a file_not_found JSON error on stderr.
    If torch is NOT available, we expect a missing_dependency JSON error.
    Either way returncode must be non-zero.
    """
    r = subprocess.run(
        [sys.executable, str(STEP), "--input", "/nonexistent/clip.mp4"],
        capture_output=True, text=True,
    )
    assert r.returncode != 0
    # stderr should still be a JSON error object
    # Find the first line of stderr that is valid JSON
    err = None
    for line in r.stderr.splitlines():
        line = line.strip()
        if line.startswith('{'):
            try:
                err = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
    assert err is not None, f"No JSON error found in stderr: {r.stderr!r}"
    assert "error" in err
    assert "message" in err


def test_remove_bg_mutual_exclusion(tmp_path):
    """--input and --inputs must be mutually exclusive."""
    r = subprocess.run(
        [
            sys.executable, str(STEP),
            "--input", "/nonexistent/a.mp4",
            "--inputs", "/nonexistent/b.mp4",
        ],
        capture_output=True, text=True,
    )
    assert r.returncode != 0


# ---------------------------------------------------------------------------
# Slow inference tests — require torch
# ---------------------------------------------------------------------------

@pytest.mark.slow
def test_remove_bg_output_is_prores_4444(tmp_path):
    """Output file should be a ProRes 4444 .mov with alpha (yuva444p10le)."""
    torch = pytest.importorskip("torch", reason="torch not installed")
    av = pytest.importorskip("av", reason="PyAV not installed")

    import subprocess as _sp
    import shutil

    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not available")

    # Create a tiny synthetic video using ffmpeg
    src = tmp_path / "src.mp4"
    _sp.run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10",
            "-t", "1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            str(src),
        ],
        check=True, capture_output=True,
    )

    out = tmp_path / "nobg.mov"
    r = subprocess.run(
        [
            sys.executable, str(STEP),
            "--input", str(src),
            "--out", str(out),
            "--model", "rvm_mobilenetv3",
            "--downsample", "0.25",
        ],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, f"stderr: {r.stderr}"
    assert out.exists()
    assert out.stat().st_size > 0

    # Verify codec via ffprobe
    probe = _sp.run(
        [
            "ffprobe", "-v", "quiet",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,pix_fmt",
            "-of", "json",
            str(out),
        ],
        capture_output=True, text=True, check=True,
    )
    info = json.loads(probe.stdout)
    stream = info["streams"][0]
    assert stream["codec_name"] == "prores"
    assert stream["pix_fmt"] == "yuva444p12le"
