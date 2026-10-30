"""caption_ink (lib/caption_ink.py): which card is under a caption, how light its backdrop is, and what the plan
writes. The render is faked: a PNG per card, light for one and dark for another."""
import copy
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
    p = _project([_card("c-light", 0, 2), _card("c-light2", 2, 4)], [_seg("a", 1, 2), _seg("b", 2, 4)])
    changes, counts, warnings = _plan(p, tmp_path, light=("c-light", "c-light2"), fail_at=(1.5,))
    assert list(changes) == [("id", "b")]
    assert len(warnings) == 1 and "1.5" in warnings[0]


def test_frames_not_started_by_the_deadline_count_as_failed(tmp_path):
    calls = []
    p = _project([_card("c-light", 0, 2), _card("c-light2", 2, 4)], [_seg("a", 1, 2), _seg("b", 2, 4)])
    changes, _, warnings = _plan(p, tmp_path, light=("c-light", "c-light2"), calls=calls, deadline=time.monotonic() - 1)
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


def test_the_band_is_scaled_to_the_frames_real_size(tmp_path):
    """A capped frame is smaller than the design canvas: a light band at the scaled rows over a dark rest reads light."""
    p = _project([_card("s1", 0, 10)], [_seg("a", 1, 2)])
    _, y0, _, y1 = ci.band(p, p["captions"]["segments"][0], W, H)
    for scale in (2, 4):   # 540x960 and 270x480
        img = Image.new("RGB", (W // scale, H // scale), (10, 10, 10))
        img.paste((0xef, 0xec, 0xe4), (0, y0 // scale, W // scale, -(-y1 // scale)))
        path = tmp_path / f"band{scale}.png"
        img.save(path)
        changes, _, _ = ci.plan(p, lambda t: str(path), W, H)
        assert changes[("id", "a")]["ink"] == "dark"
        assert changes[("id", "a")]["inkAuto"]["backdrop"] > 0.7


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


def test_a_static_overlay_is_rendered_only_at_the_coarse_frames_either_side_of_its_captions(tmp_path):
    # Was one render at the middle of the overlay's span for every caption; an overlay is now judged at each caption's
    # own time. 30 fps: the fine grid is 8 frames, the coarse 32. a (mid 1.5 s, frame 48) lies between 32 and 64, b
    # (5.5 s, 168) between 160 and 192, c (8.5 s) is 256, on the coarse grid itself. The anchors agree, so nothing
    # between them is rendered.
    calls = []
    p = _project([_matte()], [_seg("a", 1, 2), _seg("b", 5, 6), _seg("c", 8, 9)])
    changes, _, _ = _plan2(p, tmp_path, _alpha_png(tmp_path, "m7", window=(60, 300, 1020, 900)), calls=calls)
    assert sorted(calls) == [("matte", n) for n in (32, 64, 160, 192, 256)], "each frame once"
    assert set(changes) == {("id", "a"), ("id", "b"), ("id", "c")}


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


# -- where the backdrop is read from -------------------------------------------------------------------------------

def _lum(rgb):
    p = _png(Path(__import__("tempfile").mkdtemp()), "ref", rgb)
    return ci.luminance(p, (0, 0, W, H), (W, H))


def _plan3(project, tmp_path, alpha, frames):
    def frame(t):
        frames.append(t)
        return _png(tmp_path, f"k{t}", (20, 20, 20))   # dark: a read from this frame would say "light"

    def overlay(item, n):
        return alpha
    return ci.plan(project, frame, W, H, overlay_fn=overlay, project_dir=str(tmp_path))


def test_a_matte_card_is_read_from_its_own_pixels_and_renders_no_frame(tmp_path):
    p = _project([_matte()], [_seg("a", 1, 2), _seg("b", 5, 6)])
    frames = []
    changes, counts, _ = _plan3(p, tmp_path, _alpha_png(tmp_path, "mm", window=(60, 300, 1020, 900)), frames)
    assert frames == [] and counts["dark"] == 2
    assert changes[("id", "a")]["inkAuto"]["backdrop"] == pytest.approx(_lum(PAPER[:3]), abs=0.002)


def test_only_the_pixels_the_overlay_covers_count(tmp_path):
    p = _project([_matte()], [_seg("a", 1, 2)])
    _, y0, _, y1 = _band_y(p, p["captions"]["segments"][0])
    img = Image.new("RGBA", (W // 2, H // 2), PAPER)
    img.paste((255, 0, 0, 0), (0, y0 // 2, W // 20, y1 // 2))   # 10% of the band is transparent (red, alpha 0)
    path = tmp_path / "part.png"
    img.save(path)
    changes, _, _ = _plan3(p, tmp_path, str(path), [])
    assert changes[("id", "a")]["inkAuto"]["backdrop"] == pytest.approx(_lum(PAPER[:3]), abs=0.002)


def test_an_opaque_jsx_card_is_its_pixels_over_black(tmp_path):
    p = _project([_matte(opaque=True)], [_seg("a", 1, 2)])
    _, y0, _, y1 = _band_y(p, p["captions"]["segments"][0])
    img = Image.new("RGBA", (W // 2, H // 2), (0, 0, 0, 0))
    img.paste(PAPER, (0, 0, W // 2, ((y0 + y1) // 2) // 2))   # paper over the top half of the band, nothing below
    path = tmp_path / "half.png"
    img.save(path)
    frames = []
    changes, counts, _ = _plan3(p, tmp_path, str(path), frames)
    assert frames == []
    assert changes[("id", "a")]["inkAuto"]["backdrop"] == pytest.approx(_lum(PAPER[:3]) / 2, abs=0.03)


def test_a_3d_item_is_rendered_once_for_all_its_captions_at_the_middle_of_their_span(tmp_path):
    calls = []
    p = _project([_card("s1", 0, 4), _card("s2", 4, 10)], [_seg("a", 1, 2), _seg("b", 2, 3), _seg("c", 5, 6), _seg("d", 7, 9)])
    changes, counts, _ = _plan(p, tmp_path, calls=calls)
    assert sorted(calls) == [2.0, 7.0], "s1: 1..3, s2: 5..9; one frame each"
    assert counts["dark"] + counts["light"] == 4 and len(changes) == 4


def test_a_failed_3d_frame_leaves_every_caption_over_that_item(tmp_path):
    p = _project([_card("s1", 0, 4), _card("s2", 4, 10)], [_seg("a", 1, 2), _seg("b", 2, 3), _seg("c", 5, 6)])
    changes, _, warnings = _plan(p, tmp_path, fail_at=(2.0,))
    assert list(changes) == [("id", "c")] and len(warnings) == 1 and "2.0" in warnings[0]


# -- a caption that straddles a card's edge is split --------------------------------------------------------------

def _words(*spec):
    """[(text, start, end)] as caption words."""
    return [{"word": w, "start": s, "end": e} for w, s, e in spec]


def _run(first, texts, step=0.5):
    out, t = [], first
    for w in texts:
        out.append((w, round(t, 3), round(t + step, 3)))
        t += step
    return out


def _straddler(i="a", spec=None, **kw):
    spec = spec or _run(1.0, ["one", "two", "three", "four", "five", "six"])
    return {"id": i, "text": " ".join(w for w, _, _ in spec), "start": spec[0][1], "end": spec[-1][2],
            "words": _words(*spec), **kw}


def _split_plan(project, tmp_path):
    changes, counts, warnings = _plan(project, tmp_path, light=("card",), dark=())
    return changes, counts, warnings


def test_a_caption_over_footage_then_a_card_splits_at_the_word_nearest_the_edge(tmp_path):
    seg = _straddler(lineHint="kept", style="pop", offsetY=-3, scale=1.1)
    p = _project([_card("card", 2.6, 10)], [seg])
    changes, counts, warnings = _split_plan(p, tmp_path)
    pieces = changes[("id", "a")]["split"]
    assert [x["id"] for x in pieces] == ["a", "cap-0"]
    assert [x["text"] for x in pieces] == ["one two three", "four five six"]
    # "four" (2.5-3.0) starts before the card: its piece is snapped to the card's start (see the snap tests below)
    assert [(x["start"], x["end"]) for x in pieces] == [(1.0, 2.6), (2.6, 4.0)]
    assert [w["word"] for w in pieces[1]["words"]] == ["four", "five", "six"]
    assert "ink" not in pieces[0] and "inkAuto" not in pieces[0]
    assert pieces[1]["ink"] == "dark" and pieces[1]["inkAuto"]["card"] == "card"
    for x in pieces:
        assert (x["lineHint"], x["style"], x["offsetY"], x["scale"]) == ("kept", "pop", -3, 1.1)
    assert (counts["split"], counts["dark"], counts["light"]) == (1, 1, 0) and warnings == []


def test_a_caption_over_a_card_then_footage_splits_at_the_cards_end(tmp_path):
    p = _project([_card("card", 0, 2.6)], [_straddler()])
    pieces = _split_plan(p, tmp_path)[0][("id", "a")]["split"]
    assert [x["text"] for x in pieces] == ["one two three", "four five six"]
    assert pieces[0]["ink"] == "dark" and "ink" not in pieces[1]


def test_footage_card_footage_is_three_pieces_with_fresh_ids(tmp_path):
    p = _project([_card("card", 2.0, 3.0)], [_straddler(), _seg("cap-0", 20, 21)])
    pieces = _split_plan(p, tmp_path)[0][("id", "a")]["split"]
    assert [x["text"] for x in pieces] == ["one two", "three four", "five six"]
    assert [x["id"] for x in pieces] == ["a", "cap-1", "cap-2"], "minted against every id in the captions"
    assert [(x["start"], x["end"]) for x in pieces] == [(1.0, 2.0), (2.0, 3.0), (3.0, 4.0)]
    assert ["ink" in x for x in pieces] == [False, True, False]


def test_a_caption_wholly_over_one_card_or_over_footage_is_not_split(tmp_path):
    for items in ([_card("card", 0, 10)], []):
        changes, counts, _ = _split_plan(_project(items, [_straddler()]), tmp_path)
        assert counts["split"] == 0 and all("split" not in (c or {}) for c in changes.values())


def test_two_different_cards_split_too(tmp_path):
    p = _project([_card("one", 0, 2.6), _card("two", 2.6, 10)], [_straddler()])
    changes, _, _ = _plan(p, tmp_path, light=("one",), dark=("two",))
    pieces = changes[("id", "a")]["split"]
    assert [(x["inkAuto"]["card"], x["ink"]) for x in pieces] == [("one", "dark"), ("two", "light")]


@pytest.mark.parametrize("seg", [
    {"ink": "light"},                                   # a person's ink
    {"ink": "dark", "inkAuto": _auto("card", "light")},  # a person changed what the step wrote
    {"inkAuto": _auto("card", "dark")},                  # a person removed it
])
def test_a_persons_caption_is_never_split(tmp_path, seg):
    p = _project([_card("card", 2.6, 10)], [_straddler(**seg)])
    changes, counts, _ = _split_plan(p, tmp_path)
    assert changes == {} and counts["split"] == 0 and counts["kept"] == 1


def test_a_translation_and_a_caption_with_one_are_never_split(tmp_path):
    src = _straddler()
    tr = _straddler("t", lang="es", translationOf=["a"])
    p = _project([_card("card", 2.0, 10)], [src, tr])   # the middle, 2.5 s, is over the card
    changes, counts, _ = _split_plan(p, tmp_path)
    assert counts["split"] == 0 and list(changes) == [("id", "a")] and "split" not in changes[("id", "a")]


def test_one_word_and_no_word_times_are_not_split(tmp_path):
    one = _straddler(spec=[("solo", 2.0, 4.0)])
    untimed = {"id": "u", "text": "no times here", "start": 1.0, "end": 4.0,
               "words": [{"word": "no"}, {"word": "times"}, {"word": "here"}]}
    nowords = _seg("n", 1.0, 4.0)
    p = _project([_card("card", 2.6, 10)], [one, untimed, nowords])
    changes, counts, _ = _split_plan(p, tmp_path)
    assert counts["split"] == 0 and all("split" not in (c or {}) for c in changes.values())


def test_a_piece_shorter_than_a_quarter_second_keeps_the_ink_of_the_whole_captions_middle(tmp_path):
    short = _straddler("s", _run(1.0, ["a", "b", "c", "d", "e"]) + [("f", 3.5, 3.6)])
    p = _project([_card("card", 3.52, 10)], [short])
    changes, counts, _ = _split_plan(p, tmp_path)   # the middle, 2.3 s, is over footage
    assert changes == {} and counts["split"] == 0


def test_a_caption_with_no_id_is_not_split(tmp_path):
    seg = _straddler()
    del seg["id"]
    changes, counts, _ = _split_plan(_project([_card("card", 2.6, 10)], [seg]), tmp_path)
    assert counts["split"] == 0 and all("split" not in (c or {}) for c in changes.values())


def test_a_failed_backdrop_frame_leaves_a_split_caption_whole(tmp_path):
    p = _project([_card("card", 2.6, 10)], [_straddler()])
    changes, counts, warnings = _plan(p, tmp_path, light=("card",), fail_at=(3.25,))
    assert changes == {} and counts["split"] == 0 and len(warnings) == 1 and "3.25" in warnings[0]


def _read_of(project):
    return {ci._key(s, i): dict(s) for i, s in enumerate(project["captions"]["segments"]) if isinstance(s, dict)}


def _split_change(tmp_path, project=None):
    p = project or _project([_card("card", 2.6, 10)], [_straddler(), _seg("z", 20, 21)])
    changes, _, _ = _split_plan(p, tmp_path)
    return p, changes


def test_apply_replaces_the_caption_with_its_pieces_in_place(tmp_path):
    p, changes = _split_change(tmp_path)
    read = _read_of(p)
    fresh = json_copy(p)
    assert ci.apply_changes(fresh, changes, read) is True
    segs = fresh["captions"]["segments"]
    assert [s["id"] for s in segs] == ["a", "cap-0", "z"]
    assert "ink" not in segs[0] and segs[1]["ink"] == "dark"


def json_copy(p):
    import json
    return json.loads(json.dumps(p))


@pytest.mark.parametrize("edit", [{"text": "edited"}, {"start": 1.1}, {"style": "clean"}, {"ink": "light"}])
def test_a_split_refuses_when_the_whole_segment_differs_from_what_was_read(tmp_path, edit):
    p, changes = _split_change(tmp_path)
    read = _read_of(p)
    fresh = json_copy(p)
    fresh["captions"]["segments"][0].update(edit)
    with pytest.raises(ci.InkProjectChanged):
        ci.apply_changes(fresh, changes, read)
    assert [s["id"] for s in fresh["captions"]["segments"]] == ["a", "z"]


def test_a_split_refuses_when_a_minted_id_is_taken_now(tmp_path):
    p, changes = _split_change(tmp_path)
    read = _read_of(p)
    fresh = json_copy(p)
    fresh["captions"]["segments"].append(_seg("cap-0", 30, 31))
    with pytest.raises(ci.InkProjectChanged):
        ci.apply_changes(fresh, changes, read)
    assert len(fresh["captions"]["segments"]) == 3


def test_a_split_refuses_when_the_card_under_a_piece_is_gone(tmp_path):
    p, changes = _split_change(tmp_path)
    read = _read_of(p)
    fresh = json_copy(p)
    fresh["tracks"][1]["items"] = []
    with pytest.raises(ci.InkProjectChanged):
        ci.apply_changes(fresh, changes, read)


def test_splitting_is_idempotent(tmp_path):
    p, changes = _split_change(tmp_path)
    fresh = json_copy(p)
    ci.apply_changes(fresh, changes, _read_of(p))
    again, counts, warnings = _split_plan(fresh, tmp_path)
    assert counts["split"] == 0 and warnings == []
    assert ci.apply_changes(json_copy(fresh), again, _read_of(fresh)) is False


# -- the 3D backdrop cache ---------------------------------------------------------------------------------------

def _cached(project, tmp_path, calls, shade=(0xef, 0xec, 0xe4)):
    def render(t):
        calls.append(t)
        return _png(tmp_path, f"c{len(calls)}", shade)
    return ci.plan(project, render, W, H, project_dir=str(tmp_path), cache_path=str(tmp_path / "cache.json"))


def _cache_project(tmp_path, segs=None):
    _scene(tmp_path, "specs", {"style": "studio"})
    (tmp_path / "overlays").mkdir(exist_ok=True)
    (tmp_path / "overlays" / "tag.jsx").write_text("export default () => null")
    tag = {"id": "tag", "type": "overlay", "src": "./overlays/tag.jsx", "start": 0, "end": 10, "scale": 0.3,
           "offsetY": -500, "props": {"label": "a"}}
    return _project([_scene3d("s1", "specs", opaque=False), tag], segs or [_seg("a", 1, 2)])


def test_a_second_plan_over_the_same_project_renders_no_3d_frame(tmp_path):
    p = _cache_project(tmp_path)
    calls = []
    first = _cached(p, tmp_path, calls)
    second = _cached(p, tmp_path, calls)
    assert len(calls) == 1
    assert second[0] == first[0] and second[1] == first[1]
    assert first[0][("id", "a")]["inkAuto"]["backdrop"] > 0.7


def _edit_scene(p, d):
    _scene(d, "specs", {"style": "color", "wall": "#000000"})


def _edit_overlay(p, d):
    (d / "overlays" / "tag.jsx").write_text("export default () => 1")


def _edit_props(p, d):
    p["tracks"][1]["items"][1]["props"]["label"] = "b"


def _edit_geometry(p, d):
    p["tracks"][1]["items"][1]["offsetY"] = -400


def _edit_resolution(p, d):
    p["settings"]["resolution"] = [W * 2, H * 2]


def _edit_time(p, d):
    p["captions"]["segments"][0].update(start=3, end=4)


@pytest.mark.parametrize("edit", [_edit_scene, _edit_overlay, _edit_props, _edit_geometry, _edit_resolution, _edit_time])
def test_what_is_on_screen_changing_is_a_miss(tmp_path, edit):
    p = _cache_project(tmp_path)
    calls = []
    _cached(p, tmp_path, calls)
    edit(p, tmp_path)
    _cached(p, tmp_path, calls)
    assert len(calls) == 2


def test_a_caption_only_change_is_a_hit(tmp_path):
    p = _cache_project(tmp_path)
    calls = []
    _cached(p, tmp_path, calls)
    seg = p["captions"]["segments"][0]
    seg["text"] = "another line"
    p["captions"]["style"] = "outline"
    changes, _, _ = _cached(p, tmp_path, calls)
    assert len(calls) == 1 and changes[("id", "a")]["ink"] == "dark"


def test_a_corrupt_cache_is_a_miss_not_an_error(tmp_path):
    p = _cache_project(tmp_path)
    calls = []
    _cached(p, tmp_path, calls)
    (tmp_path / "cache.json").write_text("{not json")
    _cached(p, tmp_path, calls)
    assert len(calls) == 2
    _cached(p, tmp_path, calls)   # and the write after it healed the file
    assert len(calls) == 2


def test_the_cache_keeps_at_most_its_cap_of_entries(tmp_path, monkeypatch):
    import json
    monkeypatch.setattr(ci, "CACHE_MAX_ENTRIES", 3)
    calls = []
    for i in range(5):
        _cached(_cache_project(tmp_path, [_seg("a", 1 + i, 2 + i)]), tmp_path, calls)
    assert len(calls) == 5
    entries = json.loads((tmp_path / "cache.json").read_text())["entries"]
    assert len(entries) == 3
    _cached(_cache_project(tmp_path, [_seg("a", 5, 6)]), tmp_path, calls)   # the newest is kept
    assert len(calls) == 5


# -- the overlay-alone cache -------------------------------------------------------------------------------------

def _ov_cached(project, tmp_path, calls, alpha=None):
    alpha = alpha or _alpha_png(tmp_path, "ovc", window=(60, 300, 1020, 900))

    def overlay(item, n):
        calls.append((item["id"], n))
        return alpha

    def frame(t):
        raise AssertionError("a JSX card renders no frame")
    return ci.plan(project, frame, W, H, overlay_fn=overlay, project_dir=str(tmp_path),
                   cache_path=str(tmp_path / "cache.json"))


def _ov_project(tmp_path, **kw):
    (tmp_path / "overlays").mkdir(exist_ok=True)
    (tmp_path / "overlays" / "footage-card.jsx").write_text("export default () => null")
    return _project([_matte(props={"label": "a"}, **kw)], [_seg("a", 1, 2), _seg("b", 5, 6)])


@pytest.mark.parametrize("opaque", [False, True])
def test_a_second_plan_renders_no_overlay_and_reads_the_same(tmp_path, opaque):
    p = _ov_project(tmp_path, opaque=opaque)
    calls = []
    first = _ov_cached(p, tmp_path, calls)
    rendered = len(calls)
    second = _ov_cached(p, tmp_path, calls)
    assert rendered and len(calls) == rendered, "the second plan renders nothing"
    assert second[0] == first[0] and second[1] == first[1]
    plain = _plan2(p, tmp_path, _alpha_png(tmp_path, "ovc", window=(60, 300, 1020, 900)))
    assert first[0] == plain[0], "cached rows give the numbers the PNG gives"


def test_the_cached_read_is_the_pixels_the_overlay_covers(tmp_path):
    p = _ov_project(tmp_path)
    _, y0, _, y1 = _band_y(p, p["captions"]["segments"][0])
    img = Image.new("RGBA", (W // 2, H // 2), PAPER)
    img.paste((255, 0, 0, 0), (0, y0 // 2, W // 20, y1 // 2))
    path = tmp_path / "part2.png"
    img.save(path)
    changes, _, _ = _ov_cached(p, tmp_path, [], str(path))
    again, _, _ = _ov_cached(p, tmp_path, [], str(path))
    assert again == changes
    assert changes[("id", "a")]["inkAuto"]["backdrop"] == pytest.approx(_lum(PAPER[:3]), abs=0.002)


def _edit_ov_file(p, d):
    (d / "overlays" / "footage-card.jsx").write_text("export default () => 1")


def _edit_ov_props(p, d):
    p["tracks"][1]["items"][0]["props"]["label"] = "b"


def _edit_ov_resolution(p, d):
    p["settings"]["resolution"] = [1080, 1080]   # another design size


@pytest.mark.parametrize("edit", [_edit_ov_file, _edit_ov_props, _edit_ov_resolution])
def test_an_overlay_changing_is_a_miss(tmp_path, edit):
    p = _ov_project(tmp_path)
    calls = []
    _ov_cached(p, tmp_path, calls)
    rendered = len(calls)
    edit(p, tmp_path)
    _ov_cached(p, tmp_path, calls)
    assert rendered and len(calls) == 2 * rendered


def test_a_caption_only_change_does_not_render_an_overlay(tmp_path):
    p = _ov_project(tmp_path)
    calls = []
    _ov_cached(p, tmp_path, calls)
    rendered = len(calls)
    p["captions"]["segments"][0]["text"] = "another line"
    _ov_cached(p, tmp_path, calls)
    assert rendered and len(calls) == rendered


# -- a caption that overhangs its card by a few frames is snapped to the card's edge -------------------------------
# pl89h: "supplies a camera, compute, sensors, and a" ran 42.89-45.53 over a footage card from 43.00; every word's middle
# was on the card, so it was inked dark from 42.89 and drawn dark over the talking head for 3 frames.

def _snap_plan(project, tmp_path, light=("card",), dark=()):
    return _plan(project, tmp_path, light=light, dark=dark)


def _pl89h(**kw):
    spec = [("supplies", 42.89, 43.3), ("a", 43.3, 43.4), ("camera,", 43.4, 43.9), ("compute,", 43.9, 44.5),
            ("sensors,", 44.5, 45.0), ("and", 45.0, 45.3), ("a", 45.3, 45.53)]
    return _straddler("cap-26", spec, **kw)


def test_a_caption_starting_frames_before_its_card_is_snapped_to_the_cards_start(tmp_path):
    p = _project([_card("card", 43.0, 47.7)], [_pl89h()], base=_video(end=60))
    changes, counts, warnings = _snap_plan(p, tmp_path)
    ch = changes[("id", "cap-26")]
    assert ch["ink"] == "dark" and ch["inkAuto"]["card"] == "card"
    assert ch["start"] == 43.0 and ch["words"][0] == {"word": "supplies", "start": 43.0, "end": 43.3}
    assert [w["word"] for w in ch["words"]] == ["supplies", "a", "camera,", "compute,", "sensors,", "and", "a"]
    assert "end" not in ch, "the end is inside the card"
    assert (counts["dark"], counts["snapped"], counts["split"], counts["kept"]) == (1, 1, 0, 0) and warnings == []


def test_a_caption_ending_frames_after_its_card_is_snapped_to_the_cards_end(tmp_path):
    spec = [("one", 1.0, 1.4), ("two", 1.4, 1.7), ("three", 1.7, 2.12)]
    p = _project([_card("card", 0, 2.0)], [_straddler("a", spec)])
    changes, counts, _ = _snap_plan(p, tmp_path)
    ch = changes[("id", "a")]
    assert ch["end"] == 2.0 and ch["words"][-1] == {"word": "three", "start": 1.7, "end": 2.0}
    assert "start" not in ch and counts["snapped"] == 1


def test_an_overhang_that_shows_no_frame_is_left(tmp_path):
    # 34.49 against a card from 34.5: no frame (n/30) falls in between
    spec = [("walk", 34.49, 34.78), ("only", 34.78, 35.1)]
    p = _project([_card("card", 34.5, 40)], [_straddler("a", spec)], base=_video(end=60))
    changes, counts, _ = _snap_plan(p, tmp_path)
    assert set(changes[("id", "a")]) == {"ink", "inkAuto"} and counts["snapped"] == 0


def test_an_overhang_onto_another_card_is_left(tmp_path):
    p = _project([_card("other", 30, 43.0), _card("card", 43.0, 47.7)], [_pl89h()], base=_video(end=60))
    changes, counts, _ = _plan(p, tmp_path, light=("card", "other"), dark=())
    assert set(changes[("id", "cap-26")]) == {"ink", "inkAuto"} and counts["snapped"] == 0


def test_a_light_ink_caption_is_not_snapped(tmp_path):
    p = _project([_card("card", 43.0, 47.7)], [_pl89h()], base=_video(end=60))
    changes, counts, _ = _snap_plan(p, tmp_path, light=(), dark=("card",))
    assert set(changes[("id", "cap-26")]) == {"ink", "inkAuto"} and changes[("id", "cap-26")]["ink"] == "light"
    assert counts["snapped"] == 0


def test_a_snap_that_would_leave_a_word_no_time_on_screen_keeps_the_caption_light(tmp_path):
    # "so and" end before the card starts: two words, too short a piece to split off, so the caption is one run
    spec = [("so", 0.9, 0.93), ("and", 0.93, 0.96), ("then", 0.96, 1.5), ("it", 1.5, 2.0), ("goes", 2.0, 2.5)]
    p = _project([_card("card", 1.0, 10)], [_straddler("a", spec)])
    changes, counts, _ = _snap_plan(p, tmp_path)
    assert changes == {} and (counts["kept"], counts["dark"], counts["snapped"]) == (1, 0, 0)


def test_ink_of_ours_is_cleared_when_the_snap_cannot_be_made(tmp_path):
    spec = [("so", 0.9, 0.93), ("and", 0.93, 0.96), ("then", 0.96, 1.5), ("it", 1.5, 2.0), ("goes", 2.0, 2.5)]
    seg = _straddler("a", spec, ink="dark", inkAuto={"card": "card", "ink": "dark", "backdrop": 0.83})
    p = _project([_card("card", 1.0, 10)], [seg])
    changes, counts, _ = _snap_plan(p, tmp_path)
    assert changes == {("id", "a"): None} and counts["kept"] == 1


def test_a_split_piece_starting_before_its_card_is_snapped_and_the_piece_before_holds_to_it(tmp_path):
    # "four" (2.5-3.0) straddles the card's start at 2.6: its middle is on the card
    p = _project([_card("card", 2.6, 10)], [_straddler()])
    pieces = _split_plan(p, tmp_path)[0][("id", "a")]["split"]
    assert [(x["start"], x["end"]) for x in pieces] == [(1.0, 2.6), (2.6, 4.0)]
    assert pieces[0]["words"][-1]["end"] == 2.5, "the footage piece holds its last word on screen, its time unchanged"
    assert pieces[1]["words"][0] == {"word": "four", "start": 2.6, "end": 3.0}


def test_the_snap_is_written_and_is_idempotent(tmp_path):
    p = _project([_card("card", 43.0, 47.7)], [_pl89h()], base=_video(end=60))
    changes, _, _ = _snap_plan(p, tmp_path)
    fresh = json_copy(p)
    assert ci.apply_changes(fresh, changes, _read_of(p)) is True
    seg = fresh["captions"]["segments"][0]
    assert seg["start"] == 43.0 and seg["words"][0]["start"] == 43.0 and seg["ink"] == "dark"
    again, counts, _ = _snap_plan(fresh, tmp_path)
    assert ci.apply_changes(json_copy(fresh), again, _read_of(fresh)) is False and counts["snapped"] == 0


def test_a_snap_refuses_when_the_caption_changed_since_it_was_read(tmp_path):
    p = _project([_card("card", 43.0, 47.7)], [_pl89h()], base=_video(end=60))
    changes, _, _ = _snap_plan(p, tmp_path)
    fresh = json_copy(p)
    fresh["captions"]["segments"][0]["start"] = 42.8
    with pytest.raises(ci.InkProjectChanged):
        ci.apply_changes(fresh, changes, _read_of(p))
    assert fresh["captions"]["segments"][0]["start"] == 42.8


def test_aside_a_short_edge_word_over_footage_splits_off_and_the_rest_snaps(tmp_path):
    # pl89h: "pounds and costs about $400. That is, aside" (10.333-12.891) over the specs 3D, which ends at 12.6. "aside"
    # (12.665-12.891, 0.226 s) is over the talking head: under the split's floor, but a whole word at the edge.
    spec = [("pounds", 10.333, 10.7), ("and", 10.7, 10.9), ("costs", 10.9, 11.3), ("about", 11.3, 11.6),
            ("$400.", 11.6, 12.2), ("That", 12.311, 12.488), ("is,", 12.488, 12.665), ("aside", 12.665, 12.891)]
    p = _project([_card("card", 7.23, 12.6)], [_straddler("cap-4", spec), _seg("cap-0", 20, 21)], base=_video(end=60))
    changes, counts, _ = _split_plan(p, tmp_path)
    pieces = changes[("id", "cap-4")]["split"]
    assert [x["text"] for x in pieces] == ["pounds and costs about $400. That is,", "aside"]
    assert [(x["start"], x["end"]) for x in pieces] == [(10.333, 12.6), (12.6, 12.891)]
    assert pieces[0]["ink"] == "dark" and pieces[0]["words"][-1] == {"word": "is,", "start": 12.488, "end": 12.6}
    assert "ink" not in pieces[1] and pieces[1]["words"] == [{"word": "aside", "start": 12.665, "end": 12.891}]
    assert [x["id"] for x in pieces] == ["cap-4", "cap-1"]
    assert (counts["split"], counts["snapped"], counts["dark"]) == (1, 1, 1)


def test_a_short_edge_piece_of_two_words_or_inside_the_caption_still_does_not_split(tmp_path):
    # two words at the edge, 0.2 s: no split (the snap then cannot be made, so the caption is kept)
    spec = _run(1.0, ["one", "two", "three", "four"]) + [("five", 3.0, 3.1), ("six", 3.1, 3.2)]
    p = _project([_card("card", 0, 3.0)], [_straddler("a", spec)])
    changes, counts, _ = _split_plan(p, tmp_path)
    assert counts["split"] == 0
    # a short word over footage between two runs on the card: not an edge, no split
    spec = _run(1.0, ["one", "two", "three"]) + [("four", 2.5, 2.6)] + _run(2.6, ["five", "six", "seven"])
    p = _project([_card("card", 0, 2.5), _card("card2", 2.6, 10)], [_straddler("b", spec)])
    changes, counts, _ = _plan(p, tmp_path, light=("card", "card2"), dark=())
    assert counts["split"] == 0


# -- an overlay whose coverage changes over its span is judged at each caption's own time ------------------------
# A footage card (a paper surround with a hole where the clip below is): the clip starts full-screen, so the hole is
# the whole frame and the overlay covers nothing in the band, then shrinks into a card and the surround covers the
# band. It was judged at the middle of its span for every caption over it: settled, a card, so the words over the
# full-screen clip were inked dark over footage.

SWITCH = 78   # 2.6 s at 30 fps: the frame from which the surround covers the band


def _settling(tmp_path):
    clear, card = _alpha_png(tmp_path, "settle-clear", window="all"), _alpha_png(tmp_path, "settle-card", window=(60, 300, 1020, 900))
    return lambda item, n: card if n >= SWITCH else clear


def _settle_project(tmp_path, segs):
    (tmp_path / "overlays").mkdir(exist_ok=True)
    (tmp_path / "overlays" / "footage-card.jsx").write_text("export default () => null")
    return _project([_matte(end=6)], segs)


def _settle_plan(project, tmp_path, calls=None, cache=True):
    alpha = _settling(tmp_path)

    def overlay(item, n):
        if calls is not None:
            calls.append(n)
        return alpha(item, n)

    def frame(t):
        raise AssertionError("a JSX card renders no frame")
    return ci.plan(project, frame, W, H, overlay_fn=overlay, project_dir=str(tmp_path),
                   cache_path=str(tmp_path / "cache.json") if cache else None)


def test_a_caption_before_the_card_settles_is_over_footage_and_one_after_is_dark(tmp_path):
    p = _settle_project(tmp_path, [_seg("pre", 0.2, 0.8), _seg("post", 4.5, 5.5)])
    changes, counts, warnings = _settle_plan(p, tmp_path)
    assert ("id", "pre") not in changes, "at 0.5 s the overlay covers nothing in the band: the caption is over footage"
    assert changes[("id", "post")]["ink"] == "dark" and changes[("id", "post")]["inkAuto"]["card"] == "matte"
    assert changes[("id", "post")]["inkAuto"]["backdrop"] == pytest.approx(_lum(PAPER[:3]), abs=0.002)
    assert (counts["dark"], counts["light"]) == (1, 0) and warnings == []


def test_ink_of_ours_set_at_the_cards_middle_is_cleared_where_the_card_is_not_there_yet(tmp_path):
    p = _settle_project(tmp_path, [_seg("pre", 0.2, 0.8, ink="dark", inkAuto=_auto("matte", "dark"))])
    changes, counts, _ = _settle_plan(p, tmp_path)
    assert changes == {("id", "pre"): None} and counts["cleared"] == 1


def test_a_caption_straddling_the_moment_the_card_reaches_the_band_is_split(tmp_path):
    p = _settle_project(tmp_path, [_straddler(), _seg("pre", 0.2, 0.8), _seg("post", 4.5, 5.5)])
    calls = []
    changes, counts, warnings = _settle_plan(p, tmp_path, calls)
    pieces = changes[("id", "a")]["split"]
    # word middles 1.25 .. 3.75 s are frames 40, 56, 64 (before 78) and 80, 96, 112 (after)
    assert [x["text"] for x in pieces] == ["one two three", "four five six"]
    # "four" starts at 2.5 s, over footage: the dark piece starts half a frame before 80, the first grid frame that
    # shows the card (72 does not), and the piece before holds its text up to it
    assert [(x["start"], x["end"]) for x in pieces] == [(1.0, 2.65), (2.65, 4.0)]
    assert pieces[1]["words"][0] == {"word": "four", "start": 2.65, "end": 3.0}
    assert "ink" not in pieces[0] and pieces[1]["ink"] == "dark" and pieces[1]["inkAuto"]["card"] == "matte"
    assert ("id", "pre") not in changes and changes[("id", "post")]["ink"] == "dark"
    assert (counts["split"], counts["snapped"], counts["dark"]) == (1, 1, 2) and warnings == []
    # the coarse frames either side of every caption (0..160, 32 apart); 80, where 64 and 96 disagree; 72, the dark
    # piece's first grid frame, between 64 and 80, which disagree. Nothing else: the card is the same between the rest.
    assert sorted(calls) == [0, 32, 64, 72, 80, 96, 128, 160]


def test_a_rerun_over_an_unchanged_settling_card_renders_nothing_and_says_the_same(tmp_path):
    p = _settle_project(tmp_path, [_straddler(), _seg("pre", 0.2, 0.8), _seg("post", 4.5, 5.5)])
    calls = []
    first = _settle_plan(p, tmp_path, calls)
    rendered = len(calls)
    second = _settle_plan(p, tmp_path, calls)
    assert rendered == 8 and len(calls) == rendered, "every frame is a cache hit"
    assert second[0] == first[0] and second[1] == first[1]


def test_the_split_is_written_is_idempotent_and_look_reports_nothing(tmp_path):
    from lib import look_check as lc
    p = _settle_project(tmp_path, [_straddler(), _seg("post", 4.5, 5.5)])
    changes, _, _ = _settle_plan(p, tmp_path)
    fresh = copy.deepcopy(p)
    assert ci.apply_changes(fresh, changes, _read_of(p), str(tmp_path))
    assert lc.caption_ink_issues(fresh, str(tmp_path)) == [], "each piece was judged at its own time"
    again, counts, _ = _settle_plan(fresh, tmp_path)
    assert counts["split"] == 0
    assert not ci.apply_changes(copy.deepcopy(fresh), again, _read_of(fresh), str(tmp_path))


def test_the_frame_for_a_time_is_on_the_quarter_second_grid_within_the_span():
    item = _matte(start=10, end=12.1)   # 63 frames: 0..62; 12.09 s is nearest grid frame 64, past the last
    assert [ci._frame_at(item, t, 30) for t in (10, 10.1, 10.14, 11.5, 11.99, 12.09)] == [0, 0, 8, 48, 56, 62]


def test_a_dark_piece_ends_where_the_card_leaves_the_band(tmp_path):
    # the reverse: the surround covers the band up to 2.4 s (frame 72) and then opens onto footage
    clear, card = _alpha_png(tmp_path, "leave-clear", window="all"), _alpha_png(tmp_path, "leave-card", window=(60, 300, 1020, 900))
    p = _settle_project(tmp_path, [_straddler()])
    changes, counts, warnings = ci.plan(p, lambda t: None, W, H, overlay_fn=lambda item, n: card if n < 72 else clear,
                                        project_dir=str(tmp_path))
    pieces = changes[("id", "a")]["split"]
    assert [x["text"] for x in pieces] == ["one two three", "four five six"]
    # "three" ends at 2.5 s, over footage from 2.4: the dark piece ends half a frame after 64, the last grid frame that
    # shows the card (72 does not), and the piece after starts there
    assert [(x["start"], x["end"]) for x in pieces] == [(1.0, 2.15), (2.15, 4.0)]
    assert pieces[0]["ink"] == "dark" and "ink" not in pieces[1]
    assert pieces[0]["words"][-1] == {"word": "three", "start": 2.0, "end": 2.15}
    assert (counts["split"], counts["snapped"]) == (1, 1) and warnings == []


def test_a_snapped_piece_is_read_where_it_will_show_so_a_second_pass_changes_nothing(tmp_path):
    # the card covers up to frame 72 and is a lighter paper from frame 56: the dark piece (1.0 to 2.5 s, middle frame
    # 56) is snapped to end at 2.15 s (middle frame 48), so it is read at 48, where the next pass will read it too
    clear = _alpha_png(tmp_path, "shade-clear", window="all")
    shades = {}
    for name, rgb in (("a", (0xd8, 0xd4, 0xc8)), ("b", PAPER[:3])):
        img = Image.new("RGBA", (W // 2, H // 2), (*rgb, 255))
        img.paste((0, 0, 0, 0), (30, 150, 510, 450))
        img.save(tmp_path / f"shade-{name}.png")
        shades[name] = str(tmp_path / f"shade-{name}.png")

    def overlay(item, n):
        return clear if n >= 72 else shades["b" if n >= 56 else "a"]
    p = _settle_project(tmp_path, [_straddler()])
    changes, _, _ = ci.plan(p, lambda t: None, W, H, overlay_fn=overlay, project_dir=str(tmp_path))
    piece = changes[("id", "a")]["split"][0]
    assert (piece["start"], piece["end"]) == (1.0, 2.15)
    assert piece["inkAuto"]["backdrop"] == pytest.approx(_lum((0xd8, 0xd4, 0xc8)), abs=0.002)
    fresh = copy.deepcopy(p)
    assert ci.apply_changes(fresh, changes, _read_of(p), str(tmp_path))
    again, _, _ = ci.plan(fresh, lambda t: None, W, H, overlay_fn=overlay, project_dir=str(tmp_path))
    assert not ci.apply_changes(copy.deepcopy(fresh), again, _read_of(fresh), str(tmp_path))
