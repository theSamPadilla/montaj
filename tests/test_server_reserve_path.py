"""Tests for POST /api/projects/{id}/reserve-path in serve/server.py."""
import json
import os
import tempfile
from pathlib import Path

from starlette.testclient import TestClient

from serve.server import app

client = TestClient(app, raise_server_exceptions=False)


def _create_project(workspace: Path) -> str:
    """Create a minimal project dir and return its id."""
    project_id = "test-reserve-path-id"
    project_dir = workspace / "2026-04-20-test"
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "project.json").write_text(json.dumps({
        "version": "1",
        "id": project_id,
        "status": "pending",
        "name": "test",
        "workflow": "clean_cut",
        "editingPrompt": "test",
        "settings": {"resolution": [1920, 1080], "fps": 30},
        "tracks": [[]],
        "assets": [],
        "audio": {},
    }))
    return project_id


def test_reserve_path_valid(tmp_path, monkeypatch):
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setattr("serve.server.resolve_workspace", lambda: tmp_path)
    pid = _create_project(tmp_path)

    resp = client.post(f"/api/projects/{pid}/reserve-path", json={
        "prefix": "imageref_ref1",
        "extension": "png",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert "path" in data
    assert data["path"].endswith(".png")
    assert "imageref_ref1_" in data["path"]


def test_reserve_path_unknown_project(tmp_path, monkeypatch):
    monkeypatch.setattr("serve.server.resolve_workspace", lambda: tmp_path)
    resp = client.post("/api/projects/nonexistent/reserve-path", json={
        "prefix": "foo",
        "extension": "png",
    })
    assert resp.status_code == 404
    assert "project_not_found" in resp.json()["detail"]["error"]


def test_reserve_path_bad_prefix(tmp_path, monkeypatch):
    monkeypatch.setattr("serve.server.resolve_workspace", lambda: tmp_path)
    pid = _create_project(tmp_path)

    resp = client.post(f"/api/projects/{pid}/reserve-path", json={
        "prefix": "bad prefix!",
        "extension": "png",
    })
    assert resp.status_code == 400
    assert "invalid_prefix" in resp.json()["detail"]["error"]


def test_reserve_path_bad_extension(tmp_path, monkeypatch):
    monkeypatch.setattr("serve.server.resolve_workspace", lambda: tmp_path)
    pid = _create_project(tmp_path)

    resp = client.post(f"/api/projects/{pid}/reserve-path", json={
        "prefix": "foo",
        "extension": "../etc",
    })
    assert resp.status_code == 400
    assert "invalid_extension" in resp.json()["detail"]["error"]


def test_reserve_path_empty_extension(tmp_path, monkeypatch):
    monkeypatch.setattr("serve.server.resolve_workspace", lambda: tmp_path)
    pid = _create_project(tmp_path)

    resp = client.post(f"/api/projects/{pid}/reserve-path", json={
        "prefix": "foo",
        "extension": "",
    })
    assert resp.status_code == 400


def test_reserve_path_distinct_paths(tmp_path, monkeypatch):
    monkeypatch.setattr("serve.server.resolve_workspace", lambda: tmp_path)
    pid = _create_project(tmp_path)

    resp1 = client.post(f"/api/projects/{pid}/reserve-path", json={"prefix": "img", "extension": "png"})
    resp2 = client.post(f"/api/projects/{pid}/reserve-path", json={"prefix": "img", "extension": "png"})
    assert resp1.status_code == 200
    assert resp2.status_code == 200
    assert resp1.json()["path"] != resp2.json()["path"]
