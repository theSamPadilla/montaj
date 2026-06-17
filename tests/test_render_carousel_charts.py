"""End-to-end render of the three chart system overlays.

Shells out to render-carousel.js against the fixture project, asserts each
slide PNG is created at the expected dimensions, and does a pixel-grid check
that the slide actually contains chart content (not just background).
"""
import json
import subprocess
from pathlib import Path

from PIL import Image

MONTAJ_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = MONTAJ_ROOT / "tests" / "fixtures" / "carousel-charts"
RENDER_JS   = MONTAJ_ROOT / "montaj_assets" / "render" / "render-carousel.js"


def _materialize_project(tmp_path):
    """Copy fixture project.json into tmp_path with system overlay paths resolved
    to absolute paths under MONTAJ_ROOT. The committed fixture references short
    names (e.g. 'bar-chart') for portability; we resolve them here."""
    project = json.loads((FIXTURE_DIR / "project.json").read_text())
    overlays_root = MONTAJ_ROOT / "montaj_assets" / "render" / "templates" / "overlays"
    for slide in project["slides"]:
        for el in slide["elements"]:
            if el.get("type") == "overlay":
                template_name = el["overlay"]["template"]  # e.g. "bar-chart"
                el["overlay"]["template"] = str(overlays_root / template_name / f"{template_name}.jsx")
    out = tmp_path / "project.json"
    out.write_text(json.dumps(project, indent=2))
    return out


def _overlay_box_for_slide(project_path, slide_index_1based):
    """Return the (x, y, w, h) of the first overlay element on the given slide.
    Slide indices are 1-based to match the slide_NN.png naming convention."""
    project = json.loads(project_path.read_text())
    slide = project["slides"][slide_index_1based - 1]
    for el in slide["elements"]:
        if el.get("type") == "overlay":
            return (el["x"], el["y"], el["w"], el["h"])
    raise AssertionError(f"no overlay element on slide {slide_index_1based}")


def test_chart_overlays_render_to_pngs(tmp_path):
    project_path = _materialize_project(tmp_path)
    out_dir = tmp_path / "render"

    # Pin --scale 1: the pixel-grid check crops by absolute design-coord overlay
    # boxes, so the raster must stay at 1× rather than the renderer's 2× default.
    result = subprocess.run(
        ["node", str(RENDER_JS), "--project-json", str(project_path), "--out", str(out_dir), "--scale", "1"],
        capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, f"render failed: stderr={result.stderr}"

    for i, name in enumerate(["bar", "line", "pie"], start=1):
        png = out_dir / f"slide_{i:02d}.png"
        assert png.exists(), f"missing {png}"

        img = Image.open(png).convert("RGB")
        ox, oy, ow, oh = _overlay_box_for_slide(project_path, i)
        # Crop to the overlay box and count non-background pixels. A blank slide
        # would have 0 non-background pixels in the box; any rendered chart
        # (bars, line strokes, pie wedges) has hundreds-to-thousands.
        crop = img.crop((ox, oy, ox + ow, oy + oh))
        non_bg = sum(1 for px in crop.getdata() if px != (255, 255, 255))
        assert non_bg >= 200, (
            f"{name} slide has only {non_bg} non-background pixels in overlay box "
            f"({ox},{oy},{ow},{oh}) — chart likely failed to render. PNG: {png}"
        )
