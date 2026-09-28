"""Step-level tests for steps/generate/generate_music.py — PV29 T7.

Covers the new --vendor elevenlabs path (duration -> length_ms conversion,
the --duration-required precheck) and the ConnectorError.reason -> fail()
mapping for both vendors. Every test monkeypatches the connector's
generate_music directly and lib.common.get_duration (no real audio file, no
ffprobe) — the connectors' own SDK/HTTP-mocked tests cover what
generate_music() itself does. Nothing here makes a real network call.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from connectors import ConnectorError
import connectors.gemini as gemini_mod
import connectors.elevenlabs as elevenlabs_mod

_STEP_PATH = REPO_ROOT / "steps" / "generate" / "generate_music.py"


@pytest.fixture
def step_module(monkeypatch):
    spec = importlib.util.spec_from_file_location("generate_music_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "get_duration", lambda path: 12.0)
    return mod


def _last_stderr_json(capsys):
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


class TestDefaultVendorUnchanged:
    def test_default_vendor_is_still_gemini(self, step_module, monkeypatch, capsys, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(gemini_mod, "generate_music", capture)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "lofi", "--out", str(tmp_path / "m.mp3"), "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["vendor"] == "gemini"
        assert seen["prompt"] == "lofi"


class TestElevenLabsVendorDispatch:
    def test_duration_converts_to_length_ms(self, step_module, monkeypatch, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(elevenlabs_mod, "generate_music", capture)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "ambient pad", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "5.5",
        ])
        step_module.main()
        assert seen["length_ms"] == 5500
        assert seen["prompt"] == "ambient pad"

    def test_duration_required_for_elevenlabs(self, step_module, monkeypatch, capsys, tmp_path):
        def boom(**kw):
            raise AssertionError("must not reach the connector")
        monkeypatch.setattr(elevenlabs_mod, "generate_music", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "ambient pad", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs",
        ])
        with pytest.raises(SystemExit) as ei:
            step_module.main()
        assert ei.value.code == 1
        err = _last_stderr_json(capsys)
        assert err["error"] == "invalid_args"

    def test_model_override_passed_through(self, step_module, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(elevenlabs_mod, "generate_music", lambda **kw: kw["out_path"])
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "3", "--model", "custom", "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["model"] == "custom"

    def test_default_model_reported_when_not_overridden(self, step_module, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(elevenlabs_mod, "generate_music", lambda **kw: kw["out_path"])
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "3", "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["model"] == elevenlabs_mod.DEFAULT_MUSIC_MODEL

    def test_seed_and_with_vocals_not_passed_to_elevenlabs(self, step_module, monkeypatch, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(elevenlabs_mod, "generate_music", capture)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "3", "--seed", "7", "--with-vocals",
        ])
        step_module.main()
        assert "seed" not in seen
        assert "instrumental" not in seen


class TestConnectorErrorMapping:
    def test_gemini_invalid_api_key_uses_gemini_specific_message(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        def boom(**kw):
            err = ConnectorError("Gemini rejected the API key: bad key", reason="invalid_api_key")
            err.google_detail = "API key expired."
            raise err
        monkeypatch.setattr(gemini_mod, "generate_music", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["error"] == "invalid_api_key"
        assert "Google said: API key expired." in err["message"]

    def test_elevenlabs_insufficient_credit_maps_through(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        """This is the plan-gate case: ElevenLabs music needs a paid plan."""
        def boom(**kw):
            raise ConnectorError("ElevenLabs music needs a paid plan.", reason="insufficient_credit")
        monkeypatch.setattr(elevenlabs_mod, "generate_music", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "3",
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["error"] == "insufficient_credit"
        assert err["message"] == "ElevenLabs music needs a paid plan."

    def test_elevenlabs_invalid_api_key_does_not_use_gemini_message(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        def boom(**kw):
            raise ConnectorError("ElevenLabs key check failed (HTTP 401): invalid key",
                                  reason="invalid_api_key")
        monkeypatch.setattr(elevenlabs_mod, "generate_music", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "3",
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["error"] == "invalid_api_key"
        assert err["message"] == "ElevenLabs key check failed (HTTP 401): invalid key"
