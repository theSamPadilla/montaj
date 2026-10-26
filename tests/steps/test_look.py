"""look (§558): one read-only check of a project instead of a sample_frame / sample_overlay loop.

The rules (lib/look_check.py) on hand-made projects and measurements; the step with a fake measurer (what it
measures, the cap, the answer, that it writes nothing); and one real run through sample_overlay --measure (needs
node and the render bundle's puppeteer) on an overlay whose text runs off the frame and one that fits.
"""
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

MONTAJ_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(MONTAJ_ROOT))

from lib import look_check as lc  # noqa: E402
import steps.render.look as look  # noqa: E402


def _project(tmp_path, overlays=(), base=((0, 5), (5, 10)), captions=(), extra_tracks=(), resolution=(1080, 1920)):
    d = tmp_path / "proj"
    (d / "overlays").mkdir(parents=True, exist_ok=True)
    tracks = [{"id": "main", "items": [{"id": f"v{i}", "type": "video", "src": "/x/clip.mp4", "start": s, "end": e,
                                        "inPoint": 0, "outPoint": e - s} for i, (s, e) in enumerate(base)]}]
    items = []
    for ov in overlays:
        ov = dict(ov)
        # moving by default (PL89b: look says when an overlay has no motion); the motion tests pass their own
        jsx = ov.pop("jsx", "export default function O() { const m = Motion.motion(frame, fps, duration); return <div style={m.style}>hi</div> }")
        if jsx is not None:
            (d / "overlays" / f"{ov['id']}.jsx").write_text(jsx)
        items.append({"type": "overlay", "src": f"./overlays/{ov['id']}.jsx", **ov})
    tracks.append({"id": "ovl", "items": items})
    tracks += list(extra_tracks)
    p = {"id": "p1", "name": "Look", "settings": {"resolution": list(resolution), "fps": 30}, "tracks": tracks}
    if captions:
        p["captions"] = {"style": "pop", "segments": [{"id": f"cap-{i}", "text": "x", "start": s, "end": e, "words": []}
                                                      for i, (s, e) in enumerate(captions)]}
    (d / "project.json").write_text(json.dumps(p))
    return d / "project.json", p


def _texts(*boxes):
    return {"texts": [{"text": t, "bbox": {"x": x, "y": y, "w": w, "h": h}, "overflow": {}, "clippingAncestor": c}
                      for t, x, y, w, h, *rest in boxes for c in [rest[0] if rest else None]], "anyOverflow": False}


# ── the times ─────────────────────────────────────────────────────────────────────────────────────────────────────

def test_auto_times_take_seams_overlay_edges_and_caption_changes_first(tmp_path):
    _, p = _project(tmp_path, overlays=[{"id": "ov-a", "start": 2, "end": 4}], captions=[(1, 2), (2, 3), (6, 7)])
    times = lc.pick_times(p)
    assert 5.5 in times, "the cut seam, past its fade (min(0.5 s, a quarter))"
    assert 2.5 in times and 3.5 in times, "the overlay's in and out, past their fades"
    assert 6.25 in times, "a caption change after a gap"
    assert times == sorted(times) and len(times) <= lc.MAX_TIMES
    assert all(b - a > lc.MERGE_S for a, b in zip(times, times[1:])), "merged"


def test_auto_times_are_capped_and_given_times_are_clipped_and_merged(tmp_path):
    many = [{"id": f"ov-{k}", "start": k * 0.6, "end": k * 0.6 + 0.5} for k in range(16)]
    _, p = _project(tmp_path, overlays=many)
    assert len(lc.pick_times(p)) == lc.MAX_TIMES
    assert lc.pick_times(p, at=[-1, 3, 3.1, 99]) == [0.0, 3.0, 10.0]


def test_an_empty_project_has_no_times(tmp_path):
    _, p = _project(tmp_path, base=())
    assert lc.pick_times(p) == []


# ── what the data says ────────────────────────────────────────────────────────────────────────────────────────────

def test_data_issues_past_the_footage_missing_file_black_and_hidden(tmp_path):
    full = {"id": "img-full", "type": "image", "src": "/x/full.png", "start": 1, "end": 3}
    path, p = _project(tmp_path, base=((0, 5), (6, 10)),
                       overlays=[{"id": "ov-late", "start": 9, "end": 12}, {"id": "ov-gone", "start": 1, "end": 2, "jsx": None}],
                       extra_tracks=[{"id": "top", "items": [full]}])
    found = {(i["id"], i["text"]) for i in lc.data_issues(p, str(path.parent))}
    assert ("ov-late", "runs past the footage (10.0s)") in found
    assert ("ov-gone", "overlay file missing") in found
    assert ("frame", "black 5.0-6.0s") in found
    assert ("ov-gone", "hidden by img-full 1.0-2.0s") in found


def test_a_3d_scene_item_is_drawn_by_the_engine_and_has_no_overlay_file(tmp_path):
    # PL89 round 1: look answered "overlay file missing" for each 3D scene item (src engine:scene3d).
    scene = {"id": "sc-walk", "type": "overlay", "src": "engine:scene3d", "start": 1, "end": 3, "props": {"scene": "walk"}}
    path, p = _project(tmp_path, overlays=[{"id": "ov-a", "start": 2, "end": 4}], extra_tracks=[{"id": "t3d", "items": [scene]}])
    assert [i for i in lc.data_issues(p, str(path.parent)) if i["id"] == "sc-walk"] == []


def test_a_clean_project_has_no_data_issues(tmp_path):
    path, p = _project(tmp_path, overlays=[{"id": "ov-a", "start": 2, "end": 4}], captions=[(0, 2)])
    assert lc.data_issues(p, str(path.parent)) == []


def test_an_animation_only_project_is_never_black(tmp_path):
    path, p = _project(tmp_path, base=(), overlays=[{"id": "ov-a", "start": 0, "end": 4}])
    assert lc.data_issues(p, str(path.parent)) == []


# ── what the measurements say ─────────────────────────────────────────────────────────────────────────────────────

def test_a_box_is_placed_on_the_frame_by_the_items_scale_and_offset():
    b = lc.placed_box({"x": 100, "y": 200, "w": 300, "h": 50}, {"scale": 0.5, "offsetX": 10, "offsetY": -5}, 1080, 1920)
    assert b == {"x": 270 + 108 + 50, "y": 480 - 96 + 100, "w": 150, "h": 25}


@pytest.mark.parametrize("box,want", [
    (("Title", 900, 100, 400, 80), "runs off the frame"),
    (("Name", 100, 1700, 400, 80), "over the apps' bottom controls"),
    (("Tag", 800, 1000, 200, 80), "under the apps' right-side buttons"),
    (("Cut", 100, 600, 400, 80, {"tag": "DIV", "bbox": {"x": 100, "y": 600, "w": 200, "h": 80}}), "cut off by its box"),
])
def test_measured_issues_name_the_problem(box, want):
    issues = lc.measured_issues({}, _texts(box), 1080, 1920, 2.0, "ov-x")
    assert any(want in i["text"] for i in issues), issues
    assert all(i["id"] == "ov-x" and i["t"] == 2.0 for i in issues)


def test_text_that_fits_has_no_measured_issue_and_landscape_has_no_app_zones():
    assert lc.measured_issues({}, _texts(("Fits", 200, 600, 500, 90)), 1080, 1920, 1, "ov") == []
    assert lc.measured_issues({}, _texts(("Low", 200, 900, 500, 90)), 1920, 1080, 1, "ov") == []


def test_two_overlays_on_screen_at_once_whose_text_crosses_are_reported():
    a = ("ov-a", 0, 4, [{"x": 100, "y": 100, "w": 300, "h": 80}])
    b = ("ov-b", 3, 6, [{"x": 300, "y": 150, "w": 300, "h": 80}])
    c = ("ov-c", 5, 8, [{"x": 100, "y": 100, "w": 300, "h": 80}])
    assert [i["text"] for i in lc.text_overlaps([a, b, c])] == ["text overlaps ov-b", "text overlaps ov-c"]


def test_the_answer_lists_every_issue_once_grouping_the_same_one_across_items():
    # PL89g: a 300-character answer showed one issue and "more": 3, so the agent ran look again with detail to read the
    # rest (two of its five passes). Every issue comes back; the same issue on several items is one line.
    same = 'text "Footage: Phonebot" under the apps\' right-side buttons: move it up 162 px'
    issues = [{"t": t, "id": i, "text": same} for t, i in ((26.04, "ov-b"), (4.92, "ov-a"), (29.44, "ov-c"))]
    issues += [{"t": k, "id": f"ov-{k}", "text": f'text "Headline {k}" runs off the frame: move it left {k} px'} for k in range(1, 9)]
    out = lc.answer(issues, extra={"overlays": 12})
    assert "more" not in out and len(out["issues"]) == 9, out
    assert out["issues"][0] == "1s ov-1: " + 'text "Headline 1" runs off the frame: move it left 1 px'
    assert "4.92s ov-a, 26.04s ov-b, 29.44s ov-c: " + same in out["issues"]
    assert lc.answer([], extra={"overlays": 2}) == {"ok": True, "overlays": 2}


def test_a_very_long_answer_still_stops_and_counts_the_rest():
    issues = [{"t": k, "id": f"ov-{k}", "text": f'text "A long headline number {k}" runs off the frame'} for k in range(200)]
    out = lc.answer(issues)
    assert out["more"] == 200 - len(out["issues"]) and len(json.dumps(out)) <= lc.ANSWER_CAP


@pytest.mark.parametrize("box,want", [
    # PL89g: "move it right 4 px", then "up 1 px": nudges under ZONE_SLACK_PX (rounding, glyph slack) are not issues
    (("Edge", 49, 600, 400, 80), []),
    (("Edge", 45, 600, 400, 80), ['text "Edge" inside the 5% title-safe margin: move it right 9 px']),
    (("Low", 100, 1495, 400, 80), []),                                   # 5 px over the controls' 1570
    (("Tag", 795, 1000, 90, 80), []),                                    # 5 px under the buttons' 880
])
def test_a_safe_area_nudge_under_the_slack_is_not_an_issue(box, want):
    assert [i["text"] for i in lc.measured_issues({}, _texts(box), 1080, 1920, 1, "ov")] == want


# ── the step ──────────────────────────────────────────────────────────────────────────────────────────────────────

def _fake_measure(boxes_by_id):
    calls = []

    def fn(item, path, frame, duration, fps, width, height, out):
        calls.append((item["id"], frame, duration, width, height))
        return _texts(*boxes_by_id.get(item["id"], [("ok", 200, 600, 400, 80)])), None
    fn.calls = calls
    return fn


def test_look_reports_the_overflowing_overlay_and_not_the_clean_one_and_writes_nothing(tmp_path):
    path, _ = _project(tmp_path, overlays=[{"id": "ov-wide", "start": 1, "end": 3}, {"id": "ov-clean", "start": 4, "end": 6}])
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    fake = _fake_measure({"ov-wide": [("A very long headline", 600, 400, 900, 120)]})
    out = look.run(str(path), measure_fn=fake)
    assert out["ok"] is False and out["overlays"] == 2 and "looked" not in out, "text mode renders no frame"
    assert out["issues"] == ['2.0s ov-wide: text "A very long headline" runs off the frame: move it left 474 px']
    assert sorted(c[0] for c in fake.calls) == ["ov-clean", "ov-wide"]
    assert ("ov-wide", 30, 60, 1080, 1920) in fake.calls, "the middle of its span, its whole length, the design canvas"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    assert len(json.dumps(out)) <= 300


def test_look_measures_at_most_12_overlays_and_says_how_many_it_left(tmp_path):
    path, _ = _project(tmp_path, base=((0, 20),), overlays=[{"id": f"ov-{k}", "start": k, "end": k + 1} for k in range(15)])
    fake = _fake_measure({})
    out = look.run(str(path), measure_fn=fake)
    # PL89: this fixture's bare stretches are still holds too; this test is about the measure cap
    out["issues"] = [i for i in out.get("issues", []) if "still for" not in i]
    if not out["issues"]:
        out.pop("issues")
        out["ok"] = True
    assert out == {"ok": True, "overlays": 12, "unmeasured": 3}
    assert len(fake.calls) == 12


def test_look_answers_a_measure_that_failed_as_an_issue(tmp_path):
    path, _ = _project(tmp_path, overlays=[{"id": "ov-bad", "start": 1, "end": 3}])
    out = look.run(str(path), measure_fn=lambda *a: (None, "overlay_eval_failed"))
    assert [i for i in out["issues"] if "still for" not in i] == ["2.0s ov-bad: overlay_eval_failed"]


def test_look_image_adds_one_sheet_of_the_times_and_detail_adds_the_facts(tmp_path):
    path, _ = _project(tmp_path, overlays=[{"id": "ov-a", "start": 1, "end": 3}])
    sheets = []

    def fake_sheet(project_path, project_dir, times):
        sheets.append(times)
        return os.path.join(project_dir, "render", "samples", "look-x.png"), None
    out = look.run(str(path), image=True, detail=True, measure_fn=_fake_measure({}), sheet_fn=fake_sheet)
    assert len(sheets) == 1 and sheets[0] == out["times"]
    assert out["sheet"].endswith("look-x.png") and out["items"] == ["ov-a"] and isinstance(out["wallMs"], int)


def test_a_pass_measures_every_overlay_in_one_call(tmp_path, monkeypatch):
    # PL89g: one sample_overlay process (and its own Chromium) per overlay made a pass 10-16 s; the pass now hands every
    # overlay to one call (measure_many: sample_overlay --jobs, one browser per lane).
    path, _ = _project(tmp_path, overlays=[{"id": f"ov-{k}", "start": k, "end": k + 1} for k in (1, 3, 5)])
    calls = []

    def many(entries):
        calls.append([e["item"]["id"] for e in entries])
        return [(_texts(("Fits", 200, 600, 500, 90)), None) for _ in entries]
    monkeypatch.setattr(look, "measure_many", many)
    out = look.run(str(path), detail=True)
    assert calls == [["ov-1", "ov-3", "ov-5"]] and out["overlays"] == 3, (calls, out)


def test_a_failed_batch_falls_back_to_one_measure_each(tmp_path, monkeypatch):
    path, _ = _project(tmp_path, overlays=[{"id": "ov-a", "start": 1, "end": 2}, {"id": "ov-b", "start": 3, "end": 4}])
    monkeypatch.setattr(look, "measure_many", lambda entries: None)
    one = _fake_measure({"ov-a": [("Fits", 200, 600, 500, 90)], "ov-b": [("Fits", 200, 600, 500, 90)]})
    monkeypatch.setattr(look, "measure", one)
    assert look.run(str(path), detail=True)["overlays"] == 2


# PL89g: white and pale-blue labels over Sam's light shirt read poorly. look measures each text's fill against the
# picture behind it (the frame of everything under the overlay's track, read over the glyphs; or the text's own plate)
# and calls anything under CONTRAST_MIN : 1 an issue, with the fix.
def _backdrop(tmp_path, rgb):
    from PIL import Image
    path = tmp_path / f"bg-{'-'.join(map(str, rgb))}.png"
    Image.new("RGB", (1080, 1920), rgb).save(path)
    return str(path)


def _coloured(text, box, color, plate=None):
    t = _texts((text, *box))
    t["texts"][0]["color"] = color
    if plate:
        t["texts"][0]["plate"] = plate
    return t


def test_a_label_with_too_little_contrast_against_the_picture_behind_it_is_an_issue(tmp_path):
    shirt, room = _backdrop(tmp_path, (182, 194, 191)), _backdrop(tmp_path, (32, 22, 20))
    white = _coloured("computer", (400, 900, 280, 50), "rgb(255, 255, 255)")
    got = [i["text"] for i in lc.contrast_issues({}, white, 1080, 1920, 22.0, "ov-chain", shirt)]
    assert len(got) == 1 and got[0].startswith('text "computer" is 1.8 : 1 against the picture behind it'), got
    assert got[0].endswith("give it a plate, or a darker fill"), got
    assert lc.contrast_issues({}, white, 1080, 1920, 22.0, "ov-chain", room) == []
    ink = _coloured("camera", (400, 900, 200, 50), "rgb(40, 40, 46)")
    assert lc.contrast_issues({}, ink, 1080, 1920, 1, "ov", room)[0]["text"].endswith("or a lighter fill")
    # a plate under the text is what it is read against, not the picture
    plated = _coloured("computer", (400, 900, 280, 50), "rgb(255, 255, 255)", plate="rgb(20, 20, 24)")
    assert lc.contrast_issues({}, plated, 1080, 1920, 1, "ov", shirt) == []
    # no colour measured (an older measure), or no picture: nothing is said
    assert lc.contrast_issues({}, _texts(("computer", 400, 900, 280, 50)), 1080, 1920, 1, "ov", shirt) == []
    assert lc.contrast_issues({}, white, 1080, 1920, 1, "ov", None) == []


def test_the_picture_behind_an_overlay_is_every_track_below_it_without_captions():
    p = {"settings": {"fps": 30}, "captions": {"segments": [{"text": "hi", "start": 0, "end": 1}]},
         "tracks": [{"id": "main", "items": [{"id": "v", "type": "video", "src": "/x.mp4", "start": 0, "end": 5}]},
                    {"id": "card", "items": [{"id": "c", "type": "overlay", "src": "./c.jsx", "start": 0, "end": 5}]},
                    {"id": "labels", "items": [{"id": "l", "type": "overlay", "src": "./l.jsx", "start": 0, "end": 5}]},
                    {"id": "top", "items": [{"id": "t", "type": "overlay", "src": "./t.jsx", "start": 0, "end": 5}]}]}
    b = lc.backdrop_project(p, 2)
    assert "captions" not in b
    assert [[it["id"] for it in t["items"]] for t in b["tracks"]] == [["v"], ["c"], [], []]


def test_look_reports_a_label_hard_to_read_on_its_picture(tmp_path):
    path, _ = _project(tmp_path, overlays=[{"id": "ov-chain", "start": 1, "end": 3}])
    shirt = _backdrop(tmp_path, (182, 194, 191))

    def measure(item, *a):
        return _coloured("computer", (400, 600, 280, 50), "rgb(255, 255, 255)"), None
    seen = []

    def backdrops(project_path, project, entries):
        seen.append([e["label"] for e in entries])
        return {e["label"]: shirt for e in entries}
    out = look.run(str(path), detail=True, measure_fn=measure, backdrops_fn=backdrops)
    assert seen == [["ov-chain"]] and any("1.8 : 1 against the picture" in i for i in out["issues"]), out
    out = look.run(str(path), detail=True, measure_fn=measure, backdrops_fn=lambda *a: {})
    assert not any("against the picture" in i for i in out.get("issues", [])), out


def test_look_at_given_times(tmp_path):
    path, _ = _project(tmp_path, overlays=[{"id": "ov-a", "start": 1, "end": 3}])
    out = look.run(str(path), at=[2.0, 7.5], detail=True, measure_fn=_fake_measure({}))
    assert out["times"] == [2.0, 7.5]


# ── a real measure ────────────────────────────────────────────────────────────────────────────────────────────────

def _has_render():
    return shutil.which("node") is not None and (MONTAJ_ROOT / "montaj_assets" / "render" / "node_modules" / "puppeteer").exists()


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
def test_look_through_the_real_measurer_finds_the_text_off_the_frame(tmp_path):
    wide = ("export default function O() { return <div style={{position: 'absolute', left: 700, top: 500, "
            "fontSize: 120, whiteSpace: 'nowrap', color: 'white'}}>A headline far too long</div> }")
    # it moves with the runtime's Motion global (PL89b), so the real render also proves Motion is there
    fits = ("export default function O() { const m = Motion.motion(frame, fps, duration); return <div style={{position: 'absolute', left: 200, top: 700, "
            "fontSize: 60, color: 'white', ...m.style}}>Fits</div> }")
    path, _ = _project(tmp_path, overlays=[{"id": "ov-wide", "start": 1, "end": 3, "jsx": wide},
                                           {"id": "ov-fits", "start": 4, "end": 6, "jsx": fits}])
    out = look.run(str(path), detail=True)
    assert out["overlays"] == 2, out
    wide_issues = [i for i in out["issues"] if "ov-wide" in i]
    assert any("runs off the frame" in i for i in wide_issues), out
    assert not any("ov-fits" in i for i in out["issues"]), out


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
def test_the_real_pass_runs_one_measure_process_for_all_its_overlays(tmp_path, monkeypatch):
    jsx = lambda word, top: ("export default function O() { return <div style={{position: 'absolute', left: 200, top: " + str(top) +  # noqa: E731
                             ", fontSize: 60, color: 'white'}}>" + word + "</div> }")
    path, _ = _project(tmp_path, overlays=[{"id": f"ov-{k}", "start": 1 + 2 * k, "end": 2 + 2 * k, "jsx": jsx(w, 300 + 200 * k)}
                                           for k, w in enumerate(("One", "Two", "Three"))])
    spawned = []
    real = look._run_group
    monkeypatch.setattr(look, "_run_group", lambda cmd, timeout: (spawned.append(cmd), real(cmd, timeout))[1])
    out = look.run(str(path), detail=True)
    assert out["overlays"] == 3, out
    assert len(spawned) == 1 and "--jobs" in spawned[0], spawned


# ── review 1: a measure that times out ends its whole process group ──────────────────────────────────────────────

@pytest.mark.skipif(os.name == "nt", reason="POSIX process groups; Windows ends the tree with taskkill")
def test_a_timed_out_run_ends_the_wrapper_and_its_children(tmp_path):
    import subprocess as sp, time
    pidfile = tmp_path / "child.pid"
    # the wrapper starts a long child (as sample_overlay starts node and Chromium) and waits on it
    script = ("import subprocess, sys, time; p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
              f"open({str(pidfile)!r}, 'w').write(str(p.pid)); p.wait()")
    t0 = time.monotonic()
    assert look._run_group([sys.executable, "-c", script], timeout=2) is None
    assert time.monotonic() - t0 < 20
    child = int(pidfile.read_text())
    time.sleep(0.3)
    alive = sp.run(["ps", "-p", str(child), "-o", "stat="], capture_output=True, text=True).stdout.strip()
    assert alive == "" or alive.startswith("Z"), f"the child is still running: {alive!r}"


# ── review 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────

def _with_captions(tmp_path, overlays, segs=((1, 3),), style="pop", **kw):
    path, p = _project(tmp_path, overlays=overlays, **kw)
    p["captions"] = {"style": style, "segments": [{"id": f"cap-{i}", "text": "a b", "start": s, "end": e,
                                                   "words": [{"word": "a", "start": s, "end": s + 0.2}]} for i, (s, e) in enumerate(segs)]}
    path.write_text(json.dumps(p))
    return path, p


def test_text_across_the_captions_while_a_caption_shows_is_reported(tmp_path):
    # pop draws at 72.6-76.0% of a 1920 frame: y 1394-1459 (measured)
    path, _ = _with_captions(tmp_path, overlays=[{"id": "ov-low", "start": 2, "end": 4}, {"id": "ov-late", "start": 5, "end": 7}])
    out = look.run(str(path), measure_fn=_fake_measure({"ov-low": [("Name", 100, 1380, 400, 60)], "ov-late": [("Name", 100, 1380, 400, 60)]}))
    assert out["issues"] == ['3.0s ov-low: text "Name" crosses the captions (1.0-3.0s): move it up 47 px'], out
    assert "once more" in out["then"]


def test_a_bigger_or_moved_caption_moves_its_band(tmp_path):
    _, p = _with_captions(tmp_path, overlays=[])
    p["captions"]["segments"][0]["offsetY"] = -20
    band = lc.caption_bands(p, 0, 5, 1080, 1920)[0]
    assert round(band[1]) == round(0.760 * 1920 - 384)
    p["captions"]["fontsize"] = 136   # twice pop's 68: the band twice as tall, from its bottom
    top, bottom, _, _ = lc.caption_bands(p, 0, 5, 1080, 1920)[0]
    assert round(bottom - top) == round(2 * (0.760 - 0.726) * 1920)


def test_no_or_an_unknown_caption_style_is_the_band_the_renderer_draws_subtitle(tmp_path):
    for style in (None, "neon"):
        _, p = _with_captions(tmp_path / str(style), overlays=[], style=style)
        top, bottom, _, _ = lc.caption_bands(p, 0, 5, 1080, 1920)[0]
        assert (round(top), round(bottom)) == (round(0.708 * 1920), round(0.749 * 1920))


def test_a_long_caption_and_a_shown_translation_grow_the_band_up_from_its_bottom(tmp_path):
    _, p = _with_captions(tmp_path, overlays=[], style="subtitle")
    one = lc.caption_bands(p, 0, 5, 1080, 1920)[0]
    p["captions"]["segments"][0]["text"] = " ".join(["Keep the best part of every take"] * 4)
    long = lc.caption_bands(p, 0, 5, 1080, 1920)[0]
    assert long[1] == one[1] and long[0] < one[0] - 40
    p["captions"]["segments"][0]["text"] = "a b"
    p["captions"]["segments"].append({"id": "es-0", "lang": "es", "translationOf": ["cap-0"], "text": "a b", "start": 1, "end": 3})
    two = lc.caption_bands(p, 0, 5, 1080, 1920)
    assert len(two) == 1 and two[0][1] == one[1] and two[0][0] < one[0] - 20
    p["captions"]["showLangs"] = ["source"]
    assert lc.caption_bands(p, 0, 5, 1080, 1920)[0] == one, "a translation not shown adds no row"


def test_text_that_spills_out_of_its_own_box_is_reported_not_ok():
    t = {"texts": [{"text": "Three times faster", "bbox": {"x": 100, "y": 300, "w": 700, "h": 90}, "spills": True}]}
    assert [i["text"] for i in lc.measured_issues({}, t, 1080, 1920, 1, "ov")] == ['text "Three times faster" spills out of its box']


@pytest.mark.parametrize("box,frame,want", [
    (("Title", 200, 300, 600, 90), (1080, 1920), []),                     # a centred title high up: no app zone
    (("Tag", 800, 1000, 200, 80), (1080, 1350), []),                      # a 4:5 feed post: no app zones
    (("Edge", 20, 600, 400, 80), (1080, 1350), ["inside the 5% title-safe margin"]),
    (("Edge", 600, 1270, 400, 60), (1080, 1350), ["inside the 5% title-safe margin"]),
])
def test_app_zones_apply_to_tall_frames_and_the_title_safe_margin_to_every_frame(box, frame, want):
    got = [i["text"] for i in lc.measured_issues({}, _texts(box), *frame, 1, "ov")]
    assert [w for w in want if not any(w in g for g in got)] == [] and len(got) == len(want), got


@pytest.mark.parametrize("item,box,frame,want", [
    # PL89c: the agent guessed each fix in another rewrite. Each safe-area issue says how far to move the text box,
    # in the overlay's own px (the item's scale undone), to clear the zone it is in.
    ({}, ("Edge", 20, 600, 400, 80), (1080, 1920), ['text "Edge" inside the 5% title-safe margin: move it right 34 px']),
    ({}, ("Edge", 600, 1270, 400, 60), (1080, 1350), ['text "Edge" inside the 5% title-safe margin: move it up 48 px']),
    ({}, ("Name", 100, 1700, 400, 80), (1080, 1920), ["text \"Name\" over the apps' bottom controls: move it up 210 px"]),
    ({}, ("Tag", 800, 1000, 200, 80), (1080, 1920), ["text \"Tag\" under the apps' right-side buttons: move it left 120 px"]),
    ({}, ("Title", 900, 100, 400, 80), (1080, 1920), ['text "Title" runs off the frame: move it left 274 px']),
    ({}, ("Corner", 20, 30, 400, 80), (1080, 1920), ['text "Corner" inside the 5% title-safe margin: move it right 34 px and down 66 px']),
    ({"scale": 0.5}, ("Edge", -480, 600, 400, 80), (1080, 1920), ['text "Edge" inside the 5% title-safe margin: move it right 48 px']),
    ({}, ("Wide", 30, 600, 1040, 80), (1080, 1920), ['text "Wide" inside the 5% title-safe margin: make it at most 972 px wide, keeping it centred']),
])
def test_a_safe_area_issue_says_how_far_to_move_the_text(item, box, frame, want):
    assert [i["text"] for i in lc.measured_issues(item, _texts(box), *frame, 1, "ov")] == want


# PL89e: "move it up 65 px" took a credit off the apps' controls and onto the captions (1292-1432 px for "outline"),
# and "move it left 40 px" slid a centred stack off-centre. The hint clears every zone at once (the margin, the
# controls, the right-side buttons, any caption band on screen), narrows a centred block instead of sliding it, and
# says the room when nothing fits. One hint per text, on its first issue, so it is applied once.
BAND = [(1292, 1432, 47.7, 51.8)]


@pytest.mark.parametrize("box,bands,want", [
    (("PhoneBot", 100, 1470, 760, 165), BAND,
     ["text \"PhoneBot\" over the apps' bottom controls: move it up 343 px"]),
    (("old phone", 140, 1000, 800, 80), (),
     ["text \"old phone\" under the apps' right-side buttons: make it at most 680 px wide, keeping it centred"]),
    (("Tag", 200, 1350, 400, 60), BAND,
     ['text "Tag" crosses the captions (47.7-51.8s): move it down 82 px']),
    (("Big", 100, 300, 600, 1400), BAND,
     ['text "Big" crosses the captions (47.7-51.8s): make it at most 1196 px tall, the most room clear of every zone',
      "text \"Big\" over the apps' bottom controls"]),
])
def test_the_move_hint_clears_every_zone_at_once(box, bands, want):
    assert [i["text"] for i in lc.measured_issues({}, _texts(box), 1080, 1920, 1, "ov", bands)] == want


# PL89f: a centred title written as a full-width box always measured as "inside the title-safe margin" (its element
# spans the width), and the hint told the agent to narrow "UCLA" to 972 px. The zone checks and their hints use the
# text's own glyphs when the measurer gives them; with none (an older measure), the box as before.
def _glyphed(text, box, glyphs):
    t = _texts((text, *box))
    t["texts"][0]["glyphs"] = dict(zip("xywh", glyphs))
    return t


def test_a_full_width_centred_title_is_judged_by_its_glyphs():
    assert lc.measured_issues({}, _glyphed("UCLA", (0, 300, 1080, 110), (430, 310, 220, 90)), 1080, 1920, 1, "ov") == []
    edge = _glyphed("Edge", (0, 600, 1080, 80), (20, 610, 400, 60))
    assert [i["text"] for i in lc.measured_issues({}, edge, 1080, 1920, 1, "ov")] == [
        'text "Edge" inside the 5% title-safe margin: move it right 34 px']
    # the glyphs, not the box, decide the captions and the controls too
    low = _glyphed("Low", (0, 1300, 1080, 300), (440, 1200, 200, 60))
    assert lc.measured_issues({}, low, 1080, 1920, 1, "ov", [(1292, 1432, 1, 2)]) == []


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
def test_the_real_measurer_does_not_call_a_full_width_centred_title_inside_the_margin(tmp_path):
    title = ("export default function O() { return <div style={{position: 'absolute', "
             "left: 0, top: 300, width: 1080, textAlign: 'center', fontSize: 96, color: 'white'}}>UCLA</div> }")
    path, _ = _project(tmp_path, overlays=[{"id": "ov-title", "start": 1, "end": 3, "jsx": title}])
    out = look.run(str(path), detail=True)
    assert out["overlays"] == 1, out   # measured, not failed
    assert not any("ov-title" in i and ("margin" in i or "error" in i) for i in out.get("issues", [])), out


def test_an_answer_with_move_hints_says_to_run_look_again():
    hinted = [{"t": 1.0, "id": "ov", "text": "text \"Tag\" crosses the captions (1-2s): move it down 82 px"}]
    plain = [{"t": 1.0, "id": "ov", "text": "text \"Tag\" spills out of its box"}]
    assert lc.answer(hinted)["then"] == "Run look once more after these edits, not after each one."
    assert "then" not in lc.answer(plain)


def test_a_switched_off_track_draws_nothing(tmp_path):
    full = {"id": "img-off", "type": "image", "src": "/x/f.png", "start": 1, "end": 3}
    path, p = _project(tmp_path, base=((0, 5), (6, 10)), overlays=[{"id": "ov-a", "start": 1, "end": 2}],
                       extra_tracks=[{"id": "off", "enabled": False, "items": [full]}])
    texts = [i["text"] for i in lc.data_issues(p, str(path.parent))]
    assert not any("hidden by" in t for t in texts), texts
    p["tracks"][0]["enabled"] = False
    assert lc.base_end(p) == 0 and lc.pick_times(p) != []


def test_hidden_follows_the_renders_stacking_video_tracks_below_the_rest(tmp_path):
    img = {"id": "img-full", "type": "image", "src": "/x/f.png", "start": 1, "end": 3}
    vid = {"id": "vid-up", "type": "video", "src": "/x/v.mp4", "start": 1, "end": 3}
    # the video sits on a HIGHER track than the image, but a track holding video stacks below every other
    path, p = _project(tmp_path, overlays=[], extra_tracks=[{"id": "imgs", "items": [img]}, {"id": "vids", "items": [vid]}])
    found = {(i["id"], i["text"]) for i in lc.data_issues(p, str(path.parent))}
    assert ("vid-up", "hidden by img-full 1.0-3.0s") in found
    assert not any(i[0] == "img-full" and "hidden" in i[1] for i in found)


def test_a_footage_gap_under_an_overlay_is_overlay_only_not_black(tmp_path):
    path, p = _project(tmp_path, base=((0, 2), (4, 6)), overlays=[{"id": "ov-title", "start": 2, "end": 4}])
    assert ("frame", "no footage 2.0-4.0s (overlay only)") in {(i["id"], i["text"]) for i in lc.data_issues(p, str(path.parent))}


def test_auto_times_take_every_kind_round_robin(tmp_path):
    seams = [(k * 2.4, k * 2.4 + 2.4) for k in range(25)]   # a cut project: 24 seams in the first minute
    _, p = _project(tmp_path, base=seams, overlays=[{"id": "ov-late", "start": 40, "end": 53}])
    times = lc.pick_times(p)
    assert len(times) == lc.MAX_TIMES and any(40 <= t <= 53 for t in times), times
    assert max(times) > 30 and min(times) < 10, "spread over the whole project"


def test_image_mode_takes_at_most_8_times_and_a_3_by_360_sheet(tmp_path, monkeypatch):
    many = [{"id": f"ov-{k}", "start": k * 2, "end": k * 2 + 1.5} for k in range(10)]
    path, _ = _project(tmp_path, base=((0, 20),), overlays=many)
    got = []
    out = look.run(str(path), image=True, measure_fn=_fake_measure({}), sheet_fn=lambda pp, pd, times: (got.append(times), (pd + "/s.png", None))[1])
    assert len(got[0]) <= look.IMAGE_TIMES and out["times"] == got[0]
    cmds = []
    monkeypatch.setattr(look, "_run_group", lambda cmd, timeout: (cmds.append(cmd), (0, "", ""))[1])
    look.sheet(str(path), str(path.parent), [1.0, 2.0, 3.0, 4.0])
    assert cmds[0][cmds[0].index("--cols") + 1] == "3" and cmds[0][cmds[0].index("--tile-width") + 1] == "360"


def test_overlays_are_measured_three_at_a_time(tmp_path):
    import threading, time
    path, _ = _project(tmp_path, base=((0, 20),), overlays=[{"id": f"ov-{k}", "start": k, "end": k + 1} for k in range(6)])
    live, peak, lock = [0], [0], threading.Lock()

    def slow(*a):
        with lock:
            live[0] += 1
            peak[0] = max(peak[0], live[0])
        time.sleep(0.2)
        with lock:
            live[0] -= 1
        return _texts(("ok", 200, 600, 400, 80)), None
    out = look.run(str(path), measure_fn=slow)
    assert out["overlays"] == 6 and peak[0] == look.MEASURE_WORKERS


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
def test_the_real_measurer_sees_text_spill_out_of_its_box(tmp_path):
    spill = ("export default function O() { return <div style={{position: 'absolute', left: 120, top: 500, width: 300, "
             "whiteSpace: 'nowrap', fontSize: 70, color: 'white'}}>Spills out here</div> }")
    path, _ = _project(tmp_path, overlays=[{"id": "ov-spill", "start": 1, "end": 3, "jsx": spill}])
    out = look.run(str(path), detail=True)
    assert any("ov-spill" in i and "spills out of its box" in i for i in out["issues"]), out


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
def test_a_tight_heading_at_the_top_edge_is_not_off_the_frame(tmp_path, monkeypatch):
    # its glyphs rise ~10 px past a line-height of 1 at 160 px: inside the 30% slack, so the box stays the element's
    monkeypatch.setenv("TMPDIR", str(tmp_path))   # a fresh sample cache
    tight = ("export default function O() { return <div style={{position: 'absolute', left: 100, top: 0, width: 880, "
             "fontSize: 160, lineHeight: 1, fontWeight: 800, color: 'white'}}>Big</div> }")
    path, _ = _project(tmp_path, overlays=[{"id": "ov-top", "start": 1, "end": 3, "jsx": tight}])
    out = look.run(str(path), detail=True)
    assert out["overlays"] == 1 and not any("runs off the frame" in i or "spills" in i for i in out.get("issues", [])), out


# ── PL89b: motion and type a phone can read ───────────────────────────────────────────────────────────────────────

MOVING = ("export default function O() {\n  const m = Motion.motion(frame, fps, duration)\n"
          "  return <div style={m.style}>hi</div>\n}\n")


def _motion(tmp_path, jsx, files=()):
    d = tmp_path / "m"
    (d / "overlays" / "_shared").mkdir(parents=True, exist_ok=True)
    for name, text in files:
        (d / "overlays" / name).write_text(text)
    (d / "overlays" / "o.jsx").write_text(jsx)
    item = {"id": "ov-o", "type": "overlay", "src": "./overlays/o.jsx", "start": 2, "end": 6}
    return [i["text"] for i in lc.motion_issues(item, str(d), "ov-o")]


def test_an_overlay_using_motion_or_springs_and_its_duration_moves_well(tmp_path):
    assert _motion(tmp_path, MOVING) == []
    eased = ("export default function O() {\n  const s = spring({frame, fps})\n"
             "  const out = interpolate(frame, [duration - 4, duration], [1, 0])\n"
             "  return <div style={{opacity: out, transform: `scale(${s})`}}>hi</div>\n}\n")
    assert _motion(tmp_path, eased) == []
    # motion in a shared module the overlay imports counts too
    shared = "export const enter = (f, fps, d) => Motion.motion(f, fps, d)\n"
    assert _motion(tmp_path, "import { enter } from './_shared/anim.js'\nexport default function O() { return <div style={enter(frame, fps, duration).style}>x</div> }",
                   files=[("_shared/anim.js", shared)]) == []


def test_a_still_overlay_and_a_linear_one_that_never_exits_are_said(tmp_path):
    still = _motion(tmp_path, "export default function O() { return <div>hi</div> }")
    assert len(still) == 1 and "no motion" in still[0] and "Motion.motion" in still[0]
    linear = _motion(tmp_path, "export default function O() {\n  const a = interpolate(frame, [0, 10], [0, 1])\n"
                               "  return <div style={{opacity: a}}>hi</div>\n}\n")
    assert any("never leaves" in t for t in linear) and any("linear" in t for t in linear), linear


def _sized(*texts):
    return {"texts": [{"text": t, "fontSize": f"{px}px", "bbox": {"x": 100, "y": 300 + 100 * k, "w": 300, "h": px},
                       "overflow": {}, "clippingAncestor": None} for k, (t, px) in enumerate(texts)]}


def test_text_under_the_phone_floors_is_said_once_per_kind_at_its_size_on_screen():
    item = {"id": "ov-a", "type": "overlay", "start": 0, "end": 4}
    said = [i["text"] for i in lc.type_floor_issues(item, _sized(("FOOTAGE", 18), ("PhoneBot", 64), ("UCLA", 24)), 1080, 1920, 2, "ov-a")]
    assert len(said) == 2, said
    assert any('"FOOTAGE" is 18 px' in t and "36 px" in t for t in said), said
    assert any('"PhoneBot" is 64 px' in t and "72 px" in t for t in said), said
    # the item's own scale counts: at 2x the same texts are 36, 128 and 48 px on screen
    assert lc.type_floor_issues({**item, "scale": 2}, _sized(("FOOTAGE", 18), ("PhoneBot", 64), ("UCLA", 24)), 1080, 1920, 2, "ov-a") == []
    # one size alone is a label, not a missing title
    assert lc.type_floor_issues(item, _sized(("sensors", 40), ("compute", 40)), 1080, 1920, 2, "ov-a") == []


def test_look_reports_motion_and_type_floors_with_the_rest(tmp_path):
    path, _ = _project(tmp_path, overlays=[{"id": "ov-still", "start": 1, "end": 4, "jsx": "export default function O() { return <div>hi</div> }"},
                                           {"id": "ov-good", "start": 5, "end": 9, "jsx": MOVING}])

    def measure(item, *a):
        return (_sized(("tiny", 20)) if item["id"] == "ov-still" else _sized(("Big title", 96), ("label", 40))), None
    out = look.run(str(path), measure_fn=measure, detail=True)
    mine = [i for i in out["issues"] if "ov-still" in i]
    assert any("no motion" in i for i in mine) and any('"tiny" is 20 px' in i for i in mine), out["issues"]
    assert not any("ov-good" in i for i in out["issues"]), out["issues"]


# ── caption ink: data only ────────────────────────────────────────────────────────────────────────────────────────

def _ink_project(segs, card=True, style="pop"):
    items = [{"id": "paper", "type": "overlay", "src": "engine:scene3d", "start": 0, "end": 4, "opaque": True}] if card else []
    return {"id": "p", "settings": {"resolution": [1080, 1920], "fps": 30},
            "tracks": [{"id": "main", "items": [{"id": "v", "type": "video", "src": "/x/a.mp4", "start": 0, "end": 8,
                                                 "inPoint": 0, "outPoint": 8}]}, {"id": "ovl", "items": items}],
            "captions": {"style": style, "segments": [{"id": f"cap-{i}", "text": "x", "words": [], **s}
                                                      for i, s in enumerate(segs)]}}


def test_a_caption_over_a_card_whose_ink_was_not_checked_is_reported():
    issues = lc.caption_ink_issues(_ink_project([{"start": 1, "end": 2}]))
    assert len(issues) == 1 and issues[0]["id"] == "captions" and issues[0]["t"] == 1.5
    assert "paper" in issues[0]["text"] and "run caption_ink" in issues[0]["text"]


def test_a_caption_whose_ink_was_checked_for_this_card_is_fine():
    assert lc.caption_ink_issues(_ink_project([{"start": 1, "end": 2, "ink": "dark", "inkAuto": {"card": "paper", "ink": "dark"}}])) == []


def test_ink_set_for_a_card_that_is_gone_is_reported():
    issues = lc.caption_ink_issues(_ink_project([{"start": 5, "end": 6, "ink": "dark", "inkAuto": {"card": "paper", "ink": "dark"}}]))
    assert len(issues) == 1 and "paper" in issues[0]["text"] and "now over footage" in issues[0]["text"]


def test_a_persons_ink_is_never_flagged():
    auto = {"card": "paper", "ink": "dark"}
    assert lc.caption_ink_issues(_ink_project([{"start": 1, "end": 2, "ink": "light"},
                                                {"start": 5, "end": 6, "ink": "dark"},
                                                {"start": 1, "end": 2, "ink": "light", "inkAuto": auto},
                                                {"start": 5, "end": 6, "ink": "light", "inkAuto": auto},
                                                {"start": 1, "end": 2, "inkAuto": auto},
                                                {"start": 5, "end": 6, "inkAuto": auto}])) == []


def test_ink_the_step_wrote_for_another_card_is_reported():
    auto = {"card": "old", "ink": "dark"}
    issues = lc.caption_ink_issues(_ink_project([{"start": 1, "end": 2, "ink": "dark", "inkAuto": auto}]))
    assert len(issues) == 1 and "paper" in issues[0]["text"] and "not had its ink checked" in issues[0]["text"]


def test_translations_and_the_boxed_styles_are_not_flagged_for_ink():
    segs = [{"start": 1, "end": 2, "ink": "dark", "inkAuto": {"card": "paper", "ink": "dark"}},
            {"start": 1, "end": 2, "lang": "es", "translationOf": ["cap-0"]}]
    assert lc.caption_ink_issues(_ink_project(segs)) == []
    for style in ("plate", "subtitle"):
        assert lc.caption_ink_issues(_ink_project([{"start": 1, "end": 2}], style=style)) == []


def test_look_reports_the_unchecked_caption_ink_in_its_answer(tmp_path):
    path, p = _project(tmp_path, base=((0, 8),))
    p["tracks"][1]["items"].append({"id": "paper", "type": "overlay", "src": "engine:scene3d", "start": 0, "end": 4, "opaque": True})
    p["captions"] = {"style": "pop", "segments": [{"id": "cap-0", "text": "x", "start": 1, "end": 2, "words": []}]}
    path.write_text(json.dumps(p))
    out = look.run(str(path), detail=True)
    assert any("run caption_ink" in i for i in out["issues"])


def test_a_paper_matte_that_only_measuring_can_find_is_not_flagged_before_the_step_ran():
    p = _ink_project([{"start": 1, "end": 2}], card=False)
    p["tracks"][1]["items"].append({"id": "matte", "type": "overlay", "src": "./overlays/footage-card.jsx", "start": 0, "end": 4})
    assert lc.caption_ink_issues(p) == []


def test_a_3d_scene_with_a_backdrop_is_flagged_without_opaque(tmp_path):
    scenes = tmp_path / "models" / "scenes" / "specs"
    scenes.mkdir(parents=True)
    (scenes / "active.json").write_text(json.dumps({"scene": {"backdrop": {"style": "color"}}}))
    p = _ink_project([{"start": 1, "end": 2}], card=False)
    p["tracks"][1]["items"].append({"id": "s", "type": "overlay", "src": "engine:scene3d", "start": 0, "end": 4,
                                    "props": {"scene": "specs"}})
    issues = lc.caption_ink_issues(p, str(tmp_path))
    assert len(issues) == 1 and "over s" in issues[0]["text"] and "not had its ink checked" in issues[0]["text"]
    (scenes / "active.json").write_text(json.dumps({"scene": {"backdrop": {"style": "transparent"}}}))
    assert lc.caption_ink_issues(p, str(tmp_path)) == []


def test_ink_set_for_a_matte_is_fine_while_the_matte_is_on_screen_and_reported_when_it_is_not():
    p = _ink_project([{"start": 1, "end": 2, "ink": "dark", "inkAuto": {"card": "matte", "ink": "dark"}},
                      {"start": 5, "end": 6, "ink": "dark", "inkAuto": {"card": "matte", "ink": "dark"}}], card=False)
    p["tracks"][1]["items"].append({"id": "matte", "type": "overlay", "src": "./overlays/footage-card.jsx", "start": 0, "end": 4})
    issues = lc.caption_ink_issues(p)
    assert len(issues) == 1 and issues[0]["t"] == 5.5 and "now over footage" in issues[0]["text"]


# ── the top slot (PL89d) ──────────────────────────────────────────────────────────────────────────────────────────
# 52's round-5 notes: six keyword chips at top 120 and a diagram strip at y 150, one after another: a page heading over
# every shot. Three or more overlays whose text sits in the same top slot are one issue; two are a choice.

def test_three_overlays_in_the_top_slot_are_one_issue_naming_them():
    top = [{"x": 340, "y": 120, "w": 400, "h": 90}]
    placed = [("kw-1", 2, 4, top), ("kw-2", 9, 11, top), ("flow", 14, 17, [{"x": 100, "y": 150, "w": 880, "h": 60}]),
              ("mid", 20, 22, [{"x": 340, "y": 900, "w": 400, "h": 90}])]
    out = lc.top_slot_issues(placed, 1080, 1920)
    assert len(out) == 1, out
    assert out[0]["t"] == 14 and out[0]["id"] == "top-slot"
    for s in ["kw-1, kw-2, flow", "one top slot", "mid-frame", "beside what it explains"]:
        assert s in out[0]["text"], out[0]["text"]
    assert lc.top_slot_issues(placed[:2] + placed[3:], 1080, 1920) == [], "two are a choice"
    assert lc.top_slot_issues([(f"kw-{k}", k, k + 1, top) for k in range(3)], 1920, 1080) != [], "a wide frame too"


def test_look_reports_the_top_slot(tmp_path):
    path, _ = _project(tmp_path, base=((0, 20),), overlays=[{"id": f"kw-{k}", "start": 1 + 5 * k, "end": 3 + 5 * k} for k in range(3)])
    fake = _fake_measure({f"kw-{k}": [("keyword", 340, 120, 400, 90)] for k in range(3)})
    out = look.run(str(path), measure_fn=fake, detail=True)
    assert any("top-slot" in i and "one top slot" in i for i in out["issues"]), out["issues"]


# PL89e: the UCLA footage went out on cards with no credit. A footage card (frame_broll's) for third-party footage
# (its source has a title, URL or provenance, or is a download) with an empty credit is said.
def _card_project(tmp_path, src_name, credit):
    clip = {"id": "br-1", "type": "video", "src": f"/x/{src_name}", "start": 1, "end": 3, "inPoint": 0, "outPoint": 2}
    card = {"id": "ov-card", "type": "overlay", "src": "./overlays/footage-card.jsx", "start": 1, "end": 3,
            "props": {"credit": credit, "for": "br-1"}}
    path, p = _project(tmp_path, extra_tracks=[{"id": "b", "items": [clip]}, {"id": "c", "items": [card]}])
    return path, p


def test_a_third_party_footage_card_with_no_credit_is_said(tmp_path):
    path, p = _card_project(tmp_path, "youtube-phonebot-o_Q4rFSNZuE.mp4", "")
    found = [i for i in lc.data_issues(p, str(path.parent)) if i["id"] == "ov-card"]
    assert found and "credit" in found[0]["text"] and "Footage: Phonebot · YouTube" in found[0]["text"]


def test_own_footage_or_a_credited_card_is_not_said(tmp_path):
    a = tmp_path / "a"
    a.mkdir()
    path, p = _card_project(a, "IMG_1167.MOV", "")
    assert [i for i in lc.data_issues(p, str(path.parent)) if "credit" in i["text"]] == []
    b = tmp_path / "b"
    b.mkdir()
    path, p = _card_project(b, "youtube-phonebot-o_Q4rFSNZuE.mp4", "Footage: UCLA")
    assert [i for i in lc.data_issues(p, str(path.parent)) if "credit" in i["text"]] == []


# ── a font that fell back to serif (PL89e) ────────────────────────────────────────────────────────────────────────
# 52's round-6 notes: the ring's label drew in Times, given "JetBrains Mono" bare with no font loading it.

def test_text_whose_face_fell_back_to_serif_is_one_issue_naming_the_face():
    m = {"texts": [{"text": "live video", "bbox": {"x": 300, "y": 900, "w": 400, "h": 60}, "overflow": {}, "clippingAncestor": None,
                    "fontFamily": '"JetBrains Mono"', "fellBack": True},
                   {"text": "again", "bbox": {"x": 300, "y": 1000, "w": 400, "h": 60}, "overflow": {}, "clippingAncestor": None,
                    "fontFamily": '"JetBrains Mono"', "fellBack": True}], "anyOverflow": False}
    out = [i for i in lc.measured_issues({}, m, 1080, 1920, 3.0, "ov-ring") if "serif" in i["text"]]
    assert len(out) == 1, out
    assert '"live video" draws in serif' in out[0]["text"] and "JetBrains Mono" in out[0]["text"]
    assert "googleFonts" in out[0]["text"] and "generic family" in out[0]["text"]
    ok = {"texts": [dict(m["texts"][0], fellBack=False)], "anyOverflow": False}
    assert not [i for i in lc.measured_issues({}, ok, 1080, 1920, 3.0, "ov-ring") if "serif" in i["text"]]


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
def test_the_real_measurer_sees_a_face_that_did_not_load(tmp_path):
    bare = ("export default function O() { const m = Motion.motion(frame, fps, duration); return <div style={{position: 'absolute', "
            "left: 200, top: 700, fontSize: 60, color: 'white', fontFamily: 'Nonexistent Face', ...m.style}}>live video</div> }")
    stacked = bare.replace("'Nonexistent Face'", "'Nonexistent Face, sans-serif'")
    path, _ = _project(tmp_path, overlays=[{"id": "ov-bare", "start": 1, "end": 3, "jsx": bare},
                                           {"id": "ov-stack", "start": 4, "end": 6, "jsx": stacked}])
    out = look.run(str(path), detail=True)
    assert any("ov-bare" in i and "draws in serif" in i for i in out["issues"]), out
    assert not any("ov-stack" in i and "serif" in i for i in out["issues"]), out


# ── a label on its own part (PL89e) ───────────────────────────────────────────────────────────────────────────────
# 52's round-6 notes: "sensors" sat on the phone's edge. An overlay that imports a direct_scene mark file
# (overlays/_marks/<scene>.json) has its labels checked against the marked parts at the scene's moment: a label over a
# part is an issue (labels go at the leader's `to`, beside the model).

def _marked(tmp_path, box):
    jsx = ("import mark from './_marks/stack.json'\n"
           "export default function O() { const m = Motion.motion(frame, fps, duration); return <div style={m.style}>sensors</div> }")
    scene = {"id": "s3d", "items": [{"id": "s3d-1", "type": "overlay", "src": "engine:scene3d", "start": 2, "end": 8,
                                     "props": {"scene": "stack", "inPoint": 1}}]}
    path, _ = _project(tmp_path, base=((0, 10),), overlays=[{"id": "ov-labels", "start": 2, "end": 8, "jsx": jsx}], extra_tracks=[scene])
    part = lambda x: {"cast": 0, "part": "sensors", "pixel": [x, 1000], "box": [x - 200, 900, x + 200, 1100], "inView": True,
                      "leader": {"side": "right", "from": [x + 200, 1000], "to": [x + 500, 1000], "align": "start"}}
    mark = {"kind": "mark", "at": 0, "size": {"width": 2160, "height": 3840}, "parts": [part(1000)], "casts": [],
            "track": [{"t": 0, "parts": [part(1000)], "casts": []}, {"t": 4, "parts": [part(1000)], "casts": []}]}
    (path.parent / "overlays" / "_marks").mkdir()
    (path.parent / "overlays" / "_marks" / "stack.json").write_text(json.dumps(mark))
    return look.run(str(path), measure_fn=_fake_measure({"ov-labels": [box]}), detail=True)


def test_a_label_over_its_marked_part_is_an_issue_and_one_beside_it_is_not(tmp_path):
    # the part's box at 2160 x 3840 is 800-1200 x 900-1100: 400-600 x 450-550 on the 1080 canvas
    out = _marked(tmp_path / "on", ("sensors", 430, 470, 160, 60))
    assert any("ov-labels" in i and 'label "sensors" sits on the part sensors' in i for i in out["issues"]), out["issues"]
    out = _marked(tmp_path / "beside", ("sensors", 780, 470, 160, 60))
    assert not any("sits on the part" in i for i in out["issues"]), out["issues"]


# Sam (2026-10-26, a paid run's 13 tracks: 4 b-roll tracks of one clip each, 3 for 3D beats, 3 for labels): tracks of one
# kind (video, 3D beats, graphics) that never overlap in time, with nothing between them drawing over the lower one's
# items, are one issue each: they could be one track.
def test_same_kind_tracks_that_could_be_one_are_said():
    v = lambda i, s, e: {"id": i, "type": "video", "src": "/x/b.mp4", "start": s, "end": e}
    o = lambda i, s, e, src=None: {"id": i, "type": "overlay", "src": src or f"./overlays/{i}.jsx", "start": s, "end": e}
    p = {"tracks": [{"id": "trk-0", "items": [v("v0", 0, 50)]},
                    {"id": "b1", "items": [v("br1", 4, 7)]}, {"id": "b2", "items": [v("br2", 24, 27)]},
                    {"id": "s1", "items": [o("specs", 7, 13, "engine:scene3d")]}, {"id": "s2", "items": [o("mount", 13, 24, "engine:scene3d")]},
                    {"id": "g1", "items": [o("lab1", 7, 13)]}, {"id": "g2", "items": [o("lab2", 13, 24)]},
                    {"id": "g3", "items": [o("lab3", 8, 9)]}]}    # lab3 overlaps lab1: g3 stays its own track
    out = [i for i in lc.merge_track_issues(p)]
    texts = " | ".join(i["text"] for i in out)
    assert len(out) == 3, texts
    assert any(i["id"] == "b2" and "b1" in i["text"] for i in out), texts
    assert any(i["id"] == "s2" and "s1" in i["text"] for i in out), texts
    assert any(i["id"] == "g2" and "g1" in i["text"] for i in out), texts
    assert "edit_timeline" in texts and "track" in texts
    # a 3D beat between two graphics tracks, over both tracks' items: either merge would change what draws on top
    p2 = {"tracks": [p["tracks"][0], {"id": "g1", "items": [o("lab1", 7, 9)]}, {"id": "s1", "items": [o("specs", 7, 13, "engine:scene3d")]},
                     {"id": "g2", "items": [o("lab2", 10, 12)]}]}
    assert lc.merge_track_issues(p2) == []


# 52's PL89f glyph box: the overlap, top-slot and label-on-part checks read the text's own glyphs too, so a full-width
# centred label is not taken for one that covers a part or crosses another overlay.
def test_overlaps_and_the_label_on_part_check_read_the_glyphs(tmp_path, monkeypatch):
    wide = {"x": 0, "y": 470, "w": 1080, "h": 60}
    a = ("ov-a", 0, 4, [{**wide, "glyphs": {"x": 100, "y": 470, "w": 200, "h": 60}}])
    b = ("ov-b", 1, 5, [{**wide, "glyphs": {"x": 700, "y": 470, "w": 200, "h": 60}}])
    assert lc.text_overlaps([a, b]) == [], "glyphs apart, boxes crossing: no overlap"
    # a full-width label whose glyphs sit beside the marked part (400-600 x 450-550 on the 1080 canvas) is not on it
    real = _fake_measure
    monkeypatch.setattr(sys.modules[__name__], "_fake_measure", lambda boxes: (lambda *a: (_glyphed("sensors", (0, 470, 1080, 60), (780, 470, 160, 60)), None)))
    out = _marked(tmp_path / "beside", ("sensors", 0, 470, 1080, 60))
    monkeypatch.setattr(sys.modules[__name__], "_fake_measure", real)
    assert not any("sits on the part" in i for i in out["issues"]), out["issues"]


# Round 9 (52's notes): the mount was marked, but no overlay read its marks, so its labels were dropped. A mark file no
# overlay imports is named.
def test_a_mark_no_overlay_reads_is_named(tmp_path):
    jsx = "import mark from './_marks/specs.json'\nexport default function O() { const m = Motion.motion(frame, fps, duration); return <div style={m.style}>x</div> }"
    path, _ = _project(tmp_path, base=((0, 10),), overlays=[{"id": "ov-specs", "start": 1, "end": 4, "jsx": jsx}])
    marks = path.parent / "overlays" / "_marks"
    marks.mkdir()
    for name in ("specs", "mount"):
        (marks / f"{name}.json").write_text(json.dumps({"kind": "mark", "at": 0, "size": {"width": 1080, "height": 1920}, "parts": [], "casts": []}))
    out = look.run(str(path), measure_fn=_fake_measure({}), detail=True)
    named = [i for i in out["issues"] if "_marks/mount.json" in i]
    assert len(named) == 1 and "scene_labels" in named[0], out["issues"]
    assert not any("_marks/specs.json" in i for i in out["issues"]), "specs is read"
