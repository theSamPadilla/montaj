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


def test_a_video_fits_contain_by_default_as_render_draws_it():
    # Render draws a video with no fit as contain (§669): letterboxed, so it hides what is under it only when its
    # picture has the frame's shape. An image's default stays cover.
    frame = (1080.0, 1920.0)
    wide = {"type": "video", "src": "w.mp4", "sourceWidth": 1920, "sourceHeight": 1080}
    tall = {"type": "video", "src": "t.mp4", "sourceWidth": 1080, "sourceHeight": 1920}
    unknown = {"type": "video", "src": "u.mp4"}
    assert not lc._full_frame(wide, frame)
    assert lc._full_frame({**wide, "fit": "cover"}, frame)
    assert lc._full_frame({**wide, "fit": "fill"}, frame)
    assert lc._full_frame(tall, frame)
    assert not lc._full_frame({**wide, "sourceCrop": {"x": 0, "y": 0, "w": 0.3164, "h": 1}}, (1920.0, 1080.0))
    assert lc._full_frame({**wide, "sourceCrop": {"x": 0.34, "y": 0, "w": 0.3164, "h": 1}}, frame)
    assert not lc._full_frame(unknown, frame)
    assert lc._full_frame({"type": "image", "src": "a.png"}, frame)


def test_a_letterboxed_video_does_not_hide_the_track_under_it():
    # Both on video tracks, so the later track draws on top (video tracks stack below image ones).
    under = {"id": "u", "type": "video", "src": "u.mp4", "start": 0, "end": 4, "sourceWidth": 1080, "sourceHeight": 1920}
    wide = {"id": "w", "type": "video", "src": "w.mp4", "start": 0, "end": 4, "sourceWidth": 1920, "sourceHeight": 1080}
    p = {"settings": {"resolution": [1080, 1920]}, "tracks": [{"id": "base", "items": []}, {"id": "a", "items": [under]}, {"id": "b", "items": [wide]}]}
    assert not [i for i in lc.data_issues(p, ".") if "hidden by" in i["text"]]
    p["tracks"][2]["items"][0]["fit"] = "cover"
    assert [i for i in lc.data_issues(p, ".") if "hidden by" in i["text"]]
