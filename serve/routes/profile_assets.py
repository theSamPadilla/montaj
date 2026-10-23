"""Per-profile asset library endpoints — /profiles/{name}/assets*.

Each profile has an independent asset library at ~/.montaj/profiles/{name}/assets/
with a manifest.json describing summary + per-file metadata. Drift between disk
and manifest is reported (not auto-healed) so the user stays in control.

Pure manifest I/O (load/save) lives in lib/profile_assets.py so non-HTTP
consumers (e.g. project/init.py snapshotting the manifest at intake) can
reuse it without depending on the serve layer.
"""
import mimetypes
import os
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, UploadFile

from lib.profile_assets import (
    FILENAME_RE,
    MAX_ASSET_BYTES,
    NAME_RE,
    load_assets_manifest,
    save_assets_manifest,
)
from lib.disk_space import is_disk_full, remove_partial
from serve import disk_full
from serve.common import bad_request, forbidden, not_found

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _validate_name(name: str) -> None:
    if not NAME_RE.match(name or ""):
        raise bad_request("invalid_name", "Invalid profile name")


def _validate_filename(filename: str) -> None:
    if not FILENAME_RE.match(filename or ""):
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
    FILENAME_RE.
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
            "manifest": {"summary": "", "files": {}},
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

    # The name is reserved by creating the file new (`xb`, O_EXCL: never an
    # existing entry, a dangling symlink included, never through a link), with
    # the _1, _2 suffixes on a collision, so two uploads of one name at once
    # never share a file and a failed upload removes only its own (§541).
    stem, suffix = Path(base).stem, Path(base).suffix
    # Traversal check on the name (defense in depth past FILENAME_RE): it must
    # name an entry directly in assets/. A link already there is a taken name
    # (the exclusive create below skips it), never followed.
    try:
        if (assets_dir / base).parent.resolve() != assets_dir.resolve() or base in ("", ".", ".."):
            raise ValueError(base)
    except (ValueError, OSError):
        raise forbidden("traversal", "Path escapes assets dir")
    dest, counter = assets_dir / base, 1
    while True:
        try:
            fh = open(dest, "xb")
            break
        except FileExistsError:
            dest = assets_dir / _numbered(stem, suffix, counter)
            counter += 1

    try:
        return await _write_upload(file, fh, dest)
    except BaseException:
        # Any failure (a full disk, the size cap, an error, a cancel): the file
        # this upload created is removed, and only it.
        try:
            fh.close()
        except OSError:
            pass                          # a close that fails too must not keep the half file
        remove_partial(dest)
        raise


# The longest file name most filesystems take, in bytes.
_NAME_MAX = 255


def _numbered(stem: str, suffix: str, n: int) -> str:
    """`<stem>_<n><suffix>`, the stem cut so the name still fits _NAME_MAX."""
    tag = f"_{n}{suffix}"
    room = _NAME_MAX - len(tag.encode())
    cut = stem.encode()[:max(1, room)].decode("utf-8", "ignore")
    return f"{cut}{tag}"


async def _write_upload(file, fh, dest: Path) -> dict:
    """The body into `fh` (the new file at `dest`); the caller removes it on any failure."""
    written = 0
    while True:
        chunk = await file.read(1024 * 1024)  # 1 MB chunks
        if not chunk:
            break
        written += len(chunk)
        if written > MAX_ASSET_BYTES:
            raise HTTPException(413, detail={
                "error":   "payload_too_large",
                "message": f"File exceeds {MAX_ASSET_BYTES} bytes",
            })
        try:
            fh.write(chunk)
        except OSError as e:
            if is_disk_full(e):
                raise disk_full.http_error(e) from e   # §541
            raise
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


@router.put("/profiles/{name}/assets/manifest/summary")
async def update_profile_assets_summary(name: str, body: dict = Body(...)):
    _validate_name(name)

    if not isinstance(body, dict) or "summary" not in body:
        raise bad_request("invalid_body", "Body must contain 'summary'")
    summary = body["summary"]
    if not isinstance(summary, str):
        raise bad_request("invalid_summary", "'summary' must be a string")

    profile_dir = _profile_dir(name)
    if not profile_dir.exists():
        raise not_found("not_found", f"Profile '{name}' not found")

    manifest = load_assets_manifest(name)
    manifest["summary"] = summary
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
