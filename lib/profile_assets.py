"""Pure I/O helpers for per-profile asset libraries at ~/.montaj/profiles/{name}/assets/.

Source of truth for the assets manifest shape + the per-upload size cap.
HTTP-layer concerns (request validation, route handlers, status codes) live
in serve/routes/profile_assets.py — this module is intentionally HTTP-free
so non-route consumers (project/init.py, future CLI tools) can read/write
manifests without depending on the serve layer.
"""
import json
import os
import re
from pathlib import Path


MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB hard cap per upload

# Single source of truth for the validation regexes used across all three
# call sites — serve/routes/profile_assets.py, serve/routes/projects.py
# (include-profile-asset endpoint), and cli/commands/profile.py. Hoisted
# here so the patterns can't drift between layers.
#
# NAME_RE     — profile names. Alphanumerics, underscores, hyphens.
#               No leading dot (no .DS_Store-style dotfiles), no slashes.
# FILENAME_RE — asset filenames inside a profile's assets/ dir. Allows dots
#               only after the first character (so `.hidden` is rejected
#               but `clip.mp4` is fine), plus underscores and hyphens.
NAME_RE     = re.compile(r"^[a-zA-Z0-9_-]+$")
FILENAME_RE = re.compile(r"^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$")


def _profile_dir(name: str) -> Path:
    return Path.home() / ".montaj" / "profiles" / name


def _assets_dir(name: str) -> Path:
    return _profile_dir(name) / "assets"


def _manifest_path(name: str) -> Path:
    return _assets_dir(name) / "manifest.json"


def load_assets_manifest(profile_name: str) -> dict:
    """Read ~/.montaj/profiles/{profile_name}/assets/manifest.json.

    Returns {"summary": "", "files": {}} on any failure (missing, empty, bad
    JSON, or non-dict top-level value). For valid manifests, coerces missing
    keys to defaults and ensures `summary` is a string + `files` is a dict.
    Single source of truth for the empty-manifest default.
    """
    path = _manifest_path(profile_name)
    try:
        text = path.read_text()
    except (FileNotFoundError, OSError):
        return {"summary": "", "files": {}}
    if not text.strip():
        return {"summary": "", "files": {}}
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return {"summary": "", "files": {}}
    if not isinstance(data, dict):
        return {"summary": "", "files": {}}
    summary = data.get("summary", "")
    files   = data.get("files", {})
    if not isinstance(summary, str):
        summary = ""
    if not isinstance(files, dict):
        files = {}
    return {"summary": summary, "files": files}


def save_assets_manifest(profile_name: str, manifest: dict) -> None:
    """Atomically write the assets manifest. Creates parent dirs if needed.

    Single-user local app: last-writer-wins on the whole manifest is acceptable,
    so there's no file lock around the load-mutate-write window. Splitting the
    summary vs per-file PUTs narrows the lost-update window but doesn't close
    it — two concurrent PUTs on different file entries can still race. Not
    worth a fcntl lock for a single-user sidecar; revisit if Montaj ever
    serves multi-tenant.
    """
    assets_dir = _assets_dir(profile_name)
    assets_dir.mkdir(parents=True, exist_ok=True)
    path = _manifest_path(profile_name)
    tmp  = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(manifest, indent=2))
    os.replace(tmp, path)


def build_profile_snapshot(profile_name: str | None) -> dict | None:
    """Build the project.json `profileSnapshot` value for a project being
    initialized with `--profile <profile_name>`.

    Returns None when `profile_name` is falsy — the caller then omits the
    field from project.json (rather than writing `profileSnapshot: null`).

    Snapshot shape is the source of truth here; both the linear init flow
    in project/init.py and the carousel early-return branch (and any future
    project type) call this once and write the result. Three fields:

    - `name`            — the profile name (redundant with the sibling
                          `profile` field, but convenient for the agent).
    - `summary`         — hand-written guidance about how to use this asset
                          library, frozen at init time. Editing the profile
                          later does not retroactively change in-flight
                          projects.
    - `styleProfilePath` — absolute path to the profile's style_profile.md.
                          OMITTED if the file does not exist at init time.
                          Agent reads this file live (not snapshotted) for
                          editorial direction analyzed from the creator's
                          content; the snapshot only pins the location.
    - `availableAssets`  — list of asset entries (filename + description +
                          tags) sorted by filename. Frozen at init time.
    """
    if not profile_name:
        return None
    manifest = load_assets_manifest(profile_name)
    snapshot: dict = {
        "name":    profile_name,
        "summary": manifest["summary"],
        "availableAssets": [
            {
                "filename":    fn,
                "description": entry.get("description", ""),
                "tags":        entry.get("tags", []),
            }
            for fn, entry in sorted(manifest["files"].items())
        ],
    }
    style_profile = _profile_dir(profile_name) / "style_profile.md"
    if style_profile.exists():
        snapshot["styleProfilePath"] = str(style_profile)
    return snapshot
