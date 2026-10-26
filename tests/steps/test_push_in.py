"""push_in (PL89): a slow push on the talking-head clips, in one call.

Claude alone kept every talking-head piece alive with a slow zoom (1.00 to 1.07) and changed the framing at each cut;
PL89b's talking head sat still at 100%. push_in keys `scale` (and `offsetY`, so the face stays where it was) across
each main-track clip, alternating the starting zoom so consecutive clips cut on a visible change. A clip a person has
already framed (scale, offsets or keys of their own) is left alone. The guide, not the engine, decides to use it.
"""
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

import steps.edit.push_in as push  # noqa: E402


def project(tmp_path, items=None):
    items = items if items is not None else [
        {"id": "c0", "start": 0, "end": 3},
        {"id": "c1", "start": 3, "end": 7.5},
        {"id": "c2", "start": 7.5, "end": 10},
    ]
    main = [{"type": "video", "src": str(tmp_path / f"{it['id']}.mp4"), "inPoint": 0, "outPoint": it["end"] - it["start"],
             **it} for it in items]
    doc = {"version": "0.2", "id": "push-fixture", "name": "Push", "status": "draft", "workflow": "overlays",
           "editingPrompt": "", "settings": {"fps": 30, "resolution": [1080, 1920]},
           "tracks": [{"id": "trk-0", "items": main},
                      {"id": "trk-1", "items": [{"id": "ov", "type": "overlay", "src": "./overlays/x.jsx", "start": 1, "end": 2}]}]}
    p = tmp_path / "project.json"
    p.write_text(json.dumps(doc, indent=2))
    return p


def items_of(p):
    return {it["id"]: it for t in json.loads(Path(p).read_text())["tracks"] for it in t["items"]}


def track(item, prop):
    return next((t["points"] for t in item.get("keyframes", []) if t["prop"] == prop), None)


def test_each_talking_head_clip_gets_a_slow_push_alternating_its_start(tmp_path):
    p = project(tmp_path)
    out = push.run(str(p))
    assert out["pushed"] == 3 and "kept" not in out
    it = items_of(p)
    for cid, start in (("c0", 1.0), ("c1", 1.04), ("c2", 1.0)):
        s = track(it[cid], "scale")
        dur = it[cid]["end"] - it[cid]["start"]
        assert [(k["t"], k["value"]) for k in s] == [(0, start), (round(dur, 3), round(start + 0.07, 4))], cid
        oy = track(it[cid], "offsetY")
        # the anchor (35% down the frame) stays put: offsetY = (0.5 - 0.35) * 100 * (scale - 1)
        assert [round(k["value"], 3) for k in oy] == [round(15 * (start - 1), 3), round(15 * (start + 0.07 - 1), 3)], cid
    assert "keyframes" not in it["ov"], "overlays are not talking-head clips"


def test_a_clip_a_person_framed_is_left_alone(tmp_path):
    p = project(tmp_path, [
        {"id": "c0", "start": 0, "end": 3, "scale": 1.2},
        {"id": "c1", "start": 3, "end": 6, "keyframes": [{"prop": "offsetX", "points": [{"t": 0, "value": 0}, {"t": 3, "value": 5}]}]},
        {"id": "c2", "start": 6, "end": 9},
    ])
    before = items_of(p)
    out = push.run(str(p))
    after = items_of(p)
    assert out["pushed"] == 1 and out["kept"] == ["c0", "c1"]
    assert after["c0"] == before["c0"] and after["c1"] == before["c1"]
    assert track(after["c2"], "scale")


def test_running_it_again_changes_nothing(tmp_path):
    p = project(tmp_path)
    push.run(str(p))
    once = Path(p).read_text()
    out = push.run(str(p))
    assert Path(p).read_text() == once and out["pushed"] == 3


def test_items_and_zoom_narrow_it(tmp_path):
    p = project(tmp_path)
    out = push.run(str(p), items=["c1"], zoom=0.05)
    it = items_of(p)
    assert out["pushed"] == 1 and "keyframes" not in it["c0"] and "keyframes" not in it["c2"]
    assert track(it["c1"], "scale")[-1]["value"] == 1.05, "one clip given: it starts at 1.00"


def test_bad_params_and_a_missing_or_non_video_item_are_refused(tmp_path, capsys):
    p = project(tmp_path)
    for kw, code in (({"zoom": 0}, "invalid_params"), ({"zoom": 0.5}, "invalid_params"),
                     ({"items": ["nope"]}, "item_not_found"), ({"items": ["ov"]}, "not_a_video")):
        with pytest.raises(SystemExit):
            push.run(str(p), **kw)
        assert code in capsys.readouterr().err


def test_a_human_edit_since_the_read_is_refused_and_nothing_is_written(tmp_path, monkeypatch, capsys):
    p = project(tmp_path)
    real = push.read_tracks

    def read_then_edit(path):
        got = real(path)
        doc = json.loads(Path(path).read_text())
        doc["tracks"][0]["items"][0]["end"] = 2.5
        Path(path).write_text(json.dumps(doc, indent=2))
        return got
    monkeypatch.setattr(push, "read_tracks", read_then_edit)
    with pytest.raises(SystemExit):
        push.run(str(p))
    assert "project_changed" in capsys.readouterr().err
    assert all("keyframes" not in it for it in items_of(p).values())


def test_what_it_writes_passes_the_engine_validator(tmp_path):
    sys.path.insert(0, str(REPO_ROOT / "engine"))
    from validate import validate_project
    p = project(tmp_path)
    push.run(str(p))
    validate_project(str(p))
