"""Tests for steps/lyrics/lyrics_sync.py model selection."""
import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
_STEP_PATH = REPO_ROOT / "steps" / "lyrics" / "lyrics_sync.py"


def _load_step():
    spec = importlib.util.spec_from_file_location("lyrics_sync_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Stop(Exception):
    pass


def test_default_model_is_turbo():
    assert _load_step().WHISPER_MODEL == "large-v3-turbo-q5_0"


def test_model_goes_through_resolve_whisper_model(tmp_path, monkeypatch):
    """lyrics_sync picks its weight via resolve_whisper_model, so a requested
    model that is not installed falls back like every other whisper step."""
    mod = _load_step()
    audio = tmp_path / "vocals.wav"
    audio.write_bytes(b"x")
    lyrics = tmp_path / "lyrics.txt"
    lyrics.write_text("hello world\n")

    calls = []

    def fake_resolve(model, language):
        calls.append((model, language))
        raise _Stop()

    monkeypatch.setattr(mod, "resolve_whisper_model", fake_resolve)
    monkeypatch.setattr(sys, "argv", [
        "lyrics_sync.py", "--input", str(audio), "--lyrics", str(lyrics),
        "--model", "base.en", "--language", "es",
    ])
    with pytest.raises(_Stop):
        mod.main()
    assert calls == [("base.en", "es")]
