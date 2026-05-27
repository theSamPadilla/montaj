"""Regression test for carousel image objectFit divergence.

Ensures the un-cropped image branch in slide.jsx uses 'contain' (not 'cover').

The fixture slide has:
  - Canvas: 1080×1080 lime-green (#00ff00) background
  - One image element: 600×900 box at x=240, y=90
  - Source image: 2000×600 wide strip (red left half, blue right half)

Under 'contain': the wide strip is letterboxed inside the 600×900 box.
The strip height is 600 * (600/2000) = 180px tall, centred vertically in the
900-tall box.  The strip sits at y = 90 + (900-180)/2 = 450px from the canvas
top.  So pixels inside the element box but near the top (e.g. y=95, x=540)
must be lime-green — NOT red or blue.

Under 'cover': the renderer scales the 2000×600 image to fill the 600×900 box
height, producing a 3000×900 source fill where only the centre 600px is
visible.  The top of the element box (y=95) would then be covered by image
content (either red or blue), NOT lime-green.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

REPO_ROOT    = Path(__file__).parent.parent
FIXTURE_DIR  = REPO_ROOT / "tests" / "fixtures" / "carousel-objectfit"
RENDER_SCRIPT = REPO_ROOT / "montaj_assets" / "render" / "render-carousel.js"

# Slide element box (from project.json)
ELEM_X = 240
ELEM_Y = 90
ELEM_W = 600
ELEM_H = 900

# Slide background (lime green)
LIME_GREEN = (0, 255, 0)

# Tolerance for PNG color comparison (allow minor Puppeteer anti-aliasing)
COLOR_TOLERANCE = 20


def _color_near(actual: tuple, expected: tuple, tol: int = COLOR_TOLERANCE) -> bool:
    return all(abs(a - e) <= tol for a, e in zip(actual, expected))


@pytest.mark.skipif(
    not shutil.which("node"),
    reason="node not available",
)
def test_uncropped_image_is_letterboxed(tmp_path):
    """Un-cropped image element must be letterboxed (objectFit: contain), not cropped
    (objectFit: cover).  Sampled pixel above the image strip must be the slide
    background color (lime green), not image content (red or blue)."""

    node_bin = shutil.which("node")
    assert node_bin, "node binary required"

    result = subprocess.run(
        [node_bin, str(RENDER_SCRIPT),
         "--project-json", str(FIXTURE_DIR / "project.json"),
         "--out", str(tmp_path)],
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert result.returncode == 0, (
        f"render-carousel.js failed (rc={result.returncode}).\n"
        f"stdout: {result.stdout}\n"
        f"stderr: {result.stderr}"
    )

    slide_png = tmp_path / "slide_01.png"
    assert slide_png.exists(), f"Expected {slide_png} but it was not created"

    img = Image.open(slide_png).convert("RGB")
    w, h = img.size

    # The slide should be 1080×1080 (scale=1 default)
    assert w == 1080 and h == 1080, f"Expected 1080×1080 slide, got {w}×{h}"

    # Sample point: horizontally centred in the element box, near the top of the box.
    # Under 'contain' the image strip does NOT reach this high in the element box,
    # so the pixel must be the slide base_color (lime green).
    # Under 'cover' the image fills the box from top to bottom, so this pixel
    # would be red or blue.
    sample_x = ELEM_X + ELEM_W // 2   # 540  — horizontal centre of element
    sample_y = ELEM_Y + 5             # 95   — just inside the top of the element box

    pixel = img.getpixel((sample_x, sample_y))
    # Keep only RGB (drop alpha channel if present)
    pixel_rgb = pixel[:3]

    assert _color_near(pixel_rgb, LIME_GREEN), (
        f"Pixel at ({sample_x}, {sample_y}) is {pixel_rgb}, expected lime-green "
        f"{LIME_GREEN} (±{COLOR_TOLERANCE}).\n"
        "This means 'cover' is still active — image content bleeds to the top of the "
        "element box instead of being letterboxed inside it."
    )
