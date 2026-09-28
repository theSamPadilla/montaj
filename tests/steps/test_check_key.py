"""Tests for steps/credentials/check_key.py — PV29 T3, extended by T7.

The step is a thin dispatcher: pick the connector module for --provider, call
its check_key(), and map ConnectorError.reason to a fail() code. Every test
here monkeypatches the connector's check_key() directly — the connectors'
own SDK/HTTP-mocked tests (test_connectors_gemini.py, test_connectors_openai.py,
etc.) cover what check_key() itself does. Nothing here makes a real network call.

T7 registers kling, fal and elevenlabs (PROVIDERS now lists five providers —
serpapi has no check_key() and stays unsupported) and adds the model_retired
fail code, which used to fall through to check_failed.
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
import connectors.openai as openai_mod

_STEP_PATH = REPO_ROOT / "steps" / "credentials" / "check_key.py"


@pytest.fixture
def step_module():
    """Import steps/credentials/check_key.py as a module (no subprocess)."""
    spec = importlib.util.spec_from_file_location("check_key_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestProvidersRegistered:
    """T7: kling, fal and elevenlabs join gemini/openai. serpapi has no
    check_key() and is not registered here."""

    def test_providers_map_is_the_five_generation_vendors(self, step_module):
        assert step_module.PROVIDERS == {
            "gemini": "connectors.gemini",
            "openai": "connectors.openai",
            "kling": "connectors.kling",
            "fal": "connectors.fal",
            "elevenlabs": "connectors.elevenlabs",
        }

    def test_unlisted_provider_rejected_by_argparse(self, step_module, monkeypatch, capsys):
        monkeypatch.setattr(sys, "argv", ["check_key.py", "--provider", "serpapi"])
        with pytest.raises(SystemExit) as ei:
            step_module.main()
        assert ei.value.code == 2  # argparse usage error, not fail()'s exit(1)
        assert "invalid choice" in capsys.readouterr().err


class TestSchemaOptionsMatchProviders:
    """PV29 review item 1: check_key.json's `provider` enum drifted from
    PROVIDERS after T7 registered kling/fal/elevenlabs (74338ac updated the
    step but not the JSON), so serve's validate_params rejected every
    provider but gemini/openai with a 422 before the step ever ran."""

    def test_options_match_providers(self, step_module):
        schema = json.loads((_STEP_PATH.parent / "check_key.json").read_text())
        assert schema["params"][0]["options"] == sorted(step_module.PROVIDERS)

    def test_every_provider_passes_serve_validation(self, step_module):
        from serve.routes.steps import validate_params
        schema = json.loads((_STEP_PATH.parent / "check_key.json").read_text())
        for provider in step_module.PROVIDERS:
            validate_params(schema, {"provider": provider})  # must not raise


class TestOkPath:
    def test_ok_result_printed_as_json(self, step_module, monkeypatch, capsys):
        monkeypatch.setattr(gemini_mod, "check_key", lambda: {
            "ok": True, "default_model": "gemini-3.8-flash",
            "default_model_ok": True, "detail": "42 models available",
        })
        monkeypatch.setattr(sys, "argv", ["check_key.py", "--provider", "gemini"])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["provider"] == "gemini"
        assert out["ok"] is True
        assert out["default_model_ok"] is True

    def test_default_model_missing_is_still_ok(self, step_module, monkeypatch, capsys):
        """A retired default model is reported, not hidden — ok stays True,
        default_model_ok goes False, exit code stays 0."""
        monkeypatch.setattr(openai_mod, "check_key", lambda: {
            "ok": True, "default_model": "gpt-image-1",
            "default_model_ok": False, "detail": "model not in list",
        })
        monkeypatch.setattr(sys, "argv", ["check_key.py", "--provider", "openai"])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["ok"] is True
        assert out["default_model_ok"] is False


class TestErrorMapping:
    def test_invalid_api_key_reason_maps_to_fail_code(self, step_module, monkeypatch, capsys):
        def boom():
            raise ConnectorError("Gemini rejected the API key: bad key", reason="invalid_api_key")
        monkeypatch.setattr(gemini_mod, "check_key", boom)
        monkeypatch.setattr(sys, "argv", ["check_key.py", "--provider", "gemini"])

        with pytest.raises(SystemExit) as ei:
            step_module.main()
        assert ei.value.code == 1
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "invalid_api_key"
        assert "bad key" in err["message"]

    def test_unreachable_reason_maps_to_provider_unreachable(self, step_module, monkeypatch, capsys):
        def boom():
            raise ConnectorError("could not reach the API: timed out", reason="unreachable")
        monkeypatch.setattr(openai_mod, "check_key", boom)
        monkeypatch.setattr(sys, "argv", ["check_key.py", "--provider", "openai"])

        with pytest.raises(SystemExit) as ei:
            step_module.main()
        assert ei.value.code == 1
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "provider_unreachable"

    def test_model_retired_reason_maps_to_fail_code(self, step_module, monkeypatch, capsys):
        """T7: model_retired used to fall through to check_failed."""
        def boom():
            raise ConnectorError("kling-v2-old is retired; use kling-v3-omni", reason="model_retired")
        monkeypatch.setattr(gemini_mod, "check_key", boom)
        monkeypatch.setattr(sys, "argv", ["check_key.py", "--provider", "gemini"])

        with pytest.raises(SystemExit) as ei:
            step_module.main()
        assert ei.value.code == 1
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "model_retired"
        assert "kling-v3-omni" in err["message"]

    def test_insufficient_credit_reason_maps_through(self, step_module, monkeypatch, capsys):
        def boom():
            raise ConnectorError("out of credit", reason="insufficient_credit")
        monkeypatch.setattr(openai_mod, "check_key", boom)
        monkeypatch.setattr(sys, "argv", ["check_key.py", "--provider", "openai"])

        with pytest.raises(SystemExit):
            step_module.main()
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "insufficient_credit"

    def test_unclassified_reason_falls_back_to_check_failed(self, step_module, monkeypatch, capsys):
        def boom():
            raise ConnectorError("something vague went wrong")  # reason=None
        monkeypatch.setattr(gemini_mod, "check_key", boom)
        monkeypatch.setattr(sys, "argv", ["check_key.py", "--provider", "gemini"])

        with pytest.raises(SystemExit):
            step_module.main()
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "check_failed"

    def test_missing_credential_surfaces_as_check_failed(self, step_module, monkeypatch, capsys):
        """A missing credential raises CredentialError (a ConnectorError
        subclass with reason=None) through get_credential — surfaces as
        check_failed with the connector's own message, per the task spec."""
        from lib.credentials import CredentialError

        def boom():
            raise CredentialError("No gemini.api_key credential found.")
        monkeypatch.setattr(gemini_mod, "check_key", boom)
        monkeypatch.setattr(sys, "argv", ["check_key.py", "--provider", "gemini"])

        with pytest.raises(SystemExit):
            step_module.main()
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "check_failed"
        assert "credential" in err["message"]
