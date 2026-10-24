"""place (§558): one overlay at seconds or at a spoken phrase, written through the guarded path.

The speech fixture is cut's (tests/fixtures/speech_text: real audio, its whisper words relabelled): the line
"Our new editor is three times faster." said three times, first with an "um", then restarted ("Our new editor
is... Our new editor is three times faster."), then clean. Transcription is stubbed, so no model runs; the
measurer is faked except in the last tests, which render the two presets through the real sample_overlay.
"""
import json
import os
import re
import shutil
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib import look_check as lc, phrase_at  # noqa: E402
import steps.edit.place as place  # noqa: E402
import steps.render.look as look  # noqa: E402

FIX = REPO_ROOT / "tests" / "fixtures" / "speech_text"
SCRIPT = ("Our new editor is, um, three times faster. "
          "Our new editor is... Our new editor is three times faster. "
          "Our new editor is three times faster. "
          "Then we added captions for every clip. It works on every phone you own. "
          "Try it today and tell us. Thanks for watching everyone, see you.").split()
UM_TAKE_S, RESTART_TAKE_S, CLEAN_TAKE_S = 1.87, 6.54, 10.705   # "three" in each take, on the timeline


def transcript(script=SCRIPT):
    real = json.loads((FIX / "speech.json").read_text())
    words = [w for w in real["transcription"] if w["text"].strip()]
    assert len(words) == len(script)
    return {**real, "transcription": [{**w, "text": " " + t, "offsets": dict(w["offsets"])} for w, t in zip(words, script)]}


def make_project(tmp_path, overlays=(), with_transcript=True, script=SCRIPT):
    d = tmp_path / "proj"
    d.mkdir()
    shutil.copy(FIX / "speech.mp4", d / "speech.mp4")
    if with_transcript:
        (d / "speech.json").write_text(json.dumps(transcript(script)))
    (d / "overlays").mkdir()
    items = []
    for ov in overlays:
        (d / "overlays" / f"{ov['id']}.jsx").write_text("export default function O() { return <div>x</div> }")
        items.append({"type": "overlay", "src": f"./overlays/{ov['id']}.jsx", **ov})
    project = {"id": "place-fixture", "name": "Place", "settings": {"fps": 30, "resolution": [1080, 1920]},
               "tracks": [{"id": "trk-0", "items": [{"id": "clip-0", "type": "video", "src": str(d / "speech.mp4"),
                                                     "start": 0, "end": 30, "inPoint": 0, "outPoint": 30, "sourceDuration": 30}]}]}
    if items:
        project["tracks"].append({"id": "ovl-1", "items": items})
    (d / "project.json").write_text(json.dumps(project, indent=2))
    return d


def fake_measure(boxes=(("ok", 200, 600, 400, 80),)):
    calls = []

    def fn(item, path, frame, duration, fps, width, height, out):
        calls.append({"id": item["id"], "path": path, "frame": frame, "duration": duration, "props": item.get("props")})
        return {"texts": [{"text": t, "bbox": {"x": x, "y": y, "w": w, "h": h}} for t, x, y, w, h in boxes]}, None
    fn.calls = calls
    return fn


def no_transcribe(*a, **k):
    raise AssertionError("transcription was not expected")


def run(d, **kw):
    kw.setdefault("measure_fn", fake_measure())
    kw.setdefault("transcribe", no_transcribe)
    return place.run(str(d / "project.json"), **kw)


def refused(capsys, fn, *a, **k):
    with pytest.raises(SystemExit):
        fn(*a, **k)
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


def tracks(d):
    return json.loads((d / "project.json").read_text())["tracks"]


# ── by seconds, presets ───────────────────────────────────────────────────────────────────────────────────────────

def test_a_preset_at_seconds_is_added_on_the_free_overlay_track_with_its_file_and_props(tmp_path):
    d = make_project(tmp_path)
    m = fake_measure()
    out = run(d, at="2.5", for_s=4, preset="lower_third", props=json.dumps({"text": "Maya Chen", "subtitle": "Video Editor"}), measure_fn=m)
    assert out == {"id": out["id"], "start": 2.5, "end": 6.5, "track": out["track"]}
    assert re.fullmatch(r"trk-[0-9a-f]{6}", out["track"]), "a new track gets a trk-<6 hex> id (§482)"
    item = tracks(d)[1]["items"][0]
    assert item == {"id": out["id"], "type": "overlay", "start": 2.5, "end": 6.5, "src": "./overlays/lower-third.jsx",
                    "props": {"text": "Maya Chen", "subtitle": "Video Editor", "canvasW": "1080", "canvasH": "1920"}}
    assert (d / "overlays" / "lower-third.jsx").read_bytes() == (Path(place.PRESETS_DIR) / "lower-third.jsx").read_bytes()
    assert m.calls[0]["frame"] == 60 and m.calls[0]["duration"] == 120, "measured once, mid-span"
    assert len(json.dumps(out)) <= 300


def test_a_preset_never_goes_over_a_different_file_of_its_name(tmp_path):
    d = make_project(tmp_path)
    (d / "overlays" / "callout.jsx").write_text("// the person's own callout")
    out = run(d, at="1", preset="callout", props='{"text": "3x faster"}')
    assert tracks(d)[1]["items"][0]["src"] == "./overlays/callout-2.jsx"
    assert (d / "overlays" / "callout.jsx").read_text() == "// the person's own callout"
    run(d, at="10", preset="callout")
    assert tracks(d)[1]["items"][1]["src"] == "./overlays/callout-2.jsx", "the same preset file is reused"
    assert out["track"] == tracks(d)[1]["id"]


def test_an_overlay_file_in_the_project_is_placed_by_its_path(tmp_path):
    d = make_project(tmp_path)
    (d / "overlays" / "title.jsx").write_text("export default function T() { return <div>t</div> }")
    out = run(d, at="0", until=2, overlay="overlays/title.jsx")
    assert tracks(d)[1]["items"][0]["src"] == "./overlays/title.jsx" and (out["start"], out["end"]) == (0.0, 2.0)


def test_an_overlay_outside_the_project_or_missing_is_refused(tmp_path, capsys):
    d = make_project(tmp_path)
    outside = tmp_path / "elsewhere.jsx"
    outside.write_text("x")
    assert refused(capsys, run, d, at="1", overlay=str(outside))["error"] == "overlay_outside_project"
    assert refused(capsys, run, d, at="1", overlay="overlays/nope.jsx")["error"] == "overlay_not_found"
    assert len(tracks(d)) == 1, "nothing placed"


def test_a_span_past_the_footage_is_shortened_and_said(tmp_path, capsys):
    d = make_project(tmp_path)
    out = run(d, at="28", for_s=5, preset="callout")
    assert out["end"] == 30 and any("shortened to the footage end" in i for i in out["issues"])
    assert refused(capsys, run, d, at="31", preset="callout")["error"] == "invalid_span"


# ── tracks ────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_busy_track_gets_a_new_one_and_a_named_busy_track_is_refused(tmp_path, capsys):
    d = make_project(tmp_path, overlays=[{"id": "ov-a", "start": 0, "end": 5}])
    out = run(d, at="2", preset="callout")
    assert [t["id"] for t in tracks(d)] == ["trk-0", "ovl-1", out["track"]] and out["track"].startswith("trk-")
    err = refused(capsys, run, d, at="3", preset="callout", track="ovl-1")
    assert err["error"] == "track_busy" and "ov-a" in err["message"]


def test_update_by_id_moves_only_that_item(tmp_path):
    d = make_project(tmp_path, overlays=[{"id": "ov-a", "start": 1, "end": 3, "props": {"text": "A"}},
                                          {"id": "ov-b", "start": 6, "end": 8, "props": {"text": "B"}}])
    before_b = tracks(d)[1]["items"][1]
    out = run(d, item_id="ov-a", at="10", props='{"color": "#ff0000"}')
    items = tracks(d)[1]["items"]
    assert [it["id"] for it in items] == ["ov-b", "ov-a"], "no new item; kept in time order"
    assert items[0] == before_b
    assert items[1] == {"id": "ov-a", "type": "overlay", "src": "./overlays/ov-a.jsx", "start": 10.0, "end": 12.0,
                        "props": {"text": "A", "color": "#ff0000"}}
    assert out["id"] == "ov-a" and out["track"] == "ovl-1"


GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@local"]


def _git(d, *args):
    import subprocess
    return subprocess.run([*GIT, *args], cwd=d, capture_output=True, text=True, check=True).stdout


def test_an_update_by_id_takes_a_version_first_and_an_add_takes_none(tmp_path):
    d = make_project(tmp_path, overlays=[{"id": "ov-a", "start": 1, "end": 3}])
    _git(d, "init", "-q")
    _git(d, "add", "project.json")
    _git(d, "commit", "-q", "-m", "init")
    p = json.loads((d / "project.json").read_text())
    p["tracks"][1]["items"][0]["props"] = {"text": "the person's"}   # the person's edit, not in any version yet
    (d / "project.json").write_text(json.dumps(p))
    added = run(d, at="20", preset="callout")
    assert "version" not in added and _git(d, "log", "--format=%s").split("\n")[0] == "init"
    out = run(d, item_id="ov-a", at="12")
    assert out["version"] is True
    assert _git(d, "log", "-1", "--format=%s").strip() == place.VERSION_MESSAGE
    kept = json.loads(_git(d, "show", "HEAD:project.json"))
    assert kept["tracks"][1]["items"][0]["props"] == {"text": "the person's"} and kept["tracks"][1]["items"][0]["start"] == 1


def test_an_update_by_id_outside_a_git_folder_says_no_version(tmp_path):
    d = make_project(tmp_path, overlays=[{"id": "ov-a", "start": 1, "end": 3}])
    out = run(d, item_id="ov-a", at="12")
    assert "version" not in out and any("no version saved" in i for i in out["issues"])


def test_update_of_an_unknown_or_non_overlay_item_is_refused(tmp_path, capsys):
    d = make_project(tmp_path)
    assert refused(capsys, run, d, item_id="ov-zzz", at="1")["error"] == "item_not_found"
    assert refused(capsys, run, d, item_id="clip-0", at="1")["error"] == "not_an_overlay"


# ── a phrase ──────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("take,want", [("clean", CLEAN_TAKE_S), ("first", UM_TAKE_S), ("last", CLEAN_TAKE_S)])
def test_at_a_phrase_takes_the_saying_the_rule_picks(tmp_path, take, want):
    d = make_project(tmp_path)
    out = run(d, at=json.dumps({"phrase": "three times faster", "take": take}), for_s=3, preset="callout")
    assert out["start"] == pytest.approx(want, abs=0.01) and out["take"] == take
    assert "issues" not in out


def test_clean_is_never_the_um_take_or_the_restart_take(tmp_path):
    d = make_project(tmp_path)
    out = run(d, at='{"phrase": "Three times, faster!"}', preset="callout", detail=True)
    assert out["start"] not in (pytest.approx(UM_TAKE_S, abs=0.05), pytest.approx(RESTART_TAKE_S, abs=0.05))
    assert out["start"] == pytest.approx(CLEAN_TAKE_S, abs=0.01) and out["sayings"] == 3


def test_with_no_clean_take_the_fallback_is_said_in_the_issues(tmp_path):
    # the third take says "um" too ("Our new editor um, three times faster."): no saying of the phrase is clean
    script = list(SCRIPT)
    assert script[19:26] == ["Our", "new", "editor", "is", "three", "times", "faster."]
    script[22] = "um,"
    d = make_project(tmp_path, script=script)
    out = run(d, at='{"phrase": "times faster", "take": "clean"}', preset="callout")
    assert out["take"] in ("kept", "last-said")
    assert any('no clean take of "times faster"' in i for i in out["issues"]), out


def test_a_phrase_not_said_is_refused_and_nothing_is_written(tmp_path, capsys):
    d = make_project(tmp_path)
    before = (d / "project.json").read_bytes()
    err = refused(capsys, run, d, at='{"phrase": "ten times slower"}', preset="callout")
    assert err["error"] == "phrase_not_found"
    assert (d / "project.json").read_bytes() == before


def test_a_clip_with_no_transcript_is_transcribed_beside_it_first(tmp_path):
    d = make_project(tmp_path, with_transcript=False)
    calls = []

    def stub(src, prefix, model, language):
        calls.append(src)
        Path(prefix + ".json").write_text(json.dumps(transcript()))
    out = run(d, at='{"phrase": "three times faster", "take": "first"}', preset="callout", transcribe=stub)
    assert calls == [str(d / "speech.mp4")] and (d / "speech.json").is_file()
    assert out["start"] == pytest.approx(UM_TAKE_S, abs=0.01)


# ── the guarded write ─────────────────────────────────────────────────────────────────────────────────────────────

def test_a_human_edit_to_the_tracks_since_the_read_is_refused_and_kept(tmp_path, monkeypatch, capsys):
    d = make_project(tmp_path, overlays=[{"id": "ov-a", "start": 1, "end": 3}])
    real_find = phrase_at.find

    def find_then_the_person_edits(*a, **k):
        found = real_find(*a, **k)
        p = json.loads((d / "project.json").read_text())
        p["tracks"][1]["items"][0]["start"] = 1.5      # moved in the editor while place worked
        (d / "project.json").write_text(json.dumps(p))
        return found
    monkeypatch.setattr(place.phrase_at, "find", find_then_the_person_edits)
    err = refused(capsys, run, d, at='{"phrase": "three times faster"}', preset="callout")
    assert err["error"] == "project_changed"
    after = tracks(d)
    assert after[1]["items"] == [{"type": "overlay", "src": "./overlays/ov-a.jsx", "id": "ov-a", "start": 1.5, "end": 3}]
    assert not (d / "overlays" / "callout.jsx").exists(), "the preset file this call made is not left behind"


def test_a_change_outside_the_tracks_is_kept_and_not_refused(tmp_path, monkeypatch):
    d = make_project(tmp_path)
    real_find = phrase_at.find

    def find_then_rename(*a, **k):
        found = real_find(*a, **k)
        p = json.loads((d / "project.json").read_text())
        p["name"] = "Renamed meanwhile"
        (d / "project.json").write_text(json.dumps(p))
        return found
    monkeypatch.setattr(place.phrase_at, "find", find_then_rename)
    run(d, at='{"phrase": "three times faster"}', preset="callout")
    p = json.loads((d / "project.json").read_text())
    assert p["name"] == "Renamed meanwhile" and len(p["tracks"][1]["items"]) == 1


def test_the_measured_issues_come_back_short(tmp_path):
    d = make_project(tmp_path)
    out = run(d, at="2", preset="callout", measure_fn=fake_measure((("3x faster", 900, 500, 400, 120),)))
    assert out["issues"] == ['3.5s ' + out["id"] + ': text "3x faster" runs off the frame']
    assert len(json.dumps(out)) <= 300


# ── the presets, rendered ─────────────────────────────────────────────────────────────────────────────────────────

def _has_render():
    return shutil.which("node") is not None and (REPO_ROOT / "montaj_assets" / "render" / "node_modules" / "puppeteer").exists()


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
@pytest.mark.parametrize("preset,props", [
    ("lower_third", {"text": "Maya Chen", "subtitle": "Video Editor"}),
    ("callout", {"text": "3x faster"}),
    ("callout", {"text": "Every clip, captioned and cut in one go"}),
    ("lower_third", {"text": "Dr. Alexandra Montgomery-Fitzwilliam", "subtitle": "Head of Post-Production and Color"}),
])
def test_each_preset_renders_its_props_inside_the_frame_and_the_safe_areas(tmp_path, preset, props):
    d = make_project(tmp_path)
    out = run(d, at="2", for_s=3, preset=preset, props=json.dumps(props), measure_fn=look.measure, detail=True)
    assert out["issues"] == [], out
    shown = " ".join(out["text"])
    for word in props["text"].split()[:2]:
        assert word in shown, out


# ── review 1 (write safety) ───────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("kw,err", [
    ({"at": "nan"}, "invalid_at"), ({"at": "inf"}, "invalid_at"), ({"at": "NaN"}, "invalid_at"),
    ({"at": "1", "for_s": float("nan")}, "invalid_span"), ({"at": "1", "until": float("nan")}, "invalid_span"),
    ({"at": "1", "until": float("inf")}, "invalid_span"),
    ({"at": "1", "props": '{"fontSize": NaN}'}, "invalid_props"), ({"at": "1", "props": '{"x": Infinity}'}, "invalid_props"),
])
def test_a_non_finite_number_is_refused_and_nothing_is_written(tmp_path, capsys, kw, err):
    d = make_project(tmp_path)
    before = (d / "project.json").read_bytes()
    assert refused(capsys, run, d, preset="callout", **kw)["error"] == err
    assert (d / "project.json").read_bytes() == before
    json.loads((d / "project.json").read_text())   # still strict JSON


def test_an_identical_preset_no_item_points_at_is_not_reused(tmp_path):
    # a call that made overlays/callout.jsx and was then refused removes it: another call must not have reused it
    d = make_project(tmp_path)
    (d / "overlays" / "callout.jsx").write_bytes((Path(place.PRESETS_DIR) / "callout.jsx").read_bytes())
    run(d, at="1", preset="callout")
    assert tracks(d)[1]["items"][0]["src"] == "./overlays/callout-2.jsx"
    run(d, at="10", preset="callout")
    assert tracks(d)[1]["items"][1]["src"] == "./overlays/callout-2.jsx", "the file an item points at is reused"


def test_an_overlays_folder_leading_outside_the_project_is_refused(tmp_path, capsys):
    d = make_project(tmp_path)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    shutil.rmtree(d / "overlays")
    os.symlink(outside, d / "overlays")
    assert refused(capsys, run, d, at="1", preset="callout")["error"] == "overlay_outside_project"
    assert list(outside.iterdir()) == []


def test_the_sync_file_check_is_asked_of_the_name_written(tmp_path, monkeypatch):
    d = make_project(tmp_path)
    (d / "overlays" / "callout.jsx").write_text("// the person's own")
    asked = []
    monkeypatch.setattr(place.sync_clash, "check_step_write", lambda pid, fields, files: asked.append(list(files)))
    run(d, at="1", preset="callout")
    assert asked == [["overlays/callout-2.jsx"]]


def test_two_clips_sharing_one_transcript_name_are_refused_before_a_phrase_lookup(tmp_path, capsys):
    d = make_project(tmp_path)
    shutil.copy(d / "speech.mp4", d / "speech.mov")
    p = json.loads((d / "project.json").read_text())
    p["tracks"][0]["items"].append({"id": "clip-1", "type": "video", "src": str(d / "speech.mov"), "start": 30, "end": 40,
                                    "inPoint": 0, "outPoint": 10, "sourceDuration": 30})
    (d / "project.json").write_text(json.dumps(p))
    assert refused(capsys, run, d, at='{"phrase": "three times faster"}', preset="callout")["error"] == "transcript_name_clash"


def test_an_empty_track_is_not_taken_for_an_overlay_track(tmp_path):
    d = make_project(tmp_path)
    p = json.loads((d / "project.json").read_text())
    p["tracks"].append({"id": "b-roll", "items": []})
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, at="1", preset="callout")
    assert out["track"] != "b-roll" and tracks(d)[1]["items"] == []


def test_an_insert_keeps_the_other_items_order(tmp_path):
    d = make_project(tmp_path, overlays=[{"id": "ov-a", "start": 5, "end": 6}, {"id": "ov-b", "start": 1, "end": 2}])
    run(d, at="3", for_s=1, preset="callout", track="ovl-1")
    ids = [it["id"] for it in tracks(d)[1]["items"]]
    assert [i for i in ids if i in ("ov-a", "ov-b")] == ["ov-a", "ov-b"] and len(ids) == 3, "the other two keep their order"


# ── review 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_phrase_said_in_two_sentences_uses_the_first_and_names_the_other(tmp_path):
    # "every" is said in "for every clip." and in "on every phone you own."
    d = make_project(tmp_path)
    out = run(d, at='{"phrase": "every"}', preset="callout", detail=True)
    found = phrase_at.find(json.loads((d / "project.json").read_text()), str(d), "every")
    assert out["start"] == pytest.approx(found.start, abs=0.01) and len(out["also"]) == 1 and out["also"][0] > out["start"]
    assert any("said in 2 sentences" in i for i in out["issues"])


def test_takes_of_one_line_that_select_keeps_apart_are_still_one_line(tmp_path):
    script = list(SCRIPT)
    script[22] = "um,"   # "Our new editor um, three times faster.": select keeps all three takes
    d = make_project(tmp_path, script=script)
    out = run(d, at='{"phrase": "times faster"}', preset="callout")
    assert "also" not in out, out


def test_a_refrain_said_at_the_start_and_the_end_of_a_clip_is_two_lines(tmp_path):
    # take_select's rule: the same sentence in two places of one clip, other kept lines between, is two sentences
    script = list(SCRIPT)
    script[0:8] = "Subscribe for more tips. Our editor is fast.".split()
    script[-6:] = "Subscribe for more tips. Bye now.".split()
    d = make_project(tmp_path, script=script)
    out = run(d, at='{"phrase": "subscribe for more tips"}', preset="callout")
    assert out["start"] < 1 and len(out["also"]) == 1 and out["also"][0] > 10, out


def _zero_length(d, last=None):
    """The transcript's words (the last `last`, or all) at zero length, as whisper makes them up."""
    t = json.loads((d / "speech.json").read_text())
    ws = [w for w in t["transcription"] if w["text"].strip()]
    for w in ws[-last:] if last else ws:
        w["offsets"]["to"] = w["offsets"]["from"]
    (d / "speech.json").write_text(json.dumps(t))


def test_a_made_up_last_sentence_never_anchors_a_graphic(tmp_path, capsys):
    script = list(SCRIPT)
    script[-3] = "everyone."            # ... "Thanks for watching everyone. See you." : a two-word last sentence
    d = make_project(tmp_path, script=script)
    assert run(d, at='{"phrase": "see you"}', preset="callout")["start"] > 20, "real words: found"
    (tmp_path / "made-up").mkdir()
    d2 = make_project(tmp_path / "made-up", script=script)
    _zero_length(d2, last=2)
    assert refused(capsys, run, d2, at='{"phrase": "see you"}', preset="callout")["error"] == "phrase_not_found"
    assert run(d2, at='{"phrase": "thanks for watching"}', preset="callout")["start"] > 20, "the rest is speech"


def test_words_on_a_b_roll_clip_never_anchor_a_graphic(tmp_path, capsys):
    d = make_project(tmp_path)
    _zero_length(d)
    assert refused(capsys, run, d, at='{"phrase": "three times faster"}', preset="callout")["error"] == "phrase_not_found"


def test_clean_says_when_cut_keeps_another_take(tmp_path):
    d = make_project(tmp_path)
    out = run(d, at='{"phrase": "three times faster"}', preset="callout")
    assert out["take"] == "clean" and out["note"] == "cut keeps the take at 6.54s"


def test_a_phrase_said_once_never_carries_a_fallback(tmp_path):
    d = make_project(tmp_path)
    out = run(d, at='{"phrase": "thanks for watching"}', preset="callout")
    assert "issues" not in out or not any("no clean take" in i for i in out["issues"])


def test_accents_and_fillers_are_left_out_of_the_comparison(tmp_path):
    d = make_project(tmp_path)
    out = run(d, at='{"phrase": "Thrée, um, times fäster", "take": "first"}', preset="callout")
    assert out["start"] == pytest.approx(UM_TAKE_S, abs=0.01)


def test_a_language_written_without_spaces_matches_by_characters():
    seq = [(0, "三"), (1, "倍"), (2, "速い"), (3, "です")]
    assert phrase_at._matches(seq, ["三倍速い"], True) == [(0, 2)]
    assert phrase_at._matches(seq, ["倍速"], True) == [(1, 2)]
    assert phrase_at._matches(seq, ["三倍速い"], False) == []


def test_the_language_is_detected_unless_given(tmp_path):
    seen = []

    def stub(src, prefix, model, language):
        seen.append((model, language))
        Path(prefix + ".json").write_text(json.dumps(transcript()))
    d = make_project(tmp_path, with_transcript=False)
    run(d, at='{"phrase": "three times faster"}', preset="callout", transcribe=stub)
    assert seen == [(place.DEFAULT_WHISPER_MODEL, "auto")]
    (tmp_path / "second").mkdir()
    d2 = make_project(tmp_path / "second", with_transcript=False)
    run(d2, at='{"phrase": "three times faster"}', preset="callout", transcribe=stub, language="en", model="base.en")
    assert seen[-1] == ("base.en", "en")


def test_place_declares_whisper_s_model_param_so_serve_gives_it_the_long_ceiling():
    from serve.routes.steps import _runs_whisper
    schema = json.loads((REPO_ROOT / "steps" / "edit" / "place.json").read_text())
    assert _runs_whisper(schema)


def test_for_and_until_together_are_refused(tmp_path, capsys):
    d = make_project(tmp_path)
    assert refused(capsys, run, d, at="1", for_s=2, until=5, preset="callout")["error"] == "invalid_params"


def test_a_phrase_not_found_says_how_phrases_match(tmp_path, capsys):
    d = make_project(tmp_path)
    err = refused(capsys, run, d, at='{"phrase": "3 times faster"}', preset="callout")
    assert err["error"] == "phrase_not_found" and "within one sentence, as transcribed" in err["message"]


def test_a_switched_off_track_is_never_chosen(tmp_path):
    d = make_project(tmp_path, overlays=[{"id": "ov-a", "start": 10, "end": 11}])
    p = json.loads((d / "project.json").read_text())
    p["tracks"][1]["enabled"] = False
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, at="1", preset="callout")
    assert out["track"] != "ovl-1"


def test_a_switched_off_track_named_is_refused(tmp_path, capsys):
    d = make_project(tmp_path, overlays=[{"id": "ov-a", "start": 10, "end": 11}])
    p = json.loads((d / "project.json").read_text())
    p["tracks"][1]["enabled"] = False
    (d / "project.json").write_text(json.dumps(p))
    err = refused(capsys, run, d, at="1", preset="callout", track="ovl-1")
    assert "switched off" in err["message"]


def test_an_overlays_path_that_is_a_broken_link_is_refused_not_a_traceback(tmp_path, capsys):
    d = make_project(tmp_path)
    shutil.rmtree(d / "overlays")
    os.symlink(tmp_path / "gone", d / "overlays")
    assert refused(capsys, run, d, at="1", preset="callout")["error"] == "overlays_not_a_folder"


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
@pytest.mark.parametrize("style", ["pop", "outline", "highlight-box", "plate"])
def test_the_lower_third_sits_above_the_captions_of_every_bottom_style(tmp_path, style):
    d = make_project(tmp_path)
    p = json.loads((d / "project.json").read_text())
    p["captions"] = {"style": style, "segments": [{"id": "cap-1", "text": "Keep the best part of every take", "start": 0, "end": 8,
                                                   "words": [{"word": "Keep", "start": 0, "end": 0.5}]}]}
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, at="2", for_s=4, preset="lower_third", props='{"text": "Maya Chen", "subtitle": "Video Editor"}', measure_fn=look.measure)
    assert "issues" not in out, out
