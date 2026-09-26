"""Unit tests for serve.routes.files._downloads_dir / _existing_downloads_dir.

Pure path-selection logic — no dialog, no subprocess, no server. The native
file picker always defaults to ~/Downloads; when that folder doesn't exist,
the helper hands back None so the caller passes no default location at all
(rather than one that would make AppleScript error).
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

from serve.routes.files import _downloads_dir, _existing_downloads_dir


def test_downloads_dir_is_home_downloads(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert _downloads_dir() == tmp_path / "Downloads"


def test_existing_downloads_dir_returned_when_present(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    (tmp_path / "Downloads").mkdir()
    assert _existing_downloads_dir() == tmp_path / "Downloads"


def test_missing_downloads_dir_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert not (tmp_path / "Downloads").exists()
    assert _existing_downloads_dir() is None


def test_downloads_that_is_a_file_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    (tmp_path / "Downloads").write_text("x")
    assert _existing_downloads_dir() is None
