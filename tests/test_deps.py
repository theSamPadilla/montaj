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


def test_rebuild_failure_with_old_cache_warns_and_keeps_it(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _write_stamp(cache_dir, "1.0.0")
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: False)

    result = deps.render_runtime_dir()

    assert result == str(cache_dir / "render")
    err = capsys.readouterr().err
    assert ("warning: montaj runtime cache is out of date and could not be rebuilt; "
            "run `montaj install ui` when online") in err


def test_rebuild_failure_without_any_cache_raises_clear_error(tmp_path, monkeypatch):
    _prod_cache(tmp_path, monkeypatch)  # nothing on disk at all
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: False)

    try:
        deps.render_runtime_dir()
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        msg = str(e)
        assert "montaj runtime cache is missing and could not be built" in msg
        assert "montaj install ui" in msg and "when online" in msg


def test_rebuild_exception_is_wrapped_in_clear_error(tmp_path, monkeypatch):
    _prod_cache(tmp_path, monkeypatch)  # no previous cache to fall back to

    def _boom():
        raise OSError("npm not found")

    monkeypatch.setattr(install_cmd, "_ensure_ui", _boom)

    try:
        deps.render_runtime_dir()
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        msg = str(e)
        assert "montaj runtime cache is missing and could not be built" in msg
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
    _prod_cache(tmp_path, monkeypatch)  # no previous cache: failure raises
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


def test_old_cache_fallback_warns_once_per_process(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _write_stamp(cache_dir, "1.0.0")
    calls = []
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or False)

    for _ in range(3):
        assert deps.render_runtime_dir() == str(cache_dir / "render")

    assert len(calls) == 1
    assert capsys.readouterr().err.count("warning: montaj runtime cache") == 1


# ── build-then-swap (the real _ensure_ui, fake npm) ──────────────────────────
# These run the real `_ensure_ui()` against a tiny fake source tree and a fake
# `npm`, so they exercise the temp-dir build and the rename swap for real.

import importlib.metadata as _im
import subprocess as _sp
import threading

_SUBS = ["overlay-runtime", "render", "editor", "ui", "mcp",
         "schemas", "timeline-core", "luts"]


def _fake_source(tmp_path, monkeypatch, version):
    root = tmp_path / "src"
    for sub in _SUBS:
        d = root / "montaj_assets" / sub
        d.mkdir(parents=True)
        (d / "marker.txt").write_text(version)
    monkeypatch.setattr(install_cmd, "MONTAJ_ROOT", str(root))
    real_version = _im.version
    monkeypatch.setattr(_im, "version",
                        lambda name: version if name == "montaj" else real_version(name))
    monkeypatch.setattr(install_cmd.shutil, "which", lambda name: f"/usr/bin/{name}")


def _fake_npm(monkeypatch, *, fail=False, hook=None):
    calls = []

    def run(cmd, *a, **k):
        calls.append(cmd)
        if hook:
            hook(cmd)
        if fail and cmd[1] == "install":
            return _sp.CompletedProcess(cmd, 1)  # e.g. offline
        prefix = cmd[cmd.index("--prefix") + 1]
        if cmd[1] == "install":
            os.makedirs(os.path.join(prefix, "node_modules"), exist_ok=True)
        else:
            os.makedirs(os.path.join(prefix, "dist"), exist_ok=True)
            with open(os.path.join(prefix, "dist", "index.html"), "w") as f:
                f.write("<html>new</html>")
        return _sp.CompletedProcess(cmd, 0)

    monkeypatch.setattr(install_cmd.subprocess, "run", run)
    return calls


def _old_cache(cache_dir):
    (cache_dir / "ui" / "dist").mkdir(parents=True)
    (cache_dir / "ui" / "dist" / "index.html").write_text("<html>old</html>")
    (cache_dir / "render").mkdir()
    (cache_dir / "render" / "marker.txt").write_text("1.0.0")
    (cache_dir / "render" / "deleted-upstream.js").write_text("x")
    (cache_dir / ".version").write_text("1.0.0")


def _leftovers(cache_dir):
    return [p.name for p in cache_dir.parent.iterdir()
            if p.name.startswith((".montaj-build-", ".montaj-trash-"))]


def test_failed_rebuild_leaves_old_cache_intact_and_warns(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _fake_source(tmp_path, monkeypatch, "9.9.9")
    _old_cache(cache_dir)
    _fake_npm(monkeypatch, fail=True)

    result = deps.render_runtime_dir()

    assert result == str(cache_dir / "render")
    assert (cache_dir / ".version").read_text() == "1.0.0"
    assert (cache_dir / "ui" / "dist" / "index.html").read_text() == "<html>old</html>"
    assert (cache_dir / "render" / "deleted-upstream.js").exists()
    assert _leftovers(cache_dir) == []
    assert "run `montaj install ui` when online" in capsys.readouterr().err


def test_successful_rebuild_swaps_and_old_dir_is_gone(tmp_path, monkeypatch):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _fake_source(tmp_path, monkeypatch, "9.9.9")
    _old_cache(cache_dir)
    _fake_npm(monkeypatch)

    deps.render_runtime_dir()

    assert (cache_dir / ".version").read_text() == "9.9.9"
    assert (cache_dir / "render" / "marker.txt").read_text() == "9.9.9"
    assert not (cache_dir / "render" / "deleted-upstream.js").exists()
    assert (cache_dir / "ui" / "dist" / "index.html").read_text() == "<html>new</html>"
    assert _leftovers(cache_dir) == []


def test_rebuild_never_builds_inside_the_live_cache(tmp_path, monkeypatch):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _fake_source(tmp_path, monkeypatch, "9.9.9")
    _old_cache(cache_dir)
    calls = _fake_npm(monkeypatch)

    assert install_cmd._ensure_ui() is True

    prefixes = [c[c.index("--prefix") + 1] for c in calls]
    assert prefixes and not any(p.startswith(str(cache_dir) + os.sep) for p in prefixes)


def test_two_concurrent_rebuilds_end_with_one_valid_cache(tmp_path, monkeypatch):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _fake_source(tmp_path, monkeypatch, "9.9.9")
    _old_cache(cache_dir)
    barrier = threading.Barrier(2, timeout=10)
    local = threading.local()

    def hook(cmd):
        # Hold both builds mid-flight at once, each in its own temp dir.
        if not getattr(local, "met", False):
            local.met = True
            barrier.wait()

    _fake_npm(monkeypatch, hook=hook)
    results = []

    def worker():
        results.append(install_cmd._ensure_ui())

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert results == [True, True]
    assert (cache_dir / ".version").read_text() == "9.9.9"
    assert (cache_dir / "ui" / "dist" / "index.html").read_text() == "<html>new</html>"
    assert (cache_dir / "render" / "node_modules").is_dir()
    assert not (cache_dir / "render" / "deleted-upstream.js").exists()
    assert _leftovers(cache_dir) == []


# ── serve startup ────────────────────────────────────────────────────────────

import types
import uvicorn
from cli.commands import serve as serve_cmd


def _serve(monkeypatch):
    started = []
    monkeypatch.setattr(serve_cmd, "check_deps", lambda: [])
    monkeypatch.setattr(uvicorn, "run", lambda *a, **k: started.append(1))
    monkeypatch.delenv("MONTAJ_HEADLESS", raising=False)
    monkeypatch.setenv("MONTAJ_SERVE_PORT", "3999")  # handle() sets it; restore after
    args = types.SimpleNamespace(port=3999, network=False, debug=False, headless=False)
    serve_cmd.handle(args)
    return started


def test_serve_startup_rebuilds_stale_cache(tmp_path, monkeypatch):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _fake_source(tmp_path, monkeypatch, "9.9.9")
    _old_cache(cache_dir)
    _fake_npm(monkeypatch)

    started = _serve(monkeypatch)

    assert started == [1]
    assert (cache_dir / ".version").read_text() == "9.9.9"
    assert (cache_dir / "ui" / "dist" / "index.html").read_text() == "<html>new</html>"


def test_serve_startup_rebuild_failure_keeps_serving_old_cache(tmp_path, monkeypatch, capsys):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _fake_source(tmp_path, monkeypatch, "9.9.9")
    _old_cache(cache_dir)
    _fake_npm(monkeypatch, fail=True)

    started = _serve(monkeypatch)

    assert started == [1]
    assert (cache_dir / "ui" / "dist" / "index.html").read_text() == "<html>old</html>"
    err = capsys.readouterr().err
    assert err.count("montaj runtime cache is out of date and could not be rebuilt; "
                     "run `montaj install ui` when online") == 1


def test_serve_startup_skips_app_managed_cache(tmp_path, monkeypatch):
    cache_dir = _prod_cache(tmp_path, monkeypatch)
    _old_cache(cache_dir)
    (cache_dir / deps._APP_MANAGED_MARKER).write_text("4.9.1")
    calls = []
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or True)

    assert _serve(monkeypatch) == [1]
    assert calls == []


def test_serve_startup_skips_dev_checkout(tmp_path, monkeypatch):
    _prod_cache(tmp_path, monkeypatch)
    monkeypatch.setattr(deps, "is_dev_checkout", lambda: True)
    monkeypatch.setattr(serve_cmd, "check_ui", lambda: ("dev", None))
    calls = []
    monkeypatch.setattr(install_cmd, "_ensure_ui", lambda: calls.append(1) or True)

    assert _serve(monkeypatch) == [1]
    assert calls == []
