import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from cli import deps
import models as _models
import common


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


# ── whisper_bin_path() ────────────────────────────────────────────────────────
# Must consult the same montaj-managed path find_whisper_bin (lib/common.py)
# checks, and check it FIRST — otherwise check_deps()/`montaj doctor` can
# report "whisper.cpp binary not found" while transcription itself works fine
# from the managed install, because the two would be looking in different
# places.

def test_whisper_bin_path_prefers_managed_binary_over_path(tmp_path, monkeypatch):
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path))
    managed = Path(_models.model_path("whisper", common._exe("whisper-cli")))
    managed.parent.mkdir(parents=True)
    managed.write_bytes(b"fake binary")
    # Even if PATH would also resolve one, the managed path wins.
    monkeypatch.setattr(deps.shutil, "which", lambda name: f"/usr/bin/{name}")

    assert deps.whisper_bin_path() == str(managed)


def test_whisper_bin_path_falls_back_to_path_when_no_managed_binary(tmp_path, monkeypatch):
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path))
    monkeypatch.setattr(deps.shutil, "which",
                         lambda name: "/usr/bin/whisper-cli" if name == "whisper-cli" else None)

    assert deps.whisper_bin_path() == "/usr/bin/whisper-cli"


def test_whisper_bin_path_falls_back_to_legacy_when_nothing_else_found(tmp_path, monkeypatch):
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path / "managed"))
    monkeypatch.setattr(deps.shutil, "which", lambda name: None)
    # os.path.expanduser("~/...") honours $HOME on POSIX — redirect HOME
    # rather than touching os.path.expanduser itself.
    fake_home = tmp_path / "home"
    legacy = fake_home / ".local" / "bin" / "whisper-cpp"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(b"legacy")
    monkeypatch.setenv("HOME", str(fake_home))

    assert deps.whisper_bin_path() == str(legacy)


def test_whisper_bin_path_managed_looks_for_exe_on_windows(tmp_path, monkeypatch):
    """Windows seam: same _EXE_SUFFIX seam as find_whisper_bin, never sys.platform."""
    monkeypatch.setattr(common, "_EXE_SUFFIX", ".exe")
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path))
    managed = Path(_models.model_path("whisper", common._exe("whisper-cli")))
    managed.parent.mkdir(parents=True)
    managed.write_bytes(b"MZ")
    monkeypatch.setattr(deps.shutil, "which", lambda name: None)

    assert deps.whisper_bin_path() == str(managed)
