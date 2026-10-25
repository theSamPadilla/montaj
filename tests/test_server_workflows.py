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

    apply = steps["cut_apply"]
    assert apply["uses"] == "montaj/cut"
    assert apply["needs"] == ["select-takes"]
    assert apply["params"] == {"plan": "cut-plan.md"}
    assert apply["kind"] == "step"
    assert steps["probe"]["foreach"] == "clips"

    select_takes = steps["select-takes"]
    assert select_takes["uses"] == "montaj/select-takes"
    assert select_takes["needs"] == ["cut_plan"]


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


def test_get_workflow_non_dict_step_entry_does_not_500(tmp_path, monkeypatch):
    """A hand-edited workflow can have anything in `steps` — a bare string
    entry used to reach `entry.get("uses", "")`, an AttributeError that took
    the whole request down with a 500 instead of just leaving that one entry
    alone. The malformed entry is skipped; every well-formed sibling is still
    annotated normally."""
    user_dir = tmp_path / ".montaj" / "workflows"
    user_dir.mkdir(parents=True)
    (user_dir / "malformed.json").write_text(
        '{"name": "malformed", "steps": ['
        '"not-a-step-object",'
        '{"id": "ok", "uses": "montaj/probe"}'
        ']}'
    )
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)

    resp = client.get("/api/workflows/malformed")
    assert resp.status_code == 200
    body = resp.json()
    assert body["steps"][0] == "not-a-step-object"
    assert body["steps"][1]["kind"] == "step"


def test_get_workflow_still_404s_for_missing_workflow():
    resp = client.get("/api/workflows/does-not-exist-xyz")
    assert resp.status_code == 404


# ── H7: a workflow name must be a single plain segment ────────────────────────

import pytest  # noqa: E402
from lib.workflow import is_valid_workflow_name, resolve_workflow_path  # noqa: E402


def test_workflow_name_validation_rejects_traversal():
    assert is_valid_workflow_name("my-flow_2")
    for bad in ["../x", "a/b", "a\\b", ".", "", "x.json", "a b", "x" * 65, "..\\..\\win"]:
        assert not is_valid_workflow_name(bad), bad


def test_resolve_workflow_path_rejects_a_traversing_name():
    # Even if such a file existed, a traversing name never resolves to it.
    assert resolve_workflow_path("../../etc/passwd") is None
    assert resolve_workflow_path("..\\..\\x") is None


@pytest.mark.parametrize("bad", ["evil.x", "x" * 65, "a~b"])
def test_put_workflow_rejects_an_invalid_name(bad):
    resp = client.put(f"/api/workflows/{bad}", json={"steps": []})
    assert resp.status_code == 400 and resp.json()["detail"]["error"] == "invalid_name", (bad, resp.status_code)


@pytest.mark.parametrize("bad", ["evil.x", "a~b"])
def test_get_workflow_rejects_an_invalid_name(bad):
    resp = client.get(f"/api/workflows/{bad}")
    assert resp.status_code == 400 and resp.json()["detail"]["error"] == "invalid_name", (bad, resp.status_code)


def test_put_then_get_a_valid_workflow_name(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    resp = client.put("/api/workflows/my-flow", json={"steps": [], "project_type": "editing"})
    assert resp.status_code == 200, resp.text
    assert (tmp_path / ".montaj" / "workflows" / "my-flow.json").is_file()
    got = client.get("/api/workflows/my-flow")
    assert got.status_code == 200 and got.json()["project_type"] == "editing"
