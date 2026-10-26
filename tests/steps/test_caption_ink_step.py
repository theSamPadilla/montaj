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
    assert out == {"dark": 1, "light": 0, "cleared": 0, "kept": 0, "changed": True}
    doc = _read(p)
    segs = doc["captions"]["segments"]
    assert segs[0]["ink"] == "dark" and segs[0]["inkAuto"]["card"] == "card" and segs[0]["inkAuto"]["ink"] == "dark"
    assert segs[0]["inkAuto"]["backdrop"] == pytest.approx(0.83, abs=0.01)
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
        assert step.run(str(p), render_fn=_light(tmp_path)) == {"dark": 0, "light": 0, "cleared": 0, "kept": 0, "changed": False}
        assert p.read_text() == before
    q = tmp_path / "q"
    q.mkdir()
    doc = {"id": "p", "settings": {}, "tracks": [{"id": "m", "items": []}]}
    (q / "project.json").write_text(json.dumps(doc))
    before = (q / "project.json").read_text()
    assert step.run(str(q / "project.json"), render_fn=_light(tmp_path)) == {"dark": 0, "light": 0, "cleared": 0, "kept": 0, "changed": False}
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


def _segs(doc):
    return doc["captions"]["segments"]


def _edit(p, fn):
    doc = _read(p)
    fn(doc)
    p.write_text(json.dumps(doc))


def test_a_persons_ink_set_while_it_rendered_is_not_overwritten(tmp_path):
    p = _project(tmp_path)
    done = []

    def human():
        if not done:
            done.append(1)
            _edit(p, lambda d: _segs(d)[0].update(ink="light"))
    with pytest.raises(SystemExit):
        step.run(str(p), render_fn=_light(tmp_path, human))
    assert _segs(_read(p))[0] == {"id": "cap-1", "text": "hello", "start": 1, "end": 2, "words": [], "ink": "light"}


def test_ink_never_lands_on_another_caption_when_the_list_holds_junk(tmp_path):
    a = {"text": "a", "start": 1, "end": 2, "words": []}
    b = {"text": "b", "start": 3, "end": 3.5, "words": []}
    p = _project(tmp_path, segs=["junk", a, b])
    step.run(str(p), render_fn=_light(tmp_path))
    segs = _segs(_read(p))
    assert segs[0] == "junk" and segs[1]["ink"] == "dark" and segs[2]["ink"] == "dark"
    (tmp_path / "q").mkdir()
    q = _project(tmp_path / "q", segs=[None, dict(a), dict(b, start=5, end=6)])
    step.run(str(q), render_fn=_light(tmp_path))
    segs = _segs(_read(q))
    assert segs[0] is None and segs[1]["ink"] == "dark" and "ink" not in segs[2]


def test_a_junk_entry_added_while_it_rendered_refuses_instead_of_a_traceback(tmp_path):
    a = {"text": "a", "start": 1, "end": 2, "words": []}
    p = _project(tmp_path, segs=[a])
    with pytest.raises(SystemExit):
        step.run(str(p), render_fn=_light(tmp_path, lambda: _edit(p, lambda d: _segs(d).insert(0, None))))
    assert "ink" not in _segs(_read(p))[1]


def test_style_edited_while_it_rendered_refuses(tmp_path):
    p = _project(tmp_path)
    with pytest.raises(SystemExit):
        step.run(str(p), render_fn=_light(tmp_path, lambda: _edit(p, lambda d: d["captions"].update(style="plate"))))
    assert "ink" not in _segs(_read(p))[0]


def test_with_the_engine_guard_on_any_captions_edit_since_the_read_refuses(tmp_path, monkeypatch):
    monkeypatch.setattr(ci.project_revisions, "engine_guard_enabled", lambda: True)
    p = _project(tmp_path)
    with pytest.raises(SystemExit):
        step.run(str(p), render_fn=_light(tmp_path, lambda: _edit(p, lambda d: _segs(d)[1].update(text="other"))))
    assert "ink" not in _segs(_read(p))[0]
    (tmp_path / "q").mkdir()
    q = _project(tmp_path / "q")
    assert step.run(str(q), render_fn=_light(tmp_path))["changed"] is True


def test_ink_is_not_written_for_a_card_that_is_gone(tmp_path):
    p = _project(tmp_path)
    with pytest.raises(SystemExit):
        step.run(str(p), render_fn=_light(tmp_path, lambda: _edit(p, lambda d: d["tracks"][1]["items"].clear())))
    assert "ink" not in _segs(_read(p))[0]


def test_confirming_the_same_ink_counts_it_but_writes_nothing(tmp_path):
    p = _project(tmp_path)
    assert step.run(str(p), render_fn=_light(tmp_path))["changed"] is True
    again = step.run(str(p), render_fn=_light(tmp_path))
    assert again["dark"] == 1 and again["changed"] is False


def test_clearing_stale_ink_when_no_card_remains(tmp_path):
    p = _project(tmp_path, with_card=False,
                 segs=[{"id": "c", "text": "x", "start": 1, "end": 2, "words": [], "ink": "dark",
                        "inkAuto": {"card": "gone", "ink": "dark"}}])
    out = step.run(str(p), render_fn=_light(tmp_path))
    assert out["cleared"] == 1 and out["changed"] is True
    assert "ink" not in _segs(_read(p))[0] and "inkAuto" not in _segs(_read(p))[0]


def test_each_run_renders_into_its_own_folder_and_removes_it(tmp_path, monkeypatch):
    p = _project(tmp_path)
    dirs = []

    def fake_renderer(project_path, out_dir, deadline=None):
        dirs.append(out_dir)
        assert Path(out_dir).parent == p.parent / "render" / "samples"
        return _light(tmp_path)
    monkeypatch.setattr(ci, "frame_renderer", fake_renderer)
    step.run(str(p))
    step.run(str(p))
    assert len(dirs) == 2 and dirs[0] != dirs[1] and not any(Path(d).exists() for d in dirs)
    assert (p.parent / "render" / "samples").is_dir()
