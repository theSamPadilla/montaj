import copy
import json
import os
import shutil

import pytest

from lib import speech_text

from lib.speech_text import derive, render, speech_track_index, stamp

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "speech_text")
GOLDEN = os.path.join(FIX, "speech-text.golden.md")


def load_project(tmp_path):
    """tmp_path copy of the fixture folder with the /FIXTURE placeholder rewritten."""
    d = tmp_path / "fx"
    shutil.copytree(FIX, d)
    raw = (d / "project.json").read_text().replace("/FIXTURE", str(d))
    return json.loads(raw), str(d)


def speech_rows(d):
    return [r for r in d.cut if r.kind == "speech"]


def ids(d):
    return [r.line for r in speech_rows(d)]


def item(project, item_id):
    for t in project["tracks"]:
        for it in t["items"]:
            if it["id"] == item_id:
                return it


def test_golden(tmp_path):
    project, pdir = load_project(tmp_path)
    d = derive(project, pdir)
    text = render(d, project["id"])
    with open(GOLDEN, encoding="utf-8") as f:
        assert text == f.read()


def test_track_and_letters(tmp_path):
    project, pdir = load_project(tmp_path)
    d = derive(project, pdir)
    assert d.track_id == "trk-0"
    assert set(d.letters.values()) == {"A"}


def test_split_gives_same_line_id_twice(tmp_path):
    project, pdir = load_project(tmp_path)
    base = derive(project, pdir)
    # split clip-2 at a word in the middle of a line
    c2 = item(project, "clip-2")
    row = next(r for r in speech_rows(base) if r.item_ids == ["clip-2"] and len(r.words) >= 3)
    w = row.words[len(row.words) // 2]
    at = w.start
    second = copy.deepcopy(c2)
    second["id"] = "clip-2b"
    cut_tl = c2["start"] + (at - c2["inPoint"])
    c2["end"], c2["outPoint"] = cut_tl, at
    second["start"], second["inPoint"] = cut_tl, at
    project["tracks"][0]["items"].insert(2, second)
    after = derive(project, pdir)
    expected = ids(base)
    k = expected.index(row.line)
    expected.insert(k, row.line)
    assert ids(after) == expected
    assert ids(after).count(row.line) == 2


def test_repeat_gives_two_rows_same_id(tmp_path):
    project, pdir = load_project(tmp_path)
    base = derive(project, pdir)
    again = copy.deepcopy(item(project, "clip-1"))
    again.update(id="clip-1-again", start=40.0, end=40.0 + (again["end"] - again["start"]))
    project["tracks"][0]["items"].append(again)
    after = derive(project, pdir)
    first = speech_rows(base)[0].line
    clip1 = [r.line for r in speech_rows(base) if r.item_ids == ["clip-1"]]
    assert ids(after) == ids(base) + clip1
    assert ids(after).count(first) == 2


def test_reorder_swaps_rows_ids_unchanged(tmp_path):
    project, pdir = load_project(tmp_path)
    base = derive(project, pdir)
    c2, c3 = item(project, "clip-2"), item(project, "clip-3")
    d2, d3 = c2["end"] - c2["start"], c3["end"] - c3["start"]
    c3["start"], c3["end"] = 10.1, 10.1 + d3
    c2["start"], c2["end"] = 10.1 + d3 + 0.5, 10.1 + d3 + 0.5 + d2
    after = derive(project, pdir)
    by_item = lambda d, i: [r.line for r in speech_rows(d) if r.item_ids == [i]]
    assert by_item(after, "clip-2") == by_item(base, "clip-2")
    assert by_item(after, "clip-3") == by_item(base, "clip-3")
    order = [r.item_ids[0] for r in speech_rows(after)]
    assert order.index("clip-3") < order.index("clip-2")
    assert order.index("clip-1") < order.index("clip-3")


def test_stamp_changes_on_inpoint_and_sidecar(tmp_path):
    project, pdir = load_project(tmp_path)
    side = os.path.join(pdir, "speech.json")
    s0 = stamp(project, 0, [side])
    assert len(s0) == 12 and s0 == stamp(project, 0, [side])
    item(project, "clip-1")["inPoint"] = 0.001
    assert stamp(project, 0, [side]) != s0
    item(project, "clip-1")["inPoint"] = 0.0
    assert stamp(project, 0, [side]) == s0
    with open(side, "a") as f:
        f.write(" ")
    assert stamp(project, 0, [side]) != s0


def test_speech_track_found_at_index_1(tmp_path):
    project, pdir = load_project(tmp_path)
    t = project["tracks"]
    speech = t[0]
    speech["id"] = "trk-1"
    project["tracks"] = [t[2], speech, t[1]]
    assert speech_track_index(project, None) == 1
    d = derive(project, pdir)
    assert d.track_id == "trk-1"
    assert speech_track_index(project, "st-face") == 2
    assert derive(project, pdir, "st-face").track_id == "st-face"


def test_legacy_array_tracks(tmp_path):
    project, pdir = load_project(tmp_path)
    project["tracks"] = [t["items"] for t in project["tracks"]]
    d = derive(project, pdir)
    assert d.track_id == "trk-0"


def test_missing_transcript_names_the_path(tmp_path, capsys):
    project, pdir = load_project(tmp_path)
    os.remove(os.path.join(pdir, "speech.json"))
    with pytest.raises(SystemExit):
        derive(project, pdir)
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "transcript_missing"
    assert os.path.join(pdir, "speech.mp4") in err["message"]
    assert "transcribe" in err["message"]


def test_image_loop_and_gap_rows(tmp_path):
    project, pdir = load_project(tmp_path)
    items = project["tracks"][0]["items"]
    items.append({"id": "img", "type": "image", "src": os.path.join(pdir, "photo.png"), "start": 32.0, "end": 35.0})
    items.append({"id": "lp", "type": "video", "loop": True, "src": os.path.join(pdir, "speech.mp4"), "start": 35.0, "end": 36.0,
                  "inPoint": 1.0, "outPoint": 2.0})
    d = derive(project, pdir)
    kinds = [r.kind for r in d.cut]
    assert kinds[-3:] == ["gap", "image", "nospeech"]
    assert d.warnings == []
    text = render(d, "t")
    assert "-- gap 3.20" in text
    assert "-- image photo.png 3.00" in text
    assert "-- A 1.00-2.00 no speech" in text


def test_unused_none_omits_section(tmp_path):
    project, pdir = load_project(tmp_path)
    d = derive(project, pdir)
    assert "## Unused" not in render(d, "t", unused="none")
    assert "## Unused" in render(d, "t")


def test_unused_lines_and_partly(tmp_path):
    project, pdir = load_project(tmp_path)
    item(project, "clip-3")["outPoint"] = 23.5
    item(project, "clip-3")["end"] = 22.3
    d = derive(project, pdir)
    assert [ln.id for ln in d.unused] == ["A10", "A11", "A12", "A13"]
    assert d.partly == {"A10"}
    text = render(d, "t")
    assert "\n*A10 " in text.split("## Unused")[1]
    assert "\nA13 " in text.split("## Unused")[1]


def test_pause_markers_are_playing_gaps(tmp_path):
    """Measured on the fixture (README silence table): 0.15 s or more, 2 decimals, lead-in and tail included."""
    project, pdir = load_project(tmp_path)
    d = derive(project, pdir)
    by_line = {r.line: r for r in speech_rows(d)}
    assert by_line["A1"].pauses == {}
    assert by_line["A4"].pauses == {0: 1.6}
    assert by_line["A5"].pauses == {0: 0.78, 2: 0.22}
    assert by_line["A6"].pauses == {0: 0.77}
    assert by_line["A7"].pauses == {0: 0.45}
    assert by_line["A8"].pauses == {1: 0.17}   # tail against clip-2's outPoint


def test_leading_gap_row(tmp_path):
    project, pdir = load_project(tmp_path)
    for it in project["tracks"][0]["items"]:
        it["start"] += 2.0
        it["end"] += 2.0
    d = derive(project, pdir)
    assert d.cut[0].kind == "gap" and d.cut[0].dur == 2.0
    assert render(d, "t").split("## Cut\n\n")[1].startswith("-- gap 2.00\n")


def test_no_transcript_row_and_warning(tmp_path):
    project, pdir = load_project(tmp_path)
    other = os.path.join(pdir, "other.mp4")
    shutil.copy(os.path.join(pdir, "speech.mp4"), other)
    project["tracks"][0]["items"].append({"id": "x", "type": "video", "src": other, "start": 30.0, "end": 32.0,
                                           "inPoint": 1.0, "outPoint": 3.0})
    d = derive(project, pdir)
    assert d.letters[other] == "B"
    assert d.cut[-1].kind == "notranscript"
    text = render(d, "t")
    assert "B = other.mp4" in text
    assert "-- B 1.00-3.00 no transcript" in text
    assert d.warnings == [f'No transcript for {other}; run step transcribe with {json.dumps({"input": other})}']


def test_stamp_constants_are_text_only():
    from lib import speech_lines, speech_pauses
    assert set(speech_text._STAMP_CONSTANTS) <= set(dir(speech_lines)) | set(dir(speech_pauses))


# ---- parse (T6) ----

HDR = "<!-- montaj speech text v1 · track trk-0 · stamp abc123def456 -->\n"


def parse_fail(text, capsys):
    with pytest.raises(SystemExit):
        speech_text.parse(text)
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


def test_parse_round_trips_derived_rows(tmp_path):
    project, pdir = load_project(tmp_path)
    d = derive(project, pdir)
    header, rows = speech_text.parse(render(d, project["id"]))
    assert header == {"track": d.track_id, "stamp": d.stamp}
    assert len(rows) == len(d.cut)
    for p, r in zip(rows, d.cut):
        assert p.kind == r.kind
        if r.kind == "speech":
            assert p.line == r.line
            assert p.tokens == [w.text for w in r.words]
            assert p.pauses == {k: float("%.2f" % v) for k, v in r.pauses.items()}


def test_parse_all_row_kinds_and_fields():
    text = (HDR + "# t\n\nA = a.mp4\n\n## Cut\n\n"
            "A12 {0.48} hey there {0.30} you {0.20}\n"
            "-- gap 2.00\n"
            "-- B 12.40-15.50 no speech\n"
            "-- B 1.00-2.50 no transcript\n"
            "-- image photo.png 3.00\n"
            "\n## Unused\n\n*A9 not parsed {{ junk\n")
    header, rows = speech_text.parse(text)
    assert header == {"track": "trk-0", "stamp": "abc123def456"}
    s = rows[0]
    assert (s.kind, s.line, s.letter, s.number, s.lineno) == ("speech", "A12", "A", 12, 8)
    assert s.tokens == ["hey", "there", "you"]
    assert s.pauses == {0: 0.48, 2: 0.30, 3: 0.20}
    assert (rows[1].kind, rows[1].dur) == ("gap", 2.0)
    assert (rows[2].kind, rows[2].label, rows[2].t0, rows[2].t1) == ("nospeech", "B", 12.4, 15.5)
    assert rows[3].kind == "notranscript"
    assert (rows[4].kind, rows[4].label, rows[4].dur) == ("image", "photo.png", 3.0)
    assert len(rows) == 5


def test_parse_leading_star_dropped_and_repeated_ids_kept():
    _, rows = speech_text.parse(HDR + "## Cut\n*A3 one two\nA3 one\nAA10 x\n")
    assert [r.line for r in rows] == ["A3", "A3", "AA10"]
    assert rows[2].letter == "AA" and rows[2].number == 10


def test_parse_missing_header(capsys):
    e = parse_fail("## Cut\nA1 hi\n", capsys)
    assert e["error"] == "bad_header"


def test_parse_bad_marker(capsys):
    for bad in ("A1 {oops} hi", "A1 hi {0.5", "A1 hi{0.5}", "A1 {0.5}{0.6} hi", "A1 {-1} hi"):
        e = parse_fail(HDR + "## Cut\n\n" + bad + "\n", capsys)
        assert e["error"] == "bad_marker", bad
        assert "Line 4" in e["message"]


def test_parse_bad_row(capsys):
    for bad in ("hello there", "-- gap", "-- gap x", "-- A 1-2 weird", "-- unknown thing"):
        e = parse_fail(HDR + "## Cut\n\n" + bad + "\n", capsys)
        assert e["error"] == "bad_row", bad
        assert "Line 4" in e["message"]


def test_override_track_without_transcript_fails(tmp_path, capsys):
    project, pdir = load_project(tmp_path)
    project["tracks"].append({"id": "trk-9", "items": [
        {"id": "x1", "type": "video", "src": os.path.join(pdir, "nosidecar.mp4"),
         "start": 0, "end": 2, "inPoint": 0, "outPoint": 2}]})
    with pytest.raises(SystemExit):
        derive(project, pdir, track="trk-9")
    e = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert e["error"] == "transcript_missing"
    assert "nosidecar.mp4" in e["message"]


def test_parse_emptied_speech_row_is_a_deleted_line():
    _, rows = speech_text.parse(HDR + "## Cut\nA12\n*A13 {0.30}\nA14 {0.30} {0.40}x\n".replace(" {0.40}x", ""))
    assert [(r.kind, r.line, r.tokens) for r in rows] == [
        ("speech", "A12", []), ("speech", "A13", []), ("speech", "A14", [])]
    assert rows[1].pauses == {0: 0.30}
    assert rows[0].lineno == 3
