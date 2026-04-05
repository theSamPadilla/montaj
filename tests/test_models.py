"""Unit tests for lib/models.py — no external dependencies required."""
import hashlib
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
import models


# ── models_dir() ──────────────────────────────────────────────────────────────

def test_models_dir_default():
    path = models.models_dir("rvm")
    assert path == os.path.expanduser("~/.local/share/montaj/models/rvm")


def test_models_dir_uses_monkeypatched_base(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    path = models.models_dir("rvm")
    assert path == str(tmp_path / "rvm")


# ── model_path() ──────────────────────────────────────────────────────────────

def test_model_path_returns_correct_path():
    path = models.model_path("rvm", "rvm_mobilenetv3.pth")
    expected = os.path.expanduser("~/.local/share/montaj/models/rvm/rvm_mobilenetv3.pth")
    assert path == expected


# ── is_downloaded() ───────────────────────────────────────────────────────────

def test_is_downloaded_false_when_missing():
    assert not models.is_downloaded("rvm", "nonexistent_model.pth")


def test_is_downloaded_true_when_present(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    dest = tmp_path / "rvm" / "rvm_mobilenetv3.pth"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"fake weights")
    assert models.is_downloaded("rvm", "rvm_mobilenetv3.pth")


# ── ensure_model() ────────────────────────────────────────────────────────────

def test_ensure_model_returns_path_when_already_downloaded(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    dest = tmp_path / "rvm" / "rvm_mobilenetv3.pth"
    dest.parent.mkdir(parents=True)
    content = b"fake weights"
    dest.write_bytes(content)
    checksum = hashlib.sha256(content).hexdigest()
    result = models.ensure_model("rvm", "rvm_mobilenetv3.pth", "http://example.com/model.pth", checksum)
    assert result == str(dest)


def test_ensure_model_redownloads_then_fails_on_download_error(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    dest = tmp_path / "rvm" / "rvm_mobilenetv3.pth"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"corrupt data")

    def fake_download(url, dst):
        raise RuntimeError(f"Simulated download failure for {url}")

    monkeypatch.setattr(models, "_download", fake_download)

    with pytest.raises(SystemExit):
        models.ensure_model("rvm", "rvm_mobilenetv3.pth", "http://example.com/model.pth", "correctchecksum123")


def test_ensure_model_skips_checksum_when_none(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    dest = tmp_path / "rvm" / "rvm_mobilenetv3.pth"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"anything")
    result = models.ensure_model("rvm", "rvm_mobilenetv3.pth", "http://example.com", None)
    assert result == str(dest)


def test_ensure_model_downloads_when_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    content = b"fresh model weights"
    checksum = hashlib.sha256(content).hexdigest()
    dest = tmp_path / "rvm" / "rvm_mobilenetv3.pth"

    def fake_download(url, dst):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        Path(dst).write_bytes(content)

    monkeypatch.setattr(models, "_download", fake_download)
    result = models.ensure_model("rvm", "rvm_mobilenetv3.pth", "http://example.com/model.pth", checksum)
    assert result == str(dest)
    assert dest.read_bytes() == content


def test_ensure_model_redownloads_on_bad_checksum_then_fails(tmp_path, monkeypatch):
    """Corrupt file triggers re-download; if re-download also bad, fail is called."""
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    dest = tmp_path / "rvm" / "rvm_mobilenetv3.pth"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"corrupt data")
    download_count = {"n": 0}

    def fake_download(url, dst):
        download_count["n"] += 1
        Path(dst).write_bytes(b"still corrupt")

    monkeypatch.setattr(models, "_download", fake_download)
    with pytest.raises(SystemExit):
        models.ensure_model("rvm", "rvm_mobilenetv3.pth", "http://example.com/model.pth", "correctchecksum123")
    assert download_count["n"] == 1  # tried once, then failed


# ── ensure_binary() ───────────────────────────────────────────────────────────

def test_ensure_binary_sets_executable(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    dest = tmp_path / "rvm" / "rvm_bin"
    dest.parent.mkdir(parents=True)
    content = b"binary content"
    checksum = hashlib.sha256(content).hexdigest()

    def fake_download(url, dst):
        Path(dst).write_bytes(content)

    monkeypatch.setattr(models, "_download", fake_download)
    result = models.ensure_binary("rvm", "rvm_bin", "http://example.com/rvm_bin", checksum)
    assert result == str(dest)
    assert os.access(str(dest), os.X_OK)


# ── _sha256() ─────────────────────────────────────────────────────────────────

def test_sha256_returns_correct_digest(tmp_path):
    f = tmp_path / "data.bin"
    content = b"hello world"
    f.write_bytes(content)
    expected = hashlib.sha256(content).hexdigest()
    assert models._sha256(str(f)) == expected


# ── _fail() ───────────────────────────────────────────────────────────────────

def test_fail_exits_1(capsys):
    with pytest.raises(SystemExit) as exc:
        models._fail("something broke")
    assert exc.value.code == 1


def test_fail_writes_json_to_stderr(capsys):
    with pytest.raises(SystemExit):
        models._fail("something broke")
    captured = capsys.readouterr()
    err = json.loads(captured.err)
    assert err["error"] == "model_download_failed"
    assert err["message"] == "something broke"
