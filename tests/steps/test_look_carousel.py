"""look on a carousel (§558): the slides are checked instead of a timeline, and image makes one composite of them.

The measurer and the renderer are faked except in the last test, which renders real slides through
montaj_assets/render/render-carousel.js (needs node and the render bundle's puppeteer).
"""
import json
import os
import sys
import uuid
from pathlib import Path

import pytest
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib import slide_text  # noqa: E402
import steps.render.look as look  # noqa: E402

RUNTIME = str(REPO_ROOT / "montaj_assets" / "render")
W, H = 1080, 1350


def make_carousel(tmp_path, n=5, headlines=True, image=True, image_color=(30, 30, 30)):
    d = tmp_path / "carousel"
    (d / "assets").mkdir(parents=True)
    slides = []
    for i in range(n):
        els = []
        if image:
            Image.new("RGB", (W, H), image_color).save(d / "assets" / f"img{i}.png")
            els.append({"id": str(uuid.uuid4()), "type": "image", "src": f"assets/img{i}.png", "x": 0, "y": 0, "w": W, "h": H,
                        "rotation": 0, "crop": {"x": 0, "y": 0, "w": 1, "h": 1}})
        if headlines:
            els.append(slide_text.headline_element(f"Headline {i + 1}", style="bold", position="top", width=W, height=H,
                                                   runtime_dir=RUNTIME))
        slides.append({"id": str(uuid.uuid4()), "base_color": "#ffffff", "elements": els})
    project = {"version": "0.2", "id": "car-1", "name": "Carousel", "status": "draft", "workflow": "carousel",
               "projectType": "carousel", "carousel": {"aspect": "portrait"},
               "settings": {"resolution": [W, H]}, "slides": slides}
    (d / "project.json").write_text(json.dumps(project))
    return d


def proj(d):
    return json.loads((d / "project.json").read_text())


def fake_measure(bad=None):
    """Each text fills its box less a 10 px margin; `bad` maps an element's text to a bbox / spills override."""
    bad = bad or {}
    calls = []

    def fn(item, path, frame, duration, fps, width, height, out):
        calls.append(item["props"].get("text"))
        o = bad.get(item["props"].get("text"), {})
        bbox = o.get("bbox", {"x": 10, "y": 10, "w": width - 20, "h": min(80, height - 20)})
        return {"texts": [{"text": str(item["props"].get("text"))[:20], "bbox": bbox, "spills": o.get("spills", False)}]}, None
    fn.calls = calls
    return fn


def fake_render(calls=None):
    def fn(project_path, numbers, out_dir):
        if calls is not None:
            calls.append(list(numbers))
        os.makedirs(out_dir, exist_ok=True)
        out = []
        for n in numbers:
            p = os.path.join(out_dir, f"slide_{n:02d}.png")
            Image.new("RGB", (W, H), (40 * n % 255, 90, 160)).save(p)
            out.append((n, p))
        return out, []
    return fn


def run(d, **kw):
    kw.setdefault("measure_fn", fake_measure())
    kw.setdefault("render_fn", fake_render())
    return look.run(str(d / "project.json"), **kw)


def test_a_clean_5_slide_carousel_answers_zero_issues(tmp_path):
    d = make_carousel(tmp_path)
    m = fake_measure()
    assert run(d, measure_fn=m) == {"ok": True, "slides": 5, "overlays": 5}
    assert len(m.calls) == 5


def test_an_overflowing_headline_is_caught_with_its_slide(tmp_path):
    d = make_carousel(tmp_path)
    out = run(d, measure_fn=fake_measure({"Headline 2": {"spills": True}}))
    assert out["ok"] is False
    assert len(out["issues"]) == 1 and out["issues"][0].startswith("slide 2: ") and "box" in out["issues"][0]


def test_text_past_the_slide_is_off_it_and_its_own_box_overflow_is_said(tmp_path):
    d = make_carousel(tmp_path)
    off = {"bbox": {"x": 800, "y": 10, "w": 600, "h": 80}}   # past the slide's right edge (and the headline box)
    out = run(d, measure_fn=fake_measure({"Headline 3": off}))
    assert any(i.startswith("slide 3: ") and "off the slide" in i for i in out["issues"]), out


def test_two_texts_that_cross_and_a_slide_with_no_image_are_said(tmp_path):
    d = make_carousel(tmp_path, image=False)
    p = proj(d)
    second = slide_text.headline_element("Second", style="clean", position="top", width=W, height=H, runtime_dir=RUNTIME)
    second["overlay"]["props"].pop(slide_text.ROLE_KEY)   # a person's own text, not the headline
    p["slides"][0]["elements"].append(second)
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, detail=True)
    assert any(i.startswith("slide 1: text") and "overlaps" in i for i in out["issues"]), out
    assert sum("no image" in i for i in out["issues"]) == 5 and all(i.startswith("slide ") for i in out["issues"])


def test_a_headline_hard_to_read_on_its_image_is_said(tmp_path):
    d = make_carousel(tmp_path, image_color=(255, 255, 255))   # white headline on white
    out = run(d)
    assert any(i.startswith("slide 1: ") and "hard to read" in i for i in out["issues"]), out


def test_image_writes_exactly_one_768_px_composite_of_all_slides(tmp_path):
    d = make_carousel(tmp_path)
    renders = []
    out = run(d, image=True, render_fn=fake_render(renders))
    assert renders == [[1, 2, 3, 4, 5]]
    files = [f for f in os.listdir(d / "render" / "samples") if (d / "render" / "samples" / f).is_file()]
    assert files == [os.path.basename(out["sheet"])] and out["sheet"].startswith(str(d / "render" / "samples"))
    with Image.open(out["sheet"]) as im:
        assert im.size[0] == 768 and im.size[1] > 200
    assert not (d / "render" / "samples" / "look-slides").exists(), "the single slide renders are not left behind"
    again = run(d, image=True)
    assert [f for f in os.listdir(d / "render" / "samples") if (d / "render" / "samples" / f).is_file()] == [os.path.basename(again["sheet"])]


def test_at_takes_slide_numbers_and_limits_what_is_checked_and_rendered(tmp_path):
    d = make_carousel(tmp_path)
    m, renders = fake_measure(), []
    out = run(d, at=[4, 2], image=True, measure_fn=m, render_fn=fake_render(renders))
    assert renders == [[2, 4]] and sorted(m.calls) == ["Headline 2", "Headline 4"] and out["slides"] == 2


def test_a_slide_number_that_does_not_exist_is_refused(tmp_path, capsys):
    d = make_carousel(tmp_path, n=3)
    with pytest.raises(SystemExit):
        run(d, at=[9])
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert "slide" in err["message"] and "--" not in err["message"]


def test_the_answer_stays_small_and_writes_nothing_in_the_project(tmp_path):
    d = make_carousel(tmp_path, image=False)
    before = (d / "project.json").read_bytes()
    out = run(d)
    assert len(json.dumps(out)) <= 300 and out["more"] > 0
    assert (d / "project.json").read_bytes() == before


@pytest.mark.skipif(not (REPO_ROOT / "montaj_assets" / "render" / "node_modules" / "puppeteer").exists()
                    and not os.environ.get("MONTAJ_RENDER_REAL"), reason="needs the render bundle's puppeteer")
def test_the_real_renderer_makes_the_composite(tmp_path):
    d = make_carousel(tmp_path, n=3)
    out = look.run(str(d / "project.json"), image=True)
    assert out["ok"] is True, out
    with Image.open(out["sheet"]) as im:
        assert im.size[0] == 768
