"""The autouse guard in tests/conftest.py keeps every test, and every step subprocess it
starts, off the operator's real keys. These pass while a real ~/.montaj/credentials.json exists."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

import lib.credentials as creds

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_lookup_finds_nothing_in_process():
    with pytest.raises(creds.CredentialError):
        creds.get_credential("gemini", "api_key")


def test_lookup_finds_nothing_in_a_subprocess():
    code = (
        "import sys; sys.path.insert(0, sys.argv[1])\n"
        "from lib.credentials import get_credential, CredentialError\n"
        "try:\n    get_credential('gemini', 'api_key')\nexcept CredentialError:\n    print('missing')\n"
    )
    out = subprocess.run([sys.executable, "-c", code, str(REPO_ROOT)],
                         capture_output=True, text=True, timeout=60)
    assert out.stdout.strip() == "missing", out.stderr


def test_every_mapped_env_var_is_removed():
    for provider, keys in creds.KNOWN_PROVIDERS.items():
        for key in keys:
            assert creds._env_var_name(provider, key) not in os.environ


def test_a_test_can_still_set_its_own(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    assert creds.get_credential("gemini", "api_key") == "k"


def test_env_override_is_read_on_every_call(monkeypatch, tmp_path):
    p = tmp_path / "c.json"
    monkeypatch.setenv(creds.CREDENTIALS_PATH_ENV, str(p))
    creds.set_credential("gemini", "api_key", "v")
    assert p.exists() and creds.get_credential("gemini", "api_key") == "v"


def test_unset_env_falls_back_to_the_home_file(monkeypatch):
    monkeypatch.delenv(creds.CREDENTIALS_PATH_ENV)
    assert creds.credentials_path() == os.path.expanduser("~/.montaj/credentials.json")
