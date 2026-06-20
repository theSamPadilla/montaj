"""Pre-render asset normalization for carousel projects.

The sidecar's headless Chromium cannot decode ``.webp`` ``<img>`` beds (desktop
Chrome-for-Testing can), so a carousel slide whose image element points at a
``.webp`` asset throws during render. Rather than depend on the browser's codec
support, we transcode any ``.webp`` image-element bed to a sibling ``.png`` with
Pillow and hand the renderer a *normalized copy* of ``project.json`` whose ``src``
values point at the ``.png``.

The canonical ``project.json`` and the agent's saved ``src`` values are never
mutated — only a throwaway normalized file (written into the same directory so
relative ``assets/…`` paths still resolve) is produced. When there is nothing to
normalize the original path is returned unchanged, so callers can cheaply compare
the returned path against the input to decide whether a temp file needs cleanup.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

try:  # Pillow is a hard project dependency; guard only so a stray import can't crash a non-render path.
    from PIL import Image
except Exception:  # pragma: no cover - Pillow always present in the montaj env
    Image = None

_WEBP_SUFFIX = ".webp"


def _image_elements(project: dict):
    for slide in project.get("slides", []) or []:
        for element in slide.get("elements", []) or []:
            if element.get("type") == "image" and isinstance(element.get("src"), str):
                yield element


def normalize_carousel_assets(project_path) -> Path:
    """Return a ``project.json`` path safe to hand the carousel renderer.

    For a carousel project containing ``.webp`` image beds, transcode each to a
    sibling ``.png`` and write a normalized ``project.json`` (in the same
    directory, so relative asset paths still resolve) with those ``src`` values
    rewritten; return the normalized file's path. The original file is returned
    unchanged when there is nothing to normalize (non-carousel, no ``.webp`` beds,
    or unreadable JSON — the renderer surfaces bad JSON itself).
    """
    project_path = Path(project_path)
    try:
        project = json.loads(project_path.read_text())
    except Exception:
        return project_path

    if project.get("projectType") != "carousel":
        return project_path

    project_dir = project_path.parent
    rewrites: dict[str, str] = {}  # original .webp src -> produced .png src
    changed = False

    for element in _image_elements(project):
        src = element["src"]
        if not src.lower().endswith(_WEBP_SUFFIX):
            continue

        if src in rewrites:
            element["src"] = rewrites[src]
            changed = True
            continue

        png_src = src[: -len(_WEBP_SUFFIX)] + ".png"
        webp_file = project_dir / src
        png_file = project_dir / png_src

        produced = png_file.is_file()
        if not produced and Image is not None and webp_file.is_file():
            try:
                with Image.open(webp_file) as im:
                    im.save(png_file, "PNG")
                produced = png_file.is_file()
            except Exception:
                # Transcode failed: leave the .webp src in place. The renderer's
                # per-slide resilience records the failure rather than aborting.
                produced = False

        if produced:
            rewrites[src] = png_src
            element["src"] = png_src
            changed = True

    if not changed:
        return project_path

    # Normalized copy lives alongside the original so relative `assets/…` srcs and
    # the renderer's default `<dir>/render` output location are unchanged.
    fd, tmp_name = tempfile.mkstemp(prefix=".render-input-", suffix=".json", dir=str(project_dir))
    with os.fdopen(fd, "w") as f:
        json.dump(project, f)
    return Path(tmp_name)
