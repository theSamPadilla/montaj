"""Tests for steps/render/export_overlay_pages.py and export_carousel_pages.py: their guards and the carousel list.

The pages themselves (the inlined bundle, the player, the copied files, a real browser opening them) are covered by
montaj_assets/render/test/export-pages.test.mjs and carousel-pages.test.mjs.
"""
import importlib.util
import json
import os
import subprocess
import sys

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


def test_pages_go_in_a_new_folder_and_nothing_in_out_changes(tmp_path):
    """Both steps write only into a folder they make inside --out: `overlays` / `slides`, then ` 2`, ` 3`, ..."""
    from lib.common import new_folder_in
    assert load("export_overlay_pages").FOLDER == "overlays" and load("export_carousel_pages").FOLDER == "slides"
    out = tmp_path / "picked"
    out.mkdir()
    (out / "keep.txt").write_text("mine")
    (out / "slides").mkdir()
    (out / "slides" / "slide-01.html").write_text("old")
    first = new_folder_in(str(out), "slides")
    assert first == str(out / "slides 2") and os.listdir(first) == []
    assert new_folder_in(str(out), "slides") == str(out / "slides 3")
    assert (out / "keep.txt").read_text() == "mine" and (out / "slides" / "slide-01.html").read_text() == "old"
    # a link already at the name is taken as existing, never written through
    (tmp_path / "elsewhere").mkdir()
    (out / "overlays").symlink_to(tmp_path / "elsewhere", target_is_directory=True)
    assert new_folder_in(str(out), "overlays") == str(out / "overlays 2")
    assert os.listdir(tmp_path / "elsewhere") == []
    # out made when missing (the CLI; serve wants an existing folder outside the workspace)
    assert new_folder_in(str(tmp_path / "new" / "deep"), "overlays") == str(tmp_path / "new" / "deep" / "overlays")
    (tmp_path / "a-file").write_text("x")
    with pytest.raises(SystemExit):
        new_folder_in(str(tmp_path / "a-file"), "slides")
    assert (tmp_path / "a-file").read_text() == "x"


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
