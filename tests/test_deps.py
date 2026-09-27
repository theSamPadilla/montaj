import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from cli import deps
from cli.commands import install as install_cmd
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


# ── render/mcp runtime cache auto-rebuild ────────────────────────────────────
# `render_runtime_dir()`/`mcp_runtime_dir()` used to hand back a possibly
# stale `~/.cache/montaj/<sub>` with nothing ever re-checking it against the
# installed version. These exercise the new `_ensure_prod_cache_fresh()`
# hook: rebuild on stale/missing stamp, skip in dev checkouts and under an
# app-managed cache, memoize within a process, and surface a clear error
# when the rebuild itself fails.

def _prod_cache(tmp_path, monkeypatch, *, installed_version="9.9.9"):
    """Common prod-mode setup: fake BUILD_CACHE_DIR, not a dev checkout, a
    fixed installed version, and a clean (unmemoized) per-process check."""
    cache_dir = tmp_path / "cache" / "montaj"
    monkeypatch.setattr(deps, "BUILD_CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(deps, "is_dev_checkout", lambda: False)
    monkeypatch.setattr(deps, "_installed_version", lambda: installed_version)
    monkeypatch.setattr(deps, "_cache_checked", False)
    monkeypatch.setattr(deps, "_cache_check_error", None)
    # Bound the rebuild lock's own wait so a test that exercises it can't hang.
    monkeypatch.setattr(deps, "_LOCK_MAX_WAIT_S", 0.2)
    monkeypatch.setattr(deps, "_LOCK_POLL_S", 0.02)
    return cache_dir


def _write_stamp(cache_dir, version):
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / ".version").write_text(version)


def test_stale_stamp_triggers_one_rebuild_with_log_line(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _write_stamp(cache_dir, "1.0.0")  # stale: installed is 9.9.9

    calls = []
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or True)

    result = deps.render_runtime_dir()

    assert result == str(cache_dir / "render")
    assert len(calls) == 1
    assert capsys.readouterr().err.strip() == "rebuilding montaj runtime cache for 9.9.9"


def test_missing_stamp_triggers_rebuild(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    # No .version at all — not even BUILD_CACHE_DIR exists yet.
    calls = []
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or True)

    deps.render_runtime_dir()

    assert len(calls) == 1
    assert "rebuilding montaj runtime cache for 9.9.9" in capsys.readouterr().err


def test_matching_stamp_does_not_rebuild(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _write_stamp(cache_dir, "9.9.9")  # matches installed version
    calls = []
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or True)

    result = deps.render_runtime_dir()

    assert result == str(cache_dir / "render")
    assert calls == []
    assert capsys.readouterr().err == ""


def test_rebuild_failure_raises_clear_error(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _write_stamp(cache_dir, "1.0.0")
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: False)

    try:
        deps.render_runtime_dir()
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        msg = str(e)
        assert "montaj runtime cache is out of date and could not be rebuilt" in msg
        assert "montaj install ui" in msg


def test_rebuild_exception_is_wrapped_in_clear_error(tmp_path, monkeypatch):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _write_stamp(cache_dir, "1.0.0")

    def _boom():
        raise OSError("npm not found")

    monkeypatch.setattr(install_cmd, "_ensure_ui", _boom)

    try:
        deps.render_runtime_dir()
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        msg = str(e)
        assert "montaj runtime cache is out of date and could not be rebuilt" in msg
        assert "montaj install ui" in msg
        assert "npm not found" in msg


def test_dev_checkout_never_rebuilds(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    monkeypatch.setattr(deps, "is_dev_checkout", lambda: True)
    _write_stamp(cache_dir, "1.0.0")  # would be stale, if it were even consulted
    calls = []
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or True)

    result = deps.render_runtime_dir()

    assert result == os.path.join(deps.MONTAJ_ROOT, "montaj_assets", "render")
    assert calls == []
    assert capsys.readouterr().err == ""


def test_app_managed_cache_never_rebuilds(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    cache_dir.mkdir(parents=True)
    # No montaj `.version` at all (missing == stale by our own rule) but the
    # embedding app's own marker IS present.
    (cache_dir / deps._APP_MANAGED_MARKER).write_text("4.9.1")
    calls = []
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or True)

    result = deps.render_runtime_dir()

    assert result == str(cache_dir / "render")
    assert calls == []
    assert capsys.readouterr().err == ""


def test_mcp_runtime_dir_also_rebuilds_on_stale_stamp(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _write_stamp(cache_dir, "1.0.0")
    calls = []
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or True)

    result = deps.mcp_runtime_dir()

    assert result == str(cache_dir / "mcp")
    assert len(calls) == 1


def test_check_is_memoized_within_a_process(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _write_stamp(cache_dir, "1.0.0")  # stale, and the mock below never fixes it
    calls = []
    # Deliberately does NOT write a fresh stamp — if the second call re-ran
    # the check for real (rather than being memoized), it would see the same
    # stale stamp and rebuild again.
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or True)

    deps.render_runtime_dir()
    deps.render_runtime_dir()
    deps.mcp_runtime_dir()

    assert len(calls) == 1
    assert capsys.readouterr().err.count("rebuilding montaj runtime cache") == 1


def test_memoized_failure_is_reraised_without_retrying(tmp_path, monkeypatch):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _write_stamp(cache_dir, "1.0.0")
    calls = []
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or False)

    for _ in range(3):
        try:
            deps.render_runtime_dir()
            assert False, "expected RuntimeError"
        except RuntimeError:
            pass

    # Rebuild attempted once, not once per call.
    assert len(calls) == 1


# ── concurrency: the rebuild lock ────────────────────────────────────────────

def test_rebuild_lock_is_stolen_from_a_dead_pid(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _write_stamp(cache_dir, "1.0.0")
    # A pid that is not a live process on this machine.
    dead_pid = 999999999
    lock_path = deps._lock_path(str(cache_dir))
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    with open(lock_path, "w") as f:
        f.write(str(dead_pid))
    calls = []
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or True)

    deps.render_runtime_dir()

    assert len(calls) == 1
    assert not os.path.exists(lock_path)  # released after the rebuild


def test_rebuild_lock_is_stolen_after_max_wait(tmp_path, monkeypatch):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _write_stamp(cache_dir, "1.0.0")
    # Held by OUR OWN (very much alive) pid — simulates a peer that is alive
    # but never releases the lock. _LOCK_MAX_WAIT_S/_LOCK_POLL_S are patched
    # to milliseconds by _prod_cache so this test stays fast.
    lock_path = deps._lock_path(str(cache_dir))
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    with open(lock_path, "w") as f:
        f.write(str(os.getpid()))
    calls = []
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or True)

    deps.render_runtime_dir()

    assert len(calls) == 1


def test_rebuild_lock_double_checks_stamp_after_acquiring(tmp_path, monkeypatch):
    """If another process finished rebuilding while we waited for the lock,
    we must not rebuild again — the double-check inside the lock catches
    this even though the outer check (before acquiring) already saw stale."""
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _write_stamp(cache_dir, "1.0.0")
    calls = []

    real_lock = deps._rebuild_lock

    import contextlib

    @contextlib.contextmanager
    def fake_lock(cache_root):
        # "Another process" fixes the stamp the instant we're inside the lock.
        _write_stamp(cache_dir, "9.9.9")
        with real_lock(cache_root):
            yield

    monkeypatch.setattr(deps, "_rebuild_lock", fake_lock)
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or True)

    deps.render_runtime_dir()

    assert calls == []
