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
    out = run(d, headlines=json.dumps([h + "!" for h in HEADS]), measure_fn=fake_measure(spill))
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


# ── gate review fixes ─────────────────────────────────────────────────────────────────────────────────────────────

def _png(path, size, fill):
    from PIL import Image
    im = Image.new("RGB", size, "white" if fill == "checker" else fill)
    if fill == "checker":
        im = Image.new("RGB", size, "white")
        px = im.load()
        for x in range(size[0]):
            for y in range(size[1]):
                if (x // 40 + y // 40) % 2:
                    px[x, y] = (0, 0, 0)
    im.save(path)


def test_resending_the_same_headlines_keeps_a_persons_size_edit(tmp_path):
    d = make_carousel(tmp_path)
    run(d, headlines=json.dumps(HEADS))
    p = proj(d)
    headline(p["slides"][1])["overlay"]["props"].update({"fontSize": "64px", "minFontSize": "30.5"})
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, headlines=json.dumps(HEADS))
    assert out == {"changed": []} and proj(d) == p, "nothing to change, nothing written"
    out = run(d, edit=json.dumps({"slide": 2, "size": "bigger"}))
    props = headline(proj(d)["slides"][1])["overlay"]["props"]
    assert out["changed"] == [2] and props["fontSize"] == "80" and props["minFontSize"] == "30", "the picker's 64px, read"


def test_a_headline_the_person_retyped_is_kept_and_only_an_edit_replaces_it(tmp_path):
    d = make_carousel(tmp_path)
    run(d, headlines=json.dumps(HEADS))
    p = proj(d)
    headline(p["slides"][0])["overlay"]["props"]["text"] = "My own words"
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, headlines=json.dumps(["New one", "Second new"]))
    s = proj(d)["slides"]
    assert headline(s[0])["overlay"]["props"]["text"] == "My own words"
    assert headline(s[1])["overlay"]["props"]["text"] == "Second new" and out["changed"] == [2]
    assert out["issues"][0] == "slide 1: kept your edited headline (use edit to change it)"
    run(d, edit=json.dumps({"slide": 1, "headline": "Replaced on purpose"}))
    props = headline(proj(d)["slides"][0])["overlay"]["props"]
    assert props["text"] == props["montajText"] == "Replaced on purpose"


def test_a_carousel_the_app_made_gets_one_slide_per_image_asset_then_its_headlines(tmp_path):
    d = make_carousel(tmp_path)
    p = proj(d)
    sizes = [(1080, 1350), (2000, 1000), (800, 1600), (1080, 1080), (1350, 1080)]
    p["assets"] = []
    for i, size in enumerate(sizes):
        _png(d / "assets" / f"img{i}.png", size, (20, 20, 20))
        p["assets"].append({"id": f"asset-{i}", "src": str(d / "assets" / f"img{i}.png"), "type": "image", "name": f"img{i}.png"})
    p["assets"].insert(2, {"id": "asset-v", "src": str(d / "assets" / "clip.mp4"), "type": "video", "name": "clip.mp4"})
    p["slides"], p["notes"] = [], []
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, headlines=json.dumps(HEADS))
    slides = proj(d)["slides"]
    assert out["made"] == 5 and out["changed"] == [1, 2, 3, 4, 5] and out["headlines"] == {"added": 5}
    for s, size, text, a in zip(slides, sizes, HEADS, [x for x in p["assets"] if x["type"] == "image"]):
        img = s["elements"][0]
        assert img["type"] == "image" and img["src"] == a["src"] and (img["x"], img["y"], img["w"], img["h"]) == (0, 0, 1080, 1350)
        assert img.get("crop") == slide_text.cover_crop(1080, 1350, *size)
        assert headline(s)["overlay"]["props"]["text"] == text
    assert "crop" not in slides[0]["elements"][0] and slides[1]["elements"][0]["crop"]["h"] == 1
    assert v.validate_project(str(d / "project.json"))["valid"] is True


def test_the_editors_cover_crop_is_ported_exactly():
    # imageGeometry.ts coverCrop: a wider image keeps its height and the middle of its width, a taller its width
    assert slide_text.cover_crop(1080, 1350, 2000, 1000) == {"x": (1 - 0.4) / 2, "y": 0, "w": 0.8 / 2, "h": 1}
    assert slide_text.cover_crop(1080, 1350, 800, 1600) == {"x": 0, "y": (1 - 0.625) / 2, "w": 1, "h": 0.5 / 0.8}
    assert slide_text.cover_crop(1080, 1350, 1081, 1350) is None and slide_text.cover_crop(1080, 1350, 0, 10) is None


def test_lists_through_serve_and_the_cli_keep_every_item_and_the_nulls(tmp_path, monkeypatch, capsys):
    from serve.routes.steps import build_cli_args, validate_params
    d = make_carousel(tmp_path)
    schema = json.loads((REPO_ROOT / "steps" / "edit" / "slides.json").read_text())
    body = {"project": str(d / "project.json"), "headlines": ["Alpha", None, "Gamma"], "order": [1, 4, 3, 2, 5]}
    validate_params(schema, body)
    argv = build_cli_args(schema, {k: v_ for k, v_ in body.items()})
    monkeypatch.setattr(sl.look_step, "measure", fake_measure())
    monkeypatch.setattr(sl, "render_runtime_dir", lambda: RUNTIME)
    monkeypatch.setattr(sys, "argv", ["slides.py", *argv])
    before = proj(d)["slides"]
    sl.main()
    out = json.loads(capsys.readouterr().out)
    after = proj(d)["slides"]
    assert out["headlines"] == {"added": 2} and out["order"] is True
    assert [s["id"] for s in after] == [before[k]["id"] for k in (0, 3, 2, 1, 4)]
    assert headline(after[0])["overlay"]["props"]["text"] == "Alpha" and headline(after[2])["overlay"]["props"]["text"] == "Gamma"
    assert headline(after[3]) is None, "null skipped slide 2 (now 4th)"
    assert slide_text.parse_list(['["A", null]'], "headlines") == ["A", None]


@pytest.mark.parametrize("fill,style", [((250, 250, 250), "clean"), ((5, 5, 5), "bold"), ((128, 128, 128), "label"),
                                        ("checker", "label")])
def test_auto_picks_the_style_from_the_image_under_the_box(tmp_path, fill, style):
    d = make_carousel(tmp_path)
    _png(d / "assets" / "img0.png", (1200, 1350), fill)
    run(d, headlines=json.dumps(["A hook"]))
    props = headline(proj(d)["slides"][0])["overlay"]["props"]
    assert {k: props[k] for k in slide_text.PRESETS[style]} == slide_text.PRESETS[style]


def test_a_headline_hard_to_read_on_its_image_is_said_and_its_colour_kept(tmp_path):
    d = make_carousel(tmp_path)
    _png(d / "assets" / "img0.png", (1200, 1350), (245, 245, 245))
    out = run(d, headlines=json.dumps(["A hook"]), style="bold")
    assert out["issues"] == ["slide 1: the headline is hard to read on its image: style label"]
    assert headline(proj(d)["slides"][0])["overlay"]["props"]["color"] == "#ffffff"
    out = run(d, edit=json.dumps({"slide": 1, "style": "label"}))
    assert "issues" not in out, "the card is its own background"


# ── review 2 should-fixes ─────────────────────────────────────────────────────────────────────────────────────────

def test_a_call_with_nothing_to_change_answers_each_slides_headline(tmp_path):
    d = make_carousel(tmp_path)
    run(d, headlines=json.dumps(HEADS[:2]))
    before = proj(d)
    assert run(d) == {"slides": {"1": HEADS[0], "2": HEADS[1], "3": None, "4": None, "5": None}}
    assert proj(d) == before


def test_a_style_alone_restyles_every_headline_and_edit_takes_all_or_a_list(tmp_path):
    d = make_carousel(tmp_path)
    run(d, headlines=json.dumps(HEADS[:3]))
    out = run(d, style="label")
    assert out["changed"] == [1, 2, 3] and out["headlines"] == {"restyled": 3}
    assert all(headline(s)["overlay"]["props"]["bgColor"] == "#ffffff" for s in proj(d)["slides"][:3])
    out = run(d, edit=json.dumps({"slide": "all", "color": "#00ffff"}))
    assert out["changed"] == [1, 2, 3] and headline(proj(d)["slides"][3]) is None, "all edits the headlines there are"
    out = run(d, edit=json.dumps({"slide": [1, 3], "align": "left"}), style="clean")
    s = proj(d)["slides"]
    assert out["changed"] == [1, 3] and headline(s[0])["overlay"]["props"]["textAlign"] == "left"
    assert headline(s[2])["overlay"]["props"]["color"] == slide_text.PRESETS["clean"]["color"], "the call's style, for the edit"
    assert headline(s[1])["overlay"]["props"]["color"] == "#00ffff", "slide 2 is not in the list"


def test_headlines_by_slide_id_land_on_that_slide_whatever_the_order(tmp_path):
    d = make_carousel(tmp_path)
    ids = [s["id"] for s in proj(d)["slides"]]
    out = run(d, headlines=json.dumps({ids[3]: "Fourth", "1": "First"}))
    s = proj(d)["slides"]
    assert out["changed"] == [1, 4] and headline(s[3])["overlay"]["props"]["text"] == "Fourth"
    assert headline(s[0])["overlay"]["props"]["text"] == "First"


def test_a_tall_slide_keeps_its_headline_clear_of_the_apps_caption_and_buttons(tmp_path):
    d = make_carousel(tmp_path)
    p = proj(d)
    p["settings"]["resolution"] = [1080, 1920]
    (d / "project.json").write_text(json.dumps(p))
    run(d, headlines=json.dumps(["A hook"]))
    run(d, edit=json.dumps({"slide": 1, "position": "bottom"}))
    el = headline(proj(d)["slides"][0])
    assert (el["x"], el["w"]) == (round(1080 * 0.12), round(1080 * 0.76))
    assert (el["y"], el["h"]) == (round(1920 * 0.56), round(1920 * 0.20)), "bottom ends at 76%, above the caption area"


def test_a_word_too_long_for_the_box_is_said(tmp_path):
    d = make_carousel(tmp_path)
    out = run(d, headlines=json.dumps(["Supercalifragilisticexpialidocious"]))
    assert out["issues"] == ["slide 1: a word is too long for the box: shorten it"]


@pytest.mark.skipif(not shutil.which("node"), reason="needs node and the render bundle")
def test_a_headline_too_long_for_a_square_slide_does_not_fit_through_the_real_measurer(tmp_path):
    d = make_carousel(tmp_path)
    p = proj(d)
    p["settings"]["resolution"] = [1080, 1080]
    (d / "project.json").write_text(json.dumps(p))
    long = " ".join(["WMWM MWMW"] * 27)    # 269 wide capitals: past the box even at the table's floor size
    out = run(d, headlines=json.dumps([long]), measure_fn=look.measure)
    assert "slide 1: the headline does not fit its box at its smallest size: shorten it" in out["issues"], out


def test_order_can_swap_two_slides(tmp_path):
    d = make_carousel(tmp_path)
    ids = [s["id"] for s in proj(d)["slides"]]
    out = run(d, order=json.dumps({"swap": [2, 4]}))
    assert out["order"] is True and [s["id"] for s in proj(d)["slides"]] == [ids[0], ids[3], ids[2], ids[1], ids[4]]


# ── §558 land review ──────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("damage", [
    lambda el: el.pop("id"),
    lambda el: el.update(id=12345),
    lambda el: el.update(w=float("nan")),
    lambda el: el.update(frame="soon"),
])
def test_a_damaged_headline_is_skipped_by_the_check_not_a_traceback(tmp_path, damage):
    d = make_carousel(tmp_path)
    run(d, headlines=json.dumps(HEADS))
    slides = proj(d)["slides"]
    damage(headline(slides[0]))
    sl._check(slides, {slides[0]["id"]}, str(d), fake_measure())
