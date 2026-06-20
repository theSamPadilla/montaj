"""Unit tests for project/carousel_normalize.py — webp→png normalization for the
carousel render path."""
import json
from pathlib import Path

from PIL import Image

from project.carousel_normalize import normalize_carousel_assets


def _project(slides, project_type="carousel"):
    return {
        "id": "p1",
        "projectType": project_type,
        "status": "final",
        "settings": {"resolution": [1080, 1350]},
        "carousel": {"aspect": "portrait"},
        "slides": slides,
    }


def _image_el(src):
    return {"id": f"el-{src}", "type": "image", "src": src,
            "crop": {"x": 0, "y": 0, "w": 1, "h": 1},
            "x": 0, "y": 0, "w": 1080, "h": 1350, "rotation": 0}


def _write(project_dir: Path, name: str, fmt: str):
    assets = project_dir / "assets"
    assets.mkdir(exist_ok=True)
    img = Image.new("RGB", (64, 48), (10, 60, 120))
    img.save(assets / name, fmt)


def _setup(tmp_path: Path, project: dict) -> Path:
    pj = tmp_path / "project.json"
    pj.write_text(json.dumps(project))
    return pj


def test_webp_bed_transcoded_and_src_rewritten(tmp_path):
    _write(tmp_path, "bed.webp", "WEBP")
    _write(tmp_path, "logo.jpg", "JPEG")
    project = _project([
        {"id": "s1", "base_color": "#000", "elements": [_image_el("assets/bed.webp")]},
        {"id": "s2", "base_color": "#000", "elements": [_image_el("assets/logo.jpg")]},
    ])
    pj = _setup(tmp_path, project)

    out = normalize_carousel_assets(pj)

    # A normalized temp copy is returned, NOT the original path.
    assert out != pj
    assert out.parent == pj.parent  # same dir so relative asset paths resolve

    # The sibling .png was produced.
    assert (tmp_path / "assets" / "bed.png").is_file()

    # The normalized json points the webp bed at the png; the jpg is untouched.
    norm = json.loads(out.read_text())
    srcs = [el["src"] for s in norm["slides"] for el in s["elements"]]
    assert "assets/bed.png" in srcs
    assert "assets/logo.jpg" in srcs
    assert "assets/bed.webp" not in srcs

    # The canonical project.json on disk is UNCHANGED.
    canonical = json.loads(pj.read_text())
    canon_srcs = [el["src"] for s in canonical["slides"] for el in s["elements"]]
    assert "assets/bed.webp" in canon_srcs


def test_no_webp_returns_original_path_unchanged(tmp_path):
    _write(tmp_path, "logo.jpg", "JPEG")
    project = _project([
        {"id": "s1", "base_color": "#000", "elements": [_image_el("assets/logo.jpg")]},
    ])
    pj = _setup(tmp_path, project)

    out = normalize_carousel_assets(pj)
    assert out == pj  # nothing to do → caller skips temp-file cleanup


def test_non_carousel_is_passthrough(tmp_path):
    _write(tmp_path, "bed.webp", "WEBP")
    project = _project([
        {"id": "s1", "base_color": "#000", "elements": [_image_el("assets/bed.webp")]},
    ], project_type="video")
    pj = _setup(tmp_path, project)

    out = normalize_carousel_assets(pj)
    assert out == pj
    # No transcode happens for a non-carousel project.
    assert not (tmp_path / "assets" / "bed.png").exists()


def test_repeated_webp_src_transcoded_once(tmp_path):
    _write(tmp_path, "bed.webp", "WEBP")
    project = _project([
        {"id": "s1", "base_color": "#000", "elements": [_image_el("assets/bed.webp")]},
        {"id": "s2", "base_color": "#000", "elements": [_image_el("assets/bed.webp")]},
    ])
    pj = _setup(tmp_path, project)

    out = normalize_carousel_assets(pj)
    norm = json.loads(out.read_text())
    srcs = [el["src"] for s in norm["slides"] for el in s["elements"]]
    assert srcs == ["assets/bed.png", "assets/bed.png"]
