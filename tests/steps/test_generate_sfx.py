"""Step-level tests for steps/generate/generate_sfx.py — PV29 T7.

Every test monkeypatches connectors.elevenlabs.generate_sfx directly and
lib.common.get_duration (no real audio file, no ffprobe) — the connector's
own HTTP-mocked tests (test_connectors_elevenlabs.py) cover what
generate_sfx() itself does. Nothing here makes a real network call.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from connectors import ConnectorError
import connectors.elevenlabs as elevenlabs_mod

_STEP_PATH = REPO_ROOT / "steps" / "generate" / "generate_sfx.py"


@pytest.fixture
def step_module(monkeypatch):
    spec = importlib.util.spec_from_file_location("generate_sfx_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "get_duration", lambda path: 1.5)
    return mod


def _last_stderr_json(capsys):
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


class TestHappyPath:
    def test_bare_path_without_json_flag(self, step_module, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(elevenlabs_mod, "generate_sfx", lambda **kw: kw["out_path"])
        monkeypatch.setattr(sys, "argv", [
            "generate_sfx.py", "--text", "glass shattering", "--out", str(tmp_path / "o.mp3"),
        ])
        step_module.main()
        assert capsys.readouterr().out.strip() == str(tmp_path / "o.mp3")

    def test_full_dict_with_json_flag(self, step_module, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(elevenlabs_mod, "generate_sfx", lambda **kw: kw["out_path"])
        monkeypatch.setattr(sys, "argv", [
            "generate_sfx.py", "--text", "glass shattering", "--out", str(tmp_path / "o.mp3"), "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out == {
            "path": str(tmp_path / "o.mp3"), "duration_seconds": 1.5,
            "vendor": "elevenlabs", "model": elevenlabs_mod.DEFAULT_SFX_MODEL,
        }

    def test_duration_passed_through(self, step_module, monkeypatch, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(elevenlabs_mod, "generate_sfx", capture)
        monkeypatch.setattr(sys, "argv", [
            "generate_sfx.py", "--text", "x", "--out", str(tmp_path / "o.mp3"), "--duration", "3.5",
        ])
        step_module.main()
        assert seen["duration_seconds"] == 3.5

    def test_duration_omitted_when_not_given(self, step_module, monkeypatch, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(elevenlabs_mod, "generate_sfx", capture)
        monkeypatch.setattr(sys, "argv", [
            "generate_sfx.py", "--text", "x", "--out", str(tmp_path / "o.mp3"),
        ])
        step_module.main()
        assert "duration_seconds" not in seen

    def test_model_override(self, step_module, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(elevenlabs_mod, "generate_sfx", lambda **kw: kw["out_path"])
        monkeypatch.setattr(sys, "argv", [
            "generate_sfx.py", "--text", "x", "--out", str(tmp_path / "o.mp3"),
            "--model", "custom-model", "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["model"] == "custom-model"


class TestConnectorErrorMapping:
    @pytest.mark.parametrize("reason,code", [
        ("invalid_api_key", "invalid_api_key"),
        ("insufficient_credit", "insufficient_credit"),
        ("model_retired", "model_retired"),
        ("unreachable", "provider_unreachable"),
        (None, "api_error"),
    ])
    def test_reason_maps_to_fail_code(self, step_module, monkeypatch, capsys, tmp_path, reason, code):
        def boom(**kw):
            raise ConnectorError("ElevenLabs sound effect generation failed: boom", reason=reason)
        monkeypatch.setattr(elevenlabs_mod, "generate_sfx", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_sfx.py", "--text", "x", "--out", str(tmp_path / "o.mp3"),
        ])
        with pytest.raises(SystemExit) as ei:
            step_module.main()
        assert ei.value.code == 1
        err = _last_stderr_json(capsys)
        assert err["error"] == code

    def test_vendor_prefixed_onto_a_bare_message(self, step_module, monkeypatch, capsys, tmp_path):
        def boom(**kw):
            raise ConnectorError("text must not be empty")
        monkeypatch.setattr(elevenlabs_mod, "generate_sfx", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_sfx.py", "--text", "x", "--out", str(tmp_path / "o.mp3"),
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["message"] == "ElevenLabs: text must not be empty"
