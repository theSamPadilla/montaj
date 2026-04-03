"""Tests for steps/waveform_trim.py"""
import json
from tests.conftest import run_step, assert_json_output, assert_error


def test_waveform_trim_outputs_trim_spec(test_video):
    proc = run_step("waveform_trim.py", "--input", str(test_video),
                    "--threshold", "-30", "--min-silence", "0.3")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    spec = json.loads(proc.stdout)
    assert "input" in spec
    assert "keeps" in spec
    assert isinstance(spec["keeps"], list)
    assert len(spec["keeps"]) > 0
    assert all(len(k) == 2 and k[1] > k[0] for k in spec["keeps"])


def test_waveform_trim_input_is_original_path(test_video):
    proc = run_step("waveform_trim.py", "--input", str(test_video))
    spec = json.loads(proc.stdout)
    assert spec["input"] == str(test_video)


def test_waveform_trim_missing_input():
    proc = run_step("waveform_trim.py", "--input", "/no/file.mp4")
    assert_error(proc, "file_not_found")


def test_waveform_trim_batch_outputs_array(test_video):
    proc = run_step("waveform_trim.py", "--inputs", str(test_video), str(test_video))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert isinstance(result, list)
    assert len(result) == 2
    for spec in result:
        assert "input" in spec and "keeps" in spec
