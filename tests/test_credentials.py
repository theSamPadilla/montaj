"""Tests for lib.credentials — credential storage and lookup."""
import json, os, stat
import pytest

from connectors import ConnectorError
from lib.credentials import (
    CREDENTIALS_PATH,
    KNOWN_PROVIDERS,
    PROVIDER_NAMES,
    CredentialError,
    MissingCredentialError,
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
    with pytest.raises(MissingCredentialError) as ei:
        get_credential("kling", "access_key")
    assert isinstance(ei.value, CredentialError)
    assert (ei.value.provider, ei.value.key) == ("kling", "access_key")


@pytest.mark.parametrize("provider", sorted(KNOWN_PROVIDERS))
def test_missing_key_message_is_sams_copy_with_no_cli(provider):
    """§549: an app user has no CLI and no shell, so the message names only the app's
    Connectors page. Sam's copy: "No Gemini key. Add one in Montaj under Connectors."."""
    key = KNOWN_PROVIDERS[provider][0]
    with pytest.raises(MissingCredentialError) as ei:
        get_credential(provider, key)
    msg = str(ei.value)
    assert msg == f"No {PROVIDER_NAMES[provider]} key. Add one in Montaj under Connectors."
    for cli in ("montaj ", "--provider", "on the CLI", "_KEY", "credential found"):
        assert cli not in msg


def test_gemini_missing_key_reads_exactly_as_sam_wrote_it():
    with pytest.raises(MissingCredentialError) as ei:
        get_credential("gemini", "api_key")
    assert str(ei.value) == "No Gemini key. Add one in Montaj under Connectors."


def test_every_known_provider_has_a_connectors_name():
    assert set(PROVIDER_NAMES) == set(KNOWN_PROVIDERS)
    assert PROVIDER_NAMES["fal"] == "Seedance"  # the Connectors tile that holds the fal.ai key


def test_get_credential_raises_on_malformed_json(creds_path):
    os.makedirs(os.path.dirname(creds_path), exist_ok=True)
    with open(creds_path, "w") as f:
        f.write("{not valid}")
    with pytest.raises(CredentialError, match="not valid JSON") as ei:
        get_credential("kling", "access_key")
    assert not isinstance(ei.value, MissingCredentialError)


def test_malformed_json_message_names_no_cli_command(creds_path):
    os.makedirs(os.path.dirname(creds_path), exist_ok=True)
    with open(creds_path, "w") as f:
        f.write("{not valid}")
    with pytest.raises(CredentialError) as ei:
        get_credential("kling", "access_key")
    assert "montaj " not in str(ei.value) and "--provider" not in str(ei.value)
    assert str(ei.value).endswith("Fix the file or delete it.")


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
    # Kling takes either the current API key or the legacy pair; the allowlist
    # holds all three and REQUIRED_KEY_SETS decides what counts as configured.
    assert set(KNOWN_PROVIDERS["kling"]) == {"api_key", "access_key", "secret_key"}
    assert set(KNOWN_PROVIDERS["gemini"]) == {"api_key"}
    assert set(KNOWN_PROVIDERS["openai"]) == {"api_key"}


def test_known_providers_include_fal_and_elevenlabs():
    from lib.credentials import KNOWN_PROVIDERS
    assert KNOWN_PROVIDERS["fal"] == ["api_key"]
    assert KNOWN_PROVIDERS["elevenlabs"] == ["api_key"]


def test_env_overlay_accepts_new_providers():
    from lib.credentials import build_env_overlay
    env = build_env_overlay({"fal": {"api_key": "test-key"}, "elevenlabs": {"api_key": "test-key-2"}})
    assert env["FAL_API_KEY"] == "test-key"
    assert env["ELEVENLABS_API_KEY"] == "test-key-2"


# ── Kling: API key is current, access/secret is legacy ──────────────────


def test_kling_required_key_sets_accept_either_shape():
    """Either the API key alone or the legacy pair makes Kling usable.

    Kling's docs put "API Key (for all models)" first and mark
    "Access Key / Secret Key" as legacy, so both must work: existing users keep
    their pair, new ones store one key.
    """
    from lib.credentials import required_key_sets, provider_is_configured
    assert required_key_sets("kling") == [["api_key"], ["access_key", "secret_key"]]

    assert provider_is_configured("kling", lambda p, k: k == "api_key")
    assert provider_is_configured("kling", lambda p, k: k in ("access_key", "secret_key"))
    # A half-configured legacy pair is NOT usable: the JWT needs both.
    assert not provider_is_configured("kling", lambda p, k: k == "access_key")
    assert not provider_is_configured("kling", lambda p, k: False)


def test_single_key_providers_are_unchanged_by_the_kling_override():
    """Every other provider still requires its one key, via the default path."""
    from lib.credentials import required_key_sets, provider_is_configured
    for p in ("gemini", "openai", "fal", "elevenlabs", "serpapi"):
        assert required_key_sets(p) == [["api_key"]]
        assert provider_is_configured(p, lambda _p, k: k == "api_key")
        assert not provider_is_configured(p, lambda _p, k: False)


def test_build_env_overlay_accepts_a_kling_api_key():
    """The env overlay must pass an api_key through, not reject it as unknown."""
    from lib.credentials import build_env_overlay
    assert build_env_overlay({"kling": {"api_key": "x"}}) == {"KLING_API_KEY": "x"}
    # and the legacy pair still maps
    assert build_env_overlay({"kling": {"access_key": "a", "secret_key": "b"}}) == {
        "KLING_ACCESS_KEY": "a", "KLING_SECRET_KEY": "b"}
