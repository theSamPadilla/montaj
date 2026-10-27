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
import subprocess
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
    assert out["issues"] == ['3.5s ' + out["id"] + ': text "3x faster" runs off the frame: move it left 274 px']
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


# ── animation first (PL89c): ready moving patterns, placed in one call ─────────────────────────────────────────────
# 52's PL89c comparison: sections 05, 07 and 09 got nouns or nothing where Claude alone animated the idea (a command
# travelling phone -> computer -> motors, a call ring, "flat ground only" drawn under the robot), and the profile says
# animation is always preferred to plain text. Three presets make that one place call with props, no JSX written.

ANIMATED = {
    "flow": {"points": "phone > small computer > motors"},
    "ring": {"x": "0.5", "y": "0.4", "label": "LIVE"},
    "rule": {"text": "flat ground only", "y": "0.5"},
}


def test_the_animated_presets_are_place_presets_and_listed_in_its_schema():
    for name in ANIMATED:
        assert name in place.PRESETS, name
        assert (Path(place.PRESETS_DIR) / place.PRESETS[name]).is_file(), name
    schema = json.loads((REPO_ROOT / "steps" / "edit" / "place.json").read_text())
    preset = next(p for p in schema["params"] if p["name"] == "preset")
    assert set(ANIMATED) <= set(preset["options"])
    for name in ANIMATED:
        assert name in preset["description"], name


@pytest.mark.parametrize("name", sorted(ANIMATED))
def test_an_animated_preset_moves_by_the_look_check_and_places_with_its_props(tmp_path, name):
    d = make_project(tmp_path)
    out = run(d, at="2", for_s=4, preset=name, props=json.dumps(ANIMATED[name]))
    item = tracks(d)[1]["items"][0]
    assert item["src"] == "./overlays/" + place.PRESETS[name]
    assert {k: item["props"][k] for k in ANIMATED[name]} == ANIMATED[name]
    assert lc.motion_issues(item, str(d), "x") == [], "eased in, alive while held, out before its end"
    assert not out.get("issues"), out


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
@pytest.mark.parametrize("name,words", [
    ("flow", ["phone", "small", "computer", "motors"]),
    ("ring", ["LIVE"]),
    ("rule", ["flat", "ground", "only"]),
    ("flow", ["camera", "phone", "cloud", "operator", "robot"]),
])
def test_an_animated_preset_renders_every_word_inside_the_frame_and_the_safe_areas(tmp_path, name, words):
    d = make_project(tmp_path)
    props = dict(ANIMATED[name])
    if words[0] == "camera":
        props["points"] = " > ".join(words)
    out = run(d, at="2", for_s=4, preset=name, props=json.dumps(props), measure_fn=look.measure, detail=True)
    assert out["issues"] == [], out
    shown = " ".join(out["text"])
    for w in words:
        assert w in shown, out


# ── fonts a preset is given (PL89e) ───────────────────────────────────────────────────────────────────────────────
# 52's round-6 notes: the ring got fontFamily "JetBrains Mono" bare, no font loaded it, and the label drew in Times.
# A preset's face loads (place gives the item its Google Font) and ends in a generic family, so it never falls to serif.

@pytest.mark.parametrize("name", sorted(place.PRESETS) + ["footage_card"])
def test_every_preset_ends_a_bare_face_in_a_generic_family(name):
    code = (Path(place.PRESETS_DIR) / place.COPIED_PRESETS[name]).read_text()
    assert "p.fontFamily ||" not in code, f"{name}: a bare face would fall back to serif"
    assert "withGeneric(p.fontFamily" in code, name


def test_a_preset_given_a_font_gets_it_as_a_google_font(tmp_path):
    d = make_project(tmp_path)
    out = run(d, at="2", preset="ring", props=json.dumps({"label": "LIVE", "fontFamily": "JetBrains Mono", "fontWeight": "700"}))
    item = tracks(d)[1]["items"][0]
    assert any(s.startswith("JetBrains+Mono") for s in item.get("googleFonts", [])), item
    assert out.get("fonts") == item["googleFonts"]
    run(d, at="10", preset="callout", props=json.dumps({"text": "3x"}))
    assert "googleFonts" not in tracks(d)[1]["items"][1], "no font named, none added (the preset's own default)"


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
def test_a_bare_face_renders_with_its_generic_family(tmp_path):
    d = make_project(tmp_path)
    out = run(d, at="2", for_s=3, preset="rule", props=json.dumps({"text": "flat ground only", "fontFamily": "Nonexistent Face"}),
              measure_fn=look.measure, detail=True)
    assert not out.get("issues"), out


# ── configured, not written (PL89 round 9: cost) ──────────────────────────────────────────────────────────────────
# Round 6 wrote 15K characters of overlay JSX in 12 calls, most of it labels following a 3D shot (Motion.follow over a
# direct_scene mark) and stat numerals. scene_labels and stat make those one place item with props.

def _marks(d, scene="specs"):
    part = lambda x: {"cast": 0, "part": "screen", "pixel": [x, 700], "box": [x - 60, 600, x + 60, 800], "inView": True,
                      "leader": {"side": "right", "from": [x + 60, 700], "to": [x + 260, 700], "align": "start"}}
    cast = {"cast": 0, "top": [540, 500], "bottom": [540, 1000], "box": [400, 500, 680, 1000], "metres": 0.48, "inView": True,
            "rule": {"side": "left", "x": 330, "top": 500, "bottom": 1000, "label": [300, 750], "align": "end"}}
    mark = {"kind": "mark", "at": 0, "size": {"width": 1080, "height": 1920}, "parts": [part(540)], "casts": [cast],
            "track": [{"t": 0, "parts": [part(540)], "casts": [cast]}, {"t": 2, "parts": [part(520)], "casts": [cast]}]}
    (d / "overlays" / "_marks").mkdir(parents=True, exist_ok=True)
    (d / "overlays" / "_marks" / f"{scene}.json").write_text(json.dumps(mark))


LABELS = {"marks": "specs", "labels": [{"part": "screen", "text": "camera", "at": 0.5}], "rule": {"text": "19 in", "at": 1}}


def test_scene_labels_is_one_place_item_reading_the_scenes_marks(tmp_path):
    d = make_project(tmp_path)
    _marks(d)
    out = run(d, at="2", for_s=4, preset="scene_labels", props=json.dumps(LABELS))
    item = tracks(d)[1]["items"][0]
    assert item["src"] == "./overlays/scene-labels-specs.jsx"
    code = (d / "overlays" / "scene-labels-specs.jsx").read_text()
    assert "import mark from './_marks/specs.json'" in code and "__SCENE__" not in code
    assert lc.motion_issues(item, str(d), "x") == []
    assert not out.get("issues"), out
    # a second scene gets its own file; the same scene reuses its own
    _marks(d, "mount")
    run(d, at="8", preset="scene_labels", props=json.dumps({**LABELS, "marks": "mount"}))
    assert tracks(d)[1]["items"][1]["src"] == "./overlays/scene-labels-mount.jsx"


@pytest.mark.parametrize("props,word", [({"labels": []}, "marks"), ({"marks": "nope"}, "direct_scene"), ({"marks": "../x"}, "marks")])
def test_scene_labels_needs_a_scene_with_marks(tmp_path, capsys, props, word):
    d = make_project(tmp_path)
    err = refused(capsys, run, d, at="2", preset="scene_labels", props=json.dumps(props))
    assert err["error"] == "invalid_params" and word in err["message"], err


def test_stat_is_a_place_preset(tmp_path):
    d = make_project(tmp_path)
    run(d, at="2", for_s=5, preset="stat", props=json.dumps({"stats": [{"value": "4", "unit": "lb", "at": 0.3}, {"value": "$400", "sub": "the robot", "at": 2}]}))
    item = tracks(d)[1]["items"][0]
    assert item["src"] == "./overlays/stat.jsx" and lc.motion_issues(item, str(d), "x") == []


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
def test_scene_labels_and_stat_render_inside_the_frame(tmp_path, monkeypatch):
    # an overlay reads a project file (the marks) only inside the workspace, where a real project is
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    d = make_project(tmp_path)
    _marks(d)
    out = run(d, at="2", for_s=4, preset="scene_labels", props=json.dumps(LABELS), measure_fn=look.measure, detail=True)
    assert not out.get("issues"), out
    assert "camera" in " ".join(out["text"]) and "19" in " ".join(out["text"]), out
    out = run(d, at="8", for_s=4, preset="stat", props=json.dumps({"stats": [{"value": "4", "unit": "lb", "at": 0.2}]}), measure_fn=look.measure, detail=True)
    assert not out.get("issues"), out
    assert "4" in " ".join(out["text"]), out


# Round 9: the agent gave stat's times as timeline seconds (10.3, 11.5 for an item at 10.2 for 2.4 s) and placed it three
# times over. A time past the item's length that falls inside its span on the timeline is read as timeline seconds.
def test_stat_times_given_on_the_timeline_are_made_seconds_into_the_item(tmp_path):
    d = make_project(tmp_path)
    out = run(d, at="10.2", for_s=2.4, preset="stat", props=json.dumps({"stats": [{"value": "4", "unit": "lb", "at": 10.3}, {"value": "$400", "at": 11.5}]}))
    stats = tracks(d)[1]["items"][0]["props"]["stats"]
    assert [x["at"] for x in stats] == [0.1, 1.3], stats
    assert any("seconds into the item" in i for i in out.get("issues", [])), out
    run(d, at="20", for_s=3, preset="stat", props=json.dumps({"stats": [{"value": "1", "at": 0.5}, {"value": "2", "at": 2}]}))
    assert [x["at"] for x in tracks(d)[1]["items"][1]["props"]["stats"]] == [0.5, 2], "item seconds stay as given"


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


def test_clean_picks_the_last_clean_take_and_says_nothing_more(tmp_path):
    # three sayings: the last of a clear retake is the clean one; cut keeps every take until the agent picks (PL89),
    # so place never says which take cut keeps
    d = make_project(tmp_path)
    out = run(d, at='{"phrase": "three times faster"}', preset="callout")
    assert out["take"] == "clean" and out["start"] > 10 and "note" not in out, out


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


# ── §558 land review ──────────────────────────────────────────────────────────────────────────────────────────────

def test_an_id_with_path_parts_never_leaves_the_samples_folder(tmp_path):
    d = make_project(tmp_path, overlays=[{"id": "ov-a", "start": 1, "end": 3}])
    (d / "project.json").write_text((d / "project.json").read_text().replace('"ov-a"', '"../../../../escape/evil"'))
    m = fake_measure()
    outs = []
    inner = m
    def spy(item, path, frame, duration, fps, width, height, out):
        outs.append(out)
        return inner(item, path, frame, duration, fps, width, height, out)
    run(d, item_id="../../../../escape/evil", at="5", measure_fn=spy)
    samples = (d / "render" / "samples" / "look").resolve()
    assert outs and all(Path(o).resolve().parent == samples for o in outs)


def test_an_update_that_changes_nothing_writes_nothing_and_takes_no_version(tmp_path):
    d = make_project(tmp_path, overlays=[{"id": "ov-a", "start": 1, "end": 3}])
    _git(d, "init", "-q")
    _git(d, "add", "project.json")
    _git(d, "commit", "-q", "-m", "init")
    before = (d / "project.json").read_text()
    out = run(d, item_id="ov-a")
    assert "version" not in out
    assert (d / "project.json").read_text() == before
    assert _git(d, "log", "--format=%s").strip() == "init"


@pytest.mark.parametrize("bad", ["../x", "en us", "english-language-long", "e", "en-"])
def test_a_malformed_language_is_refused(tmp_path, capsys, bad):
    d = make_project(tmp_path)
    assert refused(capsys, run, d, at="2", preset="callout", language=bad)["error"] == "invalid_params"


@pytest.mark.parametrize("ok", ["auto", "en", "es-MX", "pt_BR", "yue"])
def test_a_language_code_passes_the_check(tmp_path, ok):
    d = make_project(tmp_path)
    run(d, at="2", preset="callout", language=ok)


# ── PL89b: what the paid ucla run (final-ucla-pl89b, calls 56-78) did twice ──────────────────────────────────────

def test_an_id_not_on_the_timeline_names_a_new_item_when_there_is_something_to_place(tmp_path, capsys):
    """Run calls 56-60 each passed an id for a new overlay, were refused ("No item ov-specs on the timeline"), then sent
    again without it (61-65). An id that is new and comes with an overlay or a preset is the new item's id."""
    d = make_project(tmp_path)
    out = run(d, item_id="ov-specs", at="2", for_s=3, preset="callout", props='{"text": "19 in"}')
    assert out["id"] == "ov-specs"
    assert [it["id"] for it in tracks(d)[1]["items"]] == ["ov-specs"]
    # an id with nothing to place is still an update of an item that is not there
    assert refused(capsys, run, d, item_id="ov-nope", at="1")["error"] == "item_not_found"
    # an id taken by a non-overlay item, or not a plain name, is refused
    assert refused(capsys, run, d, item_id="clip-0", at="1", preset="callout")["error"] == "not_an_overlay"
    assert refused(capsys, run, d, item_id="a b/c", at="1", preset="callout")["error"] == "invalid_id"


def fake_sheet():
    calls = []

    def fn(project_path, times, out):
        calls.append(list(times))
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(b"png")
        return out
    fn.calls = calls
    return fn


def test_items_places_every_overlay_in_one_call_with_one_sheet(tmp_path):
    """Run calls 56-65 placed five overlays one call each (ten with the refusals). items places them all, checked
    before any is written, and answers one sheet of the middle of each."""
    d = make_project(tmp_path)
    (d / "overlays" / "specs.jsx").write_text("export default function S() { return <div>19 in</div> }")
    sheet = fake_sheet()
    out = place.run_many(str(d / "project.json"), json.dumps([
        {"overlay": "overlays/specs.jsx", "at": 2, "for": 3, "id": "ov-specs"},
        {"preset": "lower_third", "at": 10, "for": 2, "props": {"text": "PhoneBot paper", "subtitle": "UCLA"}},
        {"preset": "callout", "at": 20, "until": 22, "props": {"text": "4 lb"}},
    ]), measure_fn=fake_measure(), transcribe=no_transcribe, sampler=sheet)
    assert [p["id"] for p in out["placed"]][0] == "ov-specs" and len(out["placed"]) == 3
    assert [(p["start"], p["end"]) for p in out["placed"]] == [(2.0, 5.0), (10.0, 12.0), (20.0, 22.0)]
    assert sheet.calls == [[3.5, 11.0, 21.0]], "one sheet, each overlay at its middle"
    assert out["path"] == out["sheet"] and out["sheet"].endswith(".png")
    assert sum(len(t["items"]) for t in tracks(d)[1:]) == 3


def test_items_checks_every_placement_before_writing_any(tmp_path, capsys):
    d = make_project(tmp_path)
    before = tracks(d)
    err = refused(capsys, place.run_many, str(d / "project.json"), json.dumps([
        {"preset": "callout", "at": 1}, {"overlay": "overlays/nope.jsx", "at": 3}]),
        measure_fn=fake_measure(), transcribe=no_transcribe, sampler=fake_sheet())
    assert err["error"] == "overlay_not_found" and err["message"].startswith("items[1]: ")
    assert tracks(d) == before, "nothing placed"
    assert refused(capsys, place.run_many, str(d / "project.json"), "{}", sampler=fake_sheet())["error"] == "invalid_items"


def vendored(tmp_path, monkeypatch, faces):
    """The bundled font set the render serves from (MONTAJ_FONTS_DIR's families.json): {family: [normal weights]}."""
    base = tmp_path / "fonts"
    base.mkdir()
    (base / "families.json").write_text(json.dumps({"families": sorted(faces), "faces": {f: {"normal": w} for f, w in faces.items()}}))
    monkeypatch.setenv("MONTAJ_FONTS_DIR", str(base))


def test_a_bundled_family_short_of_a_weight_keeps_its_bundled_faces_and_asks_google_for_the_rest(tmp_path, monkeypatch):
    """The bundled JetBrains Mono has 400 and 700; the run's overlays used 500 and 800."""
    vendored(tmp_path, monkeypatch, {"JetBrains Mono": [400, 700]})
    d = make_project(tmp_path)
    (d / "overlays" / "m.jsx").write_text("export default function M() { return <div style={{ fontFamily: '\"JetBrains Mono\", monospace', fontWeight: 800 }}><i style={{ fontWeight: 500 }}>x</i></div> }")
    run(d, at="1", overlay="overlays/m.jsx")
    assert tracks(d)[1]["items"][0]["googleFonts"] == ["JetBrains+Mono", "JetBrains+Mono:wght@500;800"]


def test_a_placed_overlay_gets_its_google_fonts_from_its_own_font_stacks(tmp_path, monkeypatch):
    """Run calls 72 and 78 were edit_timeline calls that only set googleFonts on overlays whose shared style named
    "JetBrains Mono". place reads the overlay and its local imports: the first family of each font stack that is not a
    system font, with the weights the files use: one spec when the bundled set has them all, else the family as it
    surely loads plus a spec of the missing weights on its own (a weight Google lacks then fails that link alone)."""
    vendored(tmp_path, monkeypatch, {"JetBrains Mono": [400, 500, 700, 800]})
    d = make_project(tmp_path)
    (d / "overlays" / "_shared").mkdir()
    (d / "overlays" / "_shared" / "style.js").write_text(
        "export const S = { mono: '\"JetBrains Mono\", ui-monospace, Menlo, monospace', body: 'Helvetica, Arial, sans-serif' }\nexport default S\n")
    (d / "overlays" / "specs.jsx").write_text(
        "import S from './_shared/style.js'\nexport default function P() {\n"
        "  return <div style={{ fontFamily: S.mono, fontWeight: 800 }}><span style={{ fontWeight: 500 }}>in</span>"
        "<b style={{ fontFamily: \"'Anton', sans-serif\" }}>19</b></div>\n}\n")
    out = run(d, at="2", overlay="overlays/specs.jsx")
    item = tracks(d)[1]["items"][0]
    assert sorted(item["googleFonts"]) == ["Anton", "Anton:wght@500;800", "JetBrains+Mono:wght@500;800"]
    assert out["fonts"] == item["googleFonts"] and "issues" not in out


def test_an_overlay_s_own_googleFonts_export_wins_and_a_preset_or_system_font_gets_none(tmp_path):
    d = make_project(tmp_path)
    (d / "overlays" / "t.jsx").write_text(
        "export const googleFonts = ['Playfair+Display:ital@1']\n"
        "export default function T() { return <div style={{ fontFamily: '\"Inter\", sans-serif' }}>t</div> }\n")
    run(d, at="1", overlay="overlays/t.jsx")
    (d / "overlays" / "sys.jsx").write_text("export default function T() { return <div style={{ fontFamily: '-apple-system, Helvetica, sans-serif' }}>t</div> }\n")
    run(d, at="5", overlay="overlays/sys.jsx")
    run(d, at="9", preset="callout")
    items = {it["src"]: it for it in tracks(d)[1]["items"]}
    assert items["./overlays/t.jsx"]["googleFonts"] == ["Playfair+Display:ital@1"]
    assert "googleFonts" not in items["./overlays/sys.jsx"] and "googleFonts" not in items["./overlays/callout.jsx"]


def test_fonts_an_item_already_names_are_kept(tmp_path):
    d = make_project(tmp_path, overlays=[{"id": "ov-a", "start": 1, "end": 3, "googleFonts": ["Syne:wght@800"]}])
    (d / "overlays" / "ov-a.jsx").write_text("export default function A() { return <div style={{ fontFamily: '\"Anton\", sans-serif' }}>a</div> }")
    run(d, item_id="ov-a", at="5")
    assert tracks(d)[1]["items"][0]["googleFonts"] == ["Syne:wght@800"]


# Sam (2026-10-26, a paid run's 13 tracks): graphics share one track unless they overlap, and a new graphic never lands
# under a 3D beat or another item drawing over its span. The choice walks down from the top: a track that draws nothing
# over the span is passed, the first graphics track free there is taken, and anything drawing over the span stops the walk
# (a new track on top, where the item draws over it).
def _tracks_doc(*tracks):
    return {"tracks": [{"id": "trk-0", "items": [{"id": "v0", "type": "video", "src": "/x/a.mp4", "start": 0, "end": 60}]}, *tracks]}


def _ov(id_, s, e, src=None):
    return {"id": id_, "type": "overlay", "src": src or f"./overlays/{id_}.jsx", "start": s, "end": e}


def test_the_default_track_is_the_highest_free_graphics_track_with_nothing_drawn_over_the_span():
    low = {"id": "g-low", "items": [_ov("a", 0, 2)]}
    beat = {"id": "3d", "items": [_ov("specs", 8, 14, "engine:scene3d")]}
    high = {"id": "g-high", "items": [_ov("b", 20, 22)]}
    broll = {"id": "b", "items": [{"id": "br", "type": "video", "src": "/x/b.mp4", "start": 9, "end": 12}]}
    doc = _tracks_doc(low, beat, high, broll)
    assert place.choose_track(doc, 9, 12) == (3, None), "over the 3D beat, never under it; a video track draws under overlays"
    assert place.choose_track(doc, 30, 32) == (3, None), "the top graphics track, not the first one"
    assert place.choose_track(doc, 21, 23) == (None, None), "b draws over that span: a new track on top"
    doc = _tracks_doc(low, beat)
    assert place.choose_track(doc, 9, 12) == (None, None), "the beat draws over it: a new track, not g-low under it"
    assert place.choose_track(doc, 3, 5) == (1, None), "the beat draws nothing then: g-low"


# Round 9 (52's PL89h notes, section 05): with its own points (`at`), flow's line and travelling dot ran straight
# through its labels ("phone—computer—motors"). The line stays in the gaps between labels.
@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
@pytest.mark.parametrize("props", [
    {"points": "phone > computer > motors", "at": [[190, 1530], [500, 1530], [800, 1530]], "fontSize": 44, "accent": "#ff0000"},
    {"points": "phone > small computer > motors", "accent": "#ff0000"},
    {"points": "camera > phone > cloud", "at": [[540, 400], [540, 700], [540, 1000]], "accent": "#ff0000"},
])
def test_flows_line_and_dot_stay_out_of_its_labels(tmp_path, props):
    from PIL import Image
    src = Path(place.PRESETS_DIR) / "flow.jsx"
    for frame in (75, 108):   # the chain drawn, then the dot travelling it
        png = tmp_path / f"f{frame}.png"
        res = subprocess.run([sys.executable, str(REPO_ROOT / "steps" / "render" / "sample_overlay.py"), "--overlay", str(src),
                              "--frame", str(frame), "--duration", "120", "--fps", "30", "--props", json.dumps(props),
                              "--measure", "--out", str(png)], capture_output=True, text=True, timeout=180)
        assert res.returncode == 0, res.stderr[-400:]
        m = json.loads(res.stdout)["measurements"]
        img = Image.open(png).convert("RGBA")
        for t in m["texts"]:
            b = t.get("glyphs") or t["bbox"]
            x0, y0, x1, y1 = int(b["x"]) + 2, int(b["y"]) + 2, int(b["x"] + b["w"]) - 2, int(b["y"] + b["h"]) - 2
            red = sum(1 for x in range(max(0, x0), min(img.width, x1)) for y in range(max(0, y0), min(img.height, y1))
                      if (lambda p: p[3] > 128 and p[0] > 200 and p[1] < 80 and p[2] < 80)(img.getpixel((x, y))))
            assert red == 0, f"frame {frame}: {red} line pixels inside {t['text']!r}"


SAM_ITEMS_1_5_1 = [   # Sam's place call (2026-10-27) less its four scene_labels items, which need his project's scene marks
    {"at": 10.14, "for": 2.14, "props": {"color": "#292C33", "stats": [{"at": 0, "unit": "lb", "value": "4"}, {"at": 1.47, "sub": "robot hardware", "value": "$400"}], "accent": "#708C99", "fontFamily": "JetBrains Mono"}, "preset": "stat"},
    {"at": 25.32, "for": 1.06, "opaque": True, "overlay": "self-righting.jsx"},
    {"at": 27.77, "for": 4.03, "props": {"x": 540, "y": 930, "color": "#FFFFFF", "label": "Video call on legs", "accent": "#708C99", "fontFamily": "JetBrains Mono"}, "preset": "ring"},
    {"at": 34.1, "for": 1.54, "props": {"y": 960, "text": "Flat ground", "color": "#292C33", "width": 650, "accent": "#708C99", "fontFamily": "JetBrains Mono"}, "preset": "rule"},
]


def test_items_take_opaque_as_the_skills_say_sams_call_places_in_one_turn(tmp_path):
    """1.5.1 (Sam: no extra turns): the overlay and edit-session skills tell the AI to set "opaque": true on a
    full-frame overlay item, and place refused it ("no field opaque"). It is an item field now, written as given."""
    d = make_project(tmp_path)
    p = json.loads((d / "project.json").read_text())
    p["tracks"][0]["items"][0].update({"end": 60, "outPoint": 60, "sourceDuration": 60})
    (d / "project.json").write_text(json.dumps(p))
    (d / "self-righting.jsx").write_text("export default function R() { return <div style={{background: '#000'}}>up</div> }")
    out = place.run_many(str(d / "project.json"), json.dumps(SAM_ITEMS_1_5_1), measure_fn=fake_measure(),
                         transcribe=no_transcribe, sampler=fake_sheet())
    assert len(out["placed"]) == 4
    items = [it for t in tracks(d)[1:] for it in t["items"]]
    cover = [it for it in items if it.get("src") == "./self-righting.jsx"]
    assert len(cover) == 1 and cover[0]["opaque"] is True
    assert all("opaque" not in it for it in items if it is not cover[0]), "only the item that asked is opaque"


def test_opaque_is_true_or_false_and_false_clears_it(tmp_path, capsys):
    d = make_project(tmp_path)
    (d / "o.jsx").write_text("export default function O() { return <div>o</div> }")
    err = refused(capsys, place.run_many, str(d / "project.json"), json.dumps([{"overlay": "o.jsx", "at": 1, "opaque": "yes"}]),
                  measure_fn=fake_measure(), transcribe=no_transcribe, sampler=fake_sheet())
    assert err["error"] == "invalid_params" and err["message"].startswith("items[0]: ") and "opaque" in err["message"]
    place.run_many(str(d / "project.json"), json.dumps([{"overlay": "o.jsx", "at": 1, "for": 2, "id": "ov-o", "opaque": True}]),
                   measure_fn=fake_measure(), transcribe=no_transcribe, sampler=fake_sheet())
    find = lambda: next(it for t in tracks(d) for it in t["items"] if it["id"] == "ov-o")
    assert find()["opaque"] is True
    place.run_many(str(d / "project.json"), json.dumps([{"id": "ov-o", "opaque": False}]),
                   measure_fn=fake_measure(), transcribe=no_transcribe, sampler=fake_sheet())
    assert "opaque" not in find()
