"""Pure I/O helpers for per-profile asset libraries at ~/.montaj/profiles/{name}/assets/.

Source of truth for the assets manifest shape + the per-upload size cap.
HTTP-layer concerns (request validation, route handlers, status codes) live
in serve/routes/profile_assets.py — this module is intentionally HTTP-free
so non-route consumers (project/init.py, future CLI tools) can read/write
manifests without depending on the serve layer.
"""
import json
import os
from pathlib import Path


MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB hard cap per upload


def _profile_dir(name: str) -> Path:
    return Path.home() / ".montaj" / "profiles" / name


def _assets_dir(name: str) -> Path:
    return _profile_dir(name) / "assets"


def _manifest_path(name: str) -> Path:
    return _assets_dir(name) / "manifest.json"


def load_assets_manifest(profile_name: str) -> dict:
    """Read ~/.montaj/profiles/{profile_name}/assets/manifest.json.

    Returns {"notes": "", "files": {}} on any failure (missing, empty, bad
    JSON, or non-dict top-level value). For valid manifests, coerces missing
    keys to defaults and ensures `notes` is a string + `files` is a dict.
    Single source of truth for the empty-manifest default.
    """
    path = _manifest_path(profile_name)
    try:
        text = path.read_text()
    except (FileNotFoundError, OSError):
        return {"notes": "", "files": {}}
    if not text.strip():
        return {"notes": "", "files": {}}
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return {"notes": "", "files": {}}
    if not isinstance(data, dict):
        return {"notes": "", "files": {}}
    notes = data.get("notes", "")
    files = data.get("files", {})
    if not isinstance(notes, str):
        notes = ""
    if not isinstance(files, dict):
        files = {}
    return {"notes": notes, "files": files}


def save_assets_manifest(profile_name: str, manifest: dict) -> None:
    """Atomically write the assets manifest. Creates parent dirs if needed.

    Single-user local app: last-writer-wins on the whole manifest is acceptable,
    so there's no file lock around the load-mutate-write window. Splitting the
    notes vs per-file PUTs narrows the lost-update window but doesn't close it
    — two concurrent PUTs on different file entries can still race. Not worth
    a fcntl lock for a single-user sidecar; revisit if Montaj ever serves
    multi-tenant.
    """
    assets_dir = _assets_dir(profile_name)
    assets_dir.mkdir(parents=True, exist_ok=True)
    path = _manifest_path(profile_name)
    tmp  = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(manifest, indent=2))
    os.replace(tmp, path)
