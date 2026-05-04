"""Per-profile asset library endpoints — /profiles/{name}/assets*.

Each profile has an independent asset library at ~/.montaj/profiles/{name}/assets/
with a manifest.json describing notes + per-file metadata. Drift between disk
and manifest is reported (not auto-healed) so the user stays in control.

Pure manifest I/O (load/save) lives in lib/profile_assets.py so non-HTTP
consumers (e.g. project/init.py snapshotting the manifest at intake) can
reuse it without depending on the serve layer.
"""
import mimetypes
import os
import re
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, UploadFile

from lib.profile_assets import (
    MAX_ASSET_BYTES,
    load_assets_manifest,
    save_assets_manifest,
)
from serve.common import bad_request, forbidden, not_found

router = APIRouter(prefix="/api")

_NAME_RE     = re.compile(r"^[a-zA-Z0-9_-]+$")
_FILENAME_RE = re.compile(r"^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$")


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _validate_name(name: str) -> None:
    if not _NAME_RE.match(name or ""):
        raise bad_request("invalid_name", "Invalid profile name")


def _validate_filename(filename: str) -> None:
    if not _FILENAME_RE.match(filename or ""):
        raise bad_request("invalid_filename", "Invalid filename")


def _profile_dir(name: str) -> Path:
    return Path.home() / ".montaj" / "profiles" / name


def _assets_dir(name: str) -> Path:
    return _profile_dir(name) / "assets"


def _manifest_path(name: str) -> Path:
    return _assets_dir(name) / "manifest.json"


def _resolve_under_assets(name: str, filename: str) -> Path:
    """Resolve {assets_dir}/{filename} and verify it stays under assets_dir.

    Belt-and-suspenders against any edge case the regex misses (e.g. odd
    Unicode normalization). Caller has already validated `filename` against
    _FILENAME_RE.
    """
    assets_dir = _assets_dir(name)
    target = (assets_dir / filename).resolve()
    try:
        target.relative_to(assets_dir.resolve())
    except (ValueError, OSError):
        raise forbidden("traversal", "Path escapes assets dir")
    return target


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/profiles/{name}/assets")
async def list_profile_assets(name: str):
    _validate_name(name)
    profile_dir = _profile_dir(name)
    if not profile_dir.exists():
        raise not_found("not_found", f"Profile '{name}' not found")

    assets_dir = _assets_dir(name)
    if not assets_dir.exists():
        return {
            "files":    [],
            "manifest": {"notes": "", "files": {}},
            "drift":    {"filesWithoutEntry": [], "entriesWithoutFile": []},
        }

    files: list[dict] = []
    on_disk: set[str] = set()
    for entry in sorted(assets_dir.iterdir(), key=lambda p: p.name):
        if not entry.is_file():
            continue
        if entry.name == "manifest.json":
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        mime = mimetypes.guess_type(entry.name)[0] or "application/octet-stream"
        files.append({
            "filename": entry.name,
            "size":     stat.st_size,
            "mime":     mime,
            "mtime":    stat.st_mtime,
            "path":     str(entry),
        })
        on_disk.add(entry.name)

    manifest = load_assets_manifest(name)
    entries  = set(manifest["files"].keys())

    drift = {
        "filesWithoutEntry":  sorted(on_disk - entries),
        "entriesWithoutFile": sorted(entries - on_disk),
    }
    return {"files": files, "manifest": manifest, "drift": drift}


@router.post("/profiles/{name}/assets")
async def upload_profile_asset(name: str, file: UploadFile):
    _validate_name(name)
    raw = file.filename or "upload"
    base = os.path.basename(raw)
    _validate_filename(base)

    assets_dir = _assets_dir(name)
    assets_dir.mkdir(parents=True, exist_ok=True)

    # Resolve collisions with the same _1, _2 suffix pattern as files.py:30–35.
    dest = assets_dir / base
    stem, suffix = dest.stem, dest.suffix
    counter = 1
    while dest.exists():
        dest = assets_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    # Post-resolution traversal check on the final dest (in case base sneaks
    # past _FILENAME_RE somehow — defense in depth).
    try:
        dest.resolve().relative_to(assets_dir.resolve())
    except (ValueError, OSError):
        raise forbidden("traversal", "Path escapes assets dir")

    written = 0
    fh = open(dest, "wb")
    try:
        while True:
            chunk = await file.read(1024 * 1024)  # 1 MB chunks
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_ASSET_BYTES:
                fh.close()
                try:
                    dest.unlink()
                except FileNotFoundError:
                    pass
                raise HTTPException(413, detail={
                    "error":   "payload_too_large",
                    "message": f"File exceeds {MAX_ASSET_BYTES} bytes",
                })
            fh.write(chunk)
    finally:
        if not fh.closed:
            fh.close()

    return {"filename": dest.name}


@router.delete("/profiles/{name}/assets/{filename}", status_code=204)
async def delete_profile_asset(name: str, filename: str):
    _validate_name(name)
    _validate_filename(filename)

    profile_dir = _profile_dir(name)
    if not profile_dir.exists():
        raise not_found("not_found", f"Profile '{name}' not found")

    target   = _resolve_under_assets(name, filename)
    manifest = load_assets_manifest(name)
    has_file  = target.exists()
    has_entry = filename in manifest["files"]

    if not has_file and not has_entry:
        raise not_found("not_found", f"Asset '{filename}' not found")

    if has_file:
        try:
            target.unlink()
        except FileNotFoundError:
            pass

    if has_entry:
        manifest["files"].pop(filename, None)
        save_assets_manifest(name, manifest)


@router.put("/profiles/{name}/assets/manifest/notes")
async def update_profile_assets_notes(name: str, body: dict = Body(...)):
    _validate_name(name)

    if not isinstance(body, dict) or "notes" not in body:
        raise bad_request("invalid_body", "Body must contain 'notes'")
    notes = body["notes"]
    if not isinstance(notes, str):
        raise bad_request("invalid_notes", "'notes' must be a string")

    profile_dir = _profile_dir(name)
    if not profile_dir.exists():
        raise not_found("not_found", f"Profile '{name}' not found")

    manifest = load_assets_manifest(name)
    manifest["notes"] = notes
    save_assets_manifest(name, manifest)
    return manifest


@router.put("/profiles/{name}/assets/manifest/files/{filename}")
async def update_profile_asset_entry(name: str, filename: str, body: dict = Body(...)):
    _validate_name(name)
    _validate_filename(filename)

    if not isinstance(body, dict):
        raise bad_request("invalid_body", "Body must be an object")

    has_description = "description" in body
    has_tags        = "tags" in body
    if not has_description and not has_tags:
        raise bad_request("invalid_body", "must include description or tags")

    description = body.get("description")
    if has_description and not isinstance(description, str):
        raise bad_request("invalid_description", "'description' must be a string")

    tags = body.get("tags", None)
    if has_tags:
        if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
            raise bad_request("invalid_tags", "'tags' must be a list of strings")

    profile_dir = _profile_dir(name)
    if not profile_dir.exists():
        raise not_found("not_found", f"Profile '{name}' not found")

    target = _resolve_under_assets(name, filename)
    if not target.exists():
        raise not_found("not_found", f"Asset '{filename}' not found")

    manifest = load_assets_manifest(name)
    # Read-then-merge: preserve keys not present in this request body.
    existing = manifest["files"].get(filename, {})
    new_entry = {**existing}
    if has_description:
        new_entry["description"] = description
    if has_tags:
        new_entry["tags"] = tags
    manifest["files"][filename] = new_entry
    save_assets_manifest(name, manifest)
    return new_entry
