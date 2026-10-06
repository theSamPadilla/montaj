"""Server-Timing on project creation and save: durations only, never names, paths or ids."""
import re

import pytest
from starlette.testclient import TestClient

from serve.server import app
from serve.sse import SSEBroadcaster
import serve.routes.projects as projects_mod

client = TestClient(app, raise_server_exceptions=False)
NAME = "Zebra-Distinctive-Name-7731"


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setattr("serve.routes.projects.resolve_workspace", lambda: tmp_path)
    if not hasattr(app.state, "broadcaster"):
        app.state.broadcaster = SSEBroadcaster()
    return tmp_path


def _create(project_path="teamZ/abc"):
    return client.post("/api/run", json={
        "prompt": "test", "workflow": "blank", "clips": [],
        "projectPath": project_path, "name": NAME,
    })


def _phases(header):
    out = {}
    for part in header.split(","):
        m = re.fullmatch(r"\s*([a-z_]+);dur=(\d+)\s*", part)
        assert m, f"bad Server-Timing part {part!r}"
        out[m.group(1)] = int(m.group(2))
    return out


def test_run_answers_server_timing(workspace):
    r = _create()
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == NAME and body["id"]
    phases = _phases(r.headers["server-timing"])
    for k in ("spawn", "init", "startup", "git_init"):
        assert k in phases, phases


def test_header_has_no_path_id_or_name(workspace):
    r = _create()
    h = r.headers["server-timing"]
    assert NAME not in h and r.json()["id"] not in h
    assert "teamZ" not in h and str(workspace) not in h and "/" not in h


def test_failing_init_error_has_no_timing_line(workspace):
    assert _create().status_code == 201
    r = _create()
    assert r.status_code == 400
    assert "MONTAJ_TIMING" not in r.text


def test_malformed_timing_line_ignored(workspace, monkeypatch):
    real = projects_mod.run_subprocess

    async def corrupt(*a, **k):
        out, err, rc = await real(*a, **k)
        err = "".join("MONTAJ_TIMING {not json\n" if l.startswith("MONTAJ_TIMING") else l
                      for l in err.splitlines(keepends=True))
        return out, err, rc

    monkeypatch.setattr(projects_mod, "run_subprocess", corrupt)
    r = _create()
    assert r.status_code == 201, r.text
    phases = _phases(r.headers["server-timing"])
    assert set(phases) == {"spawn"}


def test_split_init_timing_unit():
    err, t = projects_mod._split_init_timing(
        'warn\nMONTAJ_TIMING {"total": 12, "phases": {"git_init": 5, "x": 9}}\n')
    assert err == "warn\n" and t == {"total": 12, "phases": {"git_init": 5}}
    assert projects_mod._split_init_timing("MONTAJ_TIMING [1]\n") == ("", None)


def test_save_answers_save_duration_only(workspace):
    body = _create().json()
    body["status"] = "draft"
    r = client.put(f"/api/projects/{body['id']}", json=body)
    assert r.status_code == 200, r.text
    h = r.headers["server-timing"]
    assert set(_phases(h)) == {"save"}
    assert NAME not in h
