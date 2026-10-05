import json
import time

import pytest
from starlette.testclient import TestClient

from serve import context
from serve.server import app


@pytest.fixture(autouse=True)
def _clean():
    context.clear_all()
    yield
    context.clear_all()


def test_report_then_active_returns_it():
    context.report("p1", {"playheadSec": 12.4, "selectedIds": ["c3"]})
    active = context.active()
    assert active is not None
    project_id, state = active
    assert project_id == "p1"
    assert state.playhead_sec == 12.4
    assert state.selected_ids == ["c3"]


def test_active_is_none_before_anything_reports():
    assert context.active() is None


def test_most_recent_report_wins_across_projects():
    context.report("p1", {"playheadSec": 1.0, "selectedIds": []})
    context.report("p2", {"playheadSec": 2.0, "selectedIds": []})
    project_id, state = context.active()
    assert project_id == "p2"
    assert state.playhead_sec == 2.0
    # p1's own entry survives — only "which is active" changed.
    assert context.get("p1").playhead_sec == 1.0


def test_expired_context_is_not_active(monkeypatch):
    monkeypatch.setattr(context, "CONTEXT_TTL_SEC", 0.05)
    context.report("p1", {"playheadSec": 5.0, "selectedIds": []})
    time.sleep(0.08)
    assert context.active() is None


def test_age_ms_grows(monkeypatch):
    context.report("p1", {"playheadSec": 5.0, "selectedIds": []})
    first = context.get("p1").age_ms()
    time.sleep(0.02)
    assert context.get("p1").age_ms() > first


def test_report_coerces_and_defaults():
    context.report("p1", {})
    state = context.get("p1")
    assert state.playhead_sec == 0.0
    assert state.selected_ids == []
    assert state.selected_caption_id is None


def test_report_rejects_a_non_numeric_playhead():
    with pytest.raises(ValueError):
        context.report("p1", {"playheadSec": "twelve"})


def _project() -> dict:
    return {
        "id": "p1",
        "name": "robotics-ban",
        "settings": {"fps": 30},
        "tracks": [
            {"id": "t0", "items": [
                {"id": "c1", "type": "video", "src": "A.MOV",
                 "start": 0.0, "end": 10.0, "inPoint": 2.0, "outPoint": 12.0},
                {"id": "c2", "type": "video", "src": "B.MOV",
                 "start": 10.0, "end": 20.0, "inPoint": 0.0, "outPoint": 10.0},
            ]},
            {"id": "t1", "items": [
                {"id": "o1", "type": "overlay", "src": "title.jsx",
                 "start": 4.0, "end": 8.0},
            ]},
        ],
        "captions": {"style": "word-by-word", "segments": [
            {"id": "s1", "text": "hello there", "start": 0.0, "end": 5.0},
            {"id": "s2", "text": "the thing nobody tells you", "start": 5.0, "end": 9.0},
            {"id": "s3", "text": "is that it compounds", "start": 9.0, "end": 14.0},
        ]},
    }


def test_enrich_finds_the_clip_under_the_playhead():
    state = context.report("p1", {"playheadSec": 12.4, "selectedIds": []})
    out = context.enrich("p1", _project(), state)
    assert out["clipAtPlayhead"]["id"] == "c2"
    assert out["clipAtPlayhead"]["src"] == "B.MOV"
    # Source time = inPoint + (playhead - start).
    assert out["clipAtPlayhead"]["sourceTimeSec"] == pytest.approx(2.4)


def test_enrich_prefers_the_topmost_track_at_a_tie():
    """An overlay above a clip is what the eye is on, so it wins."""
    state = context.report("p1", {"playheadSec": 6.0, "selectedIds": []})
    out = context.enrich("p1", _project(), state)
    assert out["clipAtPlayhead"]["id"] == "o1"
    assert out["clipAtPlayhead"]["trackIdx"] == 1


def test_enrich_reports_frame_from_project_fps():
    state = context.report("p1", {"playheadSec": 12.4, "selectedIds": []})
    out = context.enrich("p1", _project(), state)
    assert out["playhead"]["frame"] == 372
    assert out["playhead"]["sec"] == 12.4


def test_enrich_reports_fps_beside_the_frame():
    state = context.report("p1", {"playheadSec": 1.0})
    out = context.enrich("p1", _project(), state)
    assert out["playhead"]["fps"] == 30.0


def test_enrich_carries_playing_when_the_editor_reports_it():
    state = context.report("p1", {"playheadSec": 3.0, "playing": True})
    assert context.enrich("p1", _project(), state)["playhead"]["playing"] is True
    state = context.report("p1", {"playheadSec": 3.0, "playing": False})
    assert context.enrich("p1", _project(), state)["playhead"]["playing"] is False


def test_enrich_omits_playing_from_an_editor_that_does_not_report_it():
    """An older editor sends no `playing`; claiming "paused" would be a guess."""
    state = context.report("p1", {"playheadSec": 3.0})
    assert "playing" not in context.enrich("p1", _project(), state)["playhead"]


def test_report_rejects_a_non_boolean_playing():
    with pytest.raises(ValueError):
        context.report("p1", {"playheadSec": 1.0, "playing": "yes"})


def test_enrich_includes_the_caption_window_around_the_playhead():
    state = context.report("p1", {"playheadSec": 6.0, "selectedIds": []})
    out = context.enrich("p1", _project(), state)
    text = out["transcriptAroundPlayhead"]["text"]
    assert "the thing nobody tells you" in text
    # One segment of lead-in and lead-out give the agent something to trim against.
    assert "hello there" in text and "is that it compounds" in text
    assert out["transcriptAroundPlayhead"]["segmentIdAtPlayhead"] == "s2"


def test_enrich_transcript_ignores_a_higher_caption_row_at_the_playhead():
    """A second row (e.g. a hand-authored title card) overlapping the
    playhead must not get quoted as "what is being said" just because it
    sits in a higher lane — only the lowest lane present is the transcript."""
    project = _project()
    project["captions"]["segments"] = project["captions"]["segments"] + [
        {"id": "t1", "text": "BREAKING NEWS", "start": 4.0, "end": 9.0, "lane": 1},
    ]
    state = context.report("p1", {"playheadSec": 6.0, "selectedIds": []})
    out = context.enrich("p1", project, state)
    text = out["transcriptAroundPlayhead"]["text"]
    assert "the thing nobody tells you" in text
    assert "BREAKING NEWS" not in text
    assert out["transcriptAroundPlayhead"]["segmentIdAtPlayhead"] == "s2"


def test_enrich_transcript_reads_the_lowest_lane_present_when_it_is_not_zero():
    """A project whose captions are ALL on a nonzero lane (hand-authored or
    agent-written, with no lane-0 segment at all) must still get quoted rather
    than going silent. This is the case "lowest lane present" exists for, as
    opposed to a literal `lane == 0` filter — a project like this has nothing
    at lane 0 for that filter to find."""
    project = _project()
    for seg in project["captions"]["segments"]:
        seg["lane"] = 2
    state = context.report("p1", {"playheadSec": 6.0, "selectedIds": []})
    out = context.enrich("p1", project, state)
    transcript = out["transcriptAroundPlayhead"]
    assert transcript is not None
    text = transcript["text"]
    assert "the thing nobody tells you" in text
    assert "hello there" in text and "is that it compounds" in text
    assert transcript["segmentIdAtPlayhead"] == "s2"


def test_enrich_transcript_is_byte_identical_for_a_single_row_project():
    """Every existing (lane-less) project must read exactly as it did before
    multi-row captions existed — the lowest-lane filter is a no-op when every
    segment is lane 0."""
    state = context.report("p1", {"playheadSec": 6.0, "selectedIds": []})
    out = context.enrich("p1", _project(), state)
    assert out["transcriptAroundPlayhead"] == {
        "text": "hello there the thing nobody tells you is that it compounds",
        "segmentIdAtPlayhead": "s2",
        "startSec": 0.0,
        "endSec": 14.0,
    }


def test_enrich_resolves_selection_to_real_items():
    state = context.report("p1", {"playheadSec": 1.0, "selectedIds": ["c2", "nope"]})
    out = context.enrich("p1", _project(), state)
    assert [s["id"] for s in out["selection"]] == ["c2"]
    assert out["selection"][0]["kind"] == "video"


def test_enrich_handles_a_playhead_in_a_gap():
    project = _project()
    project["tracks"][0]["items"] = [
        {"id": "c1", "type": "video", "src": "A.MOV", "start": 0.0, "end": 2.0},
    ]
    project["tracks"][1]["items"] = []
    state = context.report("p1", {"playheadSec": 50.0, "selectedIds": []})
    out = context.enrich("p1", project, state)
    assert out["clipAtPlayhead"] is None


def test_enrich_accepts_the_legacy_track_shape():
    project = _project()
    project["tracks"] = [[i for i in project["tracks"][0]["items"]], []]
    state = context.report("p1", {"playheadSec": 12.4, "selectedIds": []})
    out = context.enrich("p1", project, state)
    assert out["clipAtPlayhead"]["id"] == "c2"


def test_enrich_survives_a_project_with_no_captions():
    project = _project()
    del project["captions"]
    state = context.report("p1", {"playheadSec": 6.0, "selectedIds": []})
    out = context.enrich("p1", project, state)
    assert out["transcriptAroundPlayhead"] is None


def test_enrich_carries_freshness():
    state = context.report("p1", {"playheadSec": 6.0, "selectedIds": []})
    out = context.enrich("p1", _project(), state)
    assert out["ageMs"] >= 0
    assert out["project"]["id"] == "p1"
    assert out["project"]["name"] == "robotics-ban"


def test_enrich_includes_markers_sorted_by_time():
    project = _project()
    project["markers"] = [
        {"id": "m2", "t": 8.0, "label": "outro"},
        {"id": "m1", "t": 2.0, "label": "1"},
    ]
    state = context.report("p1", {"playheadSec": 5.0, "selectedIds": []})
    out = context.enrich("p1", project, state)
    assert out["markers"] == [
        {"id": "m1", "t": 2.0, "label": "1"},
        {"id": "m2", "t": 8.0, "label": "outro"},
    ]


def test_enrich_omits_markers_when_the_project_has_none():
    # An empty list would read to an agent as "the operator marked nothing",
    # which is a different claim from "this project has no markers at all".
    project = _project()
    state = context.report("p1", {"playheadSec": 0.0, "selectedIds": []})
    assert "markers" not in context.enrich("p1", project, state)


def test_enrich_skips_malformed_markers():
    project = _project()
    project["markers"] = [
        {"id": "ok", "t": 1.0, "label": "a"},
        {"id": "bad"},
        "nonsense",
        {"t": 2.0},
    ]
    state = context.report("p1", {"playheadSec": 0.0, "selectedIds": []})
    assert context.enrich("p1", project, state)["markers"] == [{"id": "ok", "t": 1.0, "label": "a"}]


def test_enrich_includes_open_notes_sorted_by_time():
    project = _project()
    project["notes"] = [
        {"id": "n2", "t": 8.0, "tEnd": 9.5, "text": "tighten"},
        {"id": "n1", "t": 2.0, "text": "caption covers face"},
        {"id": "n3", "t": 4.0, "text": "fixed already", "done": True},
    ]
    state = context.report("p1", {"playheadSec": 5.0, "selectedIds": []})
    out = context.enrich("p1", project, state)
    assert out["notes"] == [
        {"t": 2.0, "tEnd": None, "text": "caption covers face"},
        {"t": 8.0, "tEnd": 9.5, "text": "tighten"},
    ]


def test_enrich_omits_notes_when_none_are_open():
    project = _project()
    state = context.report("p1", {"playheadSec": 0.0, "selectedIds": []})
    assert "notes" not in context.enrich("p1", project, state)
    project["notes"] = [{"id": "n1", "t": 1.0, "text": "x", "done": True}]
    assert "notes" not in context.enrich("p1", project, state)


def test_enrich_skips_malformed_notes():
    project = _project()
    project["notes"] = [
        {"id": "ok", "t": 1.0, "text": "a"},
        {"id": "bad"},
        "nonsense",
        {"t": 2.0, "text": "no id"},
        {"id": "x", "t": "soon", "text": "b"},
    ]
    state = context.report("p1", {"playheadSec": 0.0, "selectedIds": []})
    assert context.enrich("p1", project, state)["notes"] == [{"t": 1.0, "tEnd": None, "text": "a"}]


def _carousel() -> dict:
    return {
        "id": "c1",
        "projectType": "carousel",
        "status": "draft",
        "carousel": {"aspect": "portrait"},
        "settings": {"resolution": [1080, 1350]},
        "slides": [
            {"id": "s-a", "base_color": "#ffffff", "elements": []},
            {"id": "s-b", "base_color": "#ffffff", "elements": []},
            {"id": "s-c", "base_color": "#ffffff", "elements": []},
        ],
    }


def test_enrich_lists_slide_notes_with_their_slide_position_and_point():
    project = _carousel()
    project["notes"] = [
        {"id": "n3", "slideId": "s-c", "x": 0.4, "y": 0.25, "text": "logo too small"},
        {"id": "n1", "slideId": "s-a", "text": "whole slide"},
        {"id": "n2", "slideId": "s-c", "text": "c whole"},
        {"id": "n4", "slideId": "s-b", "text": "addressed", "done": True},
    ]
    state = context.report("c1", {"playheadSec": 0.0, "selectedIds": []})
    assert context.enrich("c1", project, state)["notes"] == [
        {"id": "n1", "slide": 1, "slideId": "s-a", "text": "whole slide"},
        {"id": "n2", "slide": 3, "slideId": "s-c", "text": "c whole"},
        {"id": "n3", "slide": 3, "slideId": "s-c", "x": 0.4, "y": 0.25, "text": "logo too small"},
    ]


def test_enrich_lists_a_note_on_a_removed_slide_last_with_slide_none():
    project = _carousel()
    project["notes"] = [
        {"id": "gone", "slideId": "s-zzz", "x": 0.1, "y": 0.1, "text": "was on a deleted slide"},
        {"id": "kept", "slideId": "s-b", "text": "b"},
    ]
    state = context.report("c1", {"playheadSec": 0.0, "selectedIds": []})
    assert context.enrich("c1", project, state)["notes"] == [
        {"id": "kept", "slide": 2, "slideId": "s-b", "text": "b"},
        {"id": "gone", "slide": None, "slideId": "s-zzz", "x": 0.1, "y": 0.1, "text": "was on a deleted slide"},
    ]


def test_enrich_skips_malformed_slide_notes():
    project = _carousel()
    project["notes"] = [
        {"id": "ok", "slideId": "s-a", "text": "a"},
        {"id": "half", "slideId": "s-a", "x": 0.5, "text": "x without y"},
        {"id": "out", "slideId": "s-a", "x": 1.5, "y": 0.5, "text": "out of range"},
        {"id": "nos", "text": "no slide"},
        {"slideId": "s-a", "text": "no id"},
    ]
    state = context.report("c1", {"playheadSec": 0.0, "selectedIds": []})
    assert context.enrich("c1", project, state)["notes"] == [
        {"id": "ok", "slide": 1, "slideId": "s-a", "text": "a"},
    ]


def test_enrich_time_notes_are_unchanged_beside_slide_notes():
    # Time notes keep their exact PL39 shape and order, ahead of any slide notes.
    project = _project()
    project["slides"] = [{"id": "s-a", "base_color": "#fff", "elements": []}]
    project["notes"] = [
        {"id": "sn", "slideId": "s-a", "text": "slide"},
        {"id": "n2", "t": 8.0, "tEnd": 9.5, "text": "tighten"},
        {"id": "n1", "t": 2.0, "text": "caption covers face"},
    ]
    state = context.report("p1", {"playheadSec": 5.0, "selectedIds": []})
    assert context.enrich("p1", project, state)["notes"] == [
        {"t": 2.0, "tEnd": None, "text": "caption covers face"},
        {"t": 8.0, "tEnd": 9.5, "text": "tighten"},
        {"id": "sn", "slide": 1, "slideId": "s-a", "text": "slide"},
    ]


client = TestClient(app, raise_server_exceptions=False)


def _write_project(tmp_path, project: dict) -> str:
    d = tmp_path / project["id"]
    d.mkdir(parents=True, exist_ok=True)
    (d / "project.json").write_text(json.dumps(project))
    return project["id"]


def _use_workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setattr("serve.routes.projects.resolve_workspace", lambda: tmp_path)
    monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)


def test_post_context_accepts_a_report(tmp_path, monkeypatch):
    _use_workspace(tmp_path, monkeypatch)
    pid = _write_project(tmp_path, _project())
    resp = client.post(f"/api/projects/{pid}/context",
                       json={"playheadSec": 12.4, "selectedIds": ["c2"]})
    assert resp.status_code == 204
    assert context.get(pid).playhead_sec == 12.4


def test_post_context_rejects_a_bad_playhead(tmp_path, monkeypatch):
    _use_workspace(tmp_path, monkeypatch)
    pid = _write_project(tmp_path, _project())
    resp = client.post(f"/api/projects/{pid}/context", json={"playheadSec": "twelve"})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_context"


def test_post_context_rejects_a_bad_playing(tmp_path, monkeypatch):
    _use_workspace(tmp_path, monkeypatch)
    pid = _write_project(tmp_path, _project())
    resp = client.post(f"/api/projects/{pid}/context", json={"playheadSec": 1.0, "playing": 1})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_context"


def test_post_context_404s_for_an_unknown_project(tmp_path, monkeypatch):
    _use_workspace(tmp_path, monkeypatch)
    resp = client.post("/api/projects/nope/context", json={"playheadSec": 1.0})
    assert resp.status_code == 404


def test_get_context_returns_the_enriched_active_editor(tmp_path, monkeypatch):
    _use_workspace(tmp_path, monkeypatch)
    pid = _write_project(tmp_path, _project())
    client.post(f"/api/projects/{pid}/context",
                json={"playheadSec": 12.4, "selectedIds": ["c2"]})
    resp = client.get("/api/context")
    assert resp.status_code == 200
    body = resp.json()
    assert body["active"] is True
    assert body["project"]["id"] == pid
    assert body["clipAtPlayhead"]["id"] == "c2"


def test_get_context_reports_no_editor_rather_than_404(tmp_path, monkeypatch):
    _use_workspace(tmp_path, monkeypatch)
    resp = client.get("/api/context")
    assert resp.status_code == 200
    body = resp.json()
    assert body["active"] is False
    assert "reason" in body


def test_get_context_is_inactive_once_the_project_is_gone(tmp_path, monkeypatch):
    _use_workspace(tmp_path, monkeypatch)
    pid = _write_project(tmp_path, _project())
    client.post(f"/api/projects/{pid}/context", json={"playheadSec": 1.0})
    (tmp_path / pid / "project.json").unlink()
    resp = client.get("/api/context")
    assert resp.status_code == 200
    assert resp.json()["active"] is False


def test_context_route_never_writes_to_the_project(tmp_path, monkeypatch):
    """The whole design rests on this: context is ephemeral, never persisted."""
    _use_workspace(tmp_path, monkeypatch)
    pid = _write_project(tmp_path, _project())
    project_file = tmp_path / pid / "project.json"
    before = project_file.read_bytes()

    client.post(f"/api/projects/{pid}/context",
                json={"playheadSec": 12.4, "selectedIds": ["c2"]})
    client.get("/api/context")

    assert project_file.read_bytes() == before
    assert not (tmp_path / pid / "context.json").exists()


def test_enrich_treats_notes_null_as_none():
    # The editor's clear (PL43) is `notes: null` in a save body; a stray one must read as no notes.
    project = _project()
    project["notes"] = None
    state = context.report("p1", {"playheadSec": 0.0, "selectedIds": []})
    assert "notes" not in context.enrich("p1", project, state)
