"""Dependency preflight checks shared across CLI commands."""
import shutil
import os
import sys

# Single source of truth — re-export from cli.main so we don't keep two
# definitions in sync. install.py and serve/server.py also import from cli.main.
from cli.main import MONTAJ_ROOT
sys.path.insert(0, os.path.join(MONTAJ_ROOT, "lib"))
import models as _models
from common import ffmpeg_bin, ffprobe_bin

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

    Checks PATH first (catches `brew install whisper-cpp` on macOS, apt or
    a manual install on Linux), then montaj's legacy local locations. Used
    by both `check_deps` and `montaj doctor` so the two never disagree."""
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
    return os.path.join(BUILD_CACHE_DIR, "render")


def mcp_runtime_dir() -> str:
    """Where the MCP server's node_modules and server.js live at runtime."""
    if is_dev_checkout():
        return os.path.join(MONTAJ_ROOT, "montaj_assets", "mcp")
    return os.path.join(BUILD_CACHE_DIR, "mcp")


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

