"""Step-level tests for steps/media/analyze_media.py — FQ1.1 T10.

Rejection paths that never reach the connector (missing --input) run as a
real subprocess. The connector-error mapping (invalid_api_key vs the
generic api_error) is exercised in-process: the step module is imported
directly and `connectors.gemini.analyze_media` is monkeypatched to raise a
ConnectorError of the shape the connector actually produces, so we assert
what the step DOES with a reason, not the SDK-detection logic itself
(that's covered in tests/test_connectors_gemini.py).
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from connectors import ConnectorError
from tests.conftest import run_step

_STEP_PATH = REPO_ROOT / "steps" / "media" / "analyze_media.py"


@pytest.fixture
def step_module():
    """Import steps/media/analyze_media.py as a module (no subprocess)."""
    spec = importlib.util.spec_from_file_location("analyze_media_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def media_path(tmp_path):
    p = tmp_path / "clip.mp4"
    p.write_bytes(b"\x00" * 32)
    return str(p)


# ---------------------------------------------------------------------------
# Argparse / preflight (subprocess, exits before any connector call)
# ---------------------------------------------------------------------------

class TestAnalyzeMediaArgs:
    def test_missing_input_arg_exits_nonzero(self):
        proc = run_step("analyze_media.py", "--prompt", "describe this")
        assert proc.returncode != 0

    def test_missing_file_rejected(self, tmp_path):
        proc = run_step(
            "analyze_media.py",
            "--input", str(tmp_path / "nope.mp4"),
            "--prompt", "describe this",
        )
        assert proc.returncode != 0
        err = json.loads(proc.stderr)
        assert err["error"] == "file_not_found"


# ---------------------------------------------------------------------------
# Connector-error mapping (in-process, connector monkeypatched)
# ---------------------------------------------------------------------------

class TestAnalyzeMediaConnectorErrorMapping:
    def test_invalid_api_key_reason_maps_to_fail_code(
        self, step_module, monkeypatch, capsys, media_path
    ):
        def boom(**kwargs):
            raise ConnectorError(
                "Gemini rejected the API key: API key not valid.",
                reason="invalid_api_key",
            )

        monkeypatch.setattr(step_module.gemini, "analyze_media", boom)
        monkeypatch.setattr(sys, "argv", [
            "analyze_media.py", "--input", media_path, "--prompt", "describe this",
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "invalid_api_key"
        assert "Integrations" in err["message"]
        assert "montaj credentials" in err["message"]

    def test_generic_connector_error_keeps_api_error_code(
        self, step_module, monkeypatch, capsys, media_path
    ):
        def boom(**kwargs):
            raise ConnectorError("Gemini generate_content failed: quota exceeded")

        monkeypatch.setattr(step_module.gemini, "analyze_media", boom)
        monkeypatch.setattr(sys, "argv", [
            "analyze_media.py", "--input", media_path, "--prompt", "describe this",
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "api_error"
        assert "quota exceeded" in err["message"]
