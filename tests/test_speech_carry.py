"""speech_carry: everything else on the timeline follows the speech through a speech edit (PL44 T9).

The fixture is the real speech of tests/fixtures/speech_text (README there): clip-1 plays source
0-10.1 at 0, clip-2 10.7-19.7 at 10.1, clip-3 20.1-30.0 at 18.9 (a 0.2 s crossfade with clip-2).
`st-face` holds face-1, linked to clip-2. Times quoted in comments are what the T8 build gives on
that fixture (deleting A4 cuts source 11.758-14.956 out of clip-2, for instance).
"""
import copy
import json
import os
import shutil
import sys
from types import SimpleNamespace

import pytest

from lib.keyframe_curves import sample_track
from lib.speech_build import items_from_runs, runs_from_rows
from lib.speech_carry import BED_SHARE, TimeMap, carry, words_by_src
from lib.speech_pauses import silences
from lib.speech_text import derive, parse, render

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "speech_text")
FPS = 30
FRAME = 1.0 / FPS
EPS = 1e-6


def _load(dst):
    shutil.copytree(FIX, dst)
    return json.loads((dst / "project.json").read_text().replace("/FIXTURE", str(dst))), str(dst)


@pytest.fixture(scope="module")
def fx(tmp_path_factory):
    project, pdir = _load(tmp_path_factory.mktemp("sc") / "fx")
    d = derive(project, pdir)
    src = os.path.join(pdir, "speech.mp4")
    words = sorted((w for ln in d.lines.values() for w in ln.words), key=lambda w: w.idx)
    return SimpleNamespace(project=project, pdir=pdir, derived=d, text=render(d, project["id"]), src=src,
                           sils={src: silences(src)}, words=words)


def speech_items(project):
    return project["tracks"][0]["items"]


def track(project, tid):
    return next(t for t in project["tracks"] if t["id"] == tid)


def item(project, iid):
    return next(it for t in project["tracks"] for it in t["items"] if it["id"] == iid)


def all_ids(project, skip_track=0):
    return {it["id"] for i, t in enumerate(project["tracks"]) if i != skip_track for it in t["items"]}


def run(fx, text, project=None, derived=None):
    """The apply's pipeline up to the write: parse, build (T8), time map, carry (T9)."""
    project = project if project is not None else fx.project
    before = copy.deepcopy(project)
    d = derived if derived is not None else (fx.derived if project is fx.project else derive(project, fx.pdir))
    old = copy.deepcopy(speech_items(project))
    _, rows = parse(text)
    runs, rep = runs_from_rows(rows, d, fx.sils, None, old)
    items, prov = items_from_runs(runs, old, FPS, report=rep, sources=project.get("sources"),
                                  reserved_ids=all_ids(project))
    tmap = TimeMap(old, items, prov, words=words_by_src(d))
    new, crep = carry(project, 0, items, tmap, FPS, report=rep)
    assert project == before, "carry must not mutate its input"
    return SimpleNamespace(project=new, report=crep, items=items, prov=prov, tmap=tmap, old=project)


def edit(text, old_row, new_row):
    """Replace one whole row of the Cut section (new_row None deletes it)."""
    lines = text.split("\n")
    assert lines.count(old_row) == 1, old_row
    i = lines.index(old_row)
    if new_row is None:
        del lines[i]
    else:
        lines[i] = new_row
    return "\n".join(lines)


def append(text, row):
    """Add a row at the end of the Cut section."""
    return text.replace("\n\n## Unused", "\n" + row + "\n\n## Unused", 1)


def move_to_end(text, row):
    return append(edit(text, row, None), row)


def a1(fx):
    return next(x for x in fx.text.split("\n") if x.startswith("A1 "))


A4 = "A4 {1.60} Hartford,"
A5 = "A5 {0.78} 1876 CHAPTER {0.22} I"
A6 = 'A6 {0.77} "Tom!"'
A1_CUT_FROM, A1_CUT_TO = "themselves, and of how they felt and thought", "themselves, thought"   # words 7-12


def flags(report, kind):
    return [f for f in report.flagged if f["kind"] == kind]


PROBE = 1e-5   # look this far inside a word: item times are rounded to 6 decimals


def positions(items, t):
    """(src, source second) of every item playing timeline time t."""
    out = []
    for it in items:
        if it["start"] <= t < it["end"] and "inPoint" in it:
            out.append((it["src"], it["inPoint"] + (t - it["start"]) * it.get("speed", 1)))
    return out


def holder(items, src, s):
    """The new speech item whose source range holds source second s."""
    return next(it for it in items if it.get("src") == src and it["inPoint"] - EPS <= s <= it["outPoint"] + EPS)


def assert_valid(tmp_path, project, name="p"):
    """The engine's own project check, in-process; it refuses through lib.common.fail (SystemExit)."""
    engine_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "engine")
    if engine_dir not in sys.path:
        sys.path.append(engine_dir)   # validate.py imports its sibling validate_step by bare name
    from engine.validate import validate_project
    p = tmp_path / f"{name}.json"
    p.write_text(json.dumps(project))
    try:
        assert validate_project(str(p)) == {"valid": True}
    except SystemExit as e:  # validate fails through lib.common.fail
        pytest.fail(f"engine validation refused the carried project ({name}): exit {e.code}")


# ---------------------------------------------------------------- no-op


def test_constants():
    assert BED_SHARE == 0.9


def test_unedited_text_changes_nothing(fx):
    r = run(fx, fx.text)
    assert json.dumps(r.project) == json.dumps(fx.project)
    assert r.report.flagged == []
    d = r.report.as_dict()
    assert d["carried"] == {"linked": 1, "overlays": 2, "captionWords": 51, "audio": 2, "markers": 1, "notes": 1}
    assert d["cut"] == [] and d["hardCuts"] == 0


@pytest.mark.parametrize("row", [A6, A4])
def test_an_old_cut_that_plays_a_line_twice_carries_unchanged(fx, row):
    """Each old play of a repeated moment carries to its own copy (lineage), never to the first copy.
    A4 is inside face-1's range, so the old cut also holds the repeat's linked piece."""
    old = run(fx, append(fx.text, row)).project         # clip-2-s2 plays the row again from 28.8
    old["tracks"].append({"id": "trk-x", "items": [
        {"id": "on-repeat", "type": "overlay", "src": "a.jsx", "start": 28.9, "end": 29.5, "props": {}}]})
    old["markers"].append({"id": "m-rep", "t": 29.0, "label": ""})
    d = derive(old, fx.pdir)
    r = run(fx, render(d, old["id"]), project=old, derived=d)
    assert json.dumps(r.project) == json.dumps(old)


# ---------------------------------------------------------------- the time map


def test_time_map_forward_next_kept_and_new_times(fx):
    r = run(fx, edit(fx.text, A4, None))
    tm, src = r.tmap, fx.src
    c2b = item(r.project, "clip-2-s2")                  # clip-2 after "Hartford,": source 14.956-19.7
    assert tm.source_at(12.0) == (src, pytest.approx(12.6))
    assert tm.source_at(5.0) == (src, 5.0)
    assert tm.forward(5.0) == 5.0                       # before the cut: exactly unchanged
    assert tm.new_times(src, 12.6) == [] and tm.forward(12.0) is None
    assert tm.next_kept(12.0) == pytest.approx(c2b["start"])
    assert tm.forward(19.0) == pytest.approx(item(r.project, "clip-3")["start"] + 0.1)   # crossfade: the incoming item
    assert tm.forward(30.0) == pytest.approx(30.0 - 28.8 + tm.new_end)                    # past the end follows the end
    rep = run(fx, append(fx.text, A6))
    assert len(rep.tmap.new_times(src, 18.0)) == 2 and rep.tmap.forward(17.4) == 17.4     # a repeat: two times, first wins


# ---------------------------------------------------------------- linked layers


def _face_with_keyframes(fx):
    project = copy.deepcopy(fx.project)
    item(project, "face-1")["keyframes"] = [{"prop": "scale", "points": [{"t": 0, "value": 0.3}, {"t": 4.0, "value": 0.5}]}]
    return project


def test_linked_layer_follows_its_speech_piece_by_piece(fx):
    project = _face_with_keyframes(fx)
    face = item(project, "face-1")
    r = run(fx, edit(fx.text, A5, "A5 {0.78} CHAPTER {0.22} I"), project=project)   # "1876" cut inside clip-2
    pieces = track(r.project, "st-face")["items"]
    assert [p["id"] for p in pieces] == ["face-1", "face-1-s2"]
    for p in pieces:
        partner = holder(r.items, p["src"], p["inPoint"] + EPS)
        assert abs((p["start"] - p["inPoint"]) - (partner["start"] - partner["inPoint"])) < EPS, p["id"]
        assert partner["inPoint"] - EPS <= p["inPoint"] and p["outPoint"] <= partner["outPoint"] + EPS
        assert abs((p["end"] - p["start"]) - (p["outPoint"] - p["inPoint"])) < EPS
        assert (p["muted"], p["scale"], p["sourceCrop"]) == (True, 0.3, face["sourceCrop"])
        off = p["inPoint"] - face["inPoint"]
        assert abs(sample_track(p["keyframes"][0], 0) - sample_track(face["keyframes"][0], off)) < 1e-9
    assert pieces[0]["inPoint"] == face["inPoint"] and pieces[-1]["outPoint"] == face["outPoint"]
    assert pieces[0]["outPoint"] < fx.words[27].start + 0.05 and pieces[1]["inPoint"] > fx.words[27].end - 0.05
    assert flags(r.report, "linked_removed") == []
    assert r.report.carried["linked"] == 2


def test_linked_layer_replicates_for_a_repeat_and_goes_when_cut(fx):
    r = run(fx, append(fx.text, A4))                    # "Hartford," played twice
    pieces = track(r.project, "st-face")["items"]
    assert [p["id"] for p in pieces] == ["face-1", "face-1-s2"]
    rep = holder(r.items[3:], fx.src, fx.words[26].start)
    assert abs((pieces[1]["start"] - pieces[1]["inPoint"]) - (rep["start"] - rep["inPoint"])) < EPS
    assert pieces[0] == item(fx.project, "face-1")      # the original play is untouched
    r = run(fx, edit(edit(fx.text, A4, None), A5, None))
    assert track(r.project, "st-face")["items"] == []
    assert flags(r.report, "linked_removed") == [{"kind": "linked_removed", "id": "face-1", "src": fx.src}]


# ---------------------------------------------------------------- overlays


def test_overlay_moves_with_its_line(fx):
    r = run(fx, move_to_end(fx.text, a1(fx)))           # clip-1 now plays last, from 18.7
    c1 = item(r.project, "clip-1")
    ov1, ov2 = item(r.project, "ov-1"), item(r.project, "ov-2")
    assert (ov1["start"], ov1["end"]) == (pytest.approx(c1["start"] + 6.6), pytest.approx(c1["end"]))
    assert positions(r.items, ov1["start"] + PROBE)[0][1] == pytest.approx(6.6, abs=1e-4)
    assert (ov2["start"], ov2["end"]) == (pytest.approx(18.0 - 10.1), pytest.approx(20.0 - 10.1))
    assert [f["kind"] for f in r.report.flagged] == ["bed_check_timing"] and r.report.carried["overlays"] == 2


def test_overlay_whose_content_is_split_apart_keeps_the_part_under_its_start(fx):
    # 9.0-11.0 spans clip-1's end and clip-2's start; with A1 moved to the end the two parts land apart
    r = run(fx, move_to_end(fx.text, a1(fx)), project=_with_overlays(fx, ("ov-x", 9.0, 11.0)))
    c1, x = item(r.project, "clip-1"), item(r.project, "ov-x")
    assert (x["start"], x["end"]) == (pytest.approx(c1["start"] + 9.0), pytest.approx(c1["end"]))
    assert sample_track(x["keyframes"][0], x["end"] - x["start"]) == pytest.approx(1.1 / 2.0)
    assert [f["id"] for f in flags(r.report, "overlay_clipped")] == ["ov-x"]


def test_overlay_whose_line_is_deleted_comes_off_and_is_listed(fx):
    project = copy.deepcopy(fx.project)
    project["audio"]["tracks"].append({"id": "sfx", "src": fx.src, "start": 7.0, "end": 8.0, "inPoint": 1.0, "outPoint": 2.0})
    r = run(fx, edit(fx.text, a1(fx), None), project=project)
    assert [it["id"] for it in track(r.project, "trk-2")["items"]] == ["ov-2"]
    assert flags(r.report, "overlay_removed") == [{"kind": "overlay_removed", "id": "ov-1", "src": item(fx.project, "ov-1")["src"]}]
    assert [a["id"] for a in r.project["audio"]["tracks"]] == ["aud-bed", "aud-line"]
    assert flags(r.report, "audio_removed") == [{"kind": "audio_removed", "id": "sfx", "src": fx.src}]


def _with_overlays(fx, *spans):
    project = copy.deepcopy(fx.project)
    project["tracks"].append({"id": "trk-x", "items": [
        {"id": iid, "type": "overlay", "src": item(fx.project, "ov-1")["src"], "start": a, "end": b, "props": {},
         "keyframes": [{"prop": "opacity", "points": [{"t": 0, "value": 0}, {"t": b - a, "value": 1}]}]}
        for iid, a, b in spans]})
    return project


def test_overlays_landing_one_inside_the_other_are_trimmed_and_listed(fx, tmp_path):
    # both starts fall in the cut words 7-12, so both move to the first kept moment: X inside Y
    project = _with_overlays(fx, ("ov-x", 3.5, 7.0), ("ov-y", 4.0, 7.5))
    r = run(fx, fx.text.replace(A1_CUT_FROM, A1_CUT_TO), project=project)
    x, y = item(r.project, "ov-x"), item(r.project, "ov-y")
    kept = r.tmap.next_kept(3.5)
    assert x["start"] == pytest.approx(kept) and y["start"] == pytest.approx(x["end"])
    assert y["end"] == pytest.approx(r.tmap.forward(7.5 - EPS), abs=1e-5)
    assert {f["id"] for f in flags(r.report, "overlay_moved")} == {"ov-x", "ov-y"}
    assert [f["id"] for f in flags(r.report, "overlay_trimmed")] == ["ov-y"]
    # the opacity ramp is re-based: it starts where the old one stood at the item's first kept moment
    u = r.tmap.first_kept(3.5)
    assert sample_track(x["keyframes"][0], 0) == pytest.approx((u - 3.5) / 3.5)
    assert_valid(tmp_path, r.project)


def test_overlays_stacked_by_a_reorder_refuse_the_apply(fx, capsys):
    project = _with_overlays(fx, ("ov-x", 8.0, 13.0), ("ov-y", 9.0, 15.0))
    with pytest.raises(SystemExit):
        run(fx, move_to_end(fx.text, a1(fx)), project=project)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "carry_conflict"
    assert err["message"].startswith("trk-x: ov-x, ov-y overlap after the edit")


# ---------------------------------------------------------------- captions


def _caption_words(project):
    return [(seg, w) for seg in project["captions"]["segments"] for w in seg["words"]]


def test_caption_words_keep_their_source_time(fx):
    t = edit(fx.text, A4, None).replace(A1_CUT_FROM, A1_CUT_TO)
    r = run(fx, t)
    old = _caption_words(fx.project)
    new = _caption_words(r.project)
    assert len(new) == len(old) - 7                     # "Hartford," and the 6 cut words of A1
    for seg, w in new:
        cands = [ow for _, ow in old if ow["word"] == w["word"]]
        for side in ("start", "end"):
            inward = PROBE if side == "start" else -PROBE
            (src, s_new), = positions(r.items, w[side] + inward)[:1]
            matched = any(abs(s_new - s_old) <= FRAME for ow in cands for _, s_old in
                          positions(speech_items(fx.project), ow[side] + inward))
            it = holder(r.items, src, s_new)
            clipped = abs(w[side] - it["start" if side == "start" else "end"]) < EPS
            assert matched or clipped, (seg["id"], w, side)
    segs = {s["id"]: s for s in r.project["captions"]["segments"]}
    assert segs["cap-2"]["text"] == "The Author 1876 CHAPTER"
    assert segs["cap-1"]["text"] == " ".join(w["word"] for w in segs["cap-1"]["words"])
    assert segs["cap-5"]["text"] == item_text(fx, "cap-5")          # untouched words keep their text
    assert flags(r.report, "caption_removed") == []
    starts = [s["start"] for s in r.project["captions"]["segments"]]
    assert starts == sorted(starts)


def item_text(fx, sid):
    return next(s["text"] for s in fx.project["captions"]["segments"] if s["id"] == sid)


def test_a_repeated_line_gets_copies_of_its_caption_words(fx):
    project = copy.deepcopy(fx.project)
    cap3 = next(s for s in project["captions"]["segments"] if s["id"] == "cap-3")
    cap3.update(color="#ff0000", lane=1, offsetY=4)
    cap3["words"][1]["accent"] = "serif"                 # the "Tom!" of A6
    r = run(fx, append(fx.text, A6), project=project)
    segs = {s["id"]: s for s in r.project["captions"]["segments"]}
    assert segs["cap-3"] == cap3                         # the first play keeps everything
    copy_ = segs["cap-3-2"]
    rep = item(r.project, "clip-2-s2")
    assert [w["word"] for w in copy_["words"]] == ['"Tom!"'] and copy_["words"][0]["accent"] == "serif"
    assert (copy_["color"], copy_["lane"], copy_["offsetY"], copy_["text"]) == ("#ff0000", 1, 4, '"Tom!"')
    assert rep["start"] - EPS <= copy_["start"] and copy_["end"] <= rep["end"] + EPS
    assert r.report.carried["captionWords"] == 52


def test_new_speech_gets_captions_from_the_sidecar(fx):
    # clip-3 stops before A13; its caption words go too. Bringing A13 back is speech the old cut never played.
    project = copy.deepcopy(fx.project)
    c3 = speech_items(project)[2]
    c3.update(outPoint=28.4, end=c3["start"] + 28.4 - 20.1)
    cap6 = next(s for s in project["captions"]["segments"] if s["id"] == "cap-6")
    cap6["words"] = cap6["words"][:2]
    cap6.update(text='"No answer."', end=cap6["words"][-1]["end"])
    project["audio"]["tracks"][0]["end"] = c3["end"]
    d = derive(project, fx.pdir)
    text = render(d, project["id"])
    a13 = "A13 The old lady pulled her speckle."
    assert "\n" + a13 in text.split("## Unused")[1]
    r = run(fx, append(text, a13), project=project, derived=d)
    new = [s for s in r.project["captions"]["segments"] if s["id"] not in {x["id"] for x in project["captions"]["segments"]}]
    assert [s["id"] for s in new] == ["cap-7"]
    assert [w["word"] for w in new[0]["words"]] == ["The", "old", "lady", "pulled", "her", "speckle."]
    for w, ref in zip(new[0]["words"], fx.words[46:52]):
        (_, s), = positions(r.items, w["start"] + PROBE)
        assert abs(s - ref.start) <= FRAME
    assert r.report.carried["captionWords"] == 45 + 6


def test_captions_absent_or_null_are_left_alone(fx):
    for value in (None, "absent"):
        project = copy.deepcopy(fx.project)
        if value == "absent":
            del project["captions"]
        else:
            project["captions"] = None
        r = run(fx, edit(fx.text, A4, None), project=project)
        assert ("captions" in r.project) == (value is None) and r.project.get("captions") is None


# ---------------------------------------------------------------- audio


def test_bed_end_follows_the_new_end_and_is_listed(fx):
    project = copy.deepcopy(fx.project)
    project["audio"]["tracks"][0]["outPoint"] = 28.8
    r = run(fx, edit(fx.text, A4, None), project=project)
    bed = r.project["audio"]["tracks"][0]
    new_end = max(it["end"] for it in r.items)
    assert (bed["start"], bed["end"]) == (0, pytest.approx(new_end))
    assert bed["outPoint"] == pytest.approx(28.8 - (28.8 - new_end))
    assert flags(r.report, "bed_check_timing") == [{"kind": "bed_check_timing", "id": "aud-bed"}]


def test_voice_line_moves_with_item_3(fx):
    # the line starts on clip-3's first frame, inside the clip-2/clip-3 crossfade: it belongs to clip-3
    for t in (edit(fx.text, A4, None), move_to_end(fx.text, 'A8 "Tom!" {0.17}')):
        r = run(fx, t)
        line, c3 = r.project["audio"]["tracks"][1], item(r.project, "clip-3")
        assert line["start"] == pytest.approx(c3["start"]) and line["end"] == pytest.approx(c3["start"] + 2.0)
        assert (line["inPoint"], line["outPoint"]) == (5.0, 7.0)
        assert flags(r.report, "audio_moved") == [] and flags(r.report, "audio_removed") == []


# ---------------------------------------------------------------- markers and notes


def test_marker_in_a_cut_moves_to_the_next_kept_moment(fx):
    r = run(fx, edit(fx.text, A4, None))
    c2b = item(r.project, "clip-2-s2")
    assert r.project["markers"] == [{"id": "m1", "t": pytest.approx(c2b["start"]), "label": "beat"}]
    assert [f["id"] for f in flags(r.report, "marker_moved")] == ["m1", "note-1"]


def test_markers_stay_sorted(fx):
    project = copy.deepcopy(fx.project)
    project["markers"] = [{"id": "m0", "t": 5.0, "label": ""}, {"id": "m1", "t": 12.0, "label": "beat"}]
    r = run(fx, move_to_end(fx.text, a1(fx)), project=project)
    assert [(m["id"], round(m["t"], 4)) for m in r.project["markers"]] == [("m1", 1.9), ("m0", 23.7)]
    assert flags(r.report, "marker_moved") == []


def test_notes_carry_their_range_and_are_never_removed(fx):
    project = copy.deepcopy(fx.project)
    project["notes"].append({"id": "note-2", "t": 12.0, "tEnd": 12.5, "text": "all cut", "done": True})
    r = run(fx, edit(fx.text, A4, None), project=project)
    c2b = item(r.project, "clip-2-s2")
    n1, n2 = r.project["notes"]
    # note-1 14.0-15.5 is source 14.6-16.1: its start is cut, the rest (from 14.956) survives
    assert (n1["t"], n1["tEnd"], n1["text"]) == (pytest.approx(c2b["start"]), pytest.approx(c2b["start"] + 16.1 - c2b["inPoint"]), "check this line")
    assert (n2["t"], n2["tEnd"], n2["done"], n2["text"]) == (pytest.approx(c2b["start"]), pytest.approx(c2b["start"]), True, "all cut")
    assert [f["id"] for f in flags(r.report, "marker_moved")] == ["m1", "note-1", "note-2"]


# ---------------------------------------------------------------- time on no speech item (holes)


def _shifted(fx, by, after):
    """The fixture with every speech item starting at or after `after` moved by `by` seconds."""
    project = copy.deepcopy(fx.project)
    for it in speech_items(project):
        if it["start"] >= after - EPS:
            it["start"], it["end"] = round(it["start"] + by, 6), round(it["end"] + by, 6)
    return project


def test_time_past_the_end_follows_the_new_end(fx):
    project = _with_overlays(fx, ("card", 28.8, 31.8))
    project["markers"].append({"id": "m-end", "t": 30.0, "label": "end"})
    r = run(fx, edit(fx.text, A4, None), project=project)
    card, end = item(r.project, "card"), max(it["end"] for it in r.items)
    assert (card["start"], card["end"]) == (pytest.approx(end), pytest.approx(end + 3.0))
    assert r.project["markers"][-1]["t"] == pytest.approx(end + 1.2)


def test_time_in_a_gap_follows_the_speech_before_it(fx, tmp_path):
    project = _shifted(fx, 2.0, 10.1)                     # a 2.0 s gap between clip-1 and clip-2, at 10.1-12.1
    for it in track(project, "st-face")["items"] + track(project, "trk-2")["items"][1:]:
        it["start"], it["end"] = it["start"] + 2.0, it["end"] + 2.0
    project["captions"] = None
    project["tracks"].append({"id": "trk-x", "items": [
        {"id": "gap-a", "type": "overlay", "src": "a.jsx", "start": 10.6, "end": 11.6, "props": {}},
        {"id": "gap-b", "type": "overlay", "src": "b.jsx", "start": 11.7, "end": 12.0, "props": {}}]})
    d = derive(project, fx.pdir)
    text = render(d, project["id"])
    assert "\n-- gap 2.00\n" in text
    same = run(fx, text, project=project, derived=d)
    assert json.dumps(same.project) == json.dumps(project)
    r = run(fx, edit(text, "-- gap 2.00", "-- gap 1.00"), project=project, derived=d)
    a = item(r.project, "gap-a")
    assert (a["start"], a["end"]) == (10.6, pytest.approx(11.1))     # what is left of the gap: 10.1-11.1
    assert [it["id"] for it in track(r.project, "trk-x")["items"]] == ["gap-a"]
    assert [f["id"] for f in flags(r.report, "overlay_removed")] == ["gap-b"]
    assert_valid(tmp_path, r.project)
    r = run(fx, edit(text, "-- gap 2.00", None), project=project, derived=d)
    assert track(r.project, "trk-x")["items"] == []


def test_time_before_the_first_item_keeps_its_place(fx):
    project = _shifted(fx, 2.0, 0.0)
    for t in project["tracks"][1:]:
        for it in t["items"]:
            it["start"], it["end"] = it["start"] + 2.0, it["end"] + 2.0
    project["captions"] = None
    project["tracks"].append({"id": "trk-x", "items": [
        {"id": "intro", "type": "overlay", "src": "a.jsx", "start": 0.0, "end": 1.5, "props": {}}]})
    d = derive(project, fx.pdir)
    text = render(d, project["id"])
    r = run(fx, edit(text, A4, None), project=project, derived=d)
    assert item(r.project, "intro") == track(project, "trk-x")["items"][0]
    assert item(r.project, "ov-1")["start"] == pytest.approx(8.6)


# ---------------------------------------------------------------- the engine accepts the result


@pytest.mark.parametrize("name", ["a4_deleted", "a1_moved", "a1_deleted", "a6_repeated", "1876_cut", "a1_words_cut"])
def test_carried_projects_pass_engine_validation(fx, tmp_path, name):
    t = {"a4_deleted": lambda: edit(fx.text, A4, None),
         "a1_moved": lambda: move_to_end(fx.text, a1(fx)),
         "a1_deleted": lambda: edit(fx.text, a1(fx), None),
         "a6_repeated": lambda: append(fx.text, A6),
         "1876_cut": lambda: edit(fx.text, A5, "A5 {0.78} CHAPTER {0.22} I"),
         "a1_words_cut": lambda: fx.text.replace(A1_CUT_FROM, A1_CUT_TO)}[name]()
    r = run(fx, t)
    assert_valid(tmp_path, r.project, name)
    ids = [it["id"] for tr in r.project["tracks"] for it in tr["items"]]
    assert len(ids) == len(set(ids))
    cap_ids = [s["id"] for s in r.project["captions"]["segments"]]
    assert len(cap_ids) == len(set(cap_ids))


def test_report_shape(fx):
    r = run(fx, edit(fx.text, A4, None))
    d = r.report.as_dict()
    assert set(d) == {"cut", "moved", "pauses", "clamped", "hardCuts", "flagged", "carried"}
    assert d["cut"] == [{"line": "A4", "words": "Hartford,", "seconds": 1.6}]
    assert d["carried"] == {"linked": 1, "overlays": 2, "captionWords": 50, "audio": 2, "markers": 1, "notes": 1}
    assert [f["kind"] for f in d["flagged"]] == ["bed_check_timing", "marker_moved", "marker_moved"]
