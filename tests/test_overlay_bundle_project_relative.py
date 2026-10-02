"""GET /api/overlays/bundle with a project-relative `path` plus `project`.

render.js and sample-frame.js resolve a relative overlay `src` against the
project's directory (render.js resolveProjectPaths, sample-frame.js
resolveProjectPaths), so the editor preview must too. The Hub template recipe
tells agents to write `overlays/<name>.jsx`. node is REQUIRED, as in
test_overlay_bundle_route.py.
"""
import json
import shutil
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve.server import app


@pytest.fixture(autouse=True)
def _require_node():
    assert shutil.which("node"), "node is required for the overlay bundle route tests"


@pytest.fixture
def ws(tmp_path, monkeypatch):
    base = tmp_path.resolve()
    home = base / "home"
    ws = base / "ws"
    home.mkdir(); ws.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    return ws


def _project(ws: Path, pid: str, folder: str) -> Path:
    d = ws / folder
    (d / "overlays").mkdir(parents=True)
    (d / "project.json").write_text(json.dumps({"id": pid, "status": "draft"}))
    (d / "overlays" / "spot.jsx").write_text(
        f"export default function Spot() {{ return <div>{pid}</div> }}\n"
    )
    return d


def _get(**params):
    return TestClient(app).get("/api/overlays/bundle", params=params)


def test_relative_path_with_project_resolves_against_the_project_dir(ws):
    d = _project(ws, "p-one", "one")
    _project(ws, "p-two", "two")
    r = _get(path="overlays/spot.jsx", project="p-one")
    assert r.status_code == 200, r.text
    assert r.json()["inputs"] == [str(d / "overlays" / "spot.jsx")]
    assert "p-one" in r.json()["code"] and "p-two" not in r.json()["code"]


def test_dot_slash_relative_path_resolves(ws):
    d = _project(ws, "p-one", "one")
    r = _get(path="./overlays/spot.jsx", project="p-one")
    assert r.status_code == 200, r.text
    assert r.json()["inputs"] == [str(d / "overlays" / "spot.jsx")]


def test_relative_path_without_project_is_still_400(ws):
    _project(ws, "p-one", "one")
    r = _get(path="overlays/spot.jsx")
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "bad_request"


def test_escape_out_of_the_project_is_403_even_inside_the_workspace(ws):
    # The target exists and is inside the workspace, so the allowed-roots check
    # alone would serve it: only the project escape check refuses it.
    _project(ws, "p-one", "one")
    _project(ws, "p-two", "two")
    r = _get(path="../two/overlays/spot.jsx", project="p-one")
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["error"] == "forbidden"
    assert "p-two" not in r.text


def test_unknown_project_is_404(ws):
    _project(ws, "p-one", "one")
    r = _get(path="overlays/spot.jsx", project="nope")
    assert r.status_code == 404


def test_absolute_path_ignores_project(ws):
    d = _project(ws, "p-one", "one")
    _project(ws, "p-two", "two")
    r = _get(path=str(d / "overlays" / "spot.jsx"), project="p-two")
    assert r.status_code == 200, r.text
    assert r.json()["inputs"] == [str(d / "overlays" / "spot.jsx")]
