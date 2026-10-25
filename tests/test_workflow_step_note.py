"""A workflow step may carry an optional one-line `note` (at most 160 characters).

validate_workflow refuses a long or multi-line one, resolve_workflow keeps it on
each resolved step, and GET /api/workflows/{name} passes it through.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from starlette.testclient import TestClient

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))

import validate as v

from serve.server import app

client = TestClient(app, raise_server_exceptions=False)


def _workflow(note):
    step = {"id": "x", "uses": "montaj/probe"}
    if note is not None:
        step["note"] = note
    return {"name": "noted", "description": "d", "steps": [step]}


def _write(tmp_path, data):
    path = tmp_path / "noted.json"
    path.write_text(json.dumps(data))
    return str(path)


def test_validate_accepts_a_note(tmp_path):
    assert v.validate_workflow(_write(tmp_path, _workflow("One per clip")))["valid"] is True


def test_validate_accepts_exactly_160_characters(tmp_path):
    assert v.validate_workflow(_write(tmp_path, _workflow("a" * 160)))["valid"] is True


@pytest.mark.parametrize("note", ["a" * 161, "two\nlines", "cr\rhere", "", 5, ["x"]])
def test_validate_refuses_a_bad_note(tmp_path, note):
    with pytest.raises(SystemExit):
        v.validate_workflow(_write(tmp_path, _workflow(note)))


def test_resolve_workflow_keeps_the_note(tmp_path):
    path = _write(tmp_path, _workflow("Only if asked"))
    out = subprocess.run(
        [sys.executable, str(REPO_ROOT / "engine" / "resolve_workflow.py"), "--path", path],
        capture_output=True, text=True, check=True,
    )
    steps = json.loads(out.stdout)
    assert steps[0]["note"] == "Only if asked"


def test_resolve_workflow_omits_the_note_when_absent(tmp_path):
    path = _write(tmp_path, _workflow(None))
    out = subprocess.run(
        [sys.executable, str(REPO_ROOT / "engine" / "resolve_workflow.py"), "--path", path],
        capture_output=True, text=True, check=True,
    )
    assert "note" not in json.loads(out.stdout)[0]


def test_get_workflow_passes_the_note_through(tmp_path, monkeypatch):
    user_dir = tmp_path / ".montaj" / "workflows"
    user_dir.mkdir(parents=True)
    (user_dir / "noted.json").write_text(json.dumps(_workflow("Review the plan, then apply it")))
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    body = client.get("/api/workflows/noted").json()
    assert body["steps"][0]["note"] == "Review the plan, then apply it"
