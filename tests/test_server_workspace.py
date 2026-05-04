"""Tests for resolve_workspace() precedence in serve/server.py (Task B of 2026-05-02-serve-hardening)."""
import json
from pathlib import Path

import pytest

from serve.common import resolve_workspace


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    """Ensure MONTAJ_WORKSPACE_DIR doesn't leak between tests."""
    monkeypatch.delenv("MONTAJ_WORKSPACE_DIR", raising=False)


def test_env_var_takes_precedence(monkeypatch, tmp_path):
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    assert resolve_workspace() == tmp_path


def test_config_used_when_env_unset(monkeypatch, tmp_path):
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    (fake_home / ".montaj").mkdir()
    (fake_home / ".montaj" / "config.json").write_text(
        json.dumps({"workspaceDir": "/tmp/from-config"})
    )
    monkeypatch.setenv("HOME", str(fake_home))
    assert resolve_workspace() == Path("/tmp/from-config")


def test_default_when_neither_set(monkeypatch, tmp_path):
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    assert resolve_workspace() == fake_home / "Montaj"


def test_env_overrides_config(monkeypatch, tmp_path):
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    (fake_home / ".montaj").mkdir()
    (fake_home / ".montaj" / "config.json").write_text(
        json.dumps({"workspaceDir": "/tmp/from-config"})
    )
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", "/tmp/from-env")
    assert resolve_workspace() == Path("/tmp/from-env")


def test_env_var_empty_string_falls_through(monkeypatch, tmp_path):
    """Empty MONTAJ_WORKSPACE_DIR is treated as unset (falls through to config/default).

    Mirrors project/init.py's `or` short-circuit. Pinning behavior so a
    future refactor to `if env_dir is not None:` is caught.
    """
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", "")
    assert resolve_workspace() == fake_home / "Montaj"
