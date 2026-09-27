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
