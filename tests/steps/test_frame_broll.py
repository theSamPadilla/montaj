"""frame_broll (PL89): landscape b-roll in a vertical project, framed in one call.

A paid run's 9:16 centre crop of a landscape clip showed an empty wall while the robot walked out of frame (ucla
section 06). `track` follows the moving subject with a keyframed crop; `card` insets the whole frame as a card with
corner brackets and a "Footage: <source>" credit; `auto` tracks when it finds one clear subject, else makes the card.
The clips here are synthetic: a dark box crossing a light room (a subject), and the same room with nothing moving.
The still sheet's sampler is stubbed, so no renderer runs.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib import subject_track  # noqa: E402
from lib.common import ffmpeg_bin  # noqa: E402
import steps.edit.frame_broll as fb  # noqa: E402


def clip(path, moving=True, size="640x360", seconds=4, y=60):
    room = f"color=c=0xd8d2c4:s={size}:d={seconds}:r=30"
    box = "color=c=0x151515:s=50x90:d=%d:r=30" % seconds
    x = "40+130*t" if moving else "295"
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-f", "lavfi", "-i", room, "-f", "lavfi", "-i", box,
                    "-filter_complex", f"[0][1]overlay=x='{x}':y={y}", "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


def project(tmp_path, moving=True, size="640x360", y=60):
    d = tmp_path / "proj"
    d.mkdir()
    src = clip(d / "broll.mp4", moving, size, y=y)
    w, h = (int(v) for v in size.split("x"))
    proj = {"version": "0.2", "id": "fb-fixture", "name": "Frame", "status": "draft", "workflow": "overlays",
            "editingPrompt": "", "settings": {"fps": 30, "resolution": [1080, 1920]},
            "tracks": [{"id": "trk-0", "items": [{"id": "talk", "type": "video", "src": str(src), "start": 0, "end": 8,
                                                  "inPoint": 0, "outPoint": 4, "sourceDuration": 4}]},
                       {"id": "trk-1", "items": [{"id": "br-1", "type": "video", "src": str(src), "start": 2, "end": 6,
                                                  "inPoint": 0, "outPoint": 4, "sourceDuration": 4,
                                                  "sourceWidth": w, "sourceHeight": h, "muted": True}]}]}
    (d / "project.json").write_text(json.dumps(proj, indent=2))
    return d / "project.json"


def stub_sampler():
    calls = []

    def fn(project_path, times, out):
        calls.append(list(times))
        Path(out).write_bytes(b"png")
        return out
    fn.calls = calls
    return fn


def item_of(project_path, item_id):
    doc = json.loads(Path(project_path).read_text())
    return next(it for t in doc["tracks"] for it in t["items"] if it["id"] == item_id), doc


# --- the tracker (numpy only) -----------------------------------------------------------------------------------

def test_tracker_follows_a_moving_box_and_keeps_it_inside_the_crop():
    bg = np.full((54, 96), 210.0)
    frames = []
    for i in range(12):
        f = bg.copy()
        x = 5 + i * 6
        f[20:40, x:x + 8] = 20
        frames.append(f)
    path = subject_track.track(np.stack(frames), np.stack([bg] * 5), crop_w=0.3164)
    assert path["found"] >= 11
    for i, p in enumerate(path["points"]):
        cx = (5 + i * 6 + 4) / 96
        assert p["x"] <= cx <= p["x"] + 0.3164, (i, p, cx)
    assert path["points"][-1]["x"] > path["points"][0]["x"]


def test_tracker_finds_nothing_in_a_still_room():
    bg = np.full((54, 96), 210.0)
    path = subject_track.track(np.stack([bg] * 8), np.stack([bg] * 5), crop_w=0.3164)
    assert path["found"] == 0


# --- the step -----------------------------------------------------------------------------------------------------

def test_track_writes_a_keyframed_crop_that_follows_the_subject(tmp_path):
    p = project(tmp_path)
    s = stub_sampler()
    out = fb.run(str(p), "br-1", mode="track", sampler=s)
    assert out["mode"] == "track"
    item, _ = item_of(p, "br-1")
    w = item["sourceCrop"]["w"]
    assert abs(w - (360 * 9 / 16) / 640) < 0.01 and item["sourceCrop"]["h"] == 1
    xs = next(t for t in item["keyframes"] if t["prop"] == "cropX")["points"]
    assert xs[0]["t"] == 0 and xs[-1]["t"] <= 4
    assert xs[-1]["value"] > xs[0]["value"] + 0.3, "the box crosses the room left to right"
    # each keyframe holds the box: x of its centre at that time is 40 + 130 t + 25 (source px)
    for k in xs:
        cx = (40 + 130 * k["t"] + 25) / 640
        assert k["value"] - 0.02 <= cx <= k["value"] + w + 0.02, k
    assert out["sheet"] and s.calls and len(s.calls[0]) >= 3
    assert all(2 <= t <= 6 for t in s.calls[0]), "the sheet samples the item's own range on the timeline"


def test_card_insets_the_whole_frame_with_a_credit_overlay(tmp_path):
    p = project(tmp_path)
    out = fb.run(str(p), "br-1", mode="card", source="PhoneBot project video", sampler=stub_sampler())
    assert out["mode"] == "card"
    item, doc = item_of(p, "br-1")
    assert "sourceCrop" not in item and not any(t["prop"].startswith("crop") for t in item.get("keyframes", []))
    assert 0.8 <= item["scale"] <= 0.95 and item["offsetY"] < 0, "an inset above the captions"
    card = next(it for t in doc["tracks"] for it in t["items"] if it.get("type") == "overlay")
    assert (card["start"], card["end"]) == (2, 6)
    assert card["src"].startswith("./overlays/footage-card")
    props = card["props"]
    assert props["credit"] == "Footage: PhoneBot project video"
    x, y, w, h = (float(v) for v in props["box"].split(","))   # "x,y,w,h", shares of the frame
    assert abs(w - item["scale"]) < 1e-6 and y + h < 0.56, "the footage sits above the captions"
    assert props["subject"], "the moving box was tracked for the brackets"
    assert (Path(p).parent / card["src"][2:]).is_file()
    assert out["id"] == "br-1" and out["card"] == card["id"]


def test_auto_tracks_a_moving_subject_and_cards_a_still_one(tmp_path):
    a = tmp_path / "a"
    a.mkdir()
    assert fb.run(str(project(a)), "br-1", sampler=stub_sampler())["mode"] == "track"
    b = tmp_path / "b"
    b.mkdir()
    out = fb.run(str(project(b, moving=False)), "br-1", sampler=stub_sampler())
    assert out["mode"] == "card"
    assert "no moving subject" in out["why"]


def test_a_vertical_clip_needs_nothing(tmp_path):
    p = project(tmp_path, size="360x640")
    before = Path(p).read_text()
    out = fb.run(str(p), "br-1", sampler=stub_sampler())
    assert out["mode"] == "none"
    assert Path(p).read_text() == before


def test_a_human_edit_since_the_read_is_refused_and_nothing_is_written(tmp_path, monkeypatch, capsys):
    p = project(tmp_path)
    real = fb.read_tracks

    def read_then_edit(path):
        got = real(path)
        doc = json.loads(Path(path).read_text())
        doc["tracks"][0]["items"][0]["end"] = 7.5   # the person trims the talking head meanwhile
        Path(path).write_text(json.dumps(doc, indent=2))
        return got
    monkeypatch.setattr(fb, "read_tracks", read_then_edit)
    with pytest.raises(SystemExit):
        fb.run(str(p), "br-1", mode="track", sampler=stub_sampler())
    assert "project_changed" in capsys.readouterr().err
    item, doc = item_of(p, "br-1")
    assert "keyframes" not in item and doc["tracks"][0]["items"][0]["end"] == 7.5


def test_a_missing_or_wrong_item_is_refused(tmp_path, capsys):
    p = project(tmp_path)
    for item_id, code in (("nope", "item_not_found"), ("talk", "not_broll")):
        with pytest.raises(SystemExit):
            fb.run(str(p), item_id, mode="track", sampler=stub_sampler())
        assert code in capsys.readouterr().err


def test_what_it_writes_passes_the_engine_validator_and_a_clip_without_its_size_gets_it(tmp_path):
    sys.path.insert(0, str(REPO_ROOT / "engine"))
    from validate import validate_project
    for mode in ("track", "card"):
        d = tmp_path / mode
        d.mkdir()
        p = project(d)
        doc = json.loads(Path(p).read_text())
        for k in ("sourceWidth", "sourceHeight"):
            del doc["tracks"][1]["items"][0][k]
        Path(p).write_text(json.dumps(doc))
        fb.run(str(p), "br-1", mode=mode, source="the lab", sampler=stub_sampler())
        item, _ = item_of(p, "br-1")
        assert (item["sourceWidth"], item["sourceHeight"]) == (640, 360)
        validate_project(str(p))


def test_a_sheet_that_cannot_be_made_never_fails_the_written_step(tmp_path, capsys):
    p = project(tmp_path)

    def broken(project_path, times, out):
        print('{"error": "sample_failed", "message": "no 3D stage"}', file=sys.stderr)
        raise SystemExit(1)
    out = fb.run(str(p), "br-1", mode="track", sampler=broken)
    assert out["mode"] == "track" and out["keys"] >= 2
    assert "path" not in out and "no 3D stage" in out["sheet_error"]
    item, _ = item_of(p, "br-1")
    assert any(k["prop"] == "cropX" for k in item["keyframes"])


def test_a_subject_under_the_captions_is_carded_by_auto_and_said_by_track(tmp_path):
    # the box low in the frame (y 220-310 of 360): a full-height crop puts it in the caption band (56-76% of the height)
    a = tmp_path / "a"
    a.mkdir()
    out = fb.run(str(project(a, y=220)), "br-1", sampler=stub_sampler())
    assert out["mode"] == "card" and "captions" in out["why"]
    b = tmp_path / "b"
    b.mkdir()
    out = fb.run(str(project(b, y=220)), "br-1", mode="track", sampler=stub_sampler())
    assert out["mode"] == "track" and any("captions" in i for i in out["issues"])


def test_auto_cards_a_subject_the_captions_only_cross(tmp_path):
    # the box at y 120-210 of 360 (33-58%): a full-height crop has the caption band (56-76%) crossing its foot
    out = fb.run(str(project(tmp_path, y=120)), "br-1", sampler=stub_sampler())
    assert out["mode"] == "card" and "captions" in out["why"]


# PL89b: the agent sent five frame_broll calls in one turn; Claude Code runs a writing tool one call after another, so
# they took 31-42 s each, in a row. One call frames a list of items: the clips are read in parallel (at most
# MAX_PARALLEL at once), the project is written once, and one sheet shows them all.
def two_brolls(tmp_path):
    p = project(tmp_path)
    doc = json.loads(Path(p).read_text())
    second = dict(doc["tracks"][1]["items"][0], id="br-2", start=6, end=8, inPoint=0, outPoint=2)
    doc["tracks"][1]["items"].append(second)
    Path(p).write_text(json.dumps(doc, indent=2))
    return p


def test_a_list_of_items_is_framed_in_one_call_one_write_and_one_sheet(tmp_path, monkeypatch):
    p = two_brolls(tmp_path)
    versions = []
    real = fb.commit_version
    monkeypatch.setattr(fb, "commit_version", lambda d, m: versions.append(m) or real(d, m))
    s = stub_sampler()
    out = fb.run(str(p), ["br-1", "br-2", "br-1"], mode="track", sampler=s)
    assert [x["id"] for x in out["items"]] == ["br-1", "br-2"], "each item once, in the order given"
    assert all(x["mode"] == "track" and x["keys"] >= 2 for x in out["items"])
    assert len(versions) == 1, "one write"
    assert len(s.calls) == 1 and out["path"] == out["sheet"]
    times = s.calls[0]
    assert any(2 <= t < 6 for t in times) and any(6 <= t < 8 for t in times) and len(times) <= 12
    for item_id in ("br-1", "br-2"):
        item, _ = item_of(p, item_id)
        assert any(k["prop"] == "cropX" for k in item["keyframes"]), item_id


def test_the_clips_of_a_list_are_read_in_parallel_at_most_max_parallel_at_once(tmp_path, monkeypatch):
    import threading
    import time
    p = project(tmp_path)
    doc = json.loads(Path(p).read_text())
    for k in range(2, 7):
        doc["tracks"][1]["items"].append(dict(doc["tracks"][1]["items"][0], id=f"br-{k}", start=6 + k, end=7 + k, inPoint=0, outPoint=1))
    Path(p).write_text(json.dumps(doc, indent=2))
    busy, peak, lock = [0], [0], threading.Lock()
    real = fb.gray_frames

    def slow(*a, **k):
        with lock:
            busy[0] += 1
            peak[0] = max(peak[0], busy[0])
        time.sleep(0.2)
        try:
            return real(*a, **k)
        finally:
            with lock:
                busy[0] -= 1
    monkeypatch.setattr(fb, "gray_frames", slow)
    out = fb.run(str(p), [f"br-{k}" for k in range(1, 7)], mode="track", sampler=stub_sampler())
    assert len(out["items"]) == 6
    assert 2 <= peak[0] <= fb.MAX_PARALLEL == 4


def test_a_bad_item_in_a_list_is_said_for_that_item_and_the_others_are_framed(tmp_path):
    p = two_brolls(tmp_path)
    out = fb.run(str(p), ["br-1", "nope", "talk"], mode="track", sampler=stub_sampler())
    by = {x["id"]: x for x in out["items"]}
    assert by["br-1"]["mode"] == "track"
    assert by["nope"]["error"] == "item_not_found" and by["talk"]["error"] == "not_broll"
    item, _ = item_of(p, "br-1")
    assert any(k["prop"] == "cropX" for k in item["keyframes"])


def test_every_answer_says_why_it_chose_and_that_the_clip_is_done(tmp_path):
    # auto's choice holds: PL89b redid four auto cards by hand (about 8 calls) because the answer did not say plainly
    a = tmp_path / "a"
    a.mkdir()
    out = fb.run(str(project(a)), "br-1", sampler=stub_sampler())
    assert out["mode"] == "track" and "frames" in out["why"] and out["why"].endswith(fb.DONE)
    b = tmp_path / "b"
    b.mkdir()
    out = fb.run(str(project(b, moving=False)), "br-1", sampler=stub_sampler())
    assert out["mode"] == "card" and out["why"].endswith(fb.DONE)


def test_a_card_made_for_captions_still_to_come_says_so_and_does_not_invite_a_track(tmp_path):
    # captions are a default step of every edit workflow (2b, 10-25): they are always coming, so the card holds
    out = fb.run(str(project(tmp_path, y=220)), "br-1", sampler=stub_sampler())
    assert out["mode"] == "card"
    assert "captions still to come" in out["why"] and "mode track" not in out["why"]


def test_the_cli_takes_item_more_than_once(tmp_path):
    p = two_brolls(tmp_path)
    schema = json.loads((REPO_ROOT / "steps" / "edit" / "frame_broll.json").read_text())
    item = next(x for x in schema["params"] if x["name"] == "item")
    assert item.get("repeatable") is True
    parser = fb.build_parser()
    assert parser.parse_args(["--project", str(p), "--item", "br-1", "--item", "br-2"]).item == ["br-1", "br-2"]


# PL89c: the person's profile asked for wide footage in a cream matte with a small centred credit, and the run put all
# b-roll full-frame. frame_broll reads the profile's "Titles & overlays" notes (profileSnapshot.styleProfilePath): a
# line about mattes makes auto card wide footage on that matte, with its colour; track only when asked.
STYLE = """# Style

## Titles & overlays
- Keep source credits small and centered.
- Use functional mattes only where needed to frame wide evidence footage. Fill empty space with warm cream (for example #F5F3EB), with no decorative borders or sidebars.

## Format
- 9:16.
"""


def with_profile(p, text=STYLE):
    doc = json.loads(Path(p).read_text())
    style = Path(p).parent / "style_profile.md"
    style.write_text(text)
    doc["profileSnapshot"] = {"name": "fixture", "styleProfilePath": str(style)}
    Path(p).write_text(json.dumps(doc, indent=2))
    return p


def test_profile_matte_is_read_from_the_titles_and_overlays_notes(tmp_path):
    style = tmp_path / "s.md"
    style.write_text(STYLE)
    assert fb.profile_matte({"profileSnapshot": {"styleProfilePath": str(style)}}) == {"paper": "#F5F3EB", "brackets": False}
    style.write_text("## Titles & overlays\n- Mattes for wide footage, in #ffffff with corner marks.\n")
    assert fb.profile_matte({"profileSnapshot": {"styleProfilePath": str(style)}}) == {"paper": "#ffffff", "brackets": True}
    style.write_text("## Titles & overlays\n- Centred text.\n## Format\n- Use mattes in #000000.\n")
    assert fb.profile_matte({"profileSnapshot": {"styleProfilePath": str(style)}}) is None, "only the Titles & overlays notes"
    assert fb.profile_matte({}) is None and fb.profile_matte({"profileSnapshot": {"styleProfilePath": "/nope.md"}}) is None


def test_a_profile_that_asks_for_mattes_makes_auto_card_a_trackable_clip_on_its_matte(tmp_path):
    p = with_profile(project(tmp_path))   # a moving subject auto would otherwise track
    out = fb.run(str(p), "br-1", source="the lab", sampler=stub_sampler())
    assert out["mode"] == "card" and "profile" in out["why"] and "#F5F3EB" in out["why"]
    doc = json.loads(Path(p).read_text())
    card = next(it for t in doc["tracks"] for it in t["items"] if it.get("id") == out["card"])
    assert card["props"]["paper"] == "#F5F3EB" and card["props"]["brackets"] == "off"


def test_track_still_tracks_when_asked_with_a_matte_profile(tmp_path):
    p = with_profile(project(tmp_path))
    assert fb.run(str(p), "br-1", mode="track", sampler=stub_sampler())["mode"] == "track"


def test_the_card_credit_is_centred_and_brackets_can_be_turned_off():
    code = (REPO_ROOT / "montaj_assets" / "render" / "templates" / "presets" / "footage-card.jsx").read_text()
    credit = code[code.index("p.credit ?"):]
    assert "textAlign: 'center'" in credit[:600]
    assert "p.brackets !== 'off'" in code


# PL89d: the agent ran frame_broll card, then track, then card again on the same four clips, and the first cards stayed
# on the timeline: it removed them by hand (an edit_timeline). The answer says to change a clip with another mode, so a
# run replaces the card it made before for that item, and track removes it.
def cards_for(p):
    doc = json.loads(Path(p).read_text())
    return [it for t in doc["tracks"] for it in t["items"] if "footage" in str(it.get("src", ""))]


def test_running_again_replaces_the_items_own_card_and_track_removes_it(tmp_path):
    p = project(tmp_path)
    first = fb.run(str(p), "br-1", mode="card", source="the lab", sampler=stub_sampler())
    assert [c["id"] for c in cards_for(p)] == [first["card"]]
    assert cards_for(p)[0]["props"]["for"] == "br-1"
    second = fb.run(str(p), "br-1", mode="card", source="the lab", sampler=stub_sampler())
    assert [c["id"] for c in cards_for(p)] == [second["card"]], "the first card is replaced, not kept"
    fb.run(str(p), "br-1", mode="track", sampler=stub_sampler())
    assert cards_for(p) == [], "track removes the item's card"


def test_a_card_made_before_props_for_is_matched_by_its_clips_range(tmp_path):
    p = project(tmp_path)
    fb.run(str(p), "br-1", mode="card", sampler=stub_sampler())
    doc = json.loads(Path(p).read_text())
    for t in doc["tracks"]:
        for it in t["items"]:
            if "footage" in str(it.get("src", "")):
                it["props"].pop("for", None)   # a card from an earlier engine
    Path(p).write_text(json.dumps(doc, indent=2))
    fb.run(str(p), "br-1", mode="track", sampler=stub_sampler())
    assert cards_for(p) == []


# PL89d: on the card the robot was tiny inside the wide frame, and the agent tried crop, track and card again. The card
# now zooms toward the tracked subject: a still crop of the source, the same shape (so the card's box on screen is the
# same), around everywhere the subject goes, at least CARD_ZOOM_MIN of the frame; no zoom when it roams the frame.
def small_subject_project(tmp_path):
    d = tmp_path / "proj"
    d.mkdir()
    src = d / "broll.mp4"
    room = "color=c=0xd8d2c4:s=640x360:d=4:r=30"
    box = "color=c=0x151515:s=40x70:d=4:r=30"
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-f", "lavfi", "-i", room, "-f", "lavfi", "-i", box,
                    "-filter_complex", "[0][1]overlay=x='400+12*t':y=200", "-pix_fmt", "yuv420p", str(src)], check=True)
    proj = {"version": "0.2", "id": "fb-small", "name": "Small", "status": "draft", "workflow": "overlays",
            "editingPrompt": "", "settings": {"fps": 30, "resolution": [1080, 1920]},
            "tracks": [{"id": "trk-0", "items": [{"id": "talk", "type": "video", "src": str(src), "start": 0, "end": 8,
                                                  "inPoint": 0, "outPoint": 4, "sourceDuration": 4}]},
                       {"id": "trk-1", "items": [{"id": "br-1", "type": "video", "src": str(src), "start": 2, "end": 6,
                                                  "inPoint": 0, "outPoint": 4, "sourceDuration": 4,
                                                  "sourceWidth": 640, "sourceHeight": 360, "muted": True}]}]}
    (d / "project.json").write_text(json.dumps(proj, indent=2))
    return d / "project.json"


def test_the_card_zooms_toward_a_small_subject_and_keeps_the_card_box(tmp_path):
    p = small_subject_project(tmp_path)
    out = fb.run(str(p), "br-1", mode="card", sampler=stub_sampler())
    item, doc = item_of(p, "br-1")
    crop = item["sourceCrop"]
    assert abs(crop["w"] - crop["h"]) < 1e-6, "the same shape as the source, so the card's box is unchanged"
    assert fb.CARD_ZOOM_MIN <= crop["w"] < 0.85
    # the subject (x 400-460 of 640, y 200-270 of 360) is inside the crop
    assert crop["x"] <= 400 / 640 and crop["x"] + crop["w"] >= 460 / 640
    assert crop["y"] <= 200 / 360 and crop["y"] + crop["h"] >= 270 / 360
    assert item["scale"] == fb.CARD_SCALE
    assert "zoom" in out and "subject" in out["why"]
    card = next(it for t in doc["tracks"] for it in t["items"] if it.get("id") == out["card"])
    boxes = json.loads(card["props"]["subject"])
    assert all(0 <= v <= 1 for b in boxes for v in b[1:]), "the brackets' boxes are in the zoomed frame"


def test_no_zoom_when_the_subject_crosses_the_frame(tmp_path):
    p = project(tmp_path)   # a box crossing the room left to right
    out = fb.run(str(p), "br-1", mode="card", sampler=stub_sampler())
    item, _ = item_of(p, "br-1")
    assert "sourceCrop" not in item and "zoom" not in out


# PL89e: the agent called frame_broll with no item, then with a source id, before the clips were on the timeline; and
# passed no source, so the cards had no credit.
def with_sources(p, src_name=None):
    doc = json.loads(Path(p).read_text())
    item = doc["tracks"][1]["items"][0]
    doc["sources"] = [{"id": "clip-5-834c4a", "type": "video", "src": item["src"]}]
    Path(p).write_text(json.dumps(doc, indent=2))
    return p


def test_no_item_answers_what_to_pass_and_the_broll_on_the_timeline(tmp_path, capsys):
    p = project(tmp_path)
    with pytest.raises(SystemExit):
        fb.run(str(p), None, mode="card", sampler=stub_sampler())
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "missing_item"
    assert "add the clip to an upper track first, then pass its item id" in err["message"] and "br-1" in err["message"]


def test_a_source_id_says_it_is_a_source_and_to_add_the_clip_first(tmp_path, capsys):
    p = with_sources(project(tmp_path))
    with pytest.raises(SystemExit):
        fb.run(str(p), "clip-5-834c4a", mode="card", sampler=stub_sampler())
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "item_not_found"
    assert "clip-5-834c4a is a source id" in err["message"]
    assert "add the clip to an upper track first, then pass its item id" in err["message"]
    out = fb.run(str(p), ["clip-5-834c4a", "br-1"], mode="card", sampler=stub_sampler())
    assert "add the clip to an upper track first" in out["items"][0]["message"] and out["items"][1]["mode"] == "card"


@pytest.mark.parametrize("name, credit", [
    ("youtube-phonebot-o_Q4rFSNZuE.mp4", "Footage: Phonebot · YouTube"),
    ("youtube-o_Q4rFSNZuE.mp4", "Footage: YouTube"),
    ("IMG_1167.MOV", ""),
])
def test_the_credit_defaults_from_the_downloaded_source_name(name, credit):
    assert fb.default_credit({"src": f"/w/{name}"}) == credit


def test_a_source_title_or_url_wins_over_the_file_name():
    assert fb.default_credit({"src": "/w/youtube-x-o_Q4rFSNZuE.mp4", "title": "PhoneBot: a phone walks"}) == "Footage: PhoneBot: a phone walks"
    assert fb.default_credit({"src": "/w/a.mp4", "url": "https://www.example.org/watch?v=1"}) == "Footage: example.org"


def test_a_card_with_no_source_passed_gets_the_default_credit(tmp_path):
    p = project(tmp_path)
    doc = json.loads(Path(p).read_text())
    src = Path(doc["tracks"][1]["items"][0]["src"])
    renamed = src.with_name("youtube-phonebot-o_Q4rFSNZuE.mp4")
    src.rename(renamed)
    for t in doc["tracks"]:
        for it in t["items"]:
            it["src"] = str(renamed)
    Path(p).write_text(json.dumps(doc, indent=2))
    out = fb.run(str(p), "br-1", mode="card", sampler=stub_sampler())
    card = next(it for t in json.loads(Path(p).read_text())["tracks"] for it in t["items"] if it.get("id") == out["card"])
    assert card["props"]["credit"] == "Footage: Phonebot · YouTube" and "note" not in out


def test_the_credit_reads_the_title_from_the_files_provenance(tmp_path):
    d = tmp_path / "proj"
    (d / "assets").mkdir(parents=True)
    video = d / "youtube-phonebot-o_Q4rFSNZuE.mp4"
    video.write_bytes(b"x")
    (d / "assets" / ".provenance.json").write_text(json.dumps({video.name: {
        "kind": "web", "via": "fetch", "sourceUrl": "https://www.youtube.com/watch?v=o_Q4rFSNZuE", "title": "PhoneBot: a phone that walks"}}))
    assert fb.default_credit({"src": str(video)}, str(d)) == "Footage: PhoneBot: a phone that walks"
    (d / "assets" / ".provenance.json").write_text(json.dumps({video.name: {"kind": "web", "via": "url", "sourceUrl": "https://www.example.org/v.mp4"}}))
    assert fb.default_credit({"src": str(video)}, str(d)) == "Footage: example.org"


# PL89e: third-party footage keeps its credit even when the agent passes source "", unless the profile says no credits.
def youtube_project(tmp_path):
    p = project(tmp_path)
    doc = json.loads(Path(p).read_text())
    src = Path(doc["tracks"][1]["items"][0]["src"])
    renamed = src.with_name("youtube-phonebot-o_Q4rFSNZuE.mp4")
    src.rename(renamed)
    for t in doc["tracks"]:
        for it in t["items"]:
            it["src"] = str(renamed)
    Path(p).write_text(json.dumps(doc, indent=2))
    return p


def card_credit(p, card_id):
    return next(it for t in json.loads(Path(p).read_text())["tracks"] for it in t["items"] if it.get("id") == card_id)["props"]["credit"]


def test_an_empty_source_keeps_a_third_party_credit_and_says_so(tmp_path):
    p = youtube_project(tmp_path)
    out = fb.run(str(p), "br-1", mode="card", source="", sampler=stub_sampler())
    assert card_credit(p, out["card"]) == "Footage: Phonebot · YouTube"
    assert "kept" in out["credit"] and "Footage: Phonebot · YouTube" in out["credit"]


def test_a_profile_that_wants_no_credits_lets_an_empty_source_drop_it(tmp_path):
    p = with_profile(youtube_project(tmp_path), "## Titles & overlays\n- No source credits on screen.\n")
    out = fb.run(str(p), "br-1", mode="card", source="", sampler=stub_sampler())
    assert card_credit(p, out["card"]) == ""


# PL89i (kung fu run 2): b-roll added with a RELATIVE src, typed with a plain space for a screen recording's U+202F.
# frame_broll checked the src against its own working folder, so every item was "The clip's file is missing" until
# the agent rewrote each src as the absolute U+202F path. A relative src is the project folder's, then its twin.
def test_a_relative_src_with_a_typed_space_is_read_from_the_project_folder(tmp_path):
    p = project(tmp_path)
    d = Path(p).parent
    real = d / "Screen Recording 2026-10-21 at 11.59.52 AM.mp4"
    (d / "broll.mp4").rename(real)
    doc = json.loads(Path(p).read_text())
    doc["tracks"][0]["items"][0]["src"] = str(real)
    doc["tracks"][1]["items"][0]["src"] = "Screen Recording 2026-10-21 at 11.59.52 AM.mp4"
    Path(p).write_text(json.dumps(doc))
    out = fb.run(str(p), "br-1", mode="card", source="Unitree", sampler=stub_sampler())
    assert out["mode"] == "card", out
    item, _ = item_of(p, "br-1")
    assert item.get("scale"), "the card was framed"


def test_seventeen_items_are_framed_in_one_call_and_the_sheet_spans_them_all(tmp_path, monkeypatch):
    # kung fu pl89j: 17 cutaways were refused ("At most 12 items in one call") and the agent split them by hand
    p = project(tmp_path)
    doc = json.loads(Path(p).read_text())
    base = doc["tracks"][1]["items"][0]
    doc["tracks"][1]["items"] = [dict(base, id=f"br-{k}", start=2 * k, end=2 * k + 1.5, inPoint=0, outPoint=1.5)
                                 for k in range(17)]
    doc["tracks"][0]["items"][0].update(end=40, outPoint=4)
    Path(p).write_text(json.dumps(doc, indent=2))
    versions = []
    real = fb.commit_version
    monkeypatch.setattr(fb, "commit_version", lambda d, m: versions.append(m) or real(d, m))
    s = stub_sampler()
    out = fb.run(str(p), [f"br-{k}" for k in range(17)], mode="track", sampler=s)
    assert [x["id"] for x in out["items"]] == [f"br-{k}" for k in range(17)]
    assert all(x.get("mode") == "track" for x in out["items"]), out["items"]
    assert len(versions) == 1 and len(s.calls) == 1
    times = s.calls[0]
    assert len(times) <= fb.MAX_SHEET_TIMES and min(times) < 2 and max(times) > 30, times
