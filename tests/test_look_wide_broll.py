"""1.5.0 (CV pl89r): the demo's b-roll sat in the split's top half showing its whole over-the-shoulder frame
(sourceCrop x 0.066 w 0.868 h 1), so the gesture each line named was a small part of a small slot. look says so: a wide
b-roll shown nearly whole on a vertical canvas, not tracked and not carded by frame_broll."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import look_check as lc  # noqa: E402


def project(items):
    return {"settings": {"resolution": [1080, 1920]},
            "sources": [{"id": "clip-12", "src": "/w/ots.mov", "sourceWidth": 3840, "sourceHeight": 2160}],
            "tracks": [{"id": "trk-0", "items": []}, {"id": "br", "items": items}]}


def item(id_, **kw):
    return {"id": id_, "type": "video", "src": "/w/ots.mov", "start": 37.28, "end": 39.82, "inPoint": 286, "outPoint": 288.5,
            "offsetY": -31.8, **kw}


def test_a_wide_shot_shown_whole_in_a_vertical_edit_is_named():
    issues = lc.wide_broll_issues(project([item("br-fist", sourceCrop={"x": 0.066, "y": 0, "w": 0.868, "h": 1})]))
    assert len(issues) == 1 and issues[0]["id"] == "br-fist" and issues[0]["t"] == 37.28
    assert "crop it to what its line is about" in issues[0]["text"]


def test_a_cropped_tracked_or_carded_shot_is_not():
    cropped = item("a", sourceCrop={"x": 0.3, "y": 0.2, "w": 0.35, "h": 0.6})
    tracked = item("b", keyframes=[{"prop": "cropX", "points": [{"t": 0, "value": 0.2}]}])
    carded = item("c")
    card = {"id": "ov-c", "type": "overlay", "src": "./overlays/footage-card.jsx", "start": 37.28, "end": 39.82, "props": {"for": "c"}}
    p = project([cropped, tracked, carded])
    p["tracks"].append({"id": "cards", "items": [card]})
    assert lc.wide_broll_issues(p) == []
    p["settings"]["resolution"] = [1920, 1080]           # a landscape edit shows wide footage whole
    assert lc.wide_broll_issues(project([item("d")]) | {"settings": {"resolution": [1920, 1080]}}) == []


def test_a_composited_clip_is_not_a_full_frame_cover():
    plain = {"type": "image", "src": "a.png"}
    assert lc._full_frame(plain)
    assert not lc._full_frame({**plain, "mask": {"shape": "ellipse"}})
    assert lc._full_frame({**plain, "mask": {"shape": "ellipse", "enabled": False}})   # a mask turned off composites nothing
    assert not lc._full_frame({**plain, "blendMode": "screen"})
    assert lc._full_frame({**plain, "blendMode": "normal"})
    fade = {"prop": "opacity", "points": [{"t": 0, "value": 0}, {"t": 1, "value": 1}]}
    assert not lc._full_frame({**plain, "keyframes": [fade]})
    assert lc._full_frame({**plain, "keyframes": [{"prop": "scale", "points": []}]})
