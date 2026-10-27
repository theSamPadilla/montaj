"""Tests for steps/render/export_overlay_pages.py and export_carousel_pages.py: their guards and the carousel list.

The pages themselves (the inlined bundle, the player, the copied files, a real browser opening them) are covered by
montaj_assets/render/test/export-pages.test.mjs and carousel-pages.test.mjs.
"""
import importlib.util
import json
import os
import shutil
import struct
import subprocess
import sys
import zipfile
import zlib

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STEPS = os.path.join(ROOT, "steps", "render")


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(STEPS, f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(name, *args):
    return subprocess.run([sys.executable, os.path.join(STEPS, f"{name}.py"), *args], capture_output=True, text=True)


def carousel(tmp_path, slides=2):
    p = tmp_path / "project.json"
    p.write_text(json.dumps({"projectType": "carousel", "settings": {"resolution": [540, 675]},
                             "slides": [{"id": f"s{i + 1}", "base_color": "#fff", "elements": []} for i in range(slides)]}))
    return str(p)


def test_carousel_list_names_the_slides(tmp_path):
    r = run("export_carousel_pages", "--project", carousel(tmp_path), "--list")
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout) == {"items": [{"index": 1, "id": "s1"}, {"index": 2, "id": "s2"}]}


def test_carousel_step_needs_a_carousel_and_a_folder(tmp_path):
    video = tmp_path / "video.json"
    video.write_text(json.dumps({"projectType": "editing", "tracks": []}))
    r = run("export_carousel_pages", "--project", str(video), "--list")
    assert r.returncode != 0 and "not_a_carousel" in r.stderr
    r = run("export_carousel_pages", "--project", carousel(tmp_path))
    assert r.returncode != 0 and "--out" in r.stderr


def test_pages_go_in_a_new_zip_and_nothing_in_out_changes(tmp_path):
    """Both steps write one new .zip inside --out: `overlays.zip` / `slides.zip`, then ` 2.zip`, ` 3.zip`, ..."""
    from lib.common import new_file_in
    assert load("export_overlay_pages").NAME == "overlays" and load("export_carousel_pages").NAME == "slides"
    out = tmp_path / "picked"
    out.mkdir()
    (out / "keep.txt").write_text("mine")
    (out / "slides.zip").write_text("old")
    (out / "slides").mkdir()
    first = new_file_in(str(out), "slides", ".zip")
    assert first == str(out / "slides 2.zip") and os.path.getsize(first) == 0
    assert new_file_in(str(out), "slides", ".zip") == str(out / "slides 3.zip")
    assert (out / "keep.txt").read_text() == "mine" and (out / "slides.zip").read_text() == "old"
    # a link already at the name is taken as existing, never written through
    (tmp_path / "elsewhere.zip").write_text("theirs")
    (out / "overlays.zip").symlink_to(tmp_path / "elsewhere.zip")
    (out / "overlays 2.zip").symlink_to(tmp_path / "gone.zip")  # dangling
    assert new_file_in(str(out), "overlays", ".zip") == str(out / "overlays 3.zip")
    assert (tmp_path / "elsewhere.zip").read_text() == "theirs" and not (tmp_path / "gone.zip").exists()
    # out made when missing (the CLI; serve wants an existing folder outside the workspace)
    assert new_file_in(str(tmp_path / "new" / "deep"), "overlays", ".zip") == str(tmp_path / "new" / "deep" / "overlays.zip")
    (tmp_path / "a-file").write_text("x")
    with pytest.raises(SystemExit):
        new_file_in(str(tmp_path / "a-file"), "slides", ".zip")
    assert (tmp_path / "a-file").read_text() == "x"


def test_zip_folder_keeps_relative_paths_under_one_top_folder(tmp_path):
    """PL89: a user shared the loose folder without its assets/. The zip carries the pages and assets/ together, under
    one top folder, every path relative; names with spaces and U+202F survive; a skipped file is left out."""
    from lib.common import zip_folder
    src = tmp_path / "work"
    (src / "assets").mkdir(parents=True)
    (src / "index.html").write_text("<img src='assets/01-a b.png'>")
    (src / "assets" / "01-Shot 2.32\u202fPM.png").write_bytes(b"\x89PNG fake")
    (src / ".marker").write_text("x")
    dest = tmp_path / "slides 2.zip"
    dest.write_bytes(b"")
    zip_folder(str(src), str(dest), "slides 2", skip={".marker"})
    with zipfile.ZipFile(dest) as z:
        names = sorted(z.namelist())
        assert names == ["slides 2/assets/01-Shot 2.32\u202fPM.png", "slides 2/index.html"]
        assert z.read("slides 2/assets/01-Shot 2.32\u202fPM.png") == b"\x89PNG fake"
        assert all(not n.startswith("/") and ".." not in n for n in names)
        assert z.getinfo("slides 2/assets/01-Shot 2.32\u202fPM.png").flag_bits & 0x800, "UTF-8 name flagged, so U+202F unzips as itself"


def _png(path, rgb=(220, 40, 40)):
    """A tiny synthetic PNG (no user files in fixtures)."""
    w = h = 4
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


NODE_READY = shutil.which("node") and os.path.isdir(os.path.join(ROOT, "montaj_assets", "render", "node_modules", "puppeteer"))


@pytest.mark.skipif(not NODE_READY, reason="needs node and the render engine's node_modules")
def test_carousel_step_writes_one_zip_with_its_images(tmp_path):
    """End to end: a slide image named like a macOS screenshot (spaces, U+202F) lands in the zip's assets/, the page
    names it relatively, and nothing but the zip is written into --out."""
    proj = tmp_path / "proj"
    proj.mkdir()
    shot = proj / "Screenshot 2026-10-24 at 2.32.11\u202fPM.png"
    _png(shot)
    p = proj / "project.json"
    p.write_text(json.dumps({"projectType": "carousel", "settings": {"resolution": [540, 675]}, "slides": [
        {"id": "s1", "base_color": "#fff", "elements": [{"id": "i", "type": "image", "src": str(shot), "x": 0, "y": 0, "w": 100, "h": 100}]},
        {"id": "s2", "base_color": "#000", "elements": []}]}))
    out = tmp_path / "picked"
    out.mkdir()
    r = run("export_carousel_pages", "--project", str(p), "--out", str(out))
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout)
    assert res["zip"] == str(out / "slides.zip") and os.listdir(out) == ["slides.zip"]
    assert res["warnings"] == [] and res["pages"] == ["slide-01.html", "slide-02.html"] and res["index"] == "index.html"
    with zipfile.ZipFile(res["zip"]) as z:
        names = set(z.namelist())
        assert {f"slides/{f}" for f in res["files"]} == names
        asset = next(n for n in names if n.startswith("slides/assets/"))
        assert asset.endswith("\u202fPM.png") and z.read(asset) == shot.read_bytes()
        page = z.read("slides/slide-01.html").decode()
        assert asset[len("slides/"):] in page and "file://" not in page


@pytest.mark.skipif(not NODE_READY, reason="needs node and the render engine's node_modules")
def test_overlay_step_writes_one_zip_without_its_marker(tmp_path):
    proj = tmp_path / "proj"
    shutil.copytree(os.path.join(ROOT, "montaj_assets", "render", "test", "fixtures", "export-pages"), proj)
    pic = proj / "Logo 2.32\u202fPM.png"
    _png(pic, (40, 40, 220))
    p = proj / "project.json"
    p.write_text(json.dumps({"version": "1", "id": "p", "name": "p", "settings": {"fps": 30, "resolution": [540, 960]},
                             "tracks": [{"id": "trk-0", "items": [{"id": "ov1", "type": "overlay", "src": "overlays/Box.jsx",
                                                                    "start": 0, "end": 2, "props": {"label": "Hi", "logo": str(pic)}}]}]}))
    out = tmp_path / "picked"
    out.mkdir()
    r = run("export_overlay_pages", "--project", str(p), "--out", str(out))
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout)
    assert res["zip"] == str(out / "overlays.zip") and os.listdir(out) == ["overlays.zip"] and res["warnings"] == []
    with zipfile.ZipFile(res["zip"]) as z:
        names = set(z.namelist())
        assert {f"overlays/{f}" for f in res["files"]} == names
        assert not any(".montaj-overlay-pages" in n for n in names)
        asset = next(n for n in names if n.startswith("overlays/assets/"))
        assert z.read(asset) == pic.read_bytes()


def test_commands_carry_the_choices():
    cm = load("export_carousel_pages")
    cmd = cm.build_command("node", "/p/project.json", "/o", "/t", "2,3")
    assert cmd[1].endswith("render-carousel.js")
    assert "--html-dir" in cmd and "--html-only" in cmd and cmd[cmd.index("--only") + 1] == "2,3"
    assert "--only" not in cm.build_command("node", "/p/project.json", "/o", "/t", None)
    om = load("export_overlay_pages")
    assert om.build_command("node", "/p/project.json", None, None, True)[-1] == "--list"
    cmd = om.build_command("node", "/p/project.json", "/o", "a,b", False)
    assert cmd[cmd.index("--out") + 1] == "/o" and cmd[cmd.index("--items") + 1] == "a,b"
