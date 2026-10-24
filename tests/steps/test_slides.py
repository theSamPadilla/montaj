"""slides (§558): a carousel's headlines, one slide's edit and a new order, in one call, through the guarded write.

A 5-image portrait (4:5) carousel, its own git repository. The measurer is faked except in the last test, which
measures a real headline through sample_overlay.
"""
import json
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))

from lib import slide_text  # noqa: E402
import steps.edit.slides as sl  # noqa: E402
import steps.render.look as look  # noqa: E402
import validate as v  # noqa: E402

RUNTIME = str(REPO_ROOT / "montaj_assets" / "render")   # a dev checkout's render runtime (cli.deps.render_runtime_dir)
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@local"]


def git(d, *args):
    return subprocess.run([*GIT, *args], cwd=d, capture_output=True, text=True, check=True).stdout


def make_carousel(tmp_path, n=5, repo=True):
    d = tmp_path / "carousel"
    (d / "assets").mkdir(parents=True)
    slides = []
    for i in range(n):
        (d / "assets" / f"img{i}.png").write_bytes(b"png")
        slides.append({"id": str(uuid.uuid4()), "base_color": "#ffffff", "elements": [
            {"id": str(uuid.uuid4()), "type": "image", "src": f"assets/img{i}.png", "x": 0, "y": 0, "w": 1080, "h": 1350,
             "rotation": 0, "crop": {"x": 0.1, "y": 0, "w": 0.8, "h": 1}}]})
    project = {"version": "0.2", "id": "car-1", "name": "Carousel", "status": "draft", "workflow": "carousel",
               "editingPrompt": "t", "projectType": "carousel", "carousel": {"aspect": "portrait"},
               "settings": {"resolution": [1080, 1350]}, "slides": slides,
               "notes": [{"id": "note-1", "slideId": slides[1]["id"], "x": 0.4, "y": 0.25, "text": "logo too small"},
                         {"id": "note-2", "slideId": slides[3]["id"], "text": "too much text"}]}
    (d / "project.json").write_text(json.dumps(project, indent=2))
    if repo:
        git(d, "init", "-q")
        git(d, "add", "project.json")
        git(d, "commit", "-q", "-m", "init")
    return d


def proj(d):
    return json.loads((d / "project.json").read_text())


def fake_measure(spill_ids=()):
    calls = []

    def fn(item, path, frame, duration, fps, width, height, out):
        calls.append({"id": item["id"], "path": path, "w": width, "h": height, "props": item["props"]})
        spills = item["id"] in spill_ids
        return {"texts": [{"text": item["props"]["text"][:20], "bbox": {"x": 10, "y": 10, "w": width - 20, "h": 80}, "spills": spills}]}, None
    fn.calls = calls
    return fn


def run(d, **kw):
    kw.setdefault("measure_fn", fake_measure())
    kw.setdefault("runtime_dir", RUNTIME)
    return sl.run(str(d / "project.json"), **kw)


def refused(capsys, fn, *a, **k):
    with pytest.raises(SystemExit):
        fn(*a, **k)
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


def headline(slide):
    return next((el for el in slide["elements"] if slide_text._is_headline(el)), None)


HEADS = ["Cut every pause", "Keep the best take", "Captions in one click", "Export for every app", "Try it today"]


# ── headlines ─────────────────────────────────────────────────────────────────────────────────────────────────────

def test_headlines_build_on_a_5_image_carousel_as_the_editors_own_text_element(tmp_path):
    d = make_carousel(tmp_path)
    m = fake_measure()
    out = run(d, headlines=json.dumps(HEADS), measure_fn=m)
    assert out == {"changed": [1, 2, 3, 4, 5], "headlines": {"added": 5}}
    for s, text in zip(proj(d)["slides"], HEADS):
        el = s["elements"][-1]
        assert slide_text._is_headline(el) and s["elements"][0]["type"] == "image", "on top of the image"
        assert el["type"] == "overlay" and el["frame"] == 0 and el["rotation"] == 0
        assert uuid.UUID(el["id"]) and el["overlay"]["template"] == str(Path(RUNTIME) / "templates" / "overlays" / "static-text" / "static-text.jsx")
        props = el["overlay"]["props"]
        assert props["text"] == text and props["fit"] == "true" and props["color"] == "#ffffff"
        assert all(isinstance(v_, str) for v_ in props.values()), "every prop a string, as the text panel writes them"
        assert set(slide_text.template_defaults(RUNTIME)) <= set(props), "the template's own props, editable"
        assert (el["x"], el["y"], el["w"], el["h"]) == (round(1080 * 0.08), round(1350 * 0.07), round(1080 * 0.84), round(1350 * 0.30)), \
            "the project's 4:5 resolution"
    assert len(m.calls) == 5 and all((c["w"], c["h"]) == (907, 405) for c in m.calls), "measured at the box's size"
    assert v.validate_project(str(d / "project.json"))["valid"] is True


def test_the_template_path_is_byte_for_byte_what_serve_lists_for_the_editor(tmp_path):
    from serve.routes.overlays import scan_overlays
    listed = [o["jsxPath"] for o in scan_overlays(Path(RUNTIME) / "templates" / "overlays") if "static-text" in o["jsxPath"]]
    assert listed == [slide_text.template_path(RUNTIME)]


def test_a_rerun_replaces_the_headline_and_never_a_persons_own_text(tmp_path):
    d = make_carousel(tmp_path)
    run(d, headlines=json.dumps(HEADS))
    p = proj(d)
    own = {"id": str(uuid.uuid4()), "type": "overlay", "overlay": {"template": slide_text.template_path(RUNTIME), "props": {"text": "my own"}},
           "frame": 0, "x": 10, "y": 900, "w": 500, "h": 200, "rotation": 0}
    p["slides"][0]["elements"].append(own)
    first_id = headline(p["slides"][0])["id"]
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, headlines=json.dumps(["A new hook"]))
    s0 = proj(d)["slides"][0]
    assert out["headlines"] == {"replaced": 1} and headline(s0)["id"] == first_id and headline(s0)["overlay"]["props"]["text"] == "A new hook"
    assert own in s0["elements"] and len(s0["elements"]) == 3


def test_null_skips_a_slide_and_long_copy_gets_the_tables_smaller_size(tmp_path):
    d = make_carousel(tmp_path)
    long = "A long headline that runs well past forty characters and then some more words"
    out = run(d, headlines=json.dumps([None, long]))
    p = proj(d)
    assert out["changed"] == [2] and headline(p["slides"][0]) is None
    props = headline(p["slides"][1])["overlay"]["props"]
    assert (props["fontSize"], props["minFontSize"]) == ("50", "44")


# ── edit ──────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_an_edit_changes_only_that_slide_and_leaves_the_notes(tmp_path):
    d = make_carousel(tmp_path)
    run(d, headlines=json.dumps(HEADS))
    before = proj(d)
    out = run(d, edit=json.dumps({"slide": 3, "headline": "Shorter", "color": "red", "position": "bottom", "size": "smaller"}))
    after = proj(d)
    assert out == {"changed": [3], "version": True}, "the first call's write was in no version yet"
    for i in (0, 1, 3, 4):
        assert after["slides"][i] == before["slides"][i], f"slide {i + 1} untouched"
    el = headline(after["slides"][2])
    assert el["overlay"]["props"]["text"] == "Shorter" and el["overlay"]["props"]["color"] == "red"
    assert el["y"] == round(1350 * 0.63) and el["overlay"]["props"]["fontSize"] == str(round(72 * 0.8))
    assert after["notes"] == before["notes"] and after["status"] == "draft"


def test_an_edit_by_slide_id_and_one_adding_a_headline(tmp_path):
    d = make_carousel(tmp_path)
    sid = proj(d)["slides"][4]["id"]
    out = run(d, edit=json.dumps({"slide": sid, "headline": "Last word", "style": "label"}))
    el = headline(proj(d)["slides"][4])
    assert out["changed"] == [5] and el["overlay"]["props"]["bgColor"] == "#ffffff"


@pytest.mark.parametrize("edit,err", [
    ({"slide": 9, "color": "red"}, "invalid_params"),
    ({"slide": 2}, "invalid_params"),
    ({"slide": 2, "color": "not-a-colour"}, "invalid_params"),
    ({"slide": 2, "size": "huge"}, "invalid_params"),
    ({"slide": 2, "colour": "red"}, "invalid_params"),
    ({"slide": 2, "color": "red"}, "invalid_params"),   # no headline yet, and none given
])
def test_bad_edits_are_refused_and_nothing_is_written(tmp_path, capsys, edit, err):
    d = make_carousel(tmp_path)
    before = (d / "project.json").read_bytes()
    assert refused(capsys, run, d, edit=json.dumps(edit))["error"] == err
    assert (d / "project.json").read_bytes() == before


# ── order ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_an_order_swap_moves_whole_slides_and_the_notes_go_with_them(tmp_path):
    d = make_carousel(tmp_path)
    run(d, headlines=json.dumps(HEADS))
    before = proj(d)
    out = run(d, order="[1, 4, 3, 2, 5]")
    after = proj(d)
    assert out == {"changed": [], "order": True, "version": True}
    assert [s["id"] for s in after["slides"]] == [before["slides"][k]["id"] for k in (0, 3, 2, 1, 4)]
    assert after["slides"][1] == before["slides"][3] and after["slides"][3] == before["slides"][1], "whole slides moved"
    # notes and pins anchor to slideId: unchanged, so they travel with their slides
    assert after["notes"] == before["notes"]
    by_id = {s["id"]: k for k, s in enumerate(after["slides"])}
    assert by_id[after["notes"][0]["slideId"]] == 3 and by_id[after["notes"][1]["slideId"]] == 1


def test_one_call_may_combine_headlines_an_edit_and_an_order(tmp_path):
    d = make_carousel(tmp_path)
    out = run(d, headlines=json.dumps(HEADS), edit='{"slide": 2, "color": "#00ffff"}', order="[2, 1, 3, 4, 5]")
    p = proj(d)
    assert headline(p["slides"][0])["overlay"]["props"]["text"] == "Keep the best take"
    assert headline(p["slides"][0])["overlay"]["props"]["color"] == "#00ffff"
    assert out["order"] is True and sorted(out["changed"]) == [1, 2, 3, 4, 5]


@pytest.mark.parametrize("order", ["[1, 2, 3]", "[1, 1, 3, 4, 5]", "[1, 2, 3, 4, 6]", "nope", '{"a": 1}'])
def test_a_bad_order_is_refused(tmp_path, capsys, order):
    d = make_carousel(tmp_path)
    assert refused(capsys, run, d, order=order)["error"] == "invalid_params"


# ── the guarded write ─────────────────────────────────────────────────────────────────────────────────────────────

def test_a_persons_edit_meanwhile_is_refused_and_kept(tmp_path, monkeypatch, capsys):
    d = make_carousel(tmp_path)
    real = slide_text.apply

    def apply_then_the_person_edits(*a, **k):
        out = real(*a, **k)
        p = proj(d)
        p["slides"][0]["base_color"] = "#000000"     # changed in the editor meanwhile
        (d / "project.json").write_text(json.dumps(p))
        return out
    monkeypatch.setattr(sl.slide_text, "apply", apply_then_the_person_edits)
    assert refused(capsys, run, d, headlines=json.dumps(HEADS))["error"] == "project_changed"
    p = proj(d)
    assert p["slides"][0]["base_color"] == "#000000" and all(headline(s) is None for s in p["slides"])


def test_a_version_holds_the_persons_unversioned_edit_and_status_is_never_touched(tmp_path):
    d = make_carousel(tmp_path)
    p = proj(d)
    p["slides"][2]["base_color"] = "#ff0000"   # the person's edit, in no version yet
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, headlines=json.dumps(HEADS))
    assert out["version"] is True and git(d, "log", "-1", "--format=%s").strip() == sl.VERSION_MESSAGE
    assert json.loads(git(d, "show", "HEAD:project.json"))["slides"][2]["base_color"] == "#ff0000"
    assert proj(d)["status"] == "draft"


def test_a_project_that_is_not_a_carousel_or_has_no_slides_is_refused(tmp_path, capsys):
    d = make_carousel(tmp_path)
    p = proj(d)
    p["projectType"] = "editing"
    (d / "project.json").write_text(json.dumps(p))
    assert refused(capsys, run, d, headlines='["x"]')["error"] == "not_a_carousel"
    p["projectType"] = "carousel"
    p["slides"] = []
    (d / "project.json").write_text(json.dumps(p))
    assert refused(capsys, run, d, headlines='["x"]')["error"] == "no_slides"


def test_a_headline_that_does_not_fit_is_said_short(tmp_path):
    d = make_carousel(tmp_path)
    m = fake_measure()
    run(d, headlines=json.dumps(HEADS), measure_fn=m)
    spill = {headline(s)["id"] for s in proj(d)["slides"]}
    out = run(d, headlines=json.dumps(HEADS), measure_fn=fake_measure(spill))
    assert out["issues"][0] == "slide 1: the headline does not fit its box at its smallest size: shorten it"
    assert len(json.dumps(out)) <= 300 and out.get("more", 0) + len(out["issues"]) == 5


# ── a real measure ────────────────────────────────────────────────────────────────────────────────────────────────

def _has_render():
    return shutil.which("node") is not None and (REPO_ROOT / "montaj_assets" / "render" / "node_modules" / "puppeteer").exists()


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
def test_a_real_headline_fits_its_box_through_the_real_measurer(tmp_path):
    d = make_carousel(tmp_path)
    out = run(d, headlines=json.dumps(["Cut every pause", "A long headline that runs well past forty characters and then some"]),
              measure_fn=look.measure, detail=True)
    assert "issues" not in out, out
    assert out["slides"][1]["headline"] == "Cut every pause"
