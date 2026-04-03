"""Tests for steps/crop_spec.py"""
import json
import pytest
from tests.conftest import run_step, assert_error


def make_spec(tmp_path, keeps, source="fake.MOV"):
    spec = {"input": source, "keeps": keeps}
    p = tmp_path / "spec.json"
    p.write_text(json.dumps(spec))
    return p


# Keeps: [0,10], [20,30], [40,60] → virtual durations 10, 10, 20 = total 40s


def test_single_window(tmp_path):
    spec = make_spec(tmp_path, [[0, 10], [20, 30], [40, 60]])
    out = tmp_path / "out.json"
    proc = run_step("crop_spec.py", "--input", str(spec), "--keep", "2:7", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(out.read_text())
    assert result["keeps"] == [[2.0, 7.0]]


def test_multi_window(tmp_path):
    spec = make_spec(tmp_path, [[0, 10], [20, 30], [40, 60]])
    out = tmp_path / "out.json"
    proc = run_step("crop_spec.py", "--input", str(spec), "--keep", "0:2.4", "--keep", "13.84:18.33", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(out.read_text())
    keeps = result["keeps"]
    # First window [0,2.4] maps to orig [0,2.4] (within first seg [0,10])
    assert abs(keeps[0][0] - 0.0) < 0.001
    assert abs(keeps[0][1] - 2.4) < 0.001
    # Second window [13.84,18.33] spans into second seg (virtual 10=orig 20)
    # virtual 13.84 → orig 20 + 3.84 = 23.84; virtual 18.33 → orig 28.33
    assert abs(keeps[1][0] - 23.84) < 0.001
    assert abs(keeps[1][1] - 28.33) < 0.001


def test_window_spanning_segment_boundary(tmp_path):
    # virtual [8, 12]: first seg ends at virtual 10 (orig 10), second seg starts at orig 20
    spec = make_spec(tmp_path, [[0, 10], [20, 30], [40, 60]])
    out = tmp_path / "out.json"
    proc = run_step("crop_spec.py", "--input", str(spec), "--keep", "8:12", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(out.read_text())
    keeps = result["keeps"]
    assert len(keeps) == 2
    # Part from first seg: orig [8, 10]
    assert abs(keeps[0][0] - 8.0) < 0.001
    assert abs(keeps[0][1] - 10.0) < 0.001
    # Part from second seg: orig [20, 22]
    assert abs(keeps[1][0] - 20.0) < 0.001
    assert abs(keeps[1][1] - 22.0) < 0.001


def test_end_sentinel(tmp_path):
    spec = make_spec(tmp_path, [[0, 10], [20, 30], [40, 60]])
    out = tmp_path / "out.json"
    proc = run_step("crop_spec.py", "--input", str(spec), "--keep", "25:end", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(out.read_text())
    keeps = result["keeps"]
    # virtual 25 → into third seg (virtual 20=orig 40): orig 40 + (25-20) = 45
    assert abs(keeps[0][0] - 45.0) < 0.001
    assert abs(keeps[-1][1] - 60.0) < 0.001


def test_window_past_end_is_clamped(tmp_path):
    spec = make_spec(tmp_path, [[0, 10]])
    out = tmp_path / "out.json"
    proc = run_step("crop_spec.py", "--input", str(spec), "--keep", "5:999", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(out.read_text())
    keeps = result["keeps"]
    assert abs(keeps[0][0] - 5.0) < 0.001
    assert abs(keeps[0][1] - 10.0) < 0.001


def test_noop_zero_to_end(tmp_path):
    original_keeps = [[0, 10], [20, 30]]
    spec = make_spec(tmp_path, original_keeps)
    out = tmp_path / "out.json"
    proc = run_step("crop_spec.py", "--input", str(spec), "--keep", "0:end", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(out.read_text())
    assert result["keeps"] == original_keeps


def test_default_output_path(tmp_path):
    spec = make_spec(tmp_path, [[0, 10]])
    proc = run_step("crop_spec.py", "--input", str(spec), "--keep", "0:5")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    out_path = proc.stdout.strip()
    assert out_path.endswith("_cropped.json")


def test_missing_spec_file():
    proc = run_step("crop_spec.py", "--input", "/no/spec.json", "--keep", "0:5")
    assert_error(proc, "file_not_found")


def test_source_path_preserved(tmp_path):
    spec = make_spec(tmp_path, [[0, 10]], source="/original/video.MOV")
    out = tmp_path / "out.json"
    proc = run_step("crop_spec.py", "--input", str(spec), "--keep", "0:5", "--out", str(out))
    assert proc.returncode == 0
    result = json.loads(out.read_text())
    assert result["input"] == "/original/video.MOV"
