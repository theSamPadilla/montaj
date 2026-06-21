"""Tests for steps/transcribe.py — uses fake whisper binary."""
import importlib.util
import json
import os
import sys
from pathlib import Path
import pytest
from tests.conftest import run_step_env, assert_error

REPO_ROOT = Path(__file__).parent.parent.parent
_STEP_PATH = REPO_ROOT / "steps" / "speech" / "transcribe.py"


@pytest.fixture
def transcribe_module():
    """Import steps/speech/transcribe.py as a module (no subprocess)."""
    spec = importlib.util.spec_from_file_location("transcribe_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_transcribe_produces_srt_and_json(test_video, tmp_path, fake_whisper_env):
    prefix = str(tmp_path / "out")
    proc = run_step_env("transcribe.py", fake_whisper_env,
                        "--input", str(test_video), "--out", prefix)
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "srt" in result
    assert "words" in result
    assert Path(result["words"]).exists()


def test_transcribe_words_json_format(test_video, tmp_path, fake_whisper_env):
    prefix = str(tmp_path / "out")
    proc = run_step_env("transcribe.py", fake_whisper_env,
                        "--input", str(test_video), "--out", prefix)
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    words_data = json.loads(Path(result["words"]).read_text())
    assert "transcription" in words_data
    assert len(words_data["transcription"]) > 0
    entry = words_data["transcription"][0]
    assert "text" in entry
    assert "offsets" in entry


def test_transcribe_missing_input(fake_whisper_env):
    proc = run_step_env("transcribe.py", fake_whisper_env,
                        "--input", "/no/file.mp4")
    assert_error(proc, "file_not_found")


def test_transcribe_accepts_trim_spec(tmp_path, test_video, fake_whisper_env):
    spec = {"input": str(test_video), "keeps": [[0.0, 1.5], [1.8, 3.0]]}
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))

    proc = run_step_env("transcribe.py", fake_whisper_env,
                        "--input", str(spec_path), "--model", "base.en")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    # Should print a path to a .srt or .json file
    out = proc.stdout.strip()
    assert out  # non-empty


def test_transcribe_trim_spec_remaps_timestamps(tmp_path, test_video, fake_whisper_env):
    # keeps start at 2.0s — all word timestamps should be offset by 2000ms
    spec = {"input": str(test_video), "keeps": [[2.0, 3.0]]}
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))
    out_prefix = str(tmp_path / "out")

    proc = run_step_env("transcribe.py", fake_whisper_env,
                        "--input", str(spec_path), "--model", "base.en",
                        "--out", out_prefix)
    assert proc.returncode == 0, f"stderr: {proc.stderr}"

    words_path = tmp_path / "out.json"
    assert words_path.exists(), "words JSON not written"
    data = json.loads(words_path.read_text())
    first_word = data["transcription"][0]
    # fake whisper returns first word at offset 0ms
    # remapped to keep starting at 2.0s → should be >= 2000ms
    assert first_word["offsets"]["from"] >= 2000


def test_transcribe_single_whisper_invocation(transcribe_module, monkeypatch, tmp_path, capsys):
    """whisper-cli must be called exactly once, with both --output-srt and --output-json."""
    audio_file = tmp_path / "audio.wav"
    audio_file.write_bytes(b"\x00" * 16)  # non-empty placeholder

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        # Write both output files so downstream checks pass
        prefix = None
        for i, a in enumerate(cmd):
            if a == "--output-file" and i + 1 < len(cmd):
                prefix = cmd[i + 1]
        if prefix:
            Path(prefix + ".srt").write_text("1\n00:00:00,000 --> 00:00:00,500\nHello\n")
            Path(prefix + ".json").write_text(
                '{"transcription": [{"text": "Hello", "offsets": {"from": 0, "to": 500}}]}'
            )

    monkeypatch.setattr(transcribe_module, "run", fake_run)
    monkeypatch.setattr(transcribe_module, "find_whisper_bin", lambda: "whisper-cli")
    monkeypatch.setattr(transcribe_module._models, "model_path",
                        lambda family, name: str(tmp_path / name))
    monkeypatch.setattr(transcribe_module, "require_file", lambda path: None)

    out_prefix = str(tmp_path / "out")
    monkeypatch.setattr(sys, "argv",
                        ["transcribe.py", "--input", str(audio_file), "--out", out_prefix])
    transcribe_module.main()

    assert len(calls) == 1, f"Expected 1 whisper invocation, got {len(calls)}: {calls}"
    argv = calls[0]
    assert "--output-srt" in argv, "--output-srt missing from whisper call"
    assert "--output-json" in argv, "--output-json missing from whisper call"
