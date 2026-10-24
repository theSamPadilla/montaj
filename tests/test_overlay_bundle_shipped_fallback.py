"""§569: GET /api/overlays/bundle for a shipped overlay named by another Mac's absolute path.

A carousel text overlay stores the jsxPath serve listed: the shipped static-text inside the maker's own runtime. On
another Mac that path is missing, and the editor preview (and the project thumbnail) bundle this runtime's copy of it
instead. Anything else is answered as before. node is required (as in test_overlay_bundle_route.py).
"""
import shutil
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from cli.deps import render_runtime_dir
from lib.shipped_template import resolve_template_path, shipped_template_key
from serve.server import app

OTHER_MAC = "/Users/someone-else-569/Library/Application Support/Montaj/runtime-home/.cache/montaj/render/templates/overlays/static-text/static-text.jsx"


@pytest.fixture(autouse=True)
def _require_node():
    assert shutil.which("node"), "node is required for the overlay bundle route tests"


@pytest.fixture
def env(tmp_path, monkeypatch):
    base = tmp_path.resolve()
    (base / "home").mkdir()
    (base / "ws").mkdir()
    monkeypatch.setenv("HOME", str(base / "home"))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(base / "ws"))
    return base


def _get(path):
    return TestClient(app).get("/api/overlays/bundle", params={"path": path})


def test_another_macs_static_text_bundles_this_runtimes_copy(env):
    assert not Path(OTHER_MAC).exists()
    shipped = (Path(render_runtime_dir()) / "templates" / "overlays" / "static-text" / "static-text.jsx").resolve()
    assert shipped.is_file()
    r = _get(OTHER_MAC)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["code"]
    assert str(shipped) in body["inputs"]


def test_a_windows_spelled_path_resolves_too(env):
    # Made on Windows, opened here (and the other way round): not absolute to this platform's Path, so the fallback must
    # run before the relative-path rule, which would answer 400 without a project
    win = "C:\\Users\\Someone\\AppData\\Roaming\\Montaj\\runtime-home\\.cache\\montaj\\render\\templates\\overlays\\static-text\\static-text.jsx"
    r = _get(win)
    assert r.status_code == 200, r.text
    assert r.json()["code"]


def test_a_relative_path_is_never_taken_for_a_shipped_one(env):
    r = _get("templates/overlays/static-text/static-text.jsx")
    assert r.status_code == 400, r.text


def test_a_missing_path_of_another_shape_is_still_not_found(env):
    for path in (
        "/Users/x/render/templates/overlays/no-such/no-such.jsx",
        "/Users/x/render/templates/overlays/static-text/other.jsx",
        "/Users/x/.montaj/overlays/static-text/static-text.jsx",
        "/Users/x/render/templates/overlays/../../../etc/static-text/static-text.jsx",
    ):
        r = _get(path)
        assert r.status_code == 404, (path, r.text)


def test_key_and_resolve_match_the_render_side(tmp_path):
    win = "C:\\Users\\B\\AppData\\Roaming\\Montaj\\runtime-home\\.cache\\montaj\\render\\templates\\overlays\\static-text\\static-text.jsx"
    assert shipped_template_key(OTHER_MAC) == "templates/overlays/static-text/static-text.jsx"
    assert shipped_template_key(win) == shipped_template_key(OTHER_MAC)
    assert shipped_template_key("/x/templates/overlays/lyric-phrase.jsx") == "templates/overlays/lyric-phrase.jsx"
    assert shipped_template_key("/x/.montaj/overlays/static-text/static-text.jsx") is None
    assert shipped_template_key("/x/templates/overlays/static-text/other.jsx") is None
    assert shipped_template_key("/x/templates/overlays/../static-text/static-text.jsx") is None
    rt = tmp_path / "render"
    (rt / "templates" / "overlays" / "static-text").mkdir(parents=True)
    (rt / "templates" / "overlays" / "static-text" / "static-text.jsx").write_text("export default () => null\n")
    assert resolve_template_path(OTHER_MAC, rt) == rt / "templates" / "overlays" / "static-text" / "static-text.jsx"
    mine = tmp_path / "mine" / "templates" / "overlays" / "static-text" / "static-text.jsx"
    mine.parent.mkdir(parents=True)
    mine.write_text("export default () => 'mine'\n")
    assert resolve_template_path(str(mine), rt) == mine
    assert resolve_template_path("/Users/x/templates/overlays/no-such/no-such.jsx", rt) is None
