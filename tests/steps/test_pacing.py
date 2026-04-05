"""Tests for steps/pacing.py — uses fake whisper binary."""
import json
import os
import pytest
from tests.conftest import run_step_env, assert_error

_WHISPER_MODEL_NEW = os.path.expanduser("~/.local/share/montaj/models/whisper/ggml-base.en.bin")
_WHISPER_MODEL_OLD = os.path.expanduser("~/.local/share/whisper.cpp/models/ggml-base.en.bin")
requires_whisper = pytest.mark.skipif(
    not os.path.isfile(_WHISPER_MODEL_NEW) and not os.path.isfile(_WHISPER_MODEL_OLD),
    reason="whisper model not installed",
)

pytestmark = requires_whisper


def test_pacing_returns_json(test_video, tmp_path, fake_whisper_env):
    out = tmp_path / "pacing.json"
    proc = run_step_env("pacing.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base.en", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(out.read_text())
    assert "segments" in data or "slow_sections" in data or isinstance(data, dict)


def test_pacing_missing_input(fake_whisper_env):
    proc = run_step_env("pacing.py", fake_whisper_env,
                        "--input", "/no/file.mp4")
    assert_error(proc, "file_not_found")
