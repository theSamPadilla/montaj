"""Step-level tests for steps/generate/generate_voiceover.py — PV29 T7.

Covers the new --vendor elevenlabs path and the ConnectorError.reason ->
fail() mapping for all three vendors. Every test monkeypatches the
connector's generate_speech directly and lib.common.get_duration (no real
audio file, no ffprobe) — the connectors' own HTTP/SDK-mocked tests cover
what generate_speech() itself does. Nothing here makes a real network call.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from connectors import ConnectorError
import connectors.kling as kling_mod
import connectors.gemini as gemini_mod
import connectors.elevenlabs as elevenlabs_mod

_STEP_PATH = REPO_ROOT / "steps" / "generate" / "generate_voiceover.py"


@pytest.fixture
def step_module(monkeypatch):
    spec = importlib.util.spec_from_file_location("generate_voiceover_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "get_duration", lambda path: 2.0)
    return mod


def _last_stderr_json(capsys):
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


class TestElevenLabsVendorDispatch:
    def test_elevenlabs_path_calls_connector(self, step_module, monkeypatch, capsys, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(elevenlabs_mod, "generate_speech", capture)
        monkeypatch.setattr(sys, "argv", [
            "generate_voiceover.py", "--text", "hello", "--voice", "George",
            "--out", str(tmp_path / "o.mp3"), "--vendor", "elevenlabs", "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["vendor"] == "elevenlabs"
        assert seen == {"text": "hello", "voice": "George", "out_path": str(tmp_path / "o.mp3")}

    def test_elevenlabs_model_override_passed_through(self, step_module, monkeypatch, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(elevenlabs_mod, "generate_speech", capture)
        monkeypatch.setattr(sys, "argv", [
            "generate_voiceover.py", "--text", "hi", "--voice", "V",
            "--out", str(tmp_path / "o.mp3"), "--vendor", "elevenlabs", "--model", "custom",
        ])
        step_module.main()
        assert seen["model"] == "custom"

    def test_elevenlabs_ignores_speed_and_language(self, step_module, monkeypatch, tmp_path):
        """--speed/--language are accepted (global flags) but never reach
        the elevenlabs connector call."""
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(elevenlabs_mod, "generate_speech", capture)
        monkeypatch.setattr(sys, "argv", [
            "generate_voiceover.py", "--text", "hi", "--voice", "V",
            "--out", str(tmp_path / "o.mp3"), "--vendor", "elevenlabs",
            "--speed", "1.5", "--language", "es",
        ])
        step_module.main()
        assert "speed" not in seen
        assert "language" not in seen


_PROVIDERS = ("kling", "gemini", "elevenlabs", "serpapi", "fal", "kinovi", "tripo")


@pytest.fixture
def creds(monkeypatch, tmp_path):
    """No key anywhere: the credentials file is a temp path, every provider env var is cleared, and the
    default ~/.montaj/credentials.json is never opened."""
    import builtins
    import lib.credentials as credentials
    for prov, keys in credentials.KNOWN_PROVIDERS.items():
        for key in keys:
            monkeypatch.delenv(credentials._env_var_name(prov, key), raising=False)
    path = tmp_path / "credentials.json"
    monkeypatch.setenv("MONTAJ_CREDENTIALS_PATH", str(path))
    real_open = builtins.open
    home_file = credentials._DEFAULT_CREDENTIALS_PATH

    def guarded(file, *a, **kw):
        assert str(file) != home_file, "the real credentials file was opened"
        return real_open(file, *a, **kw)
    monkeypatch.setattr(builtins, "open", guarded)

    def connect(provider, key="api_key"):
        data = json.loads(path.read_text()) if path.exists() else {}
        data.setdefault(provider, {})[key] = "test-not-a-real-key"
        path.write_text(json.dumps(data))
    return connect


class TestDefaultVendorIsTheFirstConnected:
    def _run(self, step_module, monkeypatch, tmp_path, *extra):
        calls = []
        for mod, name in ((kling_mod, "kling"), (gemini_mod, "gemini"), (elevenlabs_mod, "elevenlabs")):
            monkeypatch.setattr(mod, "generate_speech",
                                lambda _n=name, **kw: (calls.append(_n), kw["out_path"])[1])
        monkeypatch.setattr(sys, "argv", [
            "generate_voiceover.py", "--text", "hi", "--voice", "V", "--out", str(tmp_path / "o.mp3"),
            "--json", *extra,
        ])
        step_module.main()
        return calls

    def test_only_elevenlabs_connected(self, step_module, monkeypatch, tmp_path, creds, capsys):
        creds("elevenlabs")
        assert self._run(step_module, monkeypatch, tmp_path) == ["elevenlabs"]
        assert json.loads(capsys.readouterr().out)["vendor"] == "elevenlabs"

    def test_only_gemini_connected(self, step_module, monkeypatch, tmp_path, creds, capsys):
        creds("gemini")
        assert self._run(step_module, monkeypatch, tmp_path) == ["gemini"]
        assert json.loads(capsys.readouterr().out)["vendor"] == "gemini"

    def test_only_kling_connected_by_the_legacy_pair(self, step_module, monkeypatch, tmp_path, creds):
        creds("kling", "access_key")
        creds("kling", "secret_key")
        assert self._run(step_module, monkeypatch, tmp_path) == ["kling"]

    def test_order_is_elevenlabs_then_gemini_then_kling(self, step_module, monkeypatch, tmp_path, creds):
        creds("kling")
        creds("gemini")
        assert self._run(step_module, monkeypatch, tmp_path) == ["gemini"]
        creds("elevenlabs")
        assert self._run(step_module, monkeypatch, tmp_path) == ["elevenlabs"]

    def test_none_connected_names_all_three_tiles(self, step_module, monkeypatch, tmp_path, creds, capsys):
        with pytest.raises(SystemExit):
            self._run(step_module, monkeypatch, tmp_path)
        err = _last_stderr_json(capsys)
        assert err["error"] == "api_error"
        assert all(n in err["message"] for n in ("ElevenLabs", "Gemini", "Kling"))
        assert "Connectors" in err["message"]

    def test_explicit_vendor_is_taken_as_given(self, step_module, monkeypatch, tmp_path, creds):
        creds("elevenlabs")
        assert self._run(step_module, monkeypatch, tmp_path, "--vendor", "kling") == ["kling"]

    def test_explicit_vendor_with_nothing_connected_still_calls_the_connector(
            self, step_module, monkeypatch, tmp_path, creds):
        assert self._run(step_module, monkeypatch, tmp_path, "--vendor", "gemini") == ["gemini"]


class TestConnectorErrorMapping:
    def test_gemini_invalid_api_key_uses_gemini_specific_message(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        def boom(**kw):
            err = ConnectorError("Gemini rejected the API key: bad key", reason="invalid_api_key")
            err.google_detail = "API key expired."
            raise err
        monkeypatch.setattr(gemini_mod, "generate_speech", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_voiceover.py", "--text", "hi", "--voice", "Kore",
            "--out", str(tmp_path / "o.mp3"), "--vendor", "gemini",
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["error"] == "invalid_api_key"
        assert "Google said: API key expired." in err["message"]

    def test_kling_invalid_api_key_does_not_use_gemini_message(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        """Regression: the old code checked e.reason == "invalid_api_key"
        with no vendor guard, so a rejected Kling key printed Gemini's
        hardcoded "Your Gemini API key was rejected..." text."""
        def boom(**kw):
            raise ConnectorError("Kling rejected the key: access key not found",
                                  reason="invalid_api_key")
        monkeypatch.setattr(kling_mod, "generate_speech", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_voiceover.py", "--text", "hi", "--voice", "sunny",
            "--out", str(tmp_path / "o.mp3"), "--vendor", "kling",
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["error"] == "invalid_api_key"
        assert err["message"] == "Kling rejected the key: access key not found"
        assert "Gemini" not in err["message"]

    def test_elevenlabs_invalid_api_key_does_not_use_gemini_message(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        def boom(**kw):
            raise ConnectorError("ElevenLabs key check failed (HTTP 401): invalid key",
                                  reason="invalid_api_key")
        monkeypatch.setattr(elevenlabs_mod, "generate_speech", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_voiceover.py", "--text", "hi", "--voice", "V",
            "--out", str(tmp_path / "o.mp3"), "--vendor", "elevenlabs",
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["error"] == "invalid_api_key"
        assert err["message"] == "ElevenLabs key check failed (HTTP 401): invalid key"

    @pytest.mark.parametrize("vendor,mod_name", [("kling", "kling"), ("elevenlabs", "elevenlabs")])
    def test_insufficient_credit_maps_through_for_non_gemini_vendors(
        self, step_module, monkeypatch, capsys, tmp_path, vendor, mod_name
    ):
        mod = {"kling": kling_mod, "elevenlabs": elevenlabs_mod}[mod_name]

        def boom(**kw):
            raise ConnectorError("out of credit", reason="insufficient_credit")
        monkeypatch.setattr(mod, "generate_speech", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_voiceover.py", "--text", "hi", "--voice", "V",
            "--out", str(tmp_path / "o.mp3"), "--vendor", vendor,
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["error"] == "insufficient_credit"
