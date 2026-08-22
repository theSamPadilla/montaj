"""The edit steps (montage / jump_cut / cross_cut) rewrite ONLY tracks[0].

Before tracks became objects these steps did `project["tracks"] = [tracks0]`,
which silently destroyed every overlay track. They now replace track 0's items
via `replace_track_items` and leave every other track — and its id / volume /
muted / enabled — alone.

Overlay item TIMES are deliberately NOT rippled: an overlay keeps its original
timestamps even when the primary track is retimed underneath it. That is an
accepted outcome, pinned here so it can't be changed silently.

Every assertion about a surviving track looks the track up BY ID. An
index-based assertion would still pass under the parallel-array bug this whole
change exists to prevent.
"""
import copy
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

import steps.edit.montage as montage
import steps.edit.jump_cut as jump_cut
import steps.edit.cross_cut as cross_cut
from lib.project_tracks import track_items


def clip(cid, start, dur=4.0):
    return {
        "id": cid, "type": "video", "src": f"./{cid}.mp4",
        "start": start, "end": start + dur, "inPoint": 0.0, "outPoint": dur,
    }


def overlay_item(oid, start, end):
    return {"id": oid, "type": "overlay", "src": f"./{oid}.jsx", "start": start, "end": end}


# Two overlay tracks, every setting at a NON-default value — a step that rebuilt
# tracks from scratch could not accidentally reproduce these.
def overlay_tracks():
    return [
        {"id": "trk-ov", "items": [overlay_item("ovl-1", 0.0, 2.0)],
         "volume": 0.5, "muted": True, "enabled": False},
        {"id": "trk-captions", "items": [overlay_item("cap-1", 5.0, 7.5)],
         "volume": 0.25, "muted": True},
    ]


def object_shape_project():
    return {
        "id": "p1",
        "tracks": [
            {"id": "trk-0", "items": [clip("clip-a", 0.0), clip("clip-b", 4.0)]},
            *overlay_tracks(),
        ],
    }


def legacy_shape_project():
    """Legacy primary track (a bare list) alongside object-shape overlay tracks."""
    return {
        "id": "p1",
        "tracks": [
            [clip("clip-a", 0.0), clip("clip-b", 4.0)],
            *overlay_tracks(),
        ],
    }


def by_id(project, track_id):
    """The one track with this id — the assertion never trusts an index."""
    matches = [t for t in project["tracks"] if isinstance(t, dict) and t.get("id") == track_id]
    assert len(matches) == 1, f"expected exactly one track with id {track_id!r}, got {len(matches)}"
    return matches[0]


def run_step(module, argv, project, monkeypatch, tmp_path):
    """Drive a step's real main() — and therefore its real write path — against
    an in-memory project. Only find_project / save_project are stubbed, so the
    `project["tracks"] = replace_track_items(...)` line under test runs for real."""
    path = tmp_path / "project.json"
    saved = {}
    monkeypatch.setattr(module, "find_project", lambda pid: (path, project))
    monkeypatch.setattr(module, "save_project", lambda p, proj: saved.update(project=proj))
    monkeypatch.setattr(sys, "argv", argv)
    module.main()
    assert "project" in saved, "step did not save the project"
    return saved["project"]


STEPS = {
    "montage": (montage, ["montage.py", "--project-id", "p1",
                          "--clips", json.dumps(["clip-a", "clip-b"]),
                          "--beat-duration", "1.0"]),
    "jump_cut": (jump_cut, ["jump_cut.py", "--project-id", "p1",
                            "--clip-id", "clip-a",
                            "--cuts", json.dumps([[1.0, 2.0]])]),
    "cross_cut": (cross_cut, ["cross_cut.py", "--project-id", "p1",
                              "--clip-a", "clip-a", "--clip-b", "clip-b",
                              "--segment-duration", "1.5"]),
}
STEP_NAMES = sorted(STEPS)


# ── the behaviour change: overlay tracks are no longer destroyed ───────────────

@pytest.mark.parametrize("name", STEP_NAMES)
def test_overlay_tracks_survive_the_edit(name, monkeypatch, tmp_path, capsys):
    module, argv = STEPS[name]
    out = run_step(module, argv, object_shape_project(), monkeypatch, tmp_path)

    ids = [t["id"] for t in out["tracks"]]
    assert "trk-ov" in ids, f"{name} destroyed overlay track 'trk-ov'"
    assert "trk-captions" in ids, f"{name} destroyed overlay track 'trk-captions'"


@pytest.mark.parametrize("name", STEP_NAMES)
def test_overlay_track_keeps_its_id_and_settings(name, monkeypatch, tmp_path, capsys):
    module, argv = STEPS[name]
    out = run_step(module, argv, object_shape_project(), monkeypatch, tmp_path)

    ov = by_id(out, "trk-ov")
    assert ov["id"] == "trk-ov"
    assert ov["volume"] == 0.5
    assert ov["muted"] is True
    assert ov["enabled"] is False

    cap = by_id(out, "trk-captions")
    assert cap["volume"] == 0.25
    assert cap["muted"] is True
    assert "enabled" not in cap, "an absent setting must stay absent, not be defaulted in"


@pytest.mark.parametrize("name", STEP_NAMES)
def test_overlay_item_times_are_not_rippled(name, monkeypatch, tmp_path, capsys):
    """Deliberate, accepted outcome: overlays keep their original timestamps
    even though the primary track is retimed underneath them."""
    module, argv = STEPS[name]
    before = copy.deepcopy(object_shape_project())
    out = run_step(module, argv, object_shape_project(), monkeypatch, tmp_path)

    assert by_id(out, "trk-ov")["items"] == by_id(before, "trk-ov")["items"]
    assert by_id(out, "trk-captions")["items"] == by_id(before, "trk-captions")["items"]
    # spelled out, so a "helpful" ripple can't slip through a structural compare
    assert [(i["start"], i["end"]) for i in by_id(out, "trk-ov")["items"]] == [(0.0, 2.0)]
    assert [(i["start"], i["end"]) for i in by_id(out, "trk-captions")["items"]] == [(5.0, 7.5)]


@pytest.mark.parametrize("name", STEP_NAMES)
def test_primary_track_is_actually_rewritten(name, monkeypatch, tmp_path, capsys):
    """Proves the step really ran — otherwise the assertions above would pass
    against a project the step no-opped on."""
    module, argv = STEPS[name]
    out = run_step(module, argv, object_shape_project(), monkeypatch, tmp_path)

    primary = by_id(out, "trk-0")["items"]
    ids = [c["id"] for c in primary]
    assert ids, f"{name} emptied tracks[0]"
    assert ids != ["clip-a", "clip-b"], f"{name} left tracks[0] untouched"
    assert primary != object_shape_project()["tracks"][0]["items"]


def test_jump_cut_retimes_the_primary_track_but_not_the_overlay(monkeypatch, tmp_path, capsys):
    """The concrete case: cutting 1s out of clip-a ripples clip-b one second
    earlier, while the overlay spanning that cut stays exactly where it was."""
    module, argv = STEPS["jump_cut"]
    out = run_step(module, argv, object_shape_project(), monkeypatch, tmp_path)

    primary = {c["id"]: c for c in by_id(out, "trk-0")["items"]}
    assert primary["clip-b"]["start"] == 3.0, "clip-b should have rippled 4.0 → 3.0"
    assert by_id(out, "trk-ov")["items"][0]["start"] == 0.0
    assert by_id(out, "trk-ov")["items"][0]["end"] == 2.0


# ── shape tolerance ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", STEP_NAMES)
def test_overlay_tracks_survive_from_a_legacy_primary_track(name, monkeypatch, tmp_path, capsys):
    module, argv = STEPS[name]
    out = run_step(module, argv, legacy_shape_project(), monkeypatch, tmp_path)

    ov = by_id(out, "trk-ov")
    assert ov["volume"] == 0.5 and ov["muted"] is True and ov["enabled"] is False
    assert ov["items"] == [overlay_item("ovl-1", 0.0, 2.0)]
    assert by_id(out, "trk-captions")["volume"] == 0.25


@pytest.mark.parametrize("name", STEP_NAMES)
def test_output_is_written_in_the_object_shape(name, monkeypatch, tmp_path, capsys):
    module, argv = STEPS[name]
    out = run_step(module, argv, legacy_shape_project(), monkeypatch, tmp_path)

    for track in out["tracks"]:
        assert isinstance(track, dict)
        assert isinstance(track["id"], str) and track["id"]
        assert isinstance(track["items"], list)


@pytest.mark.parametrize("name", STEP_NAMES)
def test_track_order_is_preserved(name, monkeypatch, tmp_path, capsys):
    """Track order is render order — the primary stays at index 0 and the
    overlays keep their relative positions above it."""
    module, argv = STEPS[name]
    out = run_step(module, argv, object_shape_project(), monkeypatch, tmp_path)

    assert [t["id"] for t in out["tracks"]] == ["trk-0", "trk-ov", "trk-captions"]
