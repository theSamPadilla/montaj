"""Tests for steps/jump_cut_detect.py — uses fake whisper binary."""
import json
import pytest
from tests.conftest import run_step_env, assert_error


def test_jump_cut_detect_returns_json(test_video, tmp_path, fake_whisper_env):
    out = tmp_path / "issues.json"
    proc = run_step_env("jump_cut_detect.py", fake_whisper_env,
                        "--input", str(test_video), "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(out.read_text())
    assert "issues" in data or isinstance(data, list)


def test_jump_cut_detect_no_model(test_video, tmp_path, fake_whisper_env):
    # --model none skips whisper transcription
    out = tmp_path / "issues.json"
    proc = run_step_env("jump_cut_detect.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "none", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"


def test_jump_cut_detect_missing_input(fake_whisper_env):
    proc = run_step_env("jump_cut_detect.py", fake_whisper_env,
                        "--input", "/no/file.mp4")
    assert_error(proc, "file_not_found")
