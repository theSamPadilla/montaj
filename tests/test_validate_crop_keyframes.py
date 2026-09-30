"""PV55: crop keyframes are for images and videos (not overlays) and in range."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))

import validate as v  # noqa: E402
from tests.conftest import FFMPEG_BIN, HAS_FFMPEG  # noqa: E402

BASE = {"version": "0.2", "id": "abc", "status": "pending", "workflow": "default", "editingPrompt": "t",
        "settings": {"resolution": [1080, 1920], "fps": 30}, "tracks": [[]], "assets": [], "audio": {}}


def _path(tmp_path, item):
    p = tmp_path / "project.json"
    p.write_text(json.dumps({**BASE, "tracks": [[item]]}))
    return str(p)


def _item(type_="image", **extra):
    return {"id": "i-0", "type": type_, "src": "p.jpg", "start": 0.0, "end": 2.0, **extra}


def _track(prop, *values):
    return {"prop": prop, "points": [{"t": float(i), "value": val} for i, val in enumerate(values)]}


def _error(capsys):
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


def test_image_crop_keyframes_in_range_pass(tmp_path):
    item = _item(keyframes=[_track("cropX", 0.0, 0.6), _track("cropW", 0.4, 0.4), _track("cropH", 1.0, 1.0)])
    assert v.validate_project(_path(tmp_path, item))["valid"] is True


@pytest.mark.parametrize("prop,bad", [("cropX", 1.2), ("cropY", -0.1), ("cropW", 0.0), ("cropH", 0.0), ("cropW", True), ("cropX", None)])
def test_out_of_range_crop_keyframe_fails(tmp_path, capsys, prop, bad):
    with pytest.raises(SystemExit):
        v.validate_project(_path(tmp_path, _item(keyframes=[_track(prop, 0.5, bad)])))
    err = _error(capsys)
    assert err["error"] == "invalid_field"
    assert prop in err["message"]


def _vtrack(prop, pairs, easing=None):
    pts = []
    for t, val in pairs:
        pt = {"t": float(t), "value": val}
        if easing is not None:
            pt["easing"] = easing[t] if isinstance(easing, dict) else easing
        pts.append(pt)
    return {"prop": prop, "points": pts}


def _video(kfs, dims=True, **extra):
    d = {"sourceWidth": 1920, "sourceHeight": 1080} if dims else {}
    return _item("video", keyframes=kfs, **d, **extra)


def _fails(tmp_path, capsys, item):
    with pytest.raises(SystemExit):
        v.validate_project(_path(tmp_path, item))
    err = _error(capsys)
    assert err["error"] == "invalid_field"
    return err["message"]


# 1920x1080 source: w=0.5625/h=1 is a 1080x1080 crop... aspect = w*1920/(h*1080).
def test_video_crop_keyframes_with_dims_and_one_aspect_pass(tmp_path):
    item = _video([_vtrack("cropX", [(0, 0.0), (2, 0.4)]),
                   _vtrack("cropW", [(0, 0.5), (2, 0.25)]),
                   _vtrack("cropH", [(0, 1.0), (2, 0.5)])])
    assert v.validate_project(_path(tmp_path, item))["valid"] is True


def test_video_crop_keyframes_only_x_y_need_no_pairing(tmp_path):
    # A static half-width crop, so the panned x stays inside the frame (fix 10).
    item = _video([_vtrack("cropX", [(0, 0.0), (2, 0.4)])], sourceCrop={"x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0})
    assert v.validate_project(_path(tmp_path, item))["valid"] is True


def test_video_crop_keyframes_without_source_dims_fail(tmp_path, capsys):
    msg = _fails(tmp_path, capsys, _video([_vtrack("cropX", [(0, 0.0), (2, 0.4)])], dims=False))
    assert "sourceWidth" in msg and "sourceHeight" in msg


def test_video_crop_only_one_of_w_h_keyed_fails(tmp_path, capsys):
    msg = _fails(tmp_path, capsys, _video([_vtrack("cropW", [(0, 0.5), (2, 0.4)])]))
    assert "only one of cropW/cropH is keyed" in msg


def test_video_crop_w_h_at_different_times_fails_naming_the_time(tmp_path, capsys):
    msg = _fails(tmp_path, capsys, _video([_vtrack("cropW", [(0, 0.5), (1, 0.4), (2, 0.3)]),
                                           _vtrack("cropH", [(0, 0.9), (2, 0.6)])]))
    assert "not keyed at the same times" in msg
    assert "t=1.0" in msg and "cropW" in msg and "cropH" in msg


def test_video_crop_w_h_with_different_easing_fails_naming_time_and_both(tmp_path, capsys):
    msg = _fails(tmp_path, capsys, _video([
        _vtrack("cropW", [(0, 0.5), (2, 0.25)], easing={0: "linear", 2: "linear"}),
        _vtrack("cropH", [(0, 1.0), (2, 0.5)], easing={0: "ease-in", 2: "linear"})]))
    assert "different easing at t=0.0" in msg
    assert "linear" in msg and "ease-in" in msg


def test_video_crop_absent_easing_equals_linear(tmp_path):
    item = _video([_vtrack("cropW", [(0, 0.5), (2, 0.25)], easing={0: "linear", 2: "linear"}),
                   _vtrack("cropH", [(0, 1.0), (2, 0.5)])])
    assert v.validate_project(_path(tmp_path, item))["valid"] is True


def test_video_crop_aspect_drift_fails_naming_both_keyframes(tmp_path, capsys):
    # t=0: 0.5*1920/(1*1080)=0.8889; t=2: 0.4*1920/(0.5*1080)=1.4222
    msg = _fails(tmp_path, capsys, _video([_vtrack("cropW", [(0, 0.5), (2, 0.4)]),
                                           _vtrack("cropH", [(0, 1.0), (2, 0.5)])]))
    assert "crop aspect at t=2.0 (1.4222) differs from t=0.0 (0.8889) by more than 1%" in msg
    assert "key cropW and cropH with one aspect" in msg
    assert "item 'i-0'" in msg


def test_video_crop_aspect_within_one_percent_passes(tmp_path):
    item = _video([_vtrack("cropW", [(0, 0.5), (2, 0.2505)]),
                   _vtrack("cropH", [(0, 1.0), (2, 0.5)])])
    assert v.validate_project(_path(tmp_path, item))["valid"] is True


def test_video_crop_out_of_range_value_fails(tmp_path, capsys):
    msg = _fails(tmp_path, capsys, _video([_vtrack("cropX", [(0, 0.0), (2, 1.5)])]))
    assert "cropX" in msg


def test_crop_keyframes_on_an_overlay_still_fail(tmp_path, capsys):
    # An overlay cannot be the primary clip, so it goes on track 1.
    p = tmp_path / "project.json"
    p.write_text(json.dumps({**BASE, "tracks": [[_item("video")], [_item("overlay", id="o-0", keyframes=[_track("cropX", 0.0, 0.5)])]]}))
    with pytest.raises(SystemExit):
        v.validate_project(str(p))
    err = _error(capsys)
    assert err["error"] == "invalid_field"
    msg = err["message"]
    assert "cropX" in msg and "image or video" in msg


def test_video_crop_point_without_t_fails(tmp_path, capsys):
    no_t = {"prop": "cropW", "points": [{"value": 0.5}, {"value": 0.25}]}
    item = _video([no_t, {"prop": "cropH", "points": [{"value": 1.0}, {"value": 0.5}]}])
    msg = _fails(tmp_path, capsys, item)
    assert "cropW" in msg and "i-0" in msg


def test_image_crop_point_without_t_fails(tmp_path, capsys):
    item = _item(keyframes=[{"prop": "cropX", "points": [{"value": 0.1}, {"t": 1.0, "value": 0.2}]}])
    msg = _fails(tmp_path, capsys, item)
    assert "cropX" in msg and "i-0" in msg


@pytest.mark.parametrize("bad_t", [True, "1", None, float("nan")])
def test_crop_point_non_numeric_t_fails(tmp_path, capsys, bad_t):
    item = _item(keyframes=[{"prop": "cropY", "points": [{"t": bad_t, "value": 0.1}]}])
    assert "cropY" in _fails(tmp_path, capsys, item)


@pytest.mark.parametrize("dims", [(0, 1080), (1920, 0)])
def test_video_crop_zero_source_size_fails(tmp_path, capsys, dims):
    item = _video([_vtrack("cropW", [(0, 0.5), (2, 0.25)]), _vtrack("cropH", [(0, 1.0), (2, 0.5)])],
                  dims=False, sourceWidth=dims[0], sourceHeight=dims[1])
    assert "sourceWidth and sourceHeight" in _fails(tmp_path, capsys, item)


def test_video_crop_only_keyframed_still_gets_the_dims_check(tmp_path, capsys):
    """A crop that is ONLY keyframed (no static sourceCrop) must reach the display-dims check."""
    if not HAS_FFMPEG:
        pytest.fail("ffmpeg missing: the dims check cannot be proven")
    clip = tmp_path / "c.mp4"
    subprocess.run([FFMPEG_BIN, "-y", "-f", "lavfi", "-i", "color=c=black:s=192x108:r=30", "-t", "1",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)], capture_output=True, check=True)
    item = {"id": "i-0", "type": "video", "src": str(clip), "start": 0.0, "end": 1.0,
            "sourceWidth": 108, "sourceHeight": 192,  # swapped: the clip displays 192x108
            "keyframes": [_vtrack("cropX", [(0, 0.0), (1, 0.0)])]}
    with pytest.raises(SystemExit):
        v.validate_project(_path(tmp_path, item))
    assert _error(capsys)["error"] == "source_dims_mismatch"


def test_crop_track_times_must_be_strictly_increasing(tmp_path, capsys):
    for pairs in ([(1, 0.1), (0, 0.2)], [(0, 0.1), (0, 0.2)]):
        msg = _fails(tmp_path, capsys, _item(keyframes=[_vtrack("cropX", pairs)]))
        assert "cropX keyframe times must be strictly increasing" in msg


def test_crop_prop_with_two_tracks_fails(tmp_path, capsys):
    msg = _fails(tmp_path, capsys, _video([_vtrack("cropX", [(0, 0.0), (1, 0.1)]), _vtrack("cropX", [(0, 0.2), (1, 0.3)])]))
    assert "more than one cropX track" in msg


def test_crop_window_past_the_edge_at_a_key_time_fails(tmp_path, capsys):
    item = _item(keyframes=[_vtrack("cropX", [(0, 0.0), (1, 0.7)]), _vtrack("cropW", [(0, 0.5), (1, 0.5)])])
    msg = _fails(tmp_path, capsys, item)
    assert "i-0" in msg and "t=1.0" in msg and "right" in msg
    item = _item(keyframes=[_vtrack("cropY", [(0, 0.0), (1, 0.8)])], sourceCrop={"x": 0, "y": 0, "w": 1, "h": 0.5})
    msg = _fails(tmp_path, capsys, item)
    assert "t=1.0" in msg and "bottom" in msg


def test_crop_window_within_rounding_tolerance_passes(tmp_path):
    # 0.5001 + 0.5 = 1.0001, inside the 1e-3 tolerance for 4-decimal agent output.
    item = _item(keyframes=[_vtrack("cropX", [(0, 0.0), (1, 0.5001)]), _vtrack("cropW", [(0, 0.5), (1, 0.5)])])
    assert v.validate_project(_path(tmp_path, item))["valid"] is True


def test_crop_edge_is_skipped_where_a_prop_is_keyed_but_not_at_that_time(tmp_path):
    # cropX is keyed only at t=2; cropW is keyed at 0 and 4, so its value at t=2 is
    # interpolated (0.5), not the full frame. 0.3 + 0.5 is inside; do not reject.
    item = _item(keyframes=[_vtrack("cropX", [(2, 0.3)]), _vtrack("cropW", [(0, 0.5), (4, 0.5)]),
                            _vtrack("cropH", [(0, 1.0), (4, 1.0)])])
    assert v.validate_project(_path(tmp_path, item))["valid"] is True


def test_video_crop_edge_is_skipped_where_x_is_keyed_but_w_is_not(tmp_path):
    item = _video([_vtrack("cropX", [(0, 0.0), (3, 0.4)]),
                   _vtrack("cropW", [(0, 0.5), (2, 0.5)]),
                   _vtrack("cropH", [(0, 1.0), (2, 1.0)])])
    assert v.validate_project(_path(tmp_path, item))["valid"] is True
