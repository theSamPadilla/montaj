"""Compositing validation at save (§616 T7): mask, blendMode, clip opacity and keyframes."""
import copy

import pytest

from lib.overlay_validation import overlay_item_errors


def _proj(*items):
    return {"tracks": [{"id": "t0", "items": list(items)}]}


def _img(**over):
    item = {"id": "i1", "type": "image", "src": "/a.png", "start": 0, "end": 3}
    item.update(over)
    return item


def _vid(**over):
    item = {"id": "v1", "type": "video", "src": "/a.mp4", "start": 0, "end": 3}
    item.update(over)
    return item


def _errs(item, prior=None):
    return overlay_item_errors(_proj(item), previous=_proj(prior) if prior else None)


@pytest.mark.parametrize("make", [_img, _vid])
def test_valid_compositing_passes(make):
    item = make(
        opacity=0.5, blendMode="screen",
        mask={"shape": "rect", "x": 0.4, "w": 0.3, "h": 0.2, "rotation": 30, "radius": 1, "feather": 0.5, "invert": True},
        keyframes=[
            {"prop": "opacity", "points": [{"t": 0, "value": 0}, {"t": 1, "value": 1}]},
            {"prop": "maskX", "points": [{"t": 0, "value": -2}]},
            {"prop": "maskW", "points": [{"t": 0, "value": 0.2}]},
            {"prop": "cropX", "points": [{"t": 0, "value": 0.1}]},
            {"prop": "offsetX", "points": [{"t": 0, "value": 5}]},
        ])
    assert _errs(item) == []


@pytest.mark.parametrize("make", [_img, _vid])
@pytest.mark.parametrize("over,needle", [
    ({"mask": {"shape": "star"}}, "mask.shape must be one of ellipse, rect, wipe, path"),
    ({"mask": {}}, "mask.shape must be one of"),
    ({"mask": "ellipse"}, "mask must be an object"),
    ({"mask": {"shape": "ellipse", "x": float("nan")}}, "mask.x must be a finite number"),
    ({"mask": {"shape": "ellipse", "y": "a"}}, "mask.y must be a finite number"),
    ({"mask": {"shape": "ellipse", "rotation": float("inf")}}, "mask.rotation must be a finite number"),
    ({"mask": {"shape": "ellipse", "w": 0}}, "mask.w must be a number greater than 0"),
    ({"mask": {"shape": "ellipse", "h": -1}}, "mask.h must be a number greater than 0"),
    ({"mask": {"shape": "rect", "radius": 1.5}}, "mask.radius must be a number from 0 to 1"),
    ({"mask": {"shape": "rect", "feather": 1.2}}, "mask.feather must be a number from 0 to 1.0"),
    ({"mask": {"shape": "rect", "invert": 1}}, "mask.invert must be a boolean"),
    ({"mask": {"shape": "rect", "enabled": 0}}, "mask.enabled must be a boolean"),
    ({"mask": {"shape": "rect", "enabled": "false"}}, "mask.enabled must be a boolean"),
    ({"blendMode": "dodge"}, "blendMode must be one of normal, screen"),
    ({"opacity": 1.2}, "opacity must be a number from 0 to 1"),
    ({"opacity": -0.1}, "opacity must be a number from 0 to 1"),
    ({"keyframes": [{"prop": "blur", "points": []}]}, "keyframes[0].prop must be one of"),
    ({"keyframes": [{"prop": "maskX", "points": [{"t": 0, "value": 0.5}]}]}, "keyframes[0] maskX needs a mask"),
    ({"keyframes": [{"prop": "opacity", "points": [{"t": 0, "value": 2}]}]}, "keyframes[0].points[0].value must be a number from 0 to 1"),
    ({"keyframes": [{"prop": "offsetX", "points": [{"t": 0, "value": float("nan")}]}]}, "keyframes[0].points[0].value must be a finite number"),
    ({"mask": {"shape": "rect"}, "keyframes": [{"prop": "maskFeather", "points": [{"t": 0, "value": 1.5}]}]}, "must be a number from 0 to 1.0"),
    ({"mask": {"shape": "rect"}, "keyframes": [{"prop": "maskH", "points": [{"t": 0, "value": 0}]}]}, "must be a number greater than 0"),
])
def test_bad_compositing_is_named(make, over, needle):
    errors = _errs(make(**over))
    assert any(needle in e for e in errors), errors
    assert errors[0].startswith("tracks[0].items[0].")


@pytest.mark.parametrize("enabled", [True, False])
def test_mask_enabled_is_a_bool_and_a_disabled_mask_still_takes_tracks(enabled):
    item = _vid(
        mask={"shape": "ellipse", "w": 0.3, "enabled": enabled},
        keyframes=[{"prop": "maskX", "points": [{"t": 0, "value": 0.4}]}])
    assert _errs(item) == []


def test_nulls_and_unknown_fields_are_lenient():
    assert _errs(_img(mask=None, blendMode=None, opacity=None, whatever=1)) == []


def test_overlay_with_mask_or_blend_is_refused():
    ov = {"id": "o", "type": "overlay", "src": "/a.jsx", "start": 0, "end": 1, "mask": {"shape": "rect"}, "blendMode": "screen",
          "blur": 10}
    errors = _errs(ov)
    assert any(e.startswith("tracks[0].items[0].mask is not supported on overlay") for e in errors)
    assert any(".blendMode is not supported on overlay" in e for e in errors)
    assert any(".blur is not supported on overlay" in e for e in errors)


@pytest.mark.parametrize("make", [_img, _vid])
@pytest.mark.parametrize("blur", [0, 12.5, 200, None])
def test_a_blur_from_0_to_200_passes(make, blur):
    assert _errs(make(blur=blur)) == []


@pytest.mark.parametrize("make", [_img, _vid])
@pytest.mark.parametrize("blur", [-1, 200.5, "40", True, float("nan"), float("inf"), [40]])
def test_a_bad_blur_is_refused_naming_the_prop(make, blur):
    errors = _errs(make(blur=blur))
    assert len(errors) == 1 and ".blur must be a number from 0 to 200" in errors[0], errors


def test_unchanged_bad_item_is_not_rechecked():
    bad = _img(blendMode="dodge")
    assert _errs(copy.deepcopy(bad), prior=bad) == []


def test_only_the_changed_field_is_reported():
    prior = _img(blendMode="dodge", mask={"shape": "star"})
    cur = _img(blendMode="dodge", mask={"shape": "rect", "feather": 9})
    errors = _errs(cur, prior=prior)
    assert len(errors) == 1 and "mask.feather" in errors[0]


def test_prior_index_is_keyed_by_type():
    prior = _proj(_img(id="same", blendMode="dodge"))
    cur = _proj(_vid(id="same", blendMode="dodge"))
    errors = overlay_item_errors(cur, previous=prior)
    assert any("blendMode" in e for e in errors)


TRI = [[0.5, 0], [1, 1], [0, 1]]
QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]]


@pytest.mark.parametrize("make", [_img, _vid])
def test_path_mask_and_morph_track_pass(make):
    item = make(
        mask={"shape": "path", "points": QUAD, "smooth": True},
        keyframes=[{"prop": "maskPoints", "points": [{"t": 0, "value": QUAD}, {"t": 1, "value": [[0, 0], [1, 0], [1, 0.5], [0, 1]]}]}])
    assert _errs(item) == []


@pytest.mark.parametrize("points", [None, "x", [[0, 0], [1, 1]], [[0, 0], [1, 1], [0.5]], [[0, 0], [1, 1], [2, 0]],
                                     [[0, 0], [1, 1], [float("nan"), 0]], [[0.1, 0.1]] * 65])
def test_path_mask_points_are_checked(points):
    errors = _errs(_img(mask={"shape": "path", "points": points}))
    assert any("mask.points must be 3 to 64 [x, y] pairs from 0 to 1" in e for e in errors), errors


def test_path_smooth_must_be_bool_and_other_shapes_ignore_points():
    assert any("mask.smooth must be a boolean" in e for e in _errs(_img(mask={"shape": "path", "points": TRI, "smooth": 1})))
    assert _errs(_img(mask={"shape": "rect", "points": "junk", "smooth": 5})) == []


def test_morph_track_length_must_match_mask_points():
    item = _img(mask={"shape": "path", "points": [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]},
                keyframes=[{"prop": "maskPoints", "points": [{"t": 0, "value": [[0, 0]] * 5}, {"t": 1, "value": QUAD}]}])
    errors = _errs(item)
    assert any("keyframes[0].points[1].value must have 5 points, like mask.points (it has 4)" in e for e in errors), errors


def test_morph_track_values_must_be_point_lists():
    item = _img(mask={"shape": "path", "points": TRI},
                keyframes=[{"prop": "maskPoints", "points": [{"t": 0, "value": 0.5}, {"t": 1, "value": [[0, 0], [1, 1], [3, 3]]}]}])
    errors = _errs(item)
    assert sum("must be a list of [x, y] pairs from 0 to 1" in e for e in errors) == 2, errors


def test_morph_track_without_path_mask_is_strict_only():
    from lib.overlay_validation import item_problems
    item = _img(mask={"shape": "rect"}, keyframes=[{"prop": "maskPoints", "points": [{"t": 0, "value": TRI}]}])
    assert any("maskPoints needs a path mask" in p for _, p in item_problems(item))
    assert item_problems(item, strict=False) == []
