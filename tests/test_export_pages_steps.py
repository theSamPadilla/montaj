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


def test_carousel_out_folder_is_replaced_only_when_empty_or_ours(tmp_path):
    mod = load("export_carousel_pages")
    other = tmp_path / "other"
    other.mkdir()
    (other / "keep.txt").write_text("mine")
    with pytest.raises(SystemExit):
        mod.check_out(str(other))
    assert (other / "keep.txt").read_text() == "mine"
    ours = tmp_path / "ours"
    ours.mkdir()
    (ours / mod.MARKER).write_text("x")
    (ours / "slide-01.html").write_text("old")
    mod.check_out(str(ours))          # ours: allowed
    mod.check_out(str(tmp_path / "new"))  # new: allowed
    empty = tmp_path / "empty"
    empty.mkdir()
    mod.check_out(str(empty))         # empty: allowed


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
