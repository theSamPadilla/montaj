"""The autouse guard in tests/conftest.py keeps every test off the operator's real keys."""
import os

import pytest

import lib.credentials as creds


def test_lookup_finds_nothing_with_no_patching_of_its_own():
    """Even when a real ~/.montaj/credentials.json exists, a test sees no credential."""
    assert creds.CREDENTIALS_PATH != os.path.expanduser("~/.montaj/credentials.json")
    with pytest.raises(creds.CredentialError):
        creds.get_credential("gemini", "api_key")


def test_every_mapped_env_var_is_removed():
    for provider, keys in creds.KNOWN_PROVIDERS.items():
        for key in keys:
            assert creds._env_var_name(provider, key) not in os.environ


def test_a_test_can_still_set_its_own(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    assert creds.get_credential("gemini", "api_key") == "k"
