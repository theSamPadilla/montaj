"""Tests for steps/waveform_trim.py"""
import json
import os
import subprocess
import sys

from tests.conftest import REPO_ROOT, run_step, assert_json_output, assert_error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from trim_spec import is_trim_spec, load as load_spec


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


# --- --out (FQ1.1 T8) -------------------------------------------------------

def test_waveform_trim_out_writes_file_and_prints_path(test_video, tmp_path):
    out = tmp_path / "spec.json"
    proc = run_step("waveform_trim.py", "--input", str(test_video), "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"

    printed = json.loads(proc.stdout)
    assert printed == {"path": str(out)}

    assert out.exists()
    on_disk = json.loads(out.read_text())
    assert on_disk["input"] == str(test_video)
    assert isinstance(on_disk["keeps"], list) and on_disk["keeps"]


def test_waveform_trim_out_resolves_to_absolute_path(test_video, tmp_path):
    """A relative --out is resolved against cwd and reported as an absolute path."""
    step = REPO_ROOT / "steps" / "audio" / "waveform_trim.py"
    proc = subprocess.run(
        [sys.executable, str(step), "--input", str(test_video), "--out", "rel_spec.json"],
        capture_output=True, text=True, cwd=str(tmp_path),
    )
    assert proc.returncode == 0, f"stderr: {proc.stderr}"

    printed = json.loads(proc.stdout)
    expected = str(tmp_path / "rel_spec.json")
    assert printed == {"path": expected}
    assert os.path.isabs(printed["path"])
    assert os.path.isfile(expected)


def test_waveform_trim_out_file_accepted_by_rm_nonspeech_loader(test_video, tmp_path):
    """The file --out writes must be exactly what rm_nonspeech's trim-spec
    loader (lib/trim_spec.py) accepts — it is the first thing rm_nonspeech
    calls on --input before doing any work."""
    out = tmp_path / "spec.json"
    proc = run_step("waveform_trim.py", "--input", str(test_video), "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    path = json.loads(proc.stdout)["path"]

    assert is_trim_spec(path)
    spec = load_spec(path)
    assert spec["input"] == str(test_video)
    assert isinstance(spec["keeps"], list) and spec["keeps"]


def test_waveform_trim_no_out_is_unchanged(test_video):
    """Without --out, stdout is still the bare trim spec — no 'path' wrapping."""
    proc = run_step("waveform_trim.py", "--input", str(test_video))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    spec = json.loads(proc.stdout)
    assert "path" not in spec
    assert "input" in spec and "keeps" in spec


def test_waveform_trim_out_rejected_with_inputs(test_video, tmp_path):
    out = tmp_path / "should-not-write.json"
    proc = run_step("waveform_trim.py", "--inputs", str(test_video), str(test_video),
                    "--out", str(out))
    assert_error(proc, "invalid_args")
    assert not out.exists()
