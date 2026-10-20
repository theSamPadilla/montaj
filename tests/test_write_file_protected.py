"""POST /api/files never writes a project's own project.json, its temp file or its lock
file (§477): those go through save_project, which takes the lock and compares revisions.
Always, guard on or off."""
import json
import os

import pytest
from starlette.testclient import TestClient

from serve import save_guard
from serve.server import app


@pytest.fixture(params=["off", "on"])
def ws(tmp_path, monkeypatch, request):
    saved = dict(save_guard._state)
    if request.param == "on":
        monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    else:
        monkeypatch.delenv("MONTAJ_ENGINE_GUARD", raising=False)
    monkeypatch.delenv("MONTAJ_SHELL_SECRET_STDIN", raising=False)
    save_guard._inject_secret_for_tests("5e" * 32)
    save_guard.startup()
    ws = (tmp_path / "ws").resolve()
    (ws / "proj").mkdir(parents=True)
    (ws / "proj" / "project.json").write_text('{"id": "proj"}')
    monkeypatch.setattr("serve.routes.files.resolve_workspace", lambda: ws)
    yield ws
    save_guard._state.clear()
    save_guard._state.update(saved)


def _write(path, content="{}"):
    return TestClient(app, raise_server_exceptions=False).post(
        "/api/files", json={"path": str(path), "content": content})


@pytest.mark.parametrize("name", [
    "project.json", "Project.JSON", "project.json.", "project.json. . ", "project.json ",
    "project.json.tmp", "PROJECT.JSON.TMP", ".project.lock", ".Project.Lock.",
])
def test_protected_names_are_refused_and_nothing_is_written(ws, name):
    target = ws / "proj" / name
    before = {p.name: p.read_bytes() for p in (ws / "proj").iterdir()}
    resp = _write(target, '{"id": "evil"}')
    print("WIRE write_file:", resp.text)
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["error"] == "project_file_protected"
    assert "save_project" in detail["message"]
    assert {p.name: p.read_bytes() for p in (ws / "proj").iterdir()} == before


def test_a_new_project_json_in_a_new_folder_is_refused_too(ws):
    resp = _write(ws / "fresh" / "project.json")
    assert resp.status_code == 400
    assert not (ws / "fresh").exists()


def test_a_symlink_to_project_json_is_refused_by_its_resolved_path(ws):
    link = ws / "proj" / "notes.txt"
    os.symlink(ws / "proj" / "project.json", link)
    resp = _write(link, '{"id": "evil"}')
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "project_file_protected"
    assert json.loads((ws / "proj" / "project.json").read_text()) == {"id": "proj"}


def test_a_backslash_path_naming_project_json_is_refused(ws):
    resp = _write(str(ws / "proj") + "\\project.json")
    assert resp.status_code == 400


@pytest.mark.parametrize("name", ["project.json.bak", "my-project.json", "project.jsonx", "overlay.json"])
def test_other_names_still_write(ws, name):
    resp = _write(ws / "proj" / name, "x")
    assert resp.status_code == 200, resp.text
    assert (ws / "proj" / name).read_text() == "x"
