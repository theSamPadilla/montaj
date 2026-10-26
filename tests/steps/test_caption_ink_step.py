"""caption_ink (the step): measures the backdrop under each caption and writes `ink`, `captions` only, under the
project lock, onto the fresh captions. A caption edited meanwhile refuses `project_changed` and writes nothing."""
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from lib import caption_ink as ci  # noqa: E402
import steps.transform.caption_ink as step  # noqa: E402


def _project(tmp_path, with_card=True, segs=None):
    d = tmp_path / "proj"
    d.mkdir()
    items = [{"id": "card", "type": "overlay", "src": "engine:scene3d", "start": 0, "end": 4, "opaque": True}] if with_card else []
    segs = segs if segs is not None else [
        {"id": "cap-1", "text": "hello", "start": 1, "end": 2, "words": []},
        {"id": "cap-2", "text": "world", "start": 5, "end": 6, "words": []}]
    doc = {"id": "p", "name": "orig", "settings": {"resolution": [1080, 1920], "fps": 30},
           "tracks": [{"id": "main", "items": [{"id": "v", "type": "video", "src": "/x/a.mp4", "start": 0, "end": 8,
                                                "inPoint": 0, "outPoint": 8}]}, {"id": "ovl", "items": items}],
           "captions": {"style": "pop", "segments": segs}}
    (d / "project.json").write_text(json.dumps(doc))
    return d / "project.json"


def _light(tmp_path, hook=None):
    def render(t):
        if hook:
            hook()
        p = tmp_path / f"f{t}.png"
        Image.new("RGB", (540, 960), (0xef, 0xec, 0xe4)).save(p)
        return str(p)
    return render


def _read(p):
    return json.loads(p.read_text())


def test_the_step_writes_ink_on_the_captions_over_the_card_and_nothing_else(tmp_path):
    p = _project(tmp_path)
    out = step.run(str(p), render_fn=_light(tmp_path))
    assert out == {"dark": 1, "light": 0, "cleared": 0, "kept": 0}
    doc = _read(p)
    segs = doc["captions"]["segments"]
    assert segs[0]["ink"] == "dark" and segs[0]["inkAuto"] == "card"
    assert "ink" not in segs[1], "over footage: untouched"
    assert doc["name"] == "orig"


def test_an_edit_to_another_field_made_while_it_rendered_survives(tmp_path):
    p = _project(tmp_path)

    def human():
        doc = _read(p)
        doc["name"] = "renamed by hand"
        p.write_text(json.dumps(doc))
    step.run(str(p), render_fn=_light(tmp_path, human))
    doc = _read(p)
    assert doc["name"] == "renamed by hand" and doc["captions"]["segments"][0]["ink"] == "dark"


def test_a_caption_edited_meanwhile_refuses_and_writes_nothing(tmp_path):
    p = _project(tmp_path)

    def human():
        doc = _read(p)
        doc["captions"]["segments"][0]["text"] = "hello, edited"
        p.write_text(json.dumps(doc))
    with pytest.raises(SystemExit):
        step.run(str(p), render_fn=_light(tmp_path, human))
    assert "ink" not in _read(p)["captions"]["segments"][0]


def test_nothing_to_do_writes_nothing(tmp_path):
    for p in (_project(tmp_path, with_card=False), ):
        before = p.read_text()
        assert step.run(str(p), render_fn=_light(tmp_path)) == {"dark": 0, "light": 0, "cleared": 0, "kept": 0}
        assert p.read_text() == before
    q = tmp_path / "q"
    q.mkdir()
    doc = {"id": "p", "settings": {}, "tracks": [{"id": "m", "items": []}]}
    (q / "project.json").write_text(json.dumps(doc))
    before = (q / "project.json").read_text()
    assert step.run(str(q / "project.json"), render_fn=_light(tmp_path)) == {"dark": 0, "light": 0, "cleared": 0, "kept": 0}
    assert (q / "project.json").read_text() == before


def test_a_second_run_changes_nothing_on_disk(tmp_path):
    p = _project(tmp_path)
    step.run(str(p), render_fn=_light(tmp_path))
    after = p.read_text()
    step.run(str(p), render_fn=_light(tmp_path))
    assert p.read_text() == after


def test_the_answer_carries_warnings_when_a_frame_fails(tmp_path):
    p = _project(tmp_path)

    def boom(t):
        raise RuntimeError("no browser")
    out = step.run(str(p), render_fn=boom)
    assert out["dark"] == 0 and out["warnings"] and "1.5" in out["warnings"][0]


def test_the_step_schema_names_a_project_param():
    schema = json.loads((ROOT / "steps" / "transform" / "caption_ink.json").read_text())
    assert schema["name"] == "caption_ink" and [x["name"] for x in schema["params"]] == ["project"]
    assert ci.INK_STYLES
