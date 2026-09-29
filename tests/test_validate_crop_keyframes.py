"""PV55: crop keyframes are image-only (phase 1) and in range."""
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))

import validate as v  # noqa: E402

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


def test_crop_keyframes_on_a_video_fail_in_phase_1(tmp_path, capsys):
    with pytest.raises(SystemExit):
        v.validate_project(_path(tmp_path, _item("video", keyframes=[_track("cropX", 0.0, 0.5)])))
    err = _error(capsys)
    assert err["error"] == "invalid_field"
    assert "image" in err["message"]
