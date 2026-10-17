"""A project created without footage has the default canvas
(settings.resolutionSource == "default"). The first footage that gets dims
(opening a project, or a PUT, backfills them) sets the canvas once, then the
marker becomes "footage". An explicit resolution is never changed, and a
project with no marker at all is never touched.
"""
import json
import time

import pytest
from starlette.testclient import TestClient

from serve.common import get_project_dir
from serve.server import app
from tests.test_server_source_dims import (
    PID, _StubBroadcaster, _clip_file, _disk, _ffmpeg, _item,
)


def _setup(tmp_path, *, resolution=(1920, 1080), source="default", items=(), extra_settings=None,
           fps=60, fps_source="default"):
    project_dir = tmp_path / PID
    project_dir.mkdir()
    settings = {"resolution": list(resolution), "fps": fps, **(extra_settings or {})}
    if fps_source is not None:
        settings["fpsSource"] = fps_source
    if source is not None:
        settings["resolutionSource"] = source
    proj = {
        "id": PID, "name": "n", "status": "draft",
        "settings": settings,
        "tracks": [{"id": "trk-0", "items": list(items)}],
        "sources": [],
    }
    (project_dir / "project.json").write_text(json.dumps(proj))
    return project_dir


@pytest.fixture
def client(tmp_path):
    holder = {}
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: holder["dir"]
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            app.state.broadcaster = _StubBroadcaster()
            yield c, holder
    finally:
        app.dependency_overrides.pop(get_project_dir, None)


def _wait_for(project_dir, pred, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred(_disk(project_dir)["settings"]):
            return
        time.sleep(0.1)


def _put_items(c, *items):
    resp = c.put(f"/api/projects/{PID}", json={"id": PID, "tracks": [{"id": "trk-0", "items": list(items)}]})
    assert resp.status_code == 200, resp.text


def test_a_empty_project_adopts_first_footage_after_put(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "uhd.mp4")
    holder["dir"] = _setup(tmp_path)
    _put_items(c, _item(src))
    _wait_for(holder["dir"], lambda s: s.get("resolutionSource") == "footage")
    s = _disk(holder["dir"])["settings"]
    assert s["resolution"] == [3840, 2160]
    assert s["resolutionSource"] == "footage"
    got = c.get(f"/api/projects/{PID}").json()["settings"]
    assert got["resolution"] == [3840, 2160] and got["resolutionSource"] == "footage"


def test_a_get_alone_adopts_footage(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "uhd.mp4")
    holder["dir"] = _setup(tmp_path, items=[_item(src)])
    got = c.get(f"/api/projects/{PID}").json()["settings"]
    assert got["resolution"] == [3840, 2160] and got["resolutionSource"] == "footage"
    assert _disk(holder["dir"])["settings"]["resolution"] == [3840, 2160]
    assert any(PID == p for p, _ in app.state.broadcaster.frames)


def test_b_second_clip_changes_nothing(client, tmp_path):
    c, holder = client
    uhd = _clip_file(tmp_path / "uhd.mp4")
    small = _clip_file(tmp_path / "small.mp4", size="640x360")
    holder["dir"] = _setup(tmp_path, items=[_item(uhd)])
    c.get(f"/api/projects/{PID}")
    _put_items(c, _item(uhd), {**_item(small), "id": "clip-1"})
    time.sleep(1.5)
    c.get(f"/api/projects/{PID}")
    s = _disk(holder["dir"])["settings"]
    assert s["resolution"] == [3840, 2160] and s["resolutionSource"] == "footage"


def test_c_explicit_is_never_changed(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "uhd.mp4")
    holder["dir"] = _setup(tmp_path, source="explicit", items=[_item(src)])
    got = c.get(f"/api/projects/{PID}").json()["settings"]
    assert got["resolution"] == [1920, 1080] and got["resolutionSource"] == "explicit"
    _put_items(c, _item(src))
    time.sleep(1.5)
    s = _disk(holder["dir"])["settings"]
    assert s["resolution"] == [1920, 1080] and s["resolutionSource"] == "explicit"


def test_d_put_that_sets_a_new_resolution_flips_to_explicit(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "uhd.mp4")
    holder["dir"] = _setup(tmp_path)
    body = {"id": PID, "settings": {"resolution": [1280, 720], "fps": 60},
            "tracks": [{"id": "trk-0", "items": [_item(src)]}]}
    assert c.put(f"/api/projects/{PID}", json=body).status_code == 200
    time.sleep(1.5)
    c.get(f"/api/projects/{PID}")
    s = _disk(holder["dir"])["settings"]
    assert s["resolution"] == [1280, 720] and s["resolutionSource"] == "explicit"


def test_d2_put_echoing_the_same_resolution_keeps_the_marker(client, tmp_path):
    c, holder = client
    holder["dir"] = _setup(tmp_path)
    body = {"id": PID, "settings": {"resolution": [1920, 1080], "fps": 60}}
    assert c.put(f"/api/projects/{PID}", json=body).status_code == 200
    assert _disk(holder["dir"])["settings"]["resolutionSource"] == "default"


def test_e_legacy_project_without_marker_is_untouched(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "uhd.mp4")
    holder["dir"] = _setup(tmp_path, source=None, items=[_item(src)])
    c.get(f"/api/projects/{PID}")
    _put_items(c, _item(src))
    time.sleep(1.5)
    s = _disk(holder["dir"])["settings"]
    assert s["resolution"] == [1920, 1080] and "resolutionSource" not in s


def test_f_aspect_guard_keeps_canvas_aspect_and_matches_short_side(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "uhd.mp4")
    holder["dir"] = _setup(tmp_path, resolution=(1080, 1920), items=[_item(src)])
    got = c.get(f"/api/projects/{PID}").json()["settings"]
    assert got["resolution"] == [2160, 3840] and got["resolutionSource"] == "footage"


def test_g_portrait_footage_keeps_a_landscape_canvas(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "portrait.mp4", size="1080x1920")
    holder["dir"] = _setup(tmp_path, items=[_item(src)])
    got = c.get(f"/api/projects/{PID}").json()["settings"]
    assert got["resolution"] == [1920, 1080] and got["resolutionSource"] == "footage"


def test_modal_footage_wins_over_first_clip(client, tmp_path):
    c, holder = client
    a = _clip_file(tmp_path / "a.mp4", size="640x360")
    b = _clip_file(tmp_path / "b.mp4", size="1280x720")
    holder["dir"] = _setup(tmp_path, items=[
        _item(a), {**_item(b), "id": "clip-1"}, {**_item(b), "id": "clip-2"},
    ])
    got = c.get(f"/api/projects/{PID}").json()["settings"]
    assert got["resolution"] == [1280, 720]


def _clip_fps(path, fps, size="3840x2160"):
    _ffmpeg("-f", "lavfi", "-i", f"testsrc=size={size}:rate={fps}:duration=1",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path))
    return str(path)


def test_fps_empty_project_adopts_first_footage_fps(client, tmp_path):
    c, holder = client
    src = _clip_fps(tmp_path / "c.mp4", 30)
    holder["dir"] = _setup(tmp_path)
    _put_items(c, _item(src))
    _wait_for(holder["dir"], lambda s: s.get("fpsSource") == "footage")
    s = _disk(holder["dir"])["settings"]
    assert s["fps"] == 30 and s["fpsSource"] == "footage"
    assert s["resolution"] == [3840, 2160] and s["resolutionSource"] == "footage"


def test_fps_footage_follow_takes_the_real_rate_of_an_iphone_like_clip(client, tmp_path):
    """r_frame_rate 120/1 at ~30 real fps (an iPhone's time base): the project takes 30, not 120."""
    from tests.test_normalize import make_iphone_like_vfr_clip
    c, holder = client
    src = make_iphone_like_vfr_clip(tmp_path / "iphone.mp4")
    holder["dir"] = _setup(tmp_path)
    _put_items(c, _item(src))
    _wait_for(holder["dir"], lambda s: s.get("fpsSource") == "footage")
    s = _disk(holder["dir"])["settings"]
    assert s["fps"] == 30 and s["fpsSource"] == "footage"


def test_fps_first_clip_in_track_order_wins_and_later_clips_change_nothing(client, tmp_path):
    c, holder = client
    a = _clip_fps(tmp_path / "a.mp4", 24, size="640x360")
    b = _clip_fps(tmp_path / "b.mp4", 25, size="640x360")
    holder["dir"] = _setup(tmp_path, items=[_item(a), {**_item(b), "id": "clip-1"}])
    assert c.get(f"/api/projects/{PID}").json()["settings"]["fps"] == 24
    _put_items(c, {**_item(b), "id": "clip-1"}, _item(a))
    time.sleep(1.5)
    c.get(f"/api/projects/{PID}")
    assert _disk(holder["dir"])["settings"]["fps"] == 24


def test_fps_explicit_put_flips_marker_and_is_never_overridden(client, tmp_path):
    c, holder = client
    src = _clip_fps(tmp_path / "c.mp4", 30)
    holder["dir"] = _setup(tmp_path)
    body = {"id": PID, "settings": {"resolution": [1920, 1080], "fps": 24},
            "tracks": [{"id": "trk-0", "items": [_item(src)]}]}
    assert c.put(f"/api/projects/{PID}", json=body).status_code == 200
    time.sleep(1.5)
    c.get(f"/api/projects/{PID}")
    s = _disk(holder["dir"])["settings"]
    assert s["fps"] == 24 and s["fpsSource"] == "explicit"
    assert s["resolutionSource"] == "default" or s["resolution"] == [3840, 2160]


def test_fps_and_resolution_markers_are_independent(client, tmp_path):
    c, holder = client
    src = _clip_fps(tmp_path / "c.mp4", 30)
    holder["dir"] = _setup(tmp_path, source="explicit", items=[_item(src)])
    s = c.get(f"/api/projects/{PID}").json()["settings"]
    assert s["resolution"] == [1920, 1080] and s["resolutionSource"] == "explicit"
    assert s["fps"] == 30 and s["fpsSource"] == "footage"


def test_fps_legacy_project_is_untouched(client, tmp_path):
    c, holder = client
    src = _clip_fps(tmp_path / "c.mp4", 30)
    holder["dir"] = _setup(tmp_path, source=None, fps_source=None, items=[_item(src)])
    c.get(f"/api/projects/{PID}")
    s = _disk(holder["dir"])["settings"]
    assert s["fps"] == 60 and "fpsSource" not in s


def test_fps_probe_failure_keeps_marker_for_a_later_open(client, tmp_path, monkeypatch):
    import lib.normalize as normalize
    c, holder = client
    src = _clip_fps(tmp_path / "c.mp4", 30)
    holder["dir"] = _setup(tmp_path, items=[_item(src, sourceWidth=3840, sourceHeight=2160)])
    real = normalize.probe_video
    monkeypatch.setattr(normalize, "probe_video", lambda *a, **k: None)
    c.get(f"/api/projects/{PID}")
    s = _disk(holder["dir"])["settings"]
    assert s["fps"] == 60 and s["fpsSource"] == "default"
    monkeypatch.setattr(normalize, "probe_video", real)
    c.get(f"/api/projects/{PID}")
    s = _disk(holder["dir"])["settings"]
    assert s["fps"] == 30 and s["fpsSource"] == "footage"


# settings.aspectSource: a default canvas whose aspect nobody chose turns to the footage's
# orientation; a chosen aspect, or a project without the marker (test_g above), keeps its own.

def test_aspect_default_landscape_canvas_turns_portrait_for_portrait_footage(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "portrait.mp4", size="1080x1920")
    holder["dir"] = _setup(tmp_path, items=[_item(src)], extra_settings={"aspectSource": "default"})
    got = c.get(f"/api/projects/{PID}").json()["settings"]
    assert got["resolution"] == [1080, 1920] and got["resolutionSource"] == "footage"
    assert got["aspectSource"] == "default"


def test_aspect_default_turns_for_a_rotated_iphone_like_clip(client, tmp_path):
    """The reported case: a phone clip stored landscape with a rotation, played portrait, into a default 16:9."""
    from tests.test_normalize import make_iphone_like_vfr_clip
    c, holder = client
    src = make_iphone_like_vfr_clip(tmp_path / "iphone.mp4")
    holder["dir"] = _setup(tmp_path, extra_settings={"aspectSource": "default"})
    _put_items(c, _item(src))
    _wait_for(holder["dir"], lambda s: s.get("resolutionSource") == "footage")
    s = _disk(holder["dir"])["settings"]
    assert s["resolution"] == [180, 320] and s["resolutionSource"] == "footage"


def test_aspect_default_portrait_canvas_turns_landscape_for_landscape_footage(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "uhd.mp4")
    holder["dir"] = _setup(tmp_path, resolution=(1080, 1920), items=[_item(src)],
                           extra_settings={"aspectSource": "default"})
    got = c.get(f"/api/projects/{PID}").json()["settings"]
    assert got["resolution"] == [3840, 2160] and got["resolutionSource"] == "footage"


def test_aspect_explicit_keeps_a_chosen_landscape_under_portrait_footage(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "portrait.mp4", size="1080x1920")
    holder["dir"] = _setup(tmp_path, items=[_item(src)], extra_settings={"aspectSource": "explicit"})
    got = c.get(f"/api/projects/{PID}").json()["settings"]
    assert got["resolution"] == [1920, 1080] and got["resolutionSource"] == "footage"


def test_aspect_default_square_footage_does_not_turn_the_canvas(client, tmp_path):
    c, holder = client
    src = _clip_file(tmp_path / "square.mp4", size="1080x1080")
    holder["dir"] = _setup(tmp_path, items=[_item(src)], extra_settings={"aspectSource": "default"})
    got = c.get(f"/api/projects/{PID}").json()["settings"]
    assert got["resolution"] == [1920, 1080] and got["resolutionSource"] == "footage"


def test_aspect_source_survives_a_put_whose_settings_leave_it_out(client, tmp_path):
    c, holder = client
    holder["dir"] = _setup(tmp_path, extra_settings={"aspectSource": "default"})
    body = {"id": PID, "settings": {"resolution": [1920, 1080], "fps": 60}}
    assert c.put(f"/api/projects/{PID}", json=body).status_code == 200
    s = _disk(holder["dir"])["settings"]
    assert s["aspectSource"] == "default" and s["resolutionSource"] == "default"


# §378: the colour space marker follows the same rule as the canvas one.
def test_colour_space_marker_flips_to_explicit_only_when_a_save_changes_it(client, tmp_path):
    c, holder = client
    holder["dir"] = _setup(tmp_path, extra_settings={"colorSpace": "hdr_hlg", "colorSpaceSource": "auto"})
    echo = {"id": PID, "settings": {"resolution": [1920, 1080], "fps": 60, "colorSpace": "hdr_hlg"}}
    assert c.put(f"/api/projects/{PID}", json=echo).status_code == 200
    assert _disk(holder["dir"])["settings"]["colorSpaceSource"] == "auto"
    # a save whose settings leave the marker out keeps the stored one
    other = {"id": PID, "settings": {"resolution": [1920, 1080], "fps": 60}}
    assert c.put(f"/api/projects/{PID}", json=other).status_code == 200
    assert _disk(holder["dir"])["settings"]["colorSpaceSource"] == "auto"
    chosen = {"id": PID, "settings": {"resolution": [1920, 1080], "fps": 60, "colorSpace": "sdr_bt709"}}
    assert c.put(f"/api/projects/{PID}", json=chosen).status_code == 200
    s = _disk(holder["dir"])["settings"]
    assert (s["colorSpace"], s["colorSpaceSource"]) == ("sdr_bt709", "explicit")
