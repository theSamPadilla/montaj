"""Step-level tests for steps/generate/generate_image.py — FQ1.1 T10.

Covers the same invalid_api_key mapping as test_analyze_media.py for a
second Gemini-calling step, and confirms the openai provider path (whose
ConnectorError never carries reason="invalid_api_key") still falls through
to the generic api_error code unaffected.
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

_STEP_PATH = REPO_ROOT / "steps" / "generate" / "generate_image.py"


@pytest.fixture
def step_module():
    """Import steps/generate/generate_image.py as a module (no subprocess)."""
    spec = importlib.util.spec_from_file_location("generate_image_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestGenerateImageConnectorErrorMapping:
    def test_gemini_invalid_key_reason_maps_to_fail_code(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        def boom(**kwargs):
            raise ConnectorError(
                "Gemini image generation failed: Permission denied.",
                reason="invalid_api_key",
            )

        monkeypatch.setattr(gemini_mod, "generate_image", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_image.py",
            "--prompt", "a cat",
            "--out", str(tmp_path / "out.png"),
            "--provider", "gemini",
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "invalid_api_key"
        assert "Integrations" in err["message"]

    def test_gemini_invalid_key_appends_google_detail(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        """`.google_detail` (set by `_wrap_sdk_error` — FQ1 #21) gets
        appended to the operator-facing message as "Google said: ..."."""
        def boom(**kwargs):
            err = ConnectorError(
                "Gemini image generation failed: Permission denied.",
                reason="invalid_api_key",
            )
            err.google_detail = "API key expired. Please renew the API key."
            raise err

        monkeypatch.setattr(gemini_mod, "generate_image", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_image.py",
            "--prompt", "a cat",
            "--out", str(tmp_path / "out.png"),
            "--provider", "gemini",
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "invalid_api_key"
        assert "Google said: API key expired. Please renew the API key." in err["message"]

    def test_openai_provider_error_keeps_api_error_code(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        """openai's ConnectorError has no reason at all — must not be
        mistaken for a Gemini key rejection."""
        def boom(**kwargs):
            raise ConnectorError("OpenAI image generation failed: bad request")

        monkeypatch.setattr(openai_mod, "generate_image", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_image.py",
            "--prompt", "a cat",
            "--out", str(tmp_path / "out.png"),
            "--provider", "openai",
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "api_error"
        assert "bad request" in err["message"]
