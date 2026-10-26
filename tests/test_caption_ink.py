"""caption_ink (lib/caption_ink.py): which card is under a caption, how light its backdrop is, and what the plan
writes. The render is faked: a PNG per card, light for one and dark for another."""
import sys
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib import caption_ink as ci  # noqa: E402

W, H = 1080, 1920


def _video(i="v0", start=0, end=20, **kw):
    return {"id": i, "type": "video", "src": "/x/a.mp4", "start": start, "end": end, "inPoint": 0, "outPoint": end - start, **kw}


def _card(i, start, end, **kw):
    return {"id": i, "type": "overlay", "src": "engine:scene3d", "start": start, "end": end, "opaque": True, **kw}


def _seg(i, start, end, **kw):
    return {"id": i, "text": "hello there", "start": start, "end": end, "words": [], **kw}


def _project(items=(), segs=(), style="pop", base=None):
    return {"id": "p", "settings": {"resolution": [W, H], "fps": 30},
            "tracks": [{"id": "main", "items": [base or _video()]}, {"id": "ovl", "items": list(items)}],
            "captions": {"style": style, "segments": list(segs)}}


def _png(tmp_path, name, rgb):
    p = tmp_path / f"{name}.png"
    Image.new("RGB", (W // 2, H // 2), rgb).save(p)   # half size: the box scales to the image
    return str(p)


# -- card_under ----------------------------------------------------------------------------------------------------

def test_an_opaque_overlay_is_the_card_under_the_time():
    p = _project([_card("c1", 2, 6)])
    assert ci.card_under(p, 3)["id"] == "c1"
    assert ci.card_under(p, 2)["id"] == "c1", "start is inclusive"
    assert ci.card_under(p, 6) is None, "end is exclusive"


def test_footage_alone_is_never_a_card():
    assert ci.card_under(_project(), 3) is None


def test_a_non_opaque_or_offset_overlay_is_never_a_card():
    assert ci.card_under(_project([_card("c", 0, 5, opaque=False)]), 1) is None
    assert ci.card_under(_project([_card("c", 0, 5, offsetX=40)]), 1) is None
    assert ci.card_under(_project([_card("c", 0, 5, scale=0.8)]), 1) is None


def test_the_topmost_card_wins():
    p = _project([_card("low", 0, 10)])
    p["tracks"].append({"id": "top", "items": [_card("high", 2, 5)]})
    assert ci.card_under(p, 3)["id"] == "high"
    assert ci.card_under(p, 7)["id"] == "low"


def test_a_switched_off_track_draws_no_card():
    p = _project([_card("c", 0, 5)])
    p["tracks"][1]["enabled"] = False
    assert ci.card_under(p, 1) is None


# -- luminance -----------------------------------------------------------------------------------------------------

def test_luminance_of_white_black_and_paper(tmp_path):
    box = (0, 1000, W, 1200)
    assert ci.luminance(_png(tmp_path, "w", (255, 255, 255)), box, (W, H)) == pytest.approx(1.0, abs=1e-3)
    assert ci.luminance(_png(tmp_path, "k", (0, 0, 0)), box, (W, H)) == pytest.approx(0.0, abs=1e-3)
    assert ci.luminance(_png(tmp_path, "paper", (0xef, 0xec, 0xe4)), box, (W, H)) == pytest.approx(0.83, abs=0.02)
    assert ci.luminance(_png(tmp_path, "grey", (0xa6, 0xa4, 0x9e)), box, (W, H)) == pytest.approx(0.37, abs=0.02)


def test_luminance_is_the_mean_over_the_box_only(tmp_path):
    img = Image.new("RGB", (100, 100), (0, 0, 0))
    img.paste((255, 255, 255), (0, 0, 100, 50))
    p = tmp_path / "half.png"
    img.save(p)
    assert ci.luminance(str(p), (0, 0, 100, 50), (100, 100)) == pytest.approx(1.0, abs=1e-3)
    assert ci.luminance(str(p), (0, 50, 100, 100), (100, 100)) == pytest.approx(0.0, abs=1e-3)
    assert ci.luminance(str(p), (0, 0, 100, 100), (100, 100)) == pytest.approx(0.5, abs=1e-3)


# -- band ----------------------------------------------------------------------------------------------------------

def test_the_band_is_the_segments_own_rows_clamped_to_the_frame():
    p = _project(segs=[_seg("a", 0, 2), _seg("b", 1, 3, offsetY=25)])
    x0, y0, x1, y1 = ci.band(p, p["captions"]["segments"][0], W, H)
    assert (x0, x1) == (0, W) and 0 <= y0 < y1 <= H
    _, by0, _, by1 = ci.band(p, p["captions"]["segments"][1], W, H)
    assert by1 == H and by0 > y0, "an offset past the bottom is clamped"


# -- plan ----------------------------------------------------------------------------------------------------------

def _plan(project, tmp_path, light=("c-light",), dark=("c-dark",), calls=None, fail_at=()):
    def render(t):
        if calls is not None:
            calls.append(t)
        if round(t, 3) in fail_at:
            raise RuntimeError("boom")
        card = ci.card_under(project, t)
        return _png(tmp_path, f"f{t}", (0xef, 0xec, 0xe4) if card["id"] in light else (20, 20, 20))
    return ci.plan(project, render, W, H)


def test_plan_marks_ink_dark_over_a_light_card_and_light_over_a_dark_one(tmp_path):
    p = _project([_card("c-light", 0, 4), _card("c-dark", 4, 8)], [_seg("a", 1, 2), _seg("b", 5, 6)])
    changes, counts, warnings = _plan(p, tmp_path)
    assert changes == {"a": {"ink": "dark", "inkAuto": "c-light"}, "b": {"ink": "light", "inkAuto": "c-dark"}}
    assert (counts["dark"], counts["light"], counts["cleared"], counts["kept"]) == (1, 1, 0, 0)
    assert warnings == []


def test_plan_leaves_a_persons_ink_and_counts_it_kept(tmp_path):
    p = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2, ink="light")])
    changes, counts, _ = _plan(p, tmp_path)
    assert changes == {} and counts["kept"] == 1


def test_plan_clears_its_own_ink_once_the_card_is_gone(tmp_path):
    p = _project([], [_seg("a", 1, 2, ink="dark", inkAuto="c-light"), _seg("b", 3, 4)])
    changes, counts, _ = _plan(p, tmp_path)
    assert changes == {"a": None} and counts["cleared"] == 1


def test_plan_skips_translations_and_the_styles_that_draw_their_own_box(tmp_path):
    segs = [_seg("a", 1, 2), _seg("t", 1, 2, lang="es", translationOf=["a"])]
    p = _project([_card("c-light", 0, 4)], segs)
    changes, _, _ = _plan(p, tmp_path)
    assert list(changes) == ["a"]
    for style in ("plate", "subtitle"):
        calls = []
        q = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2, ink="dark", inkAuto="old")], style=style)
        assert _plan(q, tmp_path, calls=calls)[0] == {} and calls == [], f"{style}: nothing rendered, nothing cleared"


def test_plan_renders_once_per_distinct_time(tmp_path):
    calls = []
    p = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2), _seg("b", 1, 2)])
    changes, _, _ = _plan(p, tmp_path, calls=calls)
    assert len(calls) == 1 and set(changes) == {"a", "b"}


def test_a_failed_render_leaves_the_segment_and_warns_with_the_time(tmp_path):
    p = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2), _seg("b", 2, 4)])
    changes, counts, warnings = _plan(p, tmp_path, fail_at=(1.5,))
    assert list(changes) == ["b"]
    assert len(warnings) == 1 and "1.5" in warnings[0]


def test_segments_without_ids_are_keyed_by_index(tmp_path):
    s = _seg("x", 1, 2)
    del s["id"]
    p = _project([_card("c-light", 0, 4)], [s])
    changes, _, _ = _plan(p, tmp_path)
    assert changes == {0: {"ink": "dark", "inkAuto": "c-light"}}
