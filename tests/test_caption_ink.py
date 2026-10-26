"""caption_ink (lib/caption_ink.py): which card is under a caption, how light its backdrop is, and what the plan
writes. The render is faked: a PNG per card, light for one and dark for another."""
import sys
import time
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib import caption_ink as ci  # noqa: E402

W, H = 1080, 1920


def _video(i="v0", start=0, end=20, **kw):
    return {"id": i, "type": "video", "src": "/x/a.mp4", "start": start, "end": end, "inPoint": 0, "outPoint": end - start, **kw}


def _image(i="im0", start=0, end=20, **kw):
    """Footage drawn above an overlay: a track holding a video stacks below every other track, an image does not."""
    return {"id": i, "type": "image", "src": "/x/a.png", "start": start, "end": end, **kw}


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

def _auto(card, ink):
    return {"card": card, "ink": ink}


def _plan(project, tmp_path, light=("c-light",), dark=("c-dark",), calls=None, fail_at=(), deadline=None):
    def render(t):
        if calls is not None:
            calls.append(t)
        if round(t, 3) in fail_at:
            raise RuntimeError("boom")
        card = ci.card_under(project, t)
        return _png(tmp_path, f"f{t}", (0xef, 0xec, 0xe4) if card["id"] in light else (20, 20, 20))
    return ci.plan(project, render, W, H, deadline)


def test_plan_marks_ink_dark_over_a_light_card_and_light_over_a_dark_one(tmp_path):
    p = _project([_card("c-light", 0, 4), _card("c-dark", 4, 8)], [_seg("a", 1, 2), _seg("b", 5, 6)])
    changes, counts, warnings = _plan(p, tmp_path)
    assert {k: (c["ink"], c["inkAuto"]["card"], c["inkAuto"]["ink"]) for k, c in changes.items()} == {
        ("id", "a"): ("dark", "c-light", "dark"), ("id", "b"): ("light", "c-dark", "light")}
    assert changes[("id", "a")]["inkAuto"]["backdrop"] == pytest.approx(0.83, abs=0.01)
    assert changes[("id", "b")]["inkAuto"]["backdrop"] == pytest.approx(0.007, abs=0.01)
    assert round(changes[("id", "a")]["inkAuto"]["backdrop"], 3) == changes[("id", "a")]["inkAuto"]["backdrop"]
    assert (counts["dark"], counts["light"], counts["cleared"], counts["kept"]) == (1, 1, 0, 0)
    assert warnings == []


def test_plan_leaves_a_persons_ink_and_counts_it_kept(tmp_path):
    p = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2, ink="light")])
    changes, counts, _ = _plan(p, tmp_path)
    assert changes == {} and counts["kept"] == 1


@pytest.mark.parametrize("seg", [
    {"ink": "light", "inkAuto": _auto("c-light", "dark")},   # a person changed what the step wrote
    {"inkAuto": _auto("c-light", "dark")},                   # a person removed it
    {"ink": "dark", "inkAuto": "c-light"},                   # not the shape the step writes
])
def test_a_persons_choice_is_never_changed_cleared_or_measured(tmp_path, seg):
    for items in ([_card("c-light", 0, 4)], []):
        calls = []
        p = _project(items, [_seg("a", 1, 2, **seg)])
        changes, counts, _ = _plan(p, tmp_path, calls=calls)
        assert changes == {} and calls == [] and counts["kept"] == 1 and counts["cleared"] == 0


def test_plan_clears_its_own_ink_once_the_card_is_gone(tmp_path):
    p = _project([], [_seg("a", 1, 2, ink="dark", inkAuto=_auto("c-light", "dark")), _seg("b", 3, 4)])
    changes, counts, _ = _plan(p, tmp_path)
    assert changes == {("id", "a"): None} and counts["cleared"] == 1


def test_plan_skips_translations_and_the_styles_that_draw_their_own_box(tmp_path):
    segs = [_seg("a", 1, 2), _seg("t", 1, 2, lang="es", translationOf=["a"])]
    p = _project([_card("c-light", 0, 4)], segs)
    changes, _, _ = _plan(p, tmp_path)
    assert list(changes) == [("id", "a")]
    for style in ("plate", "subtitle"):
        calls = []
        q = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2, ink="dark", inkAuto=_auto("old", "dark"))], style=style)
        assert _plan(q, tmp_path, calls=calls)[0] == {} and calls == [], f"{style}: nothing rendered, nothing cleared"


def test_plan_renders_once_per_distinct_time(tmp_path):
    calls = []
    p = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2), _seg("b", 1, 2)])
    changes, _, _ = _plan(p, tmp_path, calls=calls)
    assert len(calls) == 1 and set(changes) == {("id", "a"), ("id", "b")}


def test_a_failed_render_leaves_the_segment_and_warns_with_the_time(tmp_path):
    p = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2), _seg("b", 2, 4)])
    changes, counts, warnings = _plan(p, tmp_path, fail_at=(1.5,))
    assert list(changes) == [("id", "b")]
    assert len(warnings) == 1 and "1.5" in warnings[0]


def test_frames_not_started_by_the_deadline_count_as_failed(tmp_path):
    calls = []
    p = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2), _seg("b", 2, 4)])
    changes, _, warnings = _plan(p, tmp_path, calls=calls, deadline=time.monotonic() - 1)
    assert changes == {} and calls == [] and len(warnings) == 2 and "1.5" in warnings[0]


def test_segments_without_ids_are_keyed_by_index(tmp_path):
    s = _seg("x", 1, 2)
    del s["id"]
    p = _project([_card("c-light", 0, 4)], [s])
    changes, _, _ = _plan(p, tmp_path)
    assert changes == {("i", 0): {"ink": "dark", "inkAuto": {**_auto("c-light", "dark"),
                                                              "backdrop": changes[("i", 0)]["inkAuto"]["backdrop"]}}}
    assert changes[("i", 0)]["inkAuto"]["backdrop"] == pytest.approx(0.83, abs=0.01)


def test_a_stored_backdrop_changes_nothing_about_who_owns_the_ink():
    seg = _seg("a", 1, 2, ink="dark", inkAuto={"card": "c", "ink": "dark", "backdrop": 0.83})
    assert ci.ours(seg) and not ci.ours({**seg, "ink": "light"})


def test_the_index_is_the_raw_lists_when_it_holds_entries_that_are_not_captions(tmp_path):
    a, b = _seg("x", 1, 2), _seg("y", 5, 6)
    del a["id"], b["id"]
    p = _project([_card("c-light", 4, 8)], ["junk", a, b])
    changes, _, _ = _plan(p, tmp_path)
    assert list(changes) == [("i", 2)], "b is the third entry, over the card; a is over footage"


def test_an_id_is_never_read_as_an_index(tmp_path):
    p = _project([_card("c-light", 0, 4)], [_seg(1, 1, 2), _seg(0, 2, 3)])
    changes, _, _ = _plan(p, tmp_path)
    assert set(changes) == {("id", 1), ("i", 1)}


# -- needs_pass ----------------------------------------------------------------------------------------------------

def test_the_step_has_work_for_a_card_or_for_ink_of_its_own_only():
    seg = _seg("a", 1, 2)
    assert ci.needs_pass(_project([_card("c", 0, 4)], [seg]))
    assert not ci.needs_pass(_project([_card("c", 0, 4)], []))
    assert not ci.needs_pass(_project([], [seg]))
    assert ci.needs_pass(_project([], [_seg("a", 1, 2, ink="dark", inkAuto=_auto("c", "dark"))]))
    assert not ci.needs_pass(_project([], [_seg("a", 1, 2, ink="dark")])), "a person's ink"
    assert not ci.needs_pass(_project([], [_seg("a", 1, 2, ink="light", inkAuto=_auto("c", "dark"))]))


# -- apply_changes -------------------------------------------------------------------------------------------------

def _apply(project, key, change):
    read = {k: dict(s) for k, s in {ci._key(s, i): s for i, s in enumerate(project["captions"]["segments"])
                                    if isinstance(s, dict)}.items()}
    return lambda fresh: ci.apply_changes(fresh, {key: change}, read)


DARK_A = {"ink": "dark", "inkAuto": _auto("c-light", "dark")}


def test_apply_writes_ink_and_clears_it_and_says_whether_it_wrote():
    p = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2)])
    assert _apply(p, ("id", "a"), DARK_A)(p) is True
    assert p["captions"]["segments"][0]["inkAuto"] == _auto("c-light", "dark")
    assert _apply(p, ("id", "a"), DARK_A)(p) is False, "the same ink on the same card is no write"
    q = _project([], [_seg("a", 1, 2, **DARK_A)])
    assert _apply(q, ("id", "a"), None)(q) is True
    assert "ink" not in q["captions"]["segments"][0] and "inkAuto" not in q["captions"]["segments"][0]


@pytest.mark.parametrize("edit", [
    {"ink": "light"}, {"text": "edited"}, {"start": 1.1}, {"style": "clean"}, {"words": [{"w": "x"}]}, {"lang": "es"},
])
def test_a_segment_that_differs_in_any_field_since_it_was_read_refuses(edit):
    p = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2)])
    go = _apply(p, ("id", "a"), DARK_A)
    p["captions"]["segments"][0].update(edit)
    with pytest.raises(ci.InkProjectChanged):
        go(p)
    assert "inkAuto" not in p["captions"]["segments"][0]


def test_apply_refuses_when_the_card_under_the_caption_is_gone_or_another():
    p = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2)])
    go = _apply(p, ("id", "a"), DARK_A)
    for items in ([], [_card("other", 0, 4)]):
        q = _project(items, [_seg("a", 1, 2)])
        with pytest.raises(ci.InkProjectChanged):
            go(q)
    cleared = _project([], [_seg("a", 1, 2, **DARK_A)])
    go = _apply(cleared, ("id", "a"), None)
    with pytest.raises(ci.InkProjectChanged):
        go(_project([_card("c-light", 0, 4)], [_seg("a", 1, 2, **DARK_A)]))


def test_apply_refuses_a_duplicate_id_and_a_missing_one_and_writes_nothing():
    p = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2)])
    go = _apply(p, ("id", "a"), DARK_A)
    twice = _project([_card("c-light", 0, 4)], [_seg("a", 1, 2), _seg("a", 1, 2)])
    with pytest.raises(ci.InkProjectChanged):
        go(twice)
    assert all("ink" not in s for s in twice["captions"]["segments"])
    with pytest.raises(ci.InkProjectChanged):
        go(_project([_card("c-light", 0, 4)], []))


def test_apply_with_entries_that_are_not_captions_raises_the_refusal_not_a_traceback():
    a, b = _seg("x", 1, 2), _seg("y", 5, 6)
    del a["id"], b["id"]
    p = _project([_card("c-light", 4, 8)], [None, a, b])
    go = _apply(p, ("i", 2), {"ink": "dark", "inkAuto": _auto("c-light", "dark")})
    fewer = _project([_card("c-light", 4, 8)], [a, b])
    with pytest.raises(ci.InkProjectChanged):
        go(fewer)
    assert go(p) is True and "ink" in p["captions"]["segments"][2] and "ink" not in p["captions"]["segments"][1]


# -- the child process ---------------------------------------------------------------------------------------------

def test_a_timed_out_frame_kills_the_whole_process_tree(monkeypatch):
    killed = []
    real = ci.kill_tree
    monkeypatch.setattr(ci, "kill_tree", lambda proc: (killed.append(proc.pid), real(proc)))
    assert ci._run_group([sys.executable, "-c", "import time; time.sleep(30)"], 0.5) is None
    assert len(killed) == 1


def test_a_frame_gets_what_is_left_until_the_deadline_and_none_after(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(ci, "_run_group", lambda cmd, timeout: (seen.append(timeout), (0, "", ""))[1])
    out = tmp_path / "ink-1.000s.png"
    out.write_bytes(b"x")
    render = ci.frame_renderer("/p/project.json", str(tmp_path), time.monotonic() + 5)
    render(1.0)
    assert 0 < seen[0] <= 5
    with pytest.raises(RuntimeError):
        ci.frame_renderer("/p/project.json", str(tmp_path), time.monotonic() - 1)(1.0)
    assert len(seen) == 1


# -- a card is what covers the caption band ---------------------------------------------------------------------

PAPER = (0xf5, 0xf3, 0xeb, 255)


def _matte(i="matte", start=0, end=10, **kw):
    """A frame_broll-style card: a full-canvas JSX overlay, not `opaque`, painting paper round a window."""
    return {"id": i, "type": "overlay", "src": "./overlays/footage-card.jsx", "start": start, "end": end, **kw}


def _alpha_png(tmp_path, name, window=None):
    """The overlay rendered alone: paper (alpha 255) all over, transparent inside `window` (x0, y0, x1, y1 on the
    design canvas), or nowhere painted at all when window is "all"."""
    img = Image.new("RGBA", (W // 2, H // 2), (0, 0, 0, 0) if window == "all" else PAPER)
    if window and window != "all":
        x0, y0, x1, y1 = [v // 2 for v in window]
        img.paste((0, 0, 0, 0), (x0, y0, x1, y1))
    p = tmp_path / f"{name}.png"
    img.save(p)
    return str(p)


def _plan2(project, tmp_path, alpha, project_dir=None, calls=None):
    def frame(t):
        return _png(tmp_path, f"g{t}", (0xef, 0xec, 0xe4))

    def overlay(item, n):
        if calls is not None:
            calls.append((item["id"], n))
        return alpha(item, n) if callable(alpha) else alpha
    return ci.plan(project, frame, W, H, overlay_fn=overlay, project_dir=str(project_dir or tmp_path))


def _band_y(project, seg):
    return ci.band(project, seg, W, H)


def test_a_paper_matte_with_a_window_above_the_band_is_the_card(tmp_path):
    p = _project([_matte()], [_seg("a", 1, 2)])
    top_window = _alpha_png(tmp_path, "m1", window=(60, 300, 1020, 900))   # window in the upper half; band is low
    changes, counts, warnings = _plan2(p, tmp_path, top_window)
    assert changes[("id", "a")]["ink"] == "dark" and changes[("id", "a")]["inkAuto"]["card"] == "matte"
    assert counts["dark"] == 1 and warnings == []


def test_a_matte_whose_window_is_over_the_band_is_no_card(tmp_path):
    p = _project([_matte()], [_seg("a", 1, 2)])
    _, y0, _, y1 = _band_y(p, p["captions"]["segments"][0])
    changes, counts, _ = _plan2(p, tmp_path, _alpha_png(tmp_path, "m2", window=(0, y0 - 20, W, y1 + 20)))
    assert changes == {} and counts["dark"] == counts["light"] == 0


def test_a_full_canvas_overlay_transparent_over_the_band_is_no_card(tmp_path):
    p = _project([_matte("lower-third")], [_seg("a", 1, 2)])
    changes, _, _ = _plan2(p, tmp_path, _alpha_png(tmp_path, "m3", window="all"))
    assert changes == {}


def test_footage_above_the_matte_over_the_band_means_no_card(tmp_path):
    p = _project([_matte()], [_seg("a", 1, 2)])
    p["tracks"].append({"id": "top", "items": [_image("pip", 0, 10, scale=0.5)]})
    changes, _, _ = _plan2(p, tmp_path, _alpha_png(tmp_path, "m4", window=(60, 300, 1020, 900)))
    assert changes == {}, "a half-size clip centred on the frame covers the caption band"


def test_footage_above_the_matte_clear_of_the_band_leaves_the_card(tmp_path):
    p = _project([_matte()], [_seg("a", 1, 2)])
    p["tracks"].append({"id": "top", "items": [_image("pip", 0, 10, scale=0.3, offsetY=-35)]})
    changes, _, _ = _plan2(p, tmp_path, _alpha_png(tmp_path, "m5", window=(60, 300, 1020, 900)))
    assert changes[("id", "a")]["inkAuto"]["card"] == "matte"


def test_footage_below_the_matte_does_not_hide_it(tmp_path):
    p = _project([_matte()], [_seg("a", 1, 2)])   # the base video is full-frame, on a track below
    changes, _, _ = _plan2(p, tmp_path, _alpha_png(tmp_path, "m6", window=(60, 300, 1020, 900)))
    assert ("id", "a") in changes


def test_an_overlay_is_rendered_once_per_item_and_frame(tmp_path):
    calls = []
    p = _project([_matte()], [_seg("a", 1, 2), _seg("b", 1, 2)])
    _plan2(p, tmp_path, _alpha_png(tmp_path, "m7", window=(60, 300, 1020, 900)), calls=calls)
    assert calls == [("matte", 45)], "frame = round((t - start) * fps)"


def test_a_scaled_or_moved_overlay_is_not_a_candidate_and_is_not_rendered(tmp_path):
    calls = []
    for kw in ({"scale": 0.8}, {"offsetX": 10}, {"rotation": 5}, {"opacity": 0.5},
               {"keyframes": [{"prop": "scale", "points": [{"t": 0, "value": 1}, {"t": 1, "value": 2}]}]}):
        p = _project([_matte(**kw)], [_seg("a", 1, 2)])
        assert _plan2(p, tmp_path, _alpha_png(tmp_path, "m8", window="all"), calls=calls)[0] == {}, kw
    assert calls == []


def test_an_opacity_keyframe_alone_still_places_the_overlay_over_the_canvas(tmp_path):
    kf = [{"prop": "opacity", "points": [{"t": 0, "value": 0}, {"t": 1, "value": 1}]}]
    p = _project([_matte(keyframes=kf)], [_seg("a", 1, 2)])
    assert ("id", "a") in _plan2(p, tmp_path, _alpha_png(tmp_path, "m9", window=(60, 300, 1020, 900)))[0]


def test_a_failed_overlay_render_leaves_the_caption_and_warns(tmp_path):
    def boom(item, n):
        raise RuntimeError("no chromium")
    p = _project([_matte()], [_seg("a", 1, 2)])
    changes, _, warnings = _plan2(p, tmp_path, boom)
    assert changes == {} and len(warnings) == 1 and "matte" in warnings[0] and "unchanged" in warnings[0]


def test_a_failed_overlay_render_does_not_clear_ink_of_ours(tmp_path):
    def boom(item, n):
        raise RuntimeError("x")
    p = _project([_matte()], [_seg("a", 1, 2, ink="dark", inkAuto=_auto("matte", "dark"))])
    changes, _, _ = _plan2(p, tmp_path, boom)
    assert changes == {}


def test_a_matte_over_the_band_clears_ink_of_ours(tmp_path):
    p = _project([_matte()], [_seg("a", 1, 2, ink="dark", inkAuto=_auto("matte", "dark"))])
    _, y0, _, y1 = _band_y(p, p["captions"]["segments"][0])
    changes, counts, _ = _plan2(p, tmp_path, _alpha_png(tmp_path, "m10", window=(0, y0 - 20, W, y1 + 20)))
    assert changes == {("id", "a"): None} and counts["cleared"] == 1


def test_the_first_covering_candidate_from_the_top_decides(tmp_path):
    p = _project([_matte("low")], [_seg("a", 1, 2)])
    p["tracks"].append({"id": "top", "items": [_card("high", 0, 10)]})
    changes, _, _ = _plan2(p, tmp_path, _alpha_png(tmp_path, "m11", window=(60, 300, 1020, 900)))
    assert changes[("id", "a")]["inkAuto"]["card"] == "high"


# -- a 3D scene without `opaque` --------------------------------------------------------------------------------

def _scene(project_dir, sid, backdrop, fallback=False):
    base = Path(project_dir) / "models" / ("scenes/" + sid if sid else "")
    base.mkdir(parents=True, exist_ok=True)
    if fallback:
        (base / "scene.json").write_text(__import__("json").dumps({"backdrop": backdrop} if backdrop else {}))
    else:
        scene = {"backdrop": backdrop} if backdrop else {}
        (base / "active.json").write_text(__import__("json").dumps({"slug": "m", "scene": scene}))


def _scene3d(i="scene-a", sid="specs", **kw):
    props = {"scene": sid} if sid else {}
    return {"id": i, "type": "overlay", "src": "engine:scene3d", "start": 0, "end": 10, "props": props, **kw}


@pytest.mark.parametrize("backdrop", [{"style": "studio"}, {"style": "color", "wall": "#F5F3EB"}, None])
def test_a_3d_scene_with_a_backdrop_is_a_card_without_opaque(tmp_path, backdrop):
    _scene(tmp_path, "specs", backdrop)
    p = _project([_scene3d()], [_seg("a", 1, 2)])
    changes, _, warnings = _plan2(p, tmp_path, None)
    assert changes[("id", "a")]["inkAuto"]["card"] == "scene-a" and warnings == []


def test_a_3d_scene_with_a_transparent_backdrop_is_no_card(tmp_path):
    _scene(tmp_path, "specs", {"style": "transparent"})
    p = _project([_scene3d()], [_seg("a", 1, 2)])
    assert _plan2(p, tmp_path, None)[0] == {}


def test_a_3d_scene_whose_file_is_missing_is_no_card_and_warns(tmp_path):
    p = _project([_scene3d()], [_seg("a", 1, 2)])
    changes, _, warnings = _plan2(p, tmp_path, None)
    assert changes == {} and len(warnings) == 1 and "scene-a" in warnings[0]


def test_the_projects_own_scene_is_models_active_json_and_scene_json_is_a_fallback(tmp_path):
    _scene(tmp_path, "", {"style": "studio"})
    p = _project([_scene3d(sid="")], [_seg("a", 1, 2)])
    assert ("id", "a") in _plan2(p, tmp_path, None)[0]
    fb = tmp_path / "fb"
    _scene(fb, "specs", {"style": "transparent"}, fallback=True)
    assert _plan2(_project([_scene3d()], [_seg("a", 1, 2)]), tmp_path, None, project_dir=fb)[0] == {}


def test_card_under_reads_a_scene_from_the_project_dir(tmp_path):
    _scene(tmp_path, "specs", {"style": "studio"})
    p = _project([_scene3d()])
    assert ci.card_under(p, 3, project_dir=str(tmp_path))["id"] == "scene-a"
    assert ci.card_under(p, 3) is None, "no folder, no scene file to read"
