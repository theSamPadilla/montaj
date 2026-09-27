"""Tests for GET /api/workflows/{name} annotating steps with kind (FQ1.1 T6).

overlays.json references `montaj/select-takes` and `montaj/overlay`, which
are skill-backed steps (skills/select-takes/SKILL.md, skills/overlay/SKILL.md)
with no run_step executable — list_steps doesn't show them, so an agent
reading the raw workflow JSON couldn't tell them apart from a real step name.
get_workflow now runs each entry's `uses` through
engine.resolve_workflow.resolve_step and tags it `kind: "step" | "skill" |
"unknown"` (plus `skill: <name>` when kind is "skill"), additive over the
existing fields.
"""
from starlette.testclient import TestClient

from serve.server import app

client = TestClient(app, raise_server_exceptions=False)


def _steps_by_id(body):
    return {s["id"]: s for s in body["steps"]}


def test_get_workflow_marks_skill_backed_entries():
    """overlays.json's select-takes and overlay entries are skill-backed.

    Step id "overlays" has `uses: "montaj/overlay"` (singular) — the `skill`
    name comes from the resolved skill_path, not the step id, so it must be
    "overlay", not "overlays".
    """
    resp = client.get("/api/workflows/overlays")
    assert resp.status_code == 200
    steps = _steps_by_id(resp.json())

    select_takes = steps["select-takes"]
    assert select_takes["kind"] == "skill"
    assert select_takes["skill"] == "select-takes"

    overlay_entry = steps["overlays"]
    assert overlay_entry["uses"] == "montaj/overlay"
    assert overlay_entry["kind"] == "skill"
    assert overlay_entry["skill"] == "overlay"


def test_get_workflow_marks_real_step_entries():
    """overlays.json's probe entry (montaj/probe) is a real step, not a skill."""
    resp = client.get("/api/workflows/overlays")
    assert resp.status_code == 200
    steps = _steps_by_id(resp.json())

    entry = steps["probe"]
    assert entry["kind"] == "step"
    assert "skill" not in entry


def test_get_workflow_preserves_existing_fields():
    """Annotation is additive — every original field on the entry survives."""
    resp = client.get("/api/workflows/overlays")
    assert resp.status_code == 200
    steps = _steps_by_id(resp.json())

    silence = steps["silence"]
    assert silence["uses"] == "montaj/waveform_trim"
    assert silence["foreach"] == "clips"
    assert silence["params"] == {"threshold": "-30", "min-silence": 0.3}
    assert silence["kind"] == "step"

    select_takes = steps["select-takes"]
    assert select_takes["uses"] == "montaj/select-takes"
    assert select_takes["needs"] == ["transcribe"]


def test_get_workflow_unknown_scope_prefix_does_not_500(tmp_path, monkeypatch):
    """A malformed `uses` (bad scope prefix) is tagged kind=unknown, not a 500.

    resolve_step fails such a `uses` via lib.common.fail(), which calls
    sys.exit(1) — a SystemExit, not an Exception — so this also pins that the
    route catches SystemExit rather than letting it tear down the request.
    """
    user_dir = tmp_path / ".montaj" / "workflows"
    user_dir.mkdir(parents=True)
    (user_dir / "broken.json").write_text(
        '{"name": "broken", "steps": ['
        '{"id": "bad", "uses": "not-a-real-scope/whatever"}'
        ']}'
    )
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)

    resp = client.get("/api/workflows/broken")
    assert resp.status_code == 200
    steps = _steps_by_id(resp.json())
    assert steps["bad"]["kind"] == "unknown"
    assert "skill" not in steps["bad"]


def test_get_workflow_still_404s_for_missing_workflow():
    resp = client.get("/api/workflows/does-not-exist-xyz")
    assert resp.status_code == 404
