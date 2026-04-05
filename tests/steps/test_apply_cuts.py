"""Tests for steps/apply_cuts.py"""
import json, subprocess, sys
from pathlib import Path
import pytest
from tests.conftest import run_step, assert_file_output, assert_error

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "lib"))
import common


def test_apply_cuts_from_trim_spec(tmp_path, test_video):
    spec = {"input": str(test_video), "keeps": [[0.0, 1.0], [1.5, 3.0]]}
    p = tmp_path / "s.json"
    p.write_text(json.dumps(spec))
    out = tmp_path / "out.mp4"

    proc = run_step("apply_cuts.py", "--input", str(p), "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    out_path = assert_file_output(proc)
    assert out_path.suffix == ".mp4"


def test_apply_cuts_trims_correctly(tmp_path, test_video):
    # Keep only 1s of a 3s video
    spec = {"input": str(test_video), "keeps": [[0.0, 1.0]]}
    p = tmp_path / "s.json"
    p.write_text(json.dumps(spec))
    out = tmp_path / "out.mp4"

    proc = run_step("apply_cuts.py", "--input", str(p), "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"

    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(out)],
        capture_output=True, text=True
    )
    duration = float(result.stdout.strip())
    assert 0.7 <= duration <= 1.4


def test_apply_cuts_passthrough_for_raw_video(test_video):
    # Raw video with no trim spec — returns input path unchanged
    proc = run_step("apply_cuts.py", "--input", str(test_video))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert str(test_video) in proc.stdout.strip()


def test_apply_cuts_missing_input():
    proc = run_step("apply_cuts.py", "--input", "/no/file.mp4")
    assert_error(proc)
