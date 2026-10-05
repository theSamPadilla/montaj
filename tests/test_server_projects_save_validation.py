"""save_project validates `type: "overlay"` items (FQ1.1 T9).

The shape lives in lib/overlay_validation.py and is derived from its consumers
(render.js, bundle.js, the editor's VisualItem). A wrong item used to save and
render without complaint; now a save carrying `tracks` gets a 400 naming each
bad field, and nothing is written.
"""
import json
import re
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from lib.overlay_validation import overlay_item_errors
from lib.project_tracks import normalize_tracks
from serve.common import get_project_dir
from serve.server import app

PID = "save-validation-proj"
REPO = Path(__file__).resolve().parent.parent


class _StubBroadcaster:
    def publish(self, *a, **k):
        pass


def _overlay(**over):
    item = {
        "id": "ov-0",
        "type": "overlay",
        "src": "/abs/overlays/hook.jsx",
        "props": {"text": "Hook"},
        "start": 0.0,
        "end": 3.0,
    }
    item.update(over)
    return item


def _tracks(*overlay_items, video=None):
    return [
        {"id": "trk-0", "items": [video] if video else []},
        {"id": "trk-1", "items": list(overlay_items)},
    ]


@pytest.fixture
def project(tmp_path):
    project_dir = tmp_path / PID
    project_dir.mkdir()
    original = {"id": PID, "name": "n", "status": "pending", "tracks": _tracks()}
    (project_dir / "project.json").write_text(json.dumps(original))
    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        yield client, project_dir
    finally:
        app.dependency_overrides.pop(get_project_dir, None)


def _put(client, tracks, **extra):
    return client.put(f"/api/projects/{PID}", json={"id": PID, "tracks": tracks, **extra})


def _on_disk(project_dir):
    return json.loads((project_dir / "project.json").read_text())


def test_valid_overlay_saves(project):
    client, project_dir = project
    item = _overlay(googleFonts=["Anton", "Syne:wght@800"], opaque=True, scale=1, offsetX=0)
    resp = _put(client, _tracks(item))
    assert resp.status_code == 200, resp.text
    assert _on_disk(project_dir)["tracks"][1]["items"][0] == item


def test_bad_type_gives_400_with_field_message_and_writes_nothing(project):
    client, project_dir = project
    before = (project_dir / "project.json").read_text()
    resp = _put(client, _tracks(_overlay(googleFonts=[{"family": "Anton"}])))
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["error"] == "invalid_overlay_items"
    assert detail["errors"] == [
        "tracks[1].items[0].googleFonts must be an array of strings, "
        "e.g. [\"Anton\", \"Syne:wght@800\"] (item id 'ov-0')"
    ]
    # The MCP clients surface only `message`, so the field errors must be in it.
    assert "tracks[1].items[0].googleFonts" in detail["message"]
    assert "—" not in detail["message"]
    assert (project_dir / "project.json").read_text() == before


def test_bare_string_google_fonts_rejected(project):
    client, _ = project
    resp = _put(client, _tracks(_overlay(googleFonts="Anton")))
    assert resp.status_code == 400
    assert "googleFonts must be an array of strings" in resp.json()["detail"]["message"]


@pytest.mark.parametrize("field", ["src", "start", "end"])
def test_missing_required_field_gives_400(project, field):
    client, project_dir = project
    before = (project_dir / "project.json").read_text()
    item = _overlay()
    del item[field]
    resp = _put(client, _tracks(item))
    assert resp.status_code == 400
    errors = resp.json()["detail"]["errors"]
    assert len(errors) == 1
    assert errors[0].startswith(f"tracks[1].items[0].{field} is required")
    assert (project_dir / "project.json").read_text() == before


def test_every_bad_field_is_reported(project):
    client, _ = project
    bad = _overlay(start="0", props=["x"], opaque="yes", scale=True, keyframes={})
    del bad["src"]
    resp = _put(client, _tracks(_overlay(id="ok"), bad))
    assert resp.status_code == 400
    fields = {e.split(" ")[0] for e in resp.json()["detail"]["errors"]}
    assert fields == {
        "tracks[1].items[1].src",
        "tracks[1].items[1].start",
        "tracks[1].items[1].props",
        "tracks[1].items[1].opaque",
        "tracks[1].items[1].scale",
        "tracks[1].items[1].keyframes",
    }


def test_unknown_extra_fields_and_nulls_accepted(project):
    client, _ = project
    item = _overlay(someFutureField={"a": 1}, label="x", props=None, googleFonts=None, rotation=None)
    del item["id"]  # render.js tolerates an id-less item; so do the docs
    resp = _put(client, _tracks(item))
    assert resp.status_code == 200, resp.text


def test_non_overlay_items_unaffected(project):
    client, _ = project
    video = {"id": "v", "type": "video", "src": "/a.mp4", "start": 0, "end": 2, "googleFonts": "not checked"}
    image = {"id": "i", "type": "image", "start": "whatever"}
    resp = _put(client, [{"id": "trk-0", "items": [video]}, {"id": "trk-1", "items": [image]}])
    assert resp.status_code == 200, resp.text


def test_legacy_list_tracks_are_validated_after_normalizing(project):
    client, _ = project
    resp = _put(client, [[], [_overlay(end="3")]])
    assert resp.status_code == 400
    assert resp.json()["detail"]["errors"][0].startswith("tracks[1].items[0].end must be a number")


def test_save_without_tracks_does_not_revalidate_disk(project):
    client, project_dir = project
    on_disk = _on_disk(project_dir)
    on_disk["tracks"] = _tracks(_overlay(googleFonts="Anton"))
    (project_dir / "project.json").write_text(json.dumps(on_disk))
    resp = client.put(f"/api/projects/{PID}", json={"id": PID, "name": "renamed"})
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Only NEW or CHANGED overlay items are checked (FQ1.1 final review). An item
# already broken on disk — from before this validator existed, or from an
# earlier save — must not block every later save of the project that leaves
# that item alone.
# ---------------------------------------------------------------------------

def _seed_disk(project_dir, tracks):
    """Write `tracks` straight to project.json, bypassing the PUT route (and
    therefore its validation) — simulates an item that reached disk before
    this validator existed, or from an earlier, since-fixed save."""
    on_disk = _on_disk(project_dir)
    on_disk["tracks"] = tracks
    (project_dir / "project.json").write_text(json.dumps(on_disk))


def test_unchanged_bad_item_plus_new_valid_item_saves(project):
    client, project_dir = project
    bad = _overlay(googleFonts="Anton")
    _seed_disk(project_dir, _tracks(bad))
    resp = _put(client, _tracks(bad, _overlay(id="ov-1")))
    assert resp.status_code == 200, resp.text


def test_only_start_changed_on_bad_item_saves(project):
    client, project_dir = project
    bad = _overlay(googleFonts="Anton")
    _seed_disk(project_dir, _tracks(bad))
    moved = {**bad, "start": 1.0}
    resp = _put(client, _tracks(moved))
    assert resp.status_code == 200, resp.text


def test_google_fonts_changed_to_another_bad_value_gives_400(project):
    client, project_dir = project
    bad = _overlay(googleFonts="Anton")
    _seed_disk(project_dir, _tracks(bad))
    changed = {**bad, "googleFonts": "Impact"}
    resp = _put(client, _tracks(changed))
    assert resp.status_code == 400
    assert "googleFonts" in resp.json()["detail"]["message"]


def test_new_malformed_item_beside_unchanged_bad_item_names_only_the_new_one(project):
    client, project_dir = project
    bad = _overlay(googleFonts="Anton")
    _seed_disk(project_dir, _tracks(bad))
    new_bad = _overlay(id="ov-1", googleFonts="Impact")
    resp = _put(client, _tracks(bad, new_bad))
    assert resp.status_code == 400
    errors = resp.json()["detail"]["errors"]
    assert len(errors) == 1
    assert "ov-1" in errors[0]
    assert "ov-0" not in errors[0]


def test_unchanged_id_less_bad_item_saves(project):
    client, project_dir = project
    bad = _overlay(googleFonts="Anton")
    del bad["id"]
    _seed_disk(project_dir, _tracks(dict(bad)))
    resp = _put(client, _tracks(dict(bad)))
    assert resp.status_code == 200, resp.text


def test_two_identical_bad_items_on_disk_put_with_three_gives_400(project):
    client, project_dir = project
    bad = _overlay(googleFonts="Anton")
    del bad["id"]
    _seed_disk(project_dir, _tracks(dict(bad), dict(bad)))
    resp = _put(client, _tracks(dict(bad), dict(bad), dict(bad)))
    assert resp.status_code == 400
    assert len(resp.json()["detail"]["errors"]) == 1


# ---------------------------------------------------------------------------
# The validator must not reject anything the repo itself ships as a project or
# documents as an overlay item. A failure here means the schema is wrong.
# ---------------------------------------------------------------------------

def _fixture_projects():
    paths = sorted(
        list((REPO / "montaj_assets" / "timeline-core" / "fixtures").glob("*.json"))
        + list((REPO / "tests" / "fixtures").rglob("*.json"))
    )
    out = []
    for p in paths:
        data = json.loads(p.read_text())
        if isinstance(data, dict) and "tracks" in data:
            out.append((p, data))
    return out


def _documented_overlay_items():
    """Every `type: "overlay"` dict inside a parseable ```json block in docs/ and
    skills/. Carousel elements (which carry an `overlay` key, not a `src`) are a
    different shape that never lives in tracks, so they are skipped."""
    found = []

    def walk(node, source):
        if isinstance(node, dict):
            if node.get("type") == "overlay" and "overlay" not in node:
                found.append((source, node))
            for v in node.values():
                walk(v, source)
        elif isinstance(node, list):
            for v in node:
                walk(v, source)

    for md in sorted(list((REPO / "docs").rglob("*.md")) + list((REPO / "skills").rglob("*.md"))):
        for block in re.findall(r"```json\n(.*?)```", md.read_text(), re.S):
            try:
                walk(json.loads(block), md)
            except json.JSONDecodeError:
                continue  # annotated/commented examples are not strict JSON
    return found


def test_all_repo_fixture_projects_are_valid():
    projects = _fixture_projects()
    assert len(projects) >= 16
    bad = {str(p): overlay_item_errors(normalize_tracks(d)) for p, d in projects}
    assert {k: v for k, v in bad.items() if v} == {}


def test_all_documented_overlay_items_are_valid():
    items = _documented_overlay_items()
    assert len(items) >= 10
    bad = []
    for source, item in items:
        project = {"tracks": [{"id": "t", "items": [item]}]}
        bad += [f"{source}: {e}" for e in overlay_item_errors(project)]
    assert bad == []


# ---------------------------------------------------------------------------
# Project notes (PL39): a top-level `notes` field survives save and get, and a
# later PUT that omits it keeps it (serve does a shallow merge).
# ---------------------------------------------------------------------------

def test_notes_round_trip_and_survive_a_put_that_omits_them(project):
    client, project_dir = project
    notes = [{"id": "n1", "t": 1.0, "text": "x"}]
    resp = client.put(f"/api/projects/{PID}", json={"id": PID, "notes": notes})
    assert resp.status_code == 200, resp.text
    assert _on_disk(project_dir)["notes"] == notes
    got = client.get(f"/api/projects/{PID}")
    assert got.status_code == 200, got.text
    assert got.json()["notes"] == notes
    resp = client.put(f"/api/projects/{PID}", json={"id": PID, "name": "renamed"})
    assert resp.status_code == 200, resp.text
    assert _on_disk(project_dir)["notes"] == notes


# ---------------------------------------------------------------------------
# Deleting the last marker (PL43): the editor sends `markers: null` (an omitted
# key would survive serve's shallow merge). serve drops the key rather than
# storing the null, so get returns no markers.
# ---------------------------------------------------------------------------

def test_markers_null_clears_the_stored_markers(project):
    client, project_dir = project
    markers = [{"id": "m1", "t": 1.0, "label": "1"}, {"id": "m2", "t": 2.0, "label": "2"}]
    resp = client.put(f"/api/projects/{PID}", json={"id": PID, "markers": markers})
    assert resp.status_code == 200, resp.text
    assert _on_disk(project_dir)["markers"] == markers
    resp = client.put(f"/api/projects/{PID}", json={"id": PID, "markers": None})
    assert resp.status_code == 200, resp.text
    assert "markers" not in resp.json()
    assert "markers" not in _on_disk(project_dir)
    got = client.get(f"/api/projects/{PID}")
    assert got.status_code == 200, got.text
    assert not got.json().get("markers")


def test_markers_survive_a_put_that_omits_them(project):
    client, project_dir = project
    markers = [{"id": "m1", "t": 1.0, "label": "1"}]
    client.put(f"/api/projects/{PID}", json={"id": PID, "markers": markers})
    resp = client.put(f"/api/projects/{PID}", json={"id": PID, "name": "renamed"})
    assert resp.status_code == 200, resp.text
    assert _on_disk(project_dir)["markers"] == markers


def test_notes_null_clears_the_stored_notes(project):
    client, project_dir = project
    notes = [{"id": "n1", "t": 1.0, "text": "a"}, {"id": "n2", "t": 2.0, "text": "b"}]
    resp = client.put(f"/api/projects/{PID}", json={"id": PID, "notes": notes})
    assert resp.status_code == 200, resp.text
    assert _on_disk(project_dir)["notes"] == notes
    resp = client.put(f"/api/projects/{PID}", json={"id": PID, "notes": None})
    assert resp.status_code == 200, resp.text
    assert "notes" not in resp.json()
    assert "notes" not in _on_disk(project_dir)
    got = client.get(f"/api/projects/{PID}")
    assert got.status_code == 200, got.text
    assert not got.json().get("notes")


# ---------------------------------------------------------------------------
# Slide notes (PL70): a carousel's `notes` hold notes pinned to a slide (and
# optionally a point on it). serve stores them as they come, like time notes.
# ---------------------------------------------------------------------------

def test_carousel_slide_notes_round_trip_and_null_still_clears(project):
    client, project_dir = project
    carousel = {
        "id": PID,
        "projectType": "carousel",
        "status": "draft",
        "carousel": {"aspect": "square"},
        "settings": {"resolution": [1080, 1080]},
        "slides": [{"id": "s-1", "base_color": "#ffffff", "elements": []}],
    }
    (project_dir / "project.json").write_text(json.dumps(carousel))
    notes = [
        {"id": "n1", "slideId": "s-1", "x": 0.4, "y": 0.25, "text": "logo too small"},
        {"id": "n2", "slideId": "s-1", "text": "whole slide", "done": True},
    ]
    resp = client.put(f"/api/projects/{PID}", json={"id": PID, "notes": notes})
    assert resp.status_code == 200, resp.text
    assert _on_disk(project_dir)["notes"] == notes
    got = client.get(f"/api/projects/{PID}")
    assert got.status_code == 200, got.text
    assert got.json()["notes"] == notes
    assert got.json()["slides"] == carousel["slides"]
    resp = client.put(f"/api/projects/{PID}", json={"id": PID, "name": "renamed"})
    assert resp.status_code == 200, resp.text
    assert _on_disk(project_dir)["notes"] == notes
    resp = client.put(f"/api/projects/{PID}", json={"id": PID, "notes": None})
    assert resp.status_code == 200, resp.text
    assert "notes" not in resp.json()
    assert "notes" not in _on_disk(project_dir)
