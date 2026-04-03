"""Tests for steps/rm_nonspeech.py — uses fake whisper binary."""
import json
import pytest
from tests.conftest import run_step_env, assert_error


def test_rm_nonspeech_produces_output(test_video, tmp_path, fake_whisper_env):
    out = tmp_path / "clean.mp4"
    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"


def test_rm_nonspeech_missing_input(fake_whisper_env):
    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", "/no/file.mp4")
    assert_error(proc, "file_not_found")


def test_rm_nonspeech_accepts_trim_spec(tmp_path, test_video, fake_whisper_env):
    spec = {"input": str(test_video), "keeps": [[0.0, 3.0]]}
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))

    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", str(spec_path), "--model", "base.en")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "input" in result
    assert "keeps" in result
    assert result["input"] == str(test_video)
