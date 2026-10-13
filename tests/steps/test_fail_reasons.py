"""Tests for steps/generate/_fail_reasons.py — PV29 T7.

The shared ConnectorError.reason -> fail() mapping every generate step uses.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from connectors import (
    ConnectorError, INVALID_API_KEY, INSUFFICIENT_CREDIT, MODEL_RETIRED, UNREACHABLE,
)

_MODULE_PATH = REPO_ROOT / "steps" / "generate" / "_fail_reasons.py"


@pytest.fixture
def fail_reasons():
    spec = importlib.util.spec_from_file_location("_fail_reasons", _MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _fail_for(fail_reasons, monkeypatch, capsys, error, vendor_label):
    with pytest.raises(SystemExit) as ei:
        fail_reasons.fail_for(error, vendor_label)
    assert ei.value.code == 1
    return json.loads(capsys.readouterr().err.strip())


@pytest.mark.parametrize("reason,code", [
    (INVALID_API_KEY, "invalid_api_key"),
    (INSUFFICIENT_CREDIT, "insufficient_credit"),
    (MODEL_RETIRED, "model_retired"),
    (UNREACHABLE, "provider_unreachable"),
    (None, "api_error"),
    ("some_future_reason_nobody_mapped_yet", "api_error"),
])
def test_reason_maps_to_fail_code(fail_reasons, capsys, reason, code):
    error = ConnectorError("Seedance rejected the request: boom", reason=reason)
    err = _fail_for(fail_reasons, None, capsys, error, "Seedance")
    assert err["error"] == code


class TestMessageIsVerbatimWhenVendorAlreadyNamed:
    """Every real connector message already names its vendor — fail_for must
    not mangle it. Mirrors the pinned kling_generate.py cases (see
    tests/test_connectors_kling.py's _CASES): message stays exactly str(e)."""

    @pytest.mark.parametrize("message", [
        "Kling rejected the key: access key not found",
        "Your Kling account is out of credits. Top up a resource pack at kling.ai/dev.",
        "kling-v2-old is retired; use kling-v3-omni",
        "Kling API error (HTTP 500): boom",
        "fal.ai rejected the request (HTTP 401): invalid key credentials",
        "Seedance model 'x' has been retired on fal.ai. Use 'y' instead.",
        "ElevenLabs music needs a paid plan.",
        "ElevenLabs speech generation failed (HTTP 500): boom",
        "OpenAI image generation failed: bad request",
        "Gemini rejected the API key: bad key",
    ])
    def test_message_unchanged(self, fail_reasons, capsys, message):
        error = ConnectorError(message)
        vendor = next(v for v in ("Kling", "fal.ai", "Seedance", "ElevenLabs", "OpenAI", "Gemini")
                      if v.lower() in message.lower())
        err = _fail_for(fail_reasons, None, capsys, error, vendor)
        assert err["message"] == message


class TestMessageGetsVendorPrefixWhenMissing:
    def test_bare_validation_message_gets_vendor_prefix(self, fail_reasons, capsys):
        error = ConnectorError("Prompt must not be empty")
        err = _fail_for(fail_reasons, None, capsys, error, "Seedance")
        assert err["message"] == "Seedance: Prompt must not be empty"

    def test_case_insensitive_match_skips_prefix(self, fail_reasons, capsys):
        error = ConnectorError("seedance rejected the request: boom")
        err = _fail_for(fail_reasons, None, capsys, error, "Seedance")
        assert err["message"] == "seedance rejected the request: boom"
