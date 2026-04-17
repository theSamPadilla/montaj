"""Tests for lib.credentials — credential storage and lookup."""
import json, os, stat
import pytest

from connectors import ConnectorError
from lib.credentials import (
    CREDENTIALS_PATH,
    KNOWN_PROVIDERS,
    CredentialError,
    _env_var_name,
    get_credential,
    list_providers,
    set_credential,
)


@pytest.fixture(autouse=True)
def _redirect_credentials(tmp_path, monkeypatch):
    """Point CREDENTIALS_PATH at a temp dir for every test."""
    fake_path = str(tmp_path / ".montaj" / "credentials.json")
    monkeypatch.setattr("lib.credentials.CREDENTIALS_PATH", fake_path)
    return fake_path


@pytest.fixture
def creds_path(_redirect_credentials):
    """Convenience: return the redirected credentials path."""
    return _redirect_credentials


# ── get_credential: env var ─────────────────────────────────────────

def test_get_credential_returns_env_var(monkeypatch):
    monkeypatch.setenv("KLING_ACCESS_KEY", "env-value-123")
    assert get_credential("kling", "access_key") == "env-value-123"


def test_get_credential_returns_file_value(creds_path):
    os.makedirs(os.path.dirname(creds_path), exist_ok=True)
    with open(creds_path, "w") as f:
        json.dump({"kling": {"access_key": "file-value-456"}}, f)
    assert get_credential("kling", "access_key") == "file-value-456"


def test_get_credential_prefers_env_over_file(monkeypatch, creds_path):
    monkeypatch.setenv("KLING_ACCESS_KEY", "from-env")
    os.makedirs(os.path.dirname(creds_path), exist_ok=True)
    with open(creds_path, "w") as f:
        json.dump({"kling": {"access_key": "from-file"}}, f)
    assert get_credential("kling", "access_key") == "from-env"


def test_get_credential_raises_when_missing():
    with pytest.raises(CredentialError, match="No kling.access_key credential found"):
        get_credential("kling", "access_key")


def test_get_credential_raises_on_malformed_json(creds_path):
    os.makedirs(os.path.dirname(creds_path), exist_ok=True)
    with open(creds_path, "w") as f:
        f.write("{not valid}")
    with pytest.raises(CredentialError, match="not valid JSON"):
        get_credential("kling", "access_key")


# ── CredentialError hierarchy ───────────────────────────────────────

def test_credential_error_is_subclass_of_connector_error():
    assert issubclass(CredentialError, ConnectorError)
    err = CredentialError("test")
    assert isinstance(err, ConnectorError)


# ── set_credential ──────────────────────────────────────────────────

def test_set_credential_creates_file_with_0600_perms(creds_path):
    set_credential("kling", "access_key", "secret123")
    assert os.path.isfile(creds_path)
    mode = stat.S_IMODE(os.stat(creds_path).st_mode)
    assert mode == 0o600
    with open(creds_path) as f:
        data = json.load(f)
    assert data["kling"]["access_key"] == "secret123"


def test_set_credential_merges_without_clobbering(creds_path):
    set_credential("kling", "access_key", "ak1")
    set_credential("kling", "secret_key", "sk1")
    set_credential("gemini", "api_key", "gk1")
    with open(creds_path) as f:
        data = json.load(f)
    assert data == {
        "kling": {"access_key": "ak1", "secret_key": "sk1"},
        "gemini": {"api_key": "gk1"},
    }


def test_set_credential_creates_directory_if_missing(creds_path):
    # Directory doesn't exist yet — set_credential should create it
    assert not os.path.isdir(os.path.dirname(creds_path))
    set_credential("gemini", "api_key", "val")
    assert os.path.isfile(creds_path)


# ── list_providers ──────────────────────────────────────────────────

def test_list_providers_never_returns_raw_values(creds_path):
    set_credential("kling", "access_key", "super-secret")
    set_credential("kling", "secret_key", "")
    result = list_providers()
    assert result["kling"]["access_key"] == "set"
    assert result["kling"]["secret_key"] == "unset"
    # Make sure the actual secret value is nowhere in the result
    flat = json.dumps(result)
    assert "super-secret" not in flat


# ── KNOWN_PROVIDERS ─────────────────────────────────────────────────

def test_known_providers_contains_expected_entries():
    assert "kling" in KNOWN_PROVIDERS
    assert "gemini" in KNOWN_PROVIDERS
    assert "openai" in KNOWN_PROVIDERS
    assert set(KNOWN_PROVIDERS["kling"]) == {"access_key", "secret_key"}
    assert set(KNOWN_PROVIDERS["gemini"]) == {"api_key"}
    assert set(KNOWN_PROVIDERS["openai"]) == {"api_key"}
