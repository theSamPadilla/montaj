"""A step's `project` param takes the project id or its folder, not only the
path of its project.json (sample_frame, contact_sheet).

Every other project tool an agent sees takes the project id, so an agent
passes the id to sample_frame too, and then the folder. Both used to fail
inside the step. serve now resolves the value to the project's project.json
before the step runs (`resolve_project_param`); the full path still passes
through unchanged. `projectId` and `project_id` are accepted as aliases, and
so is sample_frame's own declared `input` (its schema's input block says
"type": "project").
"""
import json
import textwrap
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient

import serve.routes.steps as steps_mod
from serve.routes.steps import resolve_project_param
from serve.server import app
from tests.conftest import STEPS_DIR


def _real_schema(rel):
    return json.loads((Path(STEPS_DIR) / rel).read_text())


SAMPLE_FRAME = _real_schema("render/sample_frame.json")
CONTACT_SHEET = _real_schema("render/contact_sheet.json")


@pytest.fixture()
def project(tmp_path, monkeypatch):
    """A workspace holding one project, nested a level down like the app's."""
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-02-demo"
    pdir.mkdir(parents=True)
    pid = str(uuid.uuid4())
    (pdir / "project.json").write_text(json.dumps({"id": pid, "tracks": []}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    return pid, pdir


@pytest.mark.parametrize("schema", [SAMPLE_FRAME, CONTACT_SHEET], ids=["sample_frame", "contact_sheet"])
def test_project_id_resolves_to_its_project_json(project, schema):
    pid, pdir = project
    body = {"project": pid, "at": 1.0}
    resolve_project_param(schema, body)
    assert body["project"] == str(pdir / "project.json")


def test_project_folder_resolves_to_its_project_json(project):
    _, pdir = project
    for folder in (str(pdir), str(pdir) + "/"):
        body = {"project": folder, "at": 1.0}
        resolve_project_param(SAMPLE_FRAME, body)
        assert body["project"] == str(pdir / "project.json")


def test_full_project_json_path_passes_through_unchanged(project):
    _, pdir = project
    body = {"project": str(pdir / "project.json"), "at": 1.0}
    resolve_project_param(SAMPLE_FRAME, body)
    assert body == {"project": str(pdir / "project.json"), "at": 1.0}


def test_a_missing_absolute_path_is_left_for_the_step_to_report(tmp_path, project):
    body = {"project": str(tmp_path / "nope" / "project.json"), "at": 1.0}
    resolve_project_param(SAMPLE_FRAME, body)
    assert body["project"] == str(tmp_path / "nope" / "project.json")


@pytest.mark.parametrize("alias", ["projectId", "project_id"])
def test_project_id_aliases_become_project(project, alias):
    pid, pdir = project
    body = {alias: pid, "at": 2.5}
    resolve_project_param(SAMPLE_FRAME, body)
    assert body == {"project": str(pdir / "project.json"), "at": 2.5}


def test_sample_frame_declared_input_becomes_project(project):
    pid, pdir = project
    body = {"input": pid, "at": 0.5}
    resolve_project_param(SAMPLE_FRAME, body)
    assert body == {"project": str(pdir / "project.json"), "at": 0.5}


def test_canonical_project_wins_over_an_alias(project):
    pid, pdir = project
    body = {"project": pid, "projectId": "something-else", "at": 1.0}
    resolve_project_param(SAMPLE_FRAME, body)
    assert body["project"] == str(pdir / "project.json")


def test_unknown_project_id_is_a_422_naming_the_field_with_an_example(project):
    body = {"project": "not-a-project", "at": 1.0}
    with pytest.raises(HTTPException) as exc:
        resolve_project_param(SAMPLE_FRAME, body)
    assert exc.value.status_code == 422
    assert exc.value.detail["error"] == "invalid_params"
    message = exc.value.detail["message"]
    assert '"project"' in message
    assert "not-a-project" in message
    assert 'Example: {"project": ' in message
    assert "—" not in message


def test_missing_project_is_left_to_validate_params(project):
    body = {"at": 1.0}
    resolve_project_param(SAMPLE_FRAME, body)
    assert body == {"at": 1.0}


@pytest.mark.parametrize("rel", ["edit/jump_cut.json", "media/probe.json"])
def test_steps_without_a_project_path_param_are_untouched(project, rel):
    pid, _ = project
    body = {"input": pid, "projectId": pid}
    resolve_project_param(_real_schema(rel), body)
    assert body == {"input": pid, "projectId": pid}


# -- through the real route: the step sees --project <path> ------------------

ECHO_SRC = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, sys
    print(json.dumps({"argv": sys.argv[1:]}))
""")


@pytest.fixture()
def echo_step(tmp_path, monkeypatch):
    py_path = tmp_path / "sample_frame.py"
    py_path.write_text(ECHO_SRC)
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {"sample_frame": (SAMPLE_FRAME, py_path)})
    return py_path


def test_route_runs_the_step_with_the_resolved_path(project, echo_step):
    pid, pdir = project
    with TestClient(app, raise_server_exceptions=False) as client:
        resp = client.post("/api/steps/sample_frame", json={"project": pid, "at": 3})
    assert resp.status_code == 200, resp.text
    argv = resp.json()["argv"]
    assert argv[argv.index("--project") + 1] == str(pdir / "project.json")


def test_route_unknown_project_is_422(project, echo_step):
    with TestClient(app, raise_server_exceptions=False) as client:
        resp = client.post("/api/steps/sample_frame", json={"project": "nope", "at": 3})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["error"] == "invalid_params"
