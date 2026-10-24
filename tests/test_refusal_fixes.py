"""§558: a refused call says why and what to do. Each of these serve refusals reaches an AI agent through the app
and now names its next step (a tool, or the change to make), so the agent never has to load a skill to recover.
The error codes are unchanged."""
import os
import sys

import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient

import serve.out_guard as guard
from serve.server import app

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from caption_translation import TranslationError, apply_translation  # noqa: E402


@pytest.fixture()
def ws(tmp_path, monkeypatch):
    w = tmp_path / "ws"
    w.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(w))
    return w


@pytest.fixture()
def client(ws):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def detail(r, status, error):
    assert r.status_code == status, r.text
    d = r.json()["detail"]
    assert d["error"] == error
    return d["message"]


def test_an_unknown_project_names_list_projects(client):
    assert "list_projects" in detail(client.get("/api/projects/no-such-project"), 404, "not_found")


def test_an_unknown_job_says_to_check_for_its_output(client):
    assert "check for the step's output" in detail(client.get("/api/steps/jobs/no-such-job"), 404, "job_not_found")


def test_a_bad_workflow_name_names_list_workflows(client):
    assert "list_workflows" in detail(client.get("/api/workflows/bad.name"), 400, "invalid_name")


def test_a_write_outside_the_workspace_says_where_to_write(client, tmp_path):
    out = tmp_path / "elsewhere"
    out.mkdir()
    said = detail(client.post("/api/files", json={"path": str(out / "x.jsx"), "content": "x"}), 403, "forbidden")
    assert said.startswith("Path is outside the workspace root.")
    assert "Write inside a project's folder" in said


def test_a_write_onto_a_folder_says_it_is_not_a_file(client, ws):
    (ws / "folder").mkdir()
    said = detail(client.post("/api/files", json={"path": str(ws / "folder"), "content": "x"}), 403, "forbidden")
    assert "Choose another file path" in said


def test_a_git_write_says_to_choose_a_path_outside_it(client, ws):
    (ws / "proj" / ".git").mkdir(parents=True)
    said = detail(client.post("/api/files", json={"path": str(ws / "proj" / ".git" / "config"), "content": "x"}),
                  400, "project_file_protected")
    assert "Choose a path outside it" in said


def test_a_step_write_outside_says_what_to_do(ws, tmp_path):
    schema = {"name": "plain", "params": [{"name": "out", "type": "path"}]}
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    with pytest.raises(HTTPException) as e:
        guard.check_step_out("plain", schema, {"out": str(elsewhere / "x.mp4")}, native=True)
    assert e.value.detail["error"] == "out_not_allowed"
    assert "leave 'out' out" in e.value.detail["message"]
    (ws / "proj" / ".git").mkdir(parents=True)
    with pytest.raises(HTTPException) as e:
        guard.check_step_out("plain", schema, {"out": str(ws / "proj" / ".git" / "x")}, native=True)
    assert "Choose a path outside it" in e.value.detail["message"]


def W(word, start, end):
    return {"word": word, "start": start, "end": end}


@pytest.mark.parametrize("phrase,fix", [
    ({"source": "!!", "text": "x"}, "Set its source"),
    ({"source": "So", "text": "  "}, "Give it its text"),
])
def test_a_bad_phrase_says_what_to_set(phrase, fix):
    words = [W("So", 0.0, 0.5)]
    caps = {"style": "pop", "segments": [{"text": "So", "start": 0.0, "end": 0.5, "words": words}]}
    with pytest.raises(TranslationError) as e:
        apply_translation(caps, "es", [phrase])
    assert e.value.code == "bad_phrases"
    assert fix in str(e.value)
