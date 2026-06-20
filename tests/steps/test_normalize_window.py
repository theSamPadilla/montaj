"""Tests for steps/transform/normalize_window.py"""
import subprocess

import pytest

from tests.conftest import assert_error, assert_file_output, run_step


def test_normalize_window_basic(test_video, tmp_path):
    """Step encodes a windowed segment and prints the output path."""
    out = tmp_path / "windowed.mp4"
    proc = run_step(
        "normalize_window.py",
        "--input", str(test_video),
        "--inpoint", "0.5",
        "--outpoint", "2.0",
        "--color-space", "sdr_bt709",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    result = assert_file_output(proc)
    assert result == out


def test_normalize_window_duration(test_video, tmp_path):
    """Output duration approximates the requested window (0.5 → 2.0 = 1.5s)."""
    out = tmp_path / "windowed.mp4"
    proc = run_step(
        "normalize_window.py",
        "--input", str(test_video),
        "--inpoint", "0.5",
        "--outpoint", "2.0",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr

    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(out)],
        capture_output=True, text=True,
    )
    duration = float(r.stdout.strip())
    assert 1.0 <= duration <= 2.0, f"unexpected duration: {duration}"


def test_normalize_window_default_color_space(test_video, tmp_path):
    """--color-space defaults to sdr_bt709 when omitted."""
    out = tmp_path / "windowed_default.mp4"
    proc = run_step(
        "normalize_window.py",
        "--input", str(test_video),
        "--inpoint", "0.0",
        "--outpoint", "1.5",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    assert_file_output(proc)


def test_normalize_window_missing_input(tmp_path):
    """Step fails with a structured JSON error when the input file is absent."""
    out = tmp_path / "out.mp4"
    proc = run_step(
        "normalize_window.py",
        "--input", "/no/such/file.mp4",
        "--inpoint", "0.0",
        "--outpoint", "1.0",
        "--out", str(out),
    )
    assert_error(proc, "file_not_found")


def test_normalize_window_help():
    """Step's argparse --help exits cleanly (exit 0)."""
    import subprocess as sp, sys
    from pathlib import Path
    from tests.conftest import REPO_ROOT
    script = REPO_ROOT / "steps" / "transform" / "normalize_window.py"
    r = sp.run([sys.executable, str(script), "--help"], capture_output=True, text=True)
    assert r.returncode == 0
    assert "--input" in r.stdout
    assert "--inpoint" in r.stdout
    assert "--outpoint" in r.stdout
    assert "--color-space" in r.stdout
    assert "--out" in r.stdout
