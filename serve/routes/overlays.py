"""Overlay listing + group-creation endpoints.

Owns both /overlays* and /profiles/{name}/overlays* — the second pair is
overlay-scoped (not profile-scoped) so they share scan_overlays.
"""
import json
from pathlib import Path

from fastapi import APIRouter, Body

from serve.common import bad_request

router = APIRouter(prefix="/api")


def scan_overlays(overlays_dir: Path) -> list[dict]:
    """Scan an overlays directory for overlay entries.

    Supports a flat layout and one level of grouping:
      {overlays_dir}/{name}/{name}.jsx          — ungrouped
      {overlays_dir}/{group}/{name}/{name}.jsx  — grouped

    Each overlay dir must contain {name}.jsx; {name}.json is optional."""
    results = []
    if not overlays_dir.exists():
        return results

    def _entry(subdir: Path, group: str | None) -> dict:
        jsx_path  = subdir / f"{subdir.name}.jsx"
        schema: dict = {}
        json_path = subdir / f"{subdir.name}.json"
        if json_path.exists():
            try:
                schema = json.loads(json_path.read_text())
            except Exception:
                pass
        entry = {
            "name":        subdir.name,
            "description": schema.get("description", ""),
            "props":       schema.get("props", []),
            "jsxPath":     str(jsx_path),
        }
        if group:
            entry["group"] = group
        return entry

    for subdir in sorted(overlays_dir.iterdir()):
        if not subdir.is_dir():
            continue
        if (subdir / f"{subdir.name}.jsx").exists():
            results.append(_entry(subdir, group=None))
        else:
            children = sorted(subdir.iterdir())
            overlay_children = [c for c in children if c.is_dir() and (c / f"{c.name}.jsx").exists()]
            if overlay_children:
                for child in overlay_children:
                    results.append(_entry(child, group=subdir.name))
            else:
                results.append({"group": subdir.name, "empty": True})

    return results


@router.get("/overlays")
async def list_overlays():
    """List all overlays from the global overlay library (~/.montaj/overlays/)."""
    return scan_overlays(Path.home() / ".montaj" / "overlays")


@router.post("/overlays/groups", status_code=201)
async def create_overlay_group(body: dict = Body(...)):
    """Create a new group folder inside ~/.montaj/overlays/."""
    name = str(body.get("name", "")).strip()
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise bad_request("invalid_name", "Invalid group name")
    group_dir = Path.home() / ".montaj" / "overlays" / name
    group_dir.mkdir(parents=True, exist_ok=True)
    return {"name": name}


@router.get("/profiles/{name}/overlays")
async def list_profile_overlays(name: str):
    """List overlays from a profile's overlay library (~/.montaj/profiles/{name}/overlays/)."""
    overlays_dir = Path.home() / ".montaj" / "profiles" / name / "overlays"
    return scan_overlays(overlays_dir)


@router.post("/profiles/{name}/overlays/groups", status_code=201)
async def create_profile_overlay_group(name: str, body: dict = Body(...)):
    """Create a new group folder inside ~/.montaj/profiles/{name}/overlays/."""
    group = str(body.get("name", "")).strip()
    if not group or "/" in group or "\\" in group or group.startswith("."):
        raise bad_request("invalid_name", "Invalid group name")
    group_dir = Path.home() / ".montaj" / "profiles" / name / "overlays" / group
    group_dir.mkdir(parents=True, exist_ok=True)
    return {"name": group}
