"""Tests for steps/virtual_to_original.py"""
import json
import pytest
from tests.conftest import run_step, assert_error


def make_spec(tmp_path, keeps, source="fake.MOV"):
    spec = {"input": source, "keeps": keeps}
    p = tmp_path / "spec.json"
    p.write_text(json.dumps(spec))
    return p


# Keeps: [0,10], [20,30], [40,60] → virtual durations 10, 10, 20 = total 40s


def test_basic_mapping(tmp_path):
    spec = make_spec(tmp_path, [[0, 10], [20, 30], [40, 60]])
    proc = run_step("virtual_to_original.py", "--input", str(spec), "5.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert proc.stdout.strip() == "5.000"


def test_mapping_second_segment(tmp_path):
    # virtual 12 → in second seg (virtual 10=orig 20): orig 20 + 2 = 22
    spec = make_spec(tmp_path, [[0, 10], [20, 30], [40, 60]])
    proc = run_step("virtual_to_original.py", "--input", str(spec), "12.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert proc.stdout.strip() == "22.000"


def test_mapping_third_segment(tmp_path):
    # virtual 25 → in third seg (virtual 20=orig 40): orig 40 + 5 = 45
    spec = make_spec(tmp_path, [[0, 10], [20, 30], [40, 60]])
    proc = run_step("virtual_to_original.py", "--input", str(spec), "25.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert proc.stdout.strip() == "45.000"


def test_multiple_timestamps(tmp_path):
    spec = make_spec(tmp_path, [[0, 10], [20, 30], [40, 60]])
    proc = run_step("virtual_to_original.py", "--input", str(spec), "5.0", "12.0", "25.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    lines = proc.stdout.strip().splitlines()
    assert lines == ["5.000", "22.000", "45.000"]


def test_timestamp_at_exact_segment_boundary(tmp_path):
    # virtual 10.0 is the tail of seg 1 [0,10] → original 10.0
    # (the gap [10,20] in the original is removed; virtual 10.0 == end of seg 1)
    spec = make_spec(tmp_path, [[0, 10], [20, 30]])
    proc = run_step("virtual_to_original.py", "--input", str(spec), "10.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = float(proc.stdout.strip())
    assert abs(result - 10.0) < 0.001


def test_timestamp_past_end_clamps(tmp_path):
    spec = make_spec(tmp_path, [[0, 10]])
    proc = run_step("virtual_to_original.py", "--input", str(spec), "999.0")
    assert proc.returncode == 0
    assert "clamping" in proc.stderr
    assert proc.stdout.strip() == "10.000"


def test_inverse_mapping(tmp_path):
    # orig 22 → virtual 12 (orig 22 is in seg [20,30], virtual offset 10 + 2 = 12)
    spec = make_spec(tmp_path, [[0, 10], [20, 30], [40, 60]])
    proc = run_step("virtual_to_original.py", "--input", str(spec), "--inverse", "22.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert proc.stdout.strip() == "12.000"


def test_json_flag_form(tmp_path):
    spec = make_spec(tmp_path, [[0, 10], [20, 30]])
    proc = run_step("virtual_to_original.py", "--input", str(spec), "--times", "[5.0, 12.0]")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "results" in result
    assert abs(result["results"][0] - 5.0) < 0.001
    assert abs(result["results"][1] - 22.0) < 0.001


def test_missing_spec_file():
    proc = run_step("virtual_to_original.py", "--input", "/no/spec.json", "5.0")
    assert_error(proc, "file_not_found")
