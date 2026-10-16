"""A render's own `fps` and `motionBlur` (§284): the export window's Fast renders
this export at them, and project.json keeps its own. serve validates them (422
on a value render.js would refuse) and passes them as ``--fps``/``--motion-blur``;
absent, the render is exactly as before. The estimate keeps its lenient stand-ins
(test_render_estimate.py)."""
from pathlib import Path

import pytest
from fastapi import HTTPException

from serve.routes.projects import _render_js_args, _validate_render_body, _estimate_overrides


def _args(body, **kw):
    project_dir = Path("/w/proj")
    return _render_js_args(project_dir, project_dir / "project.json", body, **kw)[0]


def test_no_override_is_todays_render():
    assert _args({}) == ["/w/proj/project.json", "--out", "/w/proj/output/proj.mp4"]
    assert "--fps" not in _args({"export": "auto"}) and "--motion-blur" not in _args({"export": "auto"})


@pytest.mark.parametrize("body,flags", [
    ({"fps": 30}, ["--fps", "30"]),
    ({"fps": 29.97}, ["--fps", "29.97"]),
    ({"motionBlur": 1}, ["--motion-blur", "1"]),
    ({"fps": 30, "motionBlur": 1}, ["--fps", "30", "--motion-blur", "1"]),
])
def test_overrides_are_passed_to_render_js(body, flags):
    argv = _args(body)
    assert argv[-len(flags):] == flags


def test_the_estimate_passes_none_of_them_here():
    # The estimate adds its own, leniently, after --estimate (_estimate_overrides).
    argv = _args({"fps": 30, "motionBlur": 1}, overrides=False)
    assert "--fps" not in argv and "--motion-blur" not in argv


@pytest.mark.parametrize("body", [
    {"fps": 0}, {"fps": -30}, {"fps": "30"}, {"fps": True}, {"fps": float("inf")}, {"fps": float("nan")}, {"fps": [30]},
    {"motionBlur": 0}, {"motionBlur": 9}, {"motionBlur": 1.5}, {"motionBlur": "1"}, {"motionBlur": True},
])
def test_a_bad_override_is_the_renders_422(body):
    with pytest.raises(HTTPException) as e:
        _validate_render_body(body)
    assert e.value.status_code == 422
    assert e.value.detail["error"] == "invalid_argument"
    # The estimate never refuses on them: it leaves a malformed one out.
    _validate_render_body(body, overrides=False)


def test_a_good_override_passes_validation():
    for body in ({"fps": 30}, {"fps": 60.0}, {"motionBlur": 1}, {"motionBlur": 8}, {"fps": 30, "motionBlur": 1}, {}):
        _validate_render_body(body)


def test_the_estimate_takes_motion_blur_leniently():
    assert _estimate_overrides({"motionBlur": 1}) == ["--motion-blur", "1"]
    assert _estimate_overrides({"fps": 30, "motionBlur": 3}) == ["--fps", "30", "--motion-blur", "3"]
    for bad in (0, 9, 1.5, "1", True, None):
        assert "--motion-blur" not in _estimate_overrides({"motionBlur": bad})
