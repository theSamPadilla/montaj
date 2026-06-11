"""Per-request credential passthrough for POST /api/steps/{name}.

A reserved `credentials` field in the step request body is converted to env
vars for THAT ONE subprocess and nothing else. Local single-user behaviour
(ambient env / credentials.json) is unchanged when the field is absent.

Security invariants under test:
  - the secret value reaches the subprocess env (proves injection),
  - the server process os.environ is never mutated,
  - the secret never appears in 422 validation responses,
  - the reserved key never reaches CLI argv.
"""
import os
import sys
import textwrap
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from lib.credentials import CredentialError, build_env_overlay
from serve.server import app
import serve.routes.steps as steps_mod

client = TestClient(app, raise_server_exceptions=False)


# ── fake echo step ──────────────────────────────────────────────────────────

ECHO_SRC = textwrap.dedent("""\
    #!/usr/bin/env python3
    import os, sys
    # Echo the GEMINI_API_KEY env var the subprocess sees, plus all argv,
    # so tests can prove (a) env injection and (b) that the reserved
    # `credentials` key never leaked into the command line.
    print("GEMINI_API_KEY=" + (os.environ.get("GEMINI_API_KEY") or "<none>"))
    print("ARGV=" + repr(sys.argv[1:]))
""")


@pytest.fixture()
def echo_step(tmp_path, monkeypatch):
    """Install a fake `echo_env` step and route scan_steps to it.

    The step's schema declares one optional param so we can also assert the
    reserved credentials key is distinct from real params.
    """
    py_path = tmp_path / "echo_env.py"
    py_path.write_text(ECHO_SRC)
    schema = {
        "name": "echo_env",
        "params": [{"name": "label", "type": "string"}],
        "output": {"type": "file"},
    }

    def fake_scan_steps():
        return {"echo_env": (schema, py_path)}

    monkeypatch.setattr(steps_mod, "scan_steps", fake_scan_steps)
    # Ensure no ambient key bleeds in from the developer's shell.
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    return py_path


def _post(**body):
    return client.post("/api/steps/echo_env", json=body)


# ── env injection ────────────────────────────────────────────────────────────

def test_credentials_injected_into_subprocess_env(echo_step):
    resp = _post(credentials={"gemini": {"api_key": "sk-test-123"}})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    text = out["path"] if isinstance(out, dict) else str(out)
    assert "GEMINI_API_KEY=sk-test-123" in text


def test_server_process_env_not_mutated(echo_step):
    assert "GEMINI_API_KEY" not in os.environ
    resp = _post(credentials={"gemini": {"api_key": "sk-test-123"}})
    assert resp.status_code == 200, resp.text
    # The server process must never gain the key.
    assert "GEMINI_API_KEY" not in os.environ


def test_no_credentials_inherits_ambient_env(echo_step, monkeypatch):
    # With no credentials field, env=None → subprocess inherits the server's
    # environment exactly as before.
    monkeypatch.setenv("GEMINI_API_KEY", "ambient-key-xyz")
    resp = _post(label="hi")
    assert resp.status_code == 200, resp.text
    out = resp.json()
    text = out["path"] if isinstance(out, dict) else str(out)
    assert "GEMINI_API_KEY=ambient-key-xyz" in text


def test_credentials_never_reach_argv(echo_step):
    resp = _post(credentials={"gemini": {"api_key": "sk-test-123"}}, label="hi")
    assert resp.status_code == 200, resp.text
    out = resp.json()
    text = out["path"] if isinstance(out, dict) else str(out)
    # argv must carry the real param but never the secret.
    assert "sk-test-123" not in text.split("ARGV=", 1)[1]
    assert "--label" in text


# ── validation: 422s ─────────────────────────────────────────────────────────

def test_unknown_provider_422(echo_step):
    resp = _post(credentials={"notreal": {"api_key": "sk-test-x"}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "invalid_credentials"


def test_unknown_key_for_known_provider_422(echo_step):
    resp = _post(credentials={"gemini": {"wrong": "sk-test-x"}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "invalid_credentials"


def test_non_dict_credentials_422(echo_step):
    resp = _post(credentials="abc")
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "invalid_credentials"


def test_empty_value_422(echo_step):
    resp = _post(credentials={"gemini": {"api_key": ""}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "invalid_credentials"


def test_422_responses_never_echo_secret(echo_step):
    # Every rejection path must keep the submitted value out of the response.
    for creds in (
        {"notreal": {"api_key": "sk-test-secret"}},
        {"gemini": {"wrong": "sk-test-secret"}},
        {"gemini": "sk-test-secret"},
        {"gemini": {"api_key": 12345}},
    ):
        resp = _post(credentials=creds)
        assert resp.status_code == 422
        assert "sk-test-secret" not in resp.text


def test_provider_value_not_dict_422(echo_step):
    resp = _post(credentials={"gemini": "sk-test-secret"})
    assert resp.status_code == 422
    assert "sk-test-secret" not in resp.text


# ── unit tests for build_env_overlay ────────────────────────────────────────

def test_overlay_happy_path():
    overlay = build_env_overlay({
        "gemini": {"api_key": "g-key"},
        "kling": {"access_key": "ak", "secret_key": "sk"},
        "openai": {"api_key": "o-key"},
    })
    assert overlay == {
        "GEMINI_API_KEY": "g-key",
        "KLING_ACCESS_KEY": "ak",
        "KLING_SECRET_KEY": "sk",
        "OPENAI_API_KEY": "o-key",
    }


def test_overlay_empty_input():
    assert build_env_overlay({}) == {}


def test_overlay_rejects_non_dict():
    with pytest.raises(CredentialError):
        build_env_overlay("nope")


def test_overlay_rejects_unknown_provider():
    with pytest.raises(CredentialError) as ei:
        build_env_overlay({"notreal": {"api_key": "x"}})
    assert "notreal" in str(ei.value)
    assert "x" not in str(ei.value).replace("notreal", "")  # value not leaked


def test_overlay_rejects_unknown_key():
    with pytest.raises(CredentialError) as ei:
        build_env_overlay({"gemini": {"wrong": "secretval"}})
    assert "wrong" in str(ei.value)
    assert "secretval" not in str(ei.value)


def test_overlay_rejects_non_dict_provider_value():
    with pytest.raises(CredentialError):
        build_env_overlay({"gemini": "secretval"})


def test_overlay_rejects_empty_value():
    with pytest.raises(CredentialError) as ei:
        build_env_overlay({"gemini": {"api_key": ""}})
    assert "gemini.api_key" in str(ei.value)


def test_overlay_rejects_non_string_value():
    with pytest.raises(CredentialError):
        build_env_overlay({"gemini": {"api_key": 123}})


# ── error-path secret redaction ──────────────────────────────────────────────

LEAKY_SRC = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    # Simulate an upstream provider echoing the caller's own key in its error
    # body (OpenAI does this: "Incorrect API key provided: <key>").
    key = os.environ.get("OPENAI_API_KEY") or "<none>"
    print(json.dumps({"error": "api_error",
                      "message": "Incorrect API key provided: " + key}),
          file=sys.stderr)
    sys.exit(1)
""")


@pytest.fixture()
def leaky_step(tmp_path, monkeypatch):
    py_path = tmp_path / "leaky.py"
    py_path.write_text(LEAKY_SRC)
    schema = {"name": "leaky", "params": [], "output": {"type": "file"}}
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {"leaky": (schema, py_path)})
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    return py_path


def test_provider_echoed_secret_is_redacted_from_error(leaky_step):
    resp = client.post("/api/steps/leaky", json={
        "credentials": {"openai": {"api_key": "sk-SUPER-SECRET-XYZ"}},
    })
    assert resp.status_code == 500
    assert "sk-SUPER-SECRET-XYZ" not in resp.text
    assert "[redacted]" in resp.text


def test_error_without_credentials_is_not_scrubbed(leaky_step, monkeypatch):
    # Ambient (non-passthrough) keys are the operator's own local setup; the
    # scrubber only acts on injected passthrough values.
    monkeypatch.setenv("OPENAI_API_KEY", "sk-AMBIENT-LOCAL")
    resp = client.post("/api/steps/leaky", json={})
    assert resp.status_code == 500
    assert "[redacted]" not in resp.text
