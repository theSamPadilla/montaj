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
        jsx = ov.pop("jsx", "export default function O() { return <div>hi</div> }")
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
    assert 5.1 in times, "the cut seam, just after it"
    assert 2.1 in times and 3.9 in times, "the overlay's in and out, just inside"
    assert 6.1 in times, "a caption change after a gap"
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
    (("Name", 100, 1700, 400, 80), "in the bottom 350px"),
    (("Tag", 800, 600, 200, 80), "under the right-side app buttons"),
    (("Cut", 100, 600, 400, 80, {"tag": "DIV", "bbox": {"x": 100, "y": 600, "w": 200, "h": 80}}), "cut off by its box"),
])
def test_measured_issues_name_the_problem(box, want):
    issues = lc.measured_issues({}, _texts(box), 1080, 1920, 2.0, "ov-x")
    assert any(want in i["text"] for i in issues), issues
    assert all(i["id"] == "ov-x" and i["t"] == 2.0 for i in issues)


def test_text_that_fits_has_no_measured_issue_and_landscape_has_no_app_zones():
    assert lc.measured_issues({}, _texts(("Fits", 200, 600, 500, 90)), 1080, 1920, 1, "ov") == []
    assert lc.measured_issues({}, _texts(("Low", 200, 950, 500, 90)), 1920, 1080, 1, "ov") == []


def test_two_overlays_on_screen_at_once_whose_text_crosses_are_reported():
    a = ("ov-a", 0, 4, [{"x": 100, "y": 100, "w": 300, "h": 80}])
    b = ("ov-b", 3, 6, [{"x": 300, "y": 150, "w": 300, "h": 80}])
    c = ("ov-c", 5, 8, [{"x": 100, "y": 100, "w": 300, "h": 80}])
    assert [i["text"] for i in lc.text_overlaps([a, b, c])] == ["text overlaps ov-b", "text overlaps ov-c"]


def test_the_answer_stays_within_300_characters_and_counts_the_rest():
    issues = [{"t": k, "id": f"ov-{k}", "text": "text \"A long headline\" runs off the frame"} for k in range(30)]
    out = lc.answer(issues, 12, 12)
    assert len(json.dumps(out)) <= 300 and out["ok"] is False and out["more"] == 30 - len(out["issues"])
    assert lc.answer([], 9, 2) == {"ok": True, "looked": 9, "measured": 2}


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
    assert out["ok"] is False and out["measured"] == 2
    assert out["issues"] == ['2.0s ov-wide: text "A very long headline" runs off the frame']
    assert sorted(c[0] for c in fake.calls) == ["ov-clean", "ov-wide"]
    assert ("ov-wide", 30, 60, 1080, 1920) in fake.calls, "the middle of its span, its whole length, the design canvas"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    assert len(json.dumps(out)) <= 300


def test_look_measures_at_most_12_overlays_and_says_how_many_it_left(tmp_path):
    path, _ = _project(tmp_path, base=((0, 20),), overlays=[{"id": f"ov-{k}", "start": k, "end": k + 1} for k in range(15)])
    fake = _fake_measure({})
    out = look.run(str(path), measure_fn=fake)
    assert out == {"ok": True, "looked": out["looked"], "measured": 12, "unmeasured": 3}
    assert len(fake.calls) == 12


def test_look_answers_a_measure_that_failed_as_an_issue(tmp_path):
    path, _ = _project(tmp_path, overlays=[{"id": "ov-bad", "start": 1, "end": 3}])
    out = look.run(str(path), measure_fn=lambda *a: (None, "overlay_eval_failed"))
    assert out["issues"] == ["2.0s ov-bad: overlay_eval_failed"]


def test_look_image_adds_one_sheet_of_the_times_and_detail_adds_the_facts(tmp_path):
    path, _ = _project(tmp_path, overlays=[{"id": "ov-a", "start": 1, "end": 3}])
    sheets = []

    def fake_sheet(project_path, project_dir, times):
        sheets.append(times)
        return os.path.join(project_dir, "render", "samples", "look-x.png"), None
    out = look.run(str(path), image=True, detail=True, measure_fn=_fake_measure({}), sheet_fn=fake_sheet)
    assert len(sheets) == 1 and sheets[0] == out["times"]
    assert out["sheet"].endswith("look-x.png") and out["items"] == ["ov-a"] and isinstance(out["wallMs"], int)


def test_look_at_given_times(tmp_path):
    path, _ = _project(tmp_path, overlays=[{"id": "ov-a", "start": 1, "end": 3}])
    out = look.run(str(path), at=[2.0, 7.5], detail=True, measure_fn=_fake_measure({}))
    assert out["times"] == [2.0, 7.5] and out["looked"] == 2


# ── a real measure ────────────────────────────────────────────────────────────────────────────────────────────────

def _has_render():
    return shutil.which("node") is not None and (MONTAJ_ROOT / "montaj_assets" / "render" / "node_modules" / "puppeteer").exists()


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
def test_look_through_the_real_measurer_finds_the_text_off_the_frame(tmp_path):
    wide = ("export default function O() { return <div style={{position: 'absolute', left: 700, top: 500, "
            "fontSize: 120, whiteSpace: 'nowrap', color: 'white'}}>A headline far too long</div> }")
    fits = ("export default function O() { return <div style={{position: 'absolute', left: 200, top: 700, "
            "fontSize: 60, color: 'white'}}>Fits</div> }")
    path, _ = _project(tmp_path, overlays=[{"id": "ov-wide", "start": 1, "end": 3, "jsx": wide},
                                           {"id": "ov-fits", "start": 4, "end": 6, "jsx": fits}])
    out = look.run(str(path), detail=True)
    assert out["measured"] == 2, out
    wide_issues = [i for i in out["issues"] if "ov-wide" in i]
    assert any("runs off the frame" in i for i in wide_issues), out
    assert not any("ov-fits" in i for i in out["issues"]), out


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
