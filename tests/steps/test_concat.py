"""Tests for steps/concat.py"""
import sys
from pathlib import Path
import pytest
from tests.conftest import run_step, assert_file_output, assert_error

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "lib"))
import common


def test_concat_two_clips(test_video, tmp_path):
    out = tmp_path / "concat.mp4"
    proc = run_step("concat.py", "--inputs", str(test_video), str(test_video), "--out", str(out))
    assert_file_output(proc)
    dur = common.get_duration(str(out))
    original = common.get_duration(str(test_video))
    # Duration should be approximately double
    assert dur >= original * 1.5


def test_concat_three_clips(test_video, tmp_path):
    out = tmp_path / "concat3.mp4"
    proc = run_step("concat.py", "--inputs", str(test_video), str(test_video), str(test_video), "--out", str(out))
    assert_file_output(proc)
    dur = common.get_duration(str(out))
    original = common.get_duration(str(test_video))
    assert dur >= original * 2.5


def test_concat_missing_input():
    proc = run_step("concat.py", "--inputs", "/no/file.mp4")
    assert_error(proc)


import json, subprocess

def test_concat_accepts_trim_specs(tmp_path, test_video):
    spec1 = {"input": str(test_video), "keeps": [[0.0, 1.0], [1.5, 3.0]]}
    spec2 = {"input": str(test_video), "keeps": [[0.5, 2.0]]}
    p1 = tmp_path / "s1.json"; p1.write_text(json.dumps(spec1))
    p2 = tmp_path / "s2.json"; p2.write_text(json.dumps(spec2))
    out = tmp_path / "out.mp4"

    proc = run_step("concat.py", "--inputs", str(p1), str(p2), "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    out_path = assert_file_output(proc)
    assert out_path.suffix == ".mp4"

def test_concat_trim_spec_applies_cuts(tmp_path, test_video):
    # A 3s video with 1s kept → output should be ~1s
    spec = {"input": str(test_video), "keeps": [[0.0, 1.0]]}
    p = tmp_path / "s.json"; p.write_text(json.dumps(spec))
    out = tmp_path / "out.mp4"

    proc = run_step("concat.py", "--inputs", str(p), "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(out)],
        capture_output=True, text=True
    )
    duration = float(result.stdout.strip())
    assert 0.7 <= duration <= 1.4

def test_concat_rejects_mixed_inputs(tmp_path, test_video):
    spec = {"input": str(test_video), "keeps": [[0.0, 1.0]]}
    p = tmp_path / "s.json"; p.write_text(json.dumps(spec))
    from tests.conftest import assert_error
    proc = run_step("concat.py", "--inputs", str(p), str(test_video))
    assert_error(proc, "invalid_input")
