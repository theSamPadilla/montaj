"""render-zip zips only the slides named by render/manifest.json when there is one.

serve renders without --clean, so a carousel cut from 5 slides to 3 leaves
slide_04.png and slide_05.png on disk; the ZIP must not ship them.
"""
import io
import json
import zipfile

import pytest
from starlette.testclient import TestClient

from serve.common import get_project_dir
from serve.server import app

PID = "render-zip-proj"


@pytest.fixture
def project(tmp_path):
    project_dir = tmp_path / PID
    (project_dir / "render").mkdir(parents=True)
    client = TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        yield client, project_dir / "render"
    finally:
        app.dependency_overrides.pop(get_project_dir, None)


def _write(render, names, manifest=None):
    for n in names:
        (render / n).write_bytes(b"png-" + n.encode())
    if manifest is not None:
        (render / "manifest.json").write_text(json.dumps(manifest))


def _slides(*files):
    return {"slides": [{"index": i + 1, "file": f} for i, f in enumerate(files)]}


def _names(resp):
    assert resp.status_code == 200, resp.text
    return zipfile.ZipFile(io.BytesIO(resp.content)).namelist()


def test_manifest_excludes_stale_slides(project):
    client, render = project
    all_files = [f"slide_0{i}.png" for i in range(1, 6)]
    _write(render, all_files, _slides(*all_files[:3]))
    assert _names(client.get(f"/api/projects/{PID}/render-zip")) == all_files[:3]


def test_manifest_order_is_respected(project):
    client, render = project
    _write(render, ["slide_01.png", "slide_02.png", "slide_03.png"],
           _slides("slide_03.png", "slide_01.png", "slide_02.png"))
    assert _names(client.get(f"/api/projects/{PID}/render-zip")) == [
        "slide_03.png", "slide_01.png", "slide_02.png"]


@pytest.mark.parametrize("bad", ["../x.png", "sub/slide_01.png", "/etc/passwd", "..", "a\\b.png"])
def test_unsafe_manifest_entry_is_refused(project, bad):
    client, render = project
    _write(render, ["slide_01.png"], _slides("slide_01.png", bad))
    (render.parent / "x.png").write_bytes(b"outside")
    resp = client.get(f"/api/projects/{PID}/render-zip")
    assert resp.status_code == 400, resp.text


def test_missing_manifest_file_is_404(project):
    client, render = project
    _write(render, ["slide_01.png"], _slides("slide_01.png", "slide_02.png"))
    assert client.get(f"/api/projects/{PID}/render-zip").status_code == 404


def test_no_manifest_zips_everything_as_before(project):
    client, render = project
    _write(render, ["slide_01.png", "slide_02.png", "extra.txt"])
    assert _names(client.get(f"/api/projects/{PID}/render-zip")) == [
        "extra.txt", "slide_01.png", "slide_02.png"]
