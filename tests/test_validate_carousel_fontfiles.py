"""§587 r3: an overlay element's optional `fontFiles` validates as a list of {family, src} non-empty strings."""
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
        {"id": "b", "type": "overlay", "overlay": {"template": "t", "props": {}}, "frame": 0,
         "x": 0, "y": 0, "w": 10, "h": 10, "rotation": 0},
    ]}],
}


def _validate(tmp_path, font_files):
    data = copy.deepcopy(PROJECT)
    if font_files is not None:
        data["slides"][0]["elements"][0]["fontFiles"] = font_files
    path = tmp_path / "project.json"
    path.write_text(json.dumps(data))
    return v.validate_project(str(path))


@pytest.mark.parametrize("ok", [None, [], [{"family": "Mine", "src": "fonts/mine.woff2"}]])
def test_valid_font_files(tmp_path, ok):
    assert _validate(tmp_path, ok)["valid"] is True


@pytest.mark.parametrize("bad", [
    "Mine", {"family": "Mine", "src": "a.ttf"}, ["Mine"], [None], [{"family": "Mine"}],
    [{"src": "a.ttf"}], [{"family": "", "src": "a.ttf"}], [{"family": "Mine", "src": ""}],
    [{"family": 3, "src": "a.ttf"}], [{"family": "Mine", "src": ["a.ttf"]}],
])
def test_malformed_font_files_fail_invalid_field(tmp_path, bad, capsys):
    with pytest.raises(SystemExit):
        _validate(tmp_path, bad)
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["error"] == "invalid_field"
