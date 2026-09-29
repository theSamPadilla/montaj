"""Tests for the `app/` scope in resolve_step and get_workflow's annotation.

A host app (montaj-app) serves its own skills; workflows name them with
`uses: app/<name>`. Nothing for these lives on disk in montaj OSS — the
agent loads the skill remotely via get_skill. resolve_step must resolve
`app/` refs to a skill kind without touching the filesystem, and
serve/routes/workflows.py's _annotate_steps must tag them `kind: "skill"`
with the full `app/<name>` as `skill` (not just the bare name, since there
is no skill_path to read a bare name off of).
"""
import sys
from pathlib import Path

import pytest
from starlette.testclient import TestClient

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))

import resolve_workflow as rw

from serve.server import app

client = TestClient(app, raise_server_exceptions=False)


def _steps_by_id(body):
    return {s["id"]: s for s in body["steps"]}


# ---------------------------------------------------------------------------
# resolve_workflow — resolve_step()
# ---------------------------------------------------------------------------

def test_resolve_step_app_scope(tmp_path):
    ref = rw.resolve_step("app/point-cloud-character", str(tmp_path))
    assert ref == {
        "kind": "skill",
        "skill": "app/point-cloud-character",
        "remote": True,
    }


# ---------------------------------------------------------------------------
# serve/routes/workflows.py — _annotate_steps() via GET /api/workflows/{name}
# ---------------------------------------------------------------------------

def test_annotate_steps_app_scope(tmp_path, monkeypatch):
    user_dir = tmp_path / ".montaj" / "workflows"
    user_dir.mkdir(parents=True)
    (user_dir / "app-scoped.json").write_text(
        '{"name": "app-scoped", "steps": ['
        '{"id": "x", "uses": "app/x", "version": 2}'
        ']}'
    )
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)

    resp = client.get("/api/workflows/app-scoped")
    assert resp.status_code == 200
    steps = _steps_by_id(resp.json())

    entry = steps["x"]
    assert entry["kind"] == "skill"
    assert entry["skill"] == "app/x"
    assert entry["version"] == 2


def test_annotate_steps_existing_montaj_skill_unaffected():
    """An existing montaj/ skill-backed step still annotates with its bare
    name (e.g. "select-takes"), not the full `uses` — the app/ scope is
    additive, not a change to the montaj/ or user/ resolution paths."""
    resp = client.get("/api/workflows/overlays")
    assert resp.status_code == 200
    steps = _steps_by_id(resp.json())

    select_takes = steps["select-takes"]
    assert select_takes["kind"] == "skill"
    assert select_takes["skill"] == "select-takes"
