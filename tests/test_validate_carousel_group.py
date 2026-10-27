"""§587: a carousel element's optional `group` (the editor's groups) validates as a non-empty string."""
import copy
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))

import validate as v  # noqa: E402

PROJECT = {
    "version": "0.2", "id": "c1", "projectType": "carousel", "status": "draft", "workflow": "carousel",
    "editingPrompt": "", "carousel": {"aspect": "portrait"}, "settings": {"resolution": [1080, 1350]},
    "slides": [{"id": "s1", "base_color": "#ffffff", "elements": [
        {"id": "a", "type": "image", "src": "a.png", "x": 0, "y": 0, "w": 10, "h": 10, "rotation": 0},
        {"id": "b", "type": "overlay", "overlay": {"template": "t", "props": {}}, "frame": 0,
         "x": 0, "y": 0, "w": 10, "h": 10, "rotation": 0},
    ]}],
}


def _validate(tmp_path, group_a, group_b=None):
    data = copy.deepcopy(PROJECT)
    els = data["slides"][0]["elements"]
    els[0]["group"] = group_a
    if group_b is not None:
        els[1]["group"] = group_b
    path = tmp_path / "project.json"
    path.write_text(json.dumps(data))
    return v.validate_project(str(path))


def test_a_string_group_on_image_and_overlay_is_valid(tmp_path):
    assert _validate(tmp_path, "g1", "g1")["valid"] is True


def test_no_group_is_valid(tmp_path):
    path = tmp_path / "project.json"
    path.write_text(json.dumps(PROJECT))
    assert v.validate_project(str(path))["valid"] is True


def test_a_null_group_is_no_group(tmp_path):
    assert _validate(tmp_path, None)["valid"] is True


@pytest.mark.parametrize("bad", [3, "", True, ["g"], {"id": "g"}])
def test_a_group_that_is_not_a_non_empty_string_is_rejected(tmp_path, bad, capsys):
    with pytest.raises(SystemExit):
        _validate(tmp_path, bad)
    assert "slides[0].elements[0].group must be a non-empty string" in capsys.readouterr().err
