"""Step-level tests for steps/generate/generate_image.py — FQ1.1 T10.

Covers the same invalid_api_key mapping as test_analyze_media.py for a
second Gemini-calling step, and confirms openai is no longer an accepted provider.
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
import connectors.kinovi as kinovi_mod

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
        assert "Connectors" in err["message"]

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

    def test_openai_provider_refused_by_argparse(
        self, step_module, monkeypatch, tmp_path
    ):
        monkeypatch.setattr(sys, "argv", [
            "generate_image.py",
            "--prompt", "a cat",
            "--out", str(tmp_path / "out.png"),
            "--provider", "openai",
        ])
        with pytest.raises(SystemExit) as ei:
            step_module.main()
        assert ei.value.code == 2

    def test_gemini_insufficient_credit_no_longer_forced_to_api_error(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        """Gemini's own connector can raise reasons other than
        invalid_api_key too (e.g. a billing issue) — those must not be
        forced through the api_error fallback either."""
        def boom(**kwargs):
            raise ConnectorError("Gemini image generation failed: no credit",
                                  reason="insufficient_credit")

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
        assert err["error"] == "insufficient_credit"


class TestKinoviProvider:
    """§227: --provider kinovi routes to connectors.kinovi.generate_image."""

    def _run(self, step_module, monkeypatch, tmp_path, extra):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(kinovi_mod, "generate_image", capture)
        monkeypatch.setattr(sys, "argv", ["generate_image.py", "--prompt", "a fox",
                                          "--out", str(tmp_path / "fox.png"), "--provider", "kinovi", *extra])
        step_module.main()
        return seen

    def test_defaults_to_kinovis_default_image_model(self, step_module, monkeypatch, capsys, tmp_path):
        seen = self._run(step_module, monkeypatch, tmp_path, [])
        assert seen["model"] == kinovi_mod.DEFAULT_IMAGE_MODEL
        assert seen["resolution"] is None and seen["quality"] is None
        assert capsys.readouterr().out.strip() == str(tmp_path / "fox.png")

    def test_model_resolution_quality_and_aspect_pass_through(self, step_module, monkeypatch, tmp_path):
        seen = self._run(step_module, monkeypatch, tmp_path,
                         ["--model", "gpt-image-2", "--resolution", "2k", "--quality", "high", "--aspect-ratio", "9:16"])
        assert (seen["model"], seen["resolution"], seen["quality"], seen["aspect_ratio"]) == ("gpt-image-2", "2k", "high", "9:16")

    def test_size_is_ignored_with_a_warning(self, step_module, monkeypatch, capsys, tmp_path):
        self._run(step_module, monkeypatch, tmp_path, ["--size", "512x512"])
        assert "use --resolution" in capsys.readouterr().err

    def test_a_refusal_is_content_refused(self, step_module, monkeypatch, capsys, tmp_path):
        from connectors import CONTENT_REFUSED

        def boom(**kw):
            raise ConnectorError("Kinovi's content review refused the prompt", reason=CONTENT_REFUSED)
        monkeypatch.setattr(kinovi_mod, "generate_image", boom)
        monkeypatch.setattr(sys, "argv", ["generate_image.py", "--prompt", "a fox",
                                          "--out", str(tmp_path / "fox.png"), "--provider", "kinovi"])
        with pytest.raises(SystemExit):
            step_module.main()
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "content_refused"
