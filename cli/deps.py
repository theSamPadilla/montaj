"""Dependency preflight checks shared across CLI commands."""
import contextlib
import shutil
import os
import sys
import time

# Single source of truth — re-export from cli.main so we don't keep two
# definitions in sync. install.py and serve/server.py also import from cli.main.
from cli.main import MONTAJ_ROOT
sys.path.insert(0, os.path.join(MONTAJ_ROOT, "lib"))
import models as _models
from common import ffmpeg_bin, ffprobe_bin, _exe
from lib import proc

LEGACY_WHISPER_MODELS_DIR = os.path.expanduser("~/.local/share/whisper.cpp/models")
WHISPER_MODEL = "base.en"

# Build cache for Node.js bundles (render engine, Vite UI, MCP server). Keeps
# `node_modules/` and `ui/dist/` out of site-packages so the install dir stays
# immutable and `pip install` works under read-only roots like /usr/local or
# Homebrew's Cellar. XDG cache convention.
BUILD_CACHE_DIR = os.path.expanduser("~/.cache/montaj")


def _av_ok(resolved: str) -> bool:
    """True when a resolved ffmpeg/ffprobe target is an executable file.

    `resolved` is either an absolute path (the montaj-managed static build,
    the Homebrew-bundled build, or an MONTAJ_FFMPEG/MONTAJ_FFPROBE override)
    or a bare command name to look up on PATH."""
    path = resolved if os.path.isabs(resolved) else shutil.which(resolved)
    return bool(path) and os.access(path, os.X_OK)


def check_deps() -> list[str]:
    """Return a list of missing dependency descriptions. Empty = all good."""
    missing = []

    if not (_av_ok(ffmpeg_bin()) and _av_ok(ffprobe_bin())):
        missing.append("ffmpeg / ffprobe not found")

    if not whisper_bin_path():
        missing.append("whisper.cpp binary not found")

    if not whisper_model_path():
        missing.append(f"whisper model '{WHISPER_MODEL}' not downloaded")

    return missing


def whisper_model_path(model: str = WHISPER_MODEL) -> str | None:
    """Return the whisper model path, checking Montaj-managed assets first.

    `montaj install whisper` writes models under Montaj's managed model dir.
    Older installs may still have whisper.cpp's legacy model directory, so keep
    that as a fallback for compatibility.
    """
    managed = _models.model_path("whisper", f"ggml-{model}.bin")
    if os.path.isfile(managed):
        return managed

    legacy = os.path.join(LEGACY_WHISPER_MODELS_DIR, f"ggml-{model}.bin")
    if os.path.isfile(legacy):
        return legacy

    return None


def whisper_bin_path() -> str | None:
    """Return the whisper-cli/whisper-cpp binary location, or None.

    Checks the montaj-managed path first — same one lib/common.py's
    find_whisper_bin uses — then PATH (catches `brew install whisper-cpp` on
    macOS, apt or a manual install on Linux), then montaj's legacy local
    locations. Used by both `check_deps` and `montaj doctor`, so they must
    never disagree with what transcription itself actually finds."""
    managed = _models.model_path("whisper", _exe("whisper-cli"))
    if os.path.isfile(managed):
        return managed
    # PATH lookup — covers brew (/opt/homebrew/bin/whisper-cli), apt, manual
    on_path = shutil.which("whisper-cli") or shutil.which("whisper-cpp")
    if on_path:
        return on_path
    # Legacy / pre-2.0.5 install path written by older `montaj install whisper`
    for legacy in (
        "~/.local/share/montaj/models/whisper/whisper-cli",
        "~/.local/bin/whisper-cpp",
    ):
        p = os.path.expanduser(legacy)
        if os.path.isfile(p):
            return p
    return None


def is_dev_checkout() -> bool:
    """True when running from a working tree.

    Uses os.path.exists rather than isdir because git worktrees represent
    `.git` as a FILE (containing `gitdir: <path>`) instead of a directory.
    Both forms count as a working tree."""
    return os.path.exists(os.path.join(MONTAJ_ROOT, ".git"))


def ui_runtime_dir() -> str:
    """Where the UI's node_modules and dist actually live at runtime.
    Dev: source tree (Vite HMR works in place).
    Prod: ~/.cache/montaj/ui (writable; site-packages stays immutable)."""
    if is_dev_checkout():
        return os.path.join(MONTAJ_ROOT, "montaj_assets", "ui")
    return os.path.join(BUILD_CACHE_DIR, "ui")


def render_runtime_dir() -> str:
    """Where the Node render engine's node_modules + JSX templates live at runtime."""
    if is_dev_checkout():
        return os.path.join(MONTAJ_ROOT, "montaj_assets", "render")
    _ensure_prod_cache_fresh()
    return os.path.join(BUILD_CACHE_DIR, "render")


def mcp_runtime_dir() -> str:
    """Where the MCP server's node_modules and server.js live at runtime."""
    if is_dev_checkout():
        return os.path.join(MONTAJ_ROOT, "montaj_assets", "mcp")
    _ensure_prod_cache_fresh()
    return os.path.join(BUILD_CACHE_DIR, "mcp")


# ---------------------------------------------------------------------------
# Runtime cache freshness — auto-rebuild on the render/sample/MCP/serve paths.
#
# `render_runtime_dir()`/`mcp_runtime_dir()` above used to hand back
# `BUILD_CACHE_DIR/<sub>` unconditionally in prod mode, no matter how old it
# was. The cache is only ever (re)built by `montaj install ui`'s
# `_ensure_ui()` (cli/commands/install.py), which stamps `.version` with the
# package version it built against. A `brew upgrade`/`pip install -U montaj`
# bumps the installed package but leaves that stamp — and the cache tree it
# describes — untouched, so render/sample/MCP silently kept running JS built
# for the OLD version (`montaj doctor` is the only thing that ever compared
# the stamp to the installed version, and it only warned).
#
# `montaj serve` runs the same check once at startup
# (`ensure_runtime_cache_fresh()`, called from cli/commands/serve.py) before
# it resolves the UI. `ui_runtime_dir()`/`check_ui()` themselves and `montaj
# doctor` are deliberately NOT hooked: doctor's job is to explain a broken
# install, not to start an npm build while doing it.
#
# The rebuild is `_ensure_ui()`'s build-then-swap: a complete new tree is
# built in a private temp dir beside the cache and renamed into place only
# on success. So a failed or offline rebuild leaves the old cache exactly as
# it was, and we keep running on it with one warning. Only when there is no
# previously completed cache at all is a failed rebuild an error.
# ---------------------------------------------------------------------------

# NOT montaj's own stamp. This is written by the Montaj desktop app's
# first-run staging (montaj-app's desktop/src/first-run.cjs, `stageCacheTree`
# -> `.montaj-app-version`), into the very directory `render_runtime_dir()`/
# `mcp_runtime_dir()` resolve to — that app redirects `HOME` to an
# app-private `runtimeHome` (see its runtime-env.cjs) and stages
# `<runtimeHome>/.cache/montaj` itself: its own vendored bundles, its own
# version, on its own first-run schedule, never via `montaj install ui`. It
# deliberately never writes montaj's `.version` (see that file's own comment:
# "Deliberately NOT montaj's `.version`"), and the environment it hands the
# `serve` child it spawns carries no dedicated flag announcing any of this —
# checked directly against montaj-app's runtime-env.cjs/main.cjs: HOME
# redirection is the ONLY signal. So, from here, an app-managed cache looks
# exactly like a fresh install with a missing stamp — precisely the case
# we'd otherwise rebuild into. This marker is the one cheap, reliable way to
# tell the two apart: its presence means some embedder already owns this
# cache tree and restages it on its own terms, so we must never rebuild
# behind its back, stamp missing or not.
_APP_MANAGED_MARKER = ".montaj-app-version"

_LOCK_POLL_S = 0.2
# How long to wait for a peer's rebuild before doing our own anyway. The lock
# is only a duplicate-work guard (see `_rebuild_lock`), so giving up on it is
# safe: a still-running peer and we each build in our own temp dir.
_LOCK_MAX_WAIT_S = 300

_REBUILD_FAILED_MSG = (
    "montaj runtime cache is out of date and could not be rebuilt; "
    "run `montaj install ui` when online"
)

_cache_checked = False      # memoized: the check below runs at most once/process
_cache_check_error = None   # the exception it raised that one time, if it did


def _installed_version() -> str | None:
    """The installed montaj package version, or None if it can't be read.

    Not expected to ever be None once `is_dev_checkout()` is False — but
    defensive rather than letting a packaging oddity crash every render,
    sample and MCP resolution in a process."""
    try:
        from importlib.metadata import version as _pkg_version
        return _pkg_version("montaj")
    except Exception:
        return None


def _lock_path(cache_root: str) -> str:
    # Sibling of cache_root, never inside it: a rebuild swaps the whole
    # cache directory out (rename to trash, then delete), which would take a
    # lock file living inside it along with it.
    return cache_root.rstrip(os.sep) + ".rebuild.lock"


def _lock_is_stale(lock_path: str) -> bool:
    """True if the pid that wrote this lock is gone — a crashed rebuild left
    it behind. Same create-a-file-with-your-pid-in-it liveness idiom
    serve/lockfile.py already uses for its own single-instance lock."""
    try:
        pid = int(open(lock_path).read().strip())
    except (OSError, ValueError):
        return True
    try:
        return not proc.pid_alive(pid)
    except (OverflowError, ValueError):
        return True


@contextlib.contextmanager
def _rebuild_lock(cache_root: str):
    """Best-effort guard against two processes that notice a stale cache at
    the same instant both doing the (slow) rebuild. It is NOT what keeps the
    cache consistent: every rebuild builds in its own temp dir and swaps in
    atomically (`_rebuild_and_swap` in cli/commands/install.py), so two
    concurrent rebuilds cannot corrupt each other — the last swap wins.

    A plain lock FILE: `os.open(..., O_CREAT|O_EXCL)`. Waits, polling, for the
    holder to release it; steals it if the holder's pid is dead or after
    `_LOCK_MAX_WAIT_S`. A steal cannot tell a hung holder from a live slow
    one, so it may cost a duplicate rebuild; it cannot cost a broken cache.
    The caller re-checks the stamp after acquiring, so a peer that already
    finished is not repeated.
    """
    lock_path = _lock_path(cache_root)
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    deadline = time.monotonic() + _LOCK_MAX_WAIT_S
    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            if _lock_is_stale(lock_path) or time.monotonic() >= deadline:
                try:
                    os.remove(lock_path)
                except OSError:
                    pass
                continue
            time.sleep(_LOCK_POLL_S)
            continue
        with os.fdopen(fd, "w") as f:
            f.write(str(os.getpid()))
        break
    try:
        yield
    finally:
        try:
            os.remove(lock_path)
        except OSError:
            pass


def _check_and_rebuild_if_stale() -> None:
    if is_dev_checkout():
        return
    if os.path.isfile(os.path.join(BUILD_CACHE_DIR, _APP_MANAGED_MARKER)):
        return  # an embedding app owns and restages this cache itself

    current = _installed_version()
    if current is None:
        return

    # Lazy import: cli.commands.install imports from cli.deps (this module)
    # at its own module scope, so importing it back at OUR module scope would
    # be circular. Reusing its exact rebuild function is the point — this is
    # `montaj install ui`'s own `_ensure_ui()`, not a re-implementation of it.
    from cli.commands import install as _install

    if not _install._cache_is_stale(BUILD_CACHE_DIR, current):
        return

    with _rebuild_lock(BUILD_CACHE_DIR):
        # Another process may have finished rebuilding while we waited.
        if not _install._cache_is_stale(BUILD_CACHE_DIR, current):
            return
        print(f"rebuilding montaj runtime cache for {current}", file=sys.stderr)
        cause = None
        try:
            ok = _install._ensure_ui()
        except Exception as e:
            ok, cause = False, e
        if ok:
            return
        if _has_previous_cache():
            # Build-then-swap left the old cache untouched: keep using it.
            print(f"warning: {_REBUILD_FAILED_MSG}", file=sys.stderr)
            return
        detail = f" ({cause})" if cause is not None else ""
        raise RuntimeError(
            "montaj runtime cache is missing and could not be built; "
            f"run `montaj install ui` when online{detail}"
        ) from cause


def _has_previous_cache() -> bool:
    """True if BUILD_CACHE_DIR holds a completed build (any `.version`
    stamp, even an old one). A stamp is only written after every build step
    succeeded, so its presence means the tree is usable, if out of date."""
    return os.path.isfile(os.path.join(BUILD_CACHE_DIR, ".version"))


def _ensure_prod_cache_fresh() -> None:
    """Entry point for `render_runtime_dir()`/`mcp_runtime_dir()`. Runs the
    freshness check — and the rebuild, if the cache is stale — at most ONCE
    per process. Cheap on every call after the first: the point of this
    change is that checking used to cost nothing because nobody did it, not
    that it should now cost an npm install on every single render.

    A failed rebuild with an old cache to fall back on warns once and
    carries on with the old cache. A failed rebuild with NO usable cache is
    remembered and re-raised on every later call in this process, rather
    than retried (a retry storm against a dead network on every render)."""
    global _cache_checked, _cache_check_error
    if _cache_checked:
        if _cache_check_error is not None:
            raise _cache_check_error
        return
    try:
        _check_and_rebuild_if_stale()
    except Exception as e:
        _cache_check_error = e
        raise
    finally:
        _cache_checked = True


def ensure_runtime_cache_fresh() -> None:
    """Public entry for `montaj serve` startup: the same once-per-process
    stale-cache check and rebuild `render_runtime_dir()`/`mcp_runtime_dir()`
    run. No-op in dev checkouts and under an app-managed cache. Raises
    RuntimeError only when the rebuild failed and there is no previous cache."""
    _ensure_prod_cache_fresh()


def check_ui() -> tuple[str, str | None]:
    """Check whether the UI is ready to serve.

    Returns (mode, error). mode is 'dev' (working tree) or 'prod' (installed package).
    error is None when ready, or a human-readable description of what's missing.
    The wheel ships ui/src, so source presence alone can't distinguish the two —
    we key off `.git` at MONTAJ_ROOT instead."""
    ui_dir       = ui_runtime_dir()
    ui_dist      = os.path.join(ui_dir, "dist")
    ui_index     = os.path.join(ui_dist, "index.html")
    node_modules = os.path.join(ui_dir, "node_modules")

    if is_dev_checkout():
        if not os.path.isdir(node_modules):
            return "dev", "ui/node_modules missing — npm install has not been run"
        return "dev", None

    if not os.path.isfile(ui_index):
        return "prod", "ui/dist/index.html missing — UI has not been built"
    return "prod", None

