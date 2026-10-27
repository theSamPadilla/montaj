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


# PL89i: Claude alone's kung fu edit gave each talking-head shot its own ramp, in then out, cut to cut, so the frame
# drifts with him. style alternate is that, as keys; anchor face / follow put the point that stays put on his head.

def heads(samples):
    """A find_head stand-in: {item id: [(item seconds, x, y) or None]} in shares of the canvas."""
    return lambda item, project, project_path: samples.get(item["id"], [])


def test_alternate_pushes_in_then_out_shot_by_shot_and_every_cut_lands_on_a_new_scale(tmp_path):
    p = project(tmp_path)
    out = push.run(str(p), style="alternate")
    assert out["pushed"] == 3
    it = items_of(p)
    want = {"c0": (1.0, 1.09), "c1": (1.135, 1.045), "c2": (1.0, 1.09)}     # zoom 0.09 by default for alternate
    for cid, (s0, s1) in want.items():
        assert [k["value"] for k in track(it[cid], "scale")] == [s0, s1], cid
        assert [round(k["value"], 3) for k in track(it[cid], "offsetY")] == [round(15 * (s0 - 1), 3), round(15 * (s1 - 1), 3)], cid
    ends = [track(it[c], "scale") for c in ("c0", "c1", "c2")]
    for a, b in zip(ends, ends[1:]):
        assert abs(a[-1]["value"] - b[0]["value"]) >= 0.04, "a cut changes the framing"


def test_alternate_takes_the_zoom_given(tmp_path):
    p = project(tmp_path)
    push.run(str(p), style="alternate", zoom=0.06)
    assert [k["value"] for k in track(items_of(p)["c1"], "scale")] == [1.09, 1.03]


def test_anchor_face_keeps_each_shots_head_where_it_was(tmp_path, monkeypatch):
    p = project(tmp_path)
    monkeypatch.setattr(push, "find_head", heads({
        "c0": [(0, 0.40, 0.30), (1, 0.42, 0.31), (2, 0.40, 0.29)],
        "c1": [(0, 0.60, 0.25), (2, 0.60, 0.25)],
        "c2": [(0, 0.50, 0.40)],
    }))
    out = push.run(str(p), anchor="face")
    assert out["pushed"] == 3 and "noFace" not in out
    it = items_of(p)
    for cid, (ax, ay) in (("c0", (0.40, 0.30)), ("c1", (0.60, 0.25)), ("c2", (0.50, 0.40))):
        s = [k["value"] for k in track(it[cid], "scale")]
        ox, oy = track(it[cid], "offsetX"), track(it[cid], "offsetY")
        assert [round(k["value"], 3) for k in oy] == [round((0.5 - ay) * 100 * (v - 1), 3) for v in s], cid
        if ax == 0.5:
            assert ox is None or all(k["value"] == 0 for k in ox), cid
        else:
            assert [round(k["value"], 3) for k in ox] == [round((0.5 - ax) * 100 * (v - 1), 3) for v in s], cid


def test_anchor_follow_keys_the_anchor_along_the_head_smoothly(tmp_path, monkeypatch):
    p = project(tmp_path, [{"id": "c0", "start": 0, "end": 4}])
    path = [(t / 2, 0.40 + 0.02 * t, 0.30) for t in range(9)]          # the head drifts right, 2 samples a second
    monkeypatch.setattr(push, "find_head", heads({"c0": path}))
    push.run(str(p), anchor="follow")
    it = items_of(p)["c0"]
    s0, s1 = [k["value"] for k in track(it, "scale")]
    ox = track(it, "offsetX")
    assert len(ox) >= 3 and ox[0]["t"] == 0 and ox[-1]["t"] == 4
    xs = []
    for k in ox:
        s = s0 + (s1 - s0) * k["t"] / 4
        xs.append(0.5 - k["value"] / (100 * (s - 1)) if s > 1 else None)
    known = [x for x in xs if x is not None]
    assert all(b >= a - 1e-6 for a, b in zip(known, known[1:])), "the anchor moves with the head"
    assert 0.40 <= known[0] <= 0.47 and 0.49 <= known[-1] <= 0.56, known
    oy = track(it, "offsetY")
    assert [k["t"] for k in oy] == [k["t"] for k in ox]


def test_a_shot_with_no_face_keeps_the_default_anchor_and_is_named(tmp_path, monkeypatch):
    p = project(tmp_path)
    monkeypatch.setattr(push, "find_head", heads({"c0": [(0, 0.4, 0.3)], "c1": [None, None]}))
    out = push.run(str(p), anchor="face")
    assert out["pushed"] == 3 and out["noFace"] == ["c1", "c2"]
    it = items_of(p)
    assert track(it["c1"], "offsetX") is None
    s = [k["value"] for k in track(it["c1"], "scale")]
    assert [round(k["value"], 3) for k in track(it["c1"], "offsetY")] == [round(15 * (v - 1), 3) for v in s]


def test_a_face_push_run_again_is_the_same_and_a_plain_run_takes_it_back(tmp_path, monkeypatch):
    p = project(tmp_path)
    monkeypatch.setattr(push, "find_head", heads({c: [(0, 0.4, 0.3)] for c in ("c0", "c1", "c2")}))
    push.run(str(p), anchor="follow", style="alternate")
    once = Path(p).read_text()
    out = push.run(str(p), anchor="follow", style="alternate")
    assert Path(p).read_text() == once and out["pushed"] == 3 and "kept" not in out
    push.run(str(p))
    it = items_of(p)
    assert track(it["c0"], "offsetX") is None and [k["value"] for k in track(it["c1"], "scale")] == [1.04, 1.11]


def test_bad_style_and_anchor_are_refused(tmp_path, capsys):
    p = project(tmp_path)
    for kw in ({"style": "zoom"}, {"anchor": "nose"}, {"anchor": "1.5"}):
        with pytest.raises(SystemExit):
            push.run(str(p), **kw)
        assert "invalid_params" in capsys.readouterr().err


def test_a_head_maps_through_the_items_crop_onto_the_canvas():
    canvas = (1080, 1920)
    # a source the canvas's own shape: shares carry over
    assert push.to_canvas(0.4, 0.3, {"sourceWidth": 2160, "sourceHeight": 3840}, canvas) == (0.4, 0.3)
    # a crop: the share inside it
    crop = {"sourceWidth": 3840, "sourceHeight": 2160, "sourceCrop": {"x": 0.25, "y": 0, "w": 0.5, "h": 1}}
    assert push.to_canvas(0.5, 0.5, crop, canvas) == (0.5, 0.5)
    assert tuple(round(v, 6) for v in push.to_canvas(0.3, 0.2, crop, canvas)) == (0.1, 0.2)
    # no crop and another shape: the centre the canvas covers
    x, y = push.to_canvas(0.5, 0.25, {"sourceWidth": 3840, "sourceHeight": 2160}, canvas)
    assert (round(x, 3), y) == (0.5, 0.25)


def test_the_step_json_offers_style_and_anchor_face(tmp_path):
    spec = json.loads((REPO_ROOT / "steps" / "edit" / "push_in.json").read_text())
    params = {q["name"]: q for q in spec["params"]}
    assert params["style"]["type"] == "enum" and params["style"]["options"][:2] == ["push", "alternate"]
    assert params["style"]["default"] == "push"
    assert params["anchor"]["type"] == "string" and "face" in params["anchor"]["description"]
    assert "follow" in params["anchor"]["description"]


# Sam (2026-10-26): light zoom-in cuts on the head, here and there, about 10% at most; a mix of shots at 1.0 and
# slightly zoomed. style punch holds every other clip at 1 + zoom (0.08 by default, 0.1 at most) and leaves the rest at
# 1.0 with no framing keys.

def test_punch_holds_every_other_clip_slightly_zoomed_and_leaves_the_rest_at_1(tmp_path):
    p = project(tmp_path, [{"id": f"c{i}", "start": 2 * i, "end": 2 * i + 2} for i in range(4)])
    out = push.run(str(p), style="punch")
    assert out["pushed"] == 4
    it = items_of(p)
    for cid in ("c0", "c2"):
        assert "keyframes" not in it[cid] or not track(it[cid], "scale"), cid
        assert it[cid].get("scale") in (None, 1), cid
    for cid in ("c1", "c3"):
        assert [k["value"] for k in track(it[cid], "scale")] == [1.08, 1.08], cid
        assert [round(k["value"], 3) for k in track(it[cid], "offsetY")] == [1.2, 1.2], cid    # (0.5 - 0.35) * 100 * 0.08


def test_punch_on_the_face_and_never_past_ten_percent(tmp_path, monkeypatch, capsys):
    p = project(tmp_path)
    looked = []

    def find(item, project, project_path):
        looked.append(item["id"])
        return [(0, 0.40, 0.30)]
    monkeypatch.setattr(push, "find_head", find)
    out = push.run(str(p), style="punch", anchor="face", zoom=0.1)
    assert looked == ["c1"], "only the punched clips are looked at"
    assert "noFace" not in out
    c1 = items_of(p)["c1"]
    assert [k["value"] for k in track(c1, "scale")] == [1.1, 1.1]
    assert [round(k["value"], 3) for k in track(c1, "offsetX")] == [1.0, 1.0]
    assert [round(k["value"], 3) for k in track(c1, "offsetY")] == [2.0, 2.0]
    with pytest.raises(SystemExit):
        push.run(str(p), style="punch", zoom=0.12)
    assert "invalid_params" in capsys.readouterr().err


def test_punch_over_an_earlier_push_takes_its_keys_off_the_unzoomed_clips_and_runs_again_the_same(tmp_path):
    p = project(tmp_path)
    push.run(str(p))
    push.run(str(p), style="punch")
    it = items_of(p)
    assert not track(it["c0"], "scale") and not track(it["c0"], "offsetY")
    once = Path(p).read_text()
    out = push.run(str(p), style="punch")
    assert Path(p).read_text() == once and out["pushed"] == 3 and "kept" not in out


def test_the_step_json_offers_punch():
    spec = json.loads((REPO_ROOT / "steps" / "edit" / "push_in.json").read_text())
    style = next(q for q in spec["params"] if q["name"] == "style")
    assert style["options"] == ["push", "alternate", "punch"] and style["default"] == "push"


def test_the_talking_head_workflow_punches_in_on_the_face_after_the_cut():
    wf = json.loads((REPO_ROOT / "workflows" / "overlays.json").read_text())
    ids = [s["id"] for s in wf["steps"]]
    punch = next(s for s in wf["steps"] if s.get("uses") == "montaj/push_in")
    assert punch["params"] == {"style": "punch", "anchor": "face"}
    assert "cut_apply" in punch["needs"] and ids.index(punch["id"]) < ids.index("overlays")
    assert "says" in punch["note"], "left out when the prompt says so"


# Sam (2026-10-26): the punch-ins are timed with words: on a stressed or key word, a sentence start or a cut, never
# mid-word; the answer says which words. The words are the clips' transcripts (item seconds here).

def words(rows):
    """A clip_words stand-in: {item id: [(start, end, text)]} in item seconds."""
    return lambda item, project_dir: rows.get(item["id"], [])


def test_punch_lands_at_cuts_and_answers_the_first_word_of_each_punched_clip(tmp_path, monkeypatch):
    p = project(tmp_path, [{"id": f"c{i}", "start": 2 * i, "end": 2 * i + 2} for i in range(3)])
    monkeypatch.setattr(push, "clip_words", words({"c1": [(0.05, 0.4, "So"), (0.4, 0.9, "kick.")]}))
    out = push.run(str(p), style="punch")
    assert out["punches"] == [{"at": 2.0, "word": "So"}]


def test_a_long_clip_punches_in_on_a_key_word_at_its_start_never_mid_word(tmp_path, monkeypatch):
    p = project(tmp_path, [{"id": "c0", "start": 10, "end": 16}])
    rows = [(0.0, 0.3, "and"), (0.3, 0.6, "then"), (0.6, 0.8, "the"), (1.2, 1.5, "robot"), (1.5, 1.9, "took"),
            (2.6, 3.2, "seventy"), (3.2, 3.5, "kicks."), (3.6, 3.9, "It"), (3.9, 4.3, "kept"), (4.3, 5.6, "going.")]
    monkeypatch.setattr(push, "clip_words", words({"c0": rows}))
    out = push.run(str(p), style="punch")
    s = track(items_of(p)["c0"], "scale")
    assert [(k["t"], k["value"]) for k in s] == [(0, 1.0), (2.6, 1.08), (6, 1.08)], "in on 'seventy', after a pause"
    assert s[0].get("easing") == "hold", "a cut in the shot, not a zoom"
    oy = track(items_of(p)["c0"], "offsetY")
    assert [k["t"] for k in oy] == [0, 2.6, 6] and oy[0].get("easing") == "hold"
    assert out["punches"] == [{"at": 12.6, "word": "seventy"}]


def test_a_long_punched_clip_comes_back_out_at_a_sentence_start(tmp_path, monkeypatch):
    p = project(tmp_path, [{"id": "c0", "start": 0, "end": 2}, {"id": "c1", "start": 2, "end": 8}])
    rows = [(0.0, 0.4, "Robots"), (0.4, 0.8, "fall."), (1.0, 1.4, "Mostly"), (1.4, 2.0, "sideways,"),
            (2.0, 2.4, "honestly."), (2.9, 3.2, "But"), (3.2, 3.6, "this"), (3.6, 4.1, "one"), (4.1, 5.5, "stands.")]
    monkeypatch.setattr(push, "clip_words", words({"c1": rows}))
    out = push.run(str(p), style="punch")
    s = track(items_of(p)["c1"], "scale")
    assert [(k["t"], k["value"]) for k in s] == [(0, 1.08), (2.9, 1.0), (6, 1.0)], "out at 'But', a sentence start"
    assert out["punches"] == [{"at": 2.0, "word": "Robots"}]


def test_a_long_clip_with_only_small_words_or_none_near_its_ends_keeps_one_framing(tmp_path, monkeypatch):
    p = project(tmp_path, [{"id": "c0", "start": 0, "end": 6}])
    rows = [(0.2, 0.5, "Unitree"), (1.0, 1.3, "and"), (2.0, 2.3, "the"), (3.0, 3.3, "a"), (5.4, 5.9, "Thousands")]
    monkeypatch.setattr(push, "clip_words", words({"c0": rows}))
    out = push.run(str(p), style="punch")
    assert "keyframes" not in items_of(p)["c0"] and "punches" not in out
