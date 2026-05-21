import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from cli import deps
import models as _models


def test_whisper_model_path_prefers_managed_model(tmp_path, monkeypatch):
    managed_root = tmp_path / "managed"
    legacy_root = tmp_path / "legacy"
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(managed_root))
    monkeypatch.setattr(deps, "LEGACY_WHISPER_MODELS_DIR", str(legacy_root))

    managed = Path(_models.model_path("whisper", "ggml-base.en.bin"))
    legacy = legacy_root / "ggml-base.en.bin"
    managed.parent.mkdir(parents=True)
    legacy.parent.mkdir(parents=True)
    managed.write_bytes(b"managed")
    legacy.write_bytes(b"legacy")

    assert deps.whisper_model_path("base.en") == str(managed)


def test_whisper_model_path_falls_back_to_legacy_model(tmp_path, monkeypatch):
    managed_root = tmp_path / "managed"
    legacy_root = tmp_path / "legacy"
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(managed_root))
    monkeypatch.setattr(deps, "LEGACY_WHISPER_MODELS_DIR", str(legacy_root))

    legacy = legacy_root / "ggml-base.en.bin"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(b"legacy")

    assert deps.whisper_model_path("base.en") == str(legacy)


def test_whisper_model_path_returns_none_when_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path / "managed"))
    monkeypatch.setattr(deps, "LEGACY_WHISPER_MODELS_DIR", str(tmp_path / "legacy"))

    assert deps.whisper_model_path("base.en") is None


def test_check_deps_accepts_managed_whisper_model(tmp_path, monkeypatch):
    managed_root = tmp_path / "managed"
    legacy_root = tmp_path / "legacy"
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(managed_root))
    monkeypatch.setattr(deps, "LEGACY_WHISPER_MODELS_DIR", str(legacy_root))
    monkeypatch.setattr(deps.shutil, "which", lambda name: f"/usr/bin/{name}")

    managed = Path(_models.model_path("whisper", "ggml-base.en.bin"))
    managed.parent.mkdir(parents=True)
    managed.write_bytes(b"managed")

    assert "whisper model 'base.en' not downloaded" not in deps.check_deps()


def test_check_deps_accepts_legacy_whisper_model(tmp_path, monkeypatch):
    managed_root = tmp_path / "managed"
    legacy_root = tmp_path / "legacy"
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(managed_root))
    monkeypatch.setattr(deps, "LEGACY_WHISPER_MODELS_DIR", str(legacy_root))
    monkeypatch.setattr(deps.shutil, "which", lambda name: f"/usr/bin/{name}")

    legacy = legacy_root / "ggml-base.en.bin"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(b"legacy")

    assert "whisper model 'base.en' not downloaded" not in deps.check_deps()


def test_check_deps_reports_missing_whisper_model(tmp_path, monkeypatch):
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path / "managed"))
    monkeypatch.setattr(deps, "LEGACY_WHISPER_MODELS_DIR", str(tmp_path / "legacy"))
    monkeypatch.setattr(deps.shutil, "which", lambda name: f"/usr/bin/{name}")

    assert "whisper model 'base.en' not downloaded" in deps.check_deps()
