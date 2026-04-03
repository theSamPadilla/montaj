"""Tests for steps/best_take.py — uses fake whisper binary."""
import json
import pytest
from tests.conftest import run_step_env, assert_error


def test_best_take_returns_json(test_video, tmp_path, fake_whisper_env):
    out = tmp_path / "takes.json"
    proc = run_step_env("best_take.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base.en", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(out.read_text())
    assert isinstance(data, (dict, list))


def test_best_take_missing_input(fake_whisper_env):
    proc = run_step_env("best_take.py", fake_whisper_env,
                        "--input", "/no/file.mp4")
    assert_error(proc, "file_not_found")
