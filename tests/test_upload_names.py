"""Uploads are saved under their own name only (serve/routes/files.py upload_name, save_upload).

The multipart filename used to be joined as given, so `../` or an absolute name created files anywhere.
Now only its last component is used; empty, `.`, `..` and a NUL are refused; and the file is created new,
never over an existing file or through a link."""
import json
import os

import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient

from serve.routes.files import upload_name
from serve.server import app


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


@pytest.mark.parametrize("raw, name", [
    ("clip.mp4", "clip.mp4"),
    ("../x.txt", "x.txt"),
    ("../../../../etc/x.txt", "x.txt"),
    ("/abs/x.txt", "x.txt"),
    ("a\\..\\b\\x.txt", "x.txt"),
    ("", "upload"),
    (None, "upload"),
])
def test_upload_name_keeps_only_the_last_component(raw, name):
    assert upload_name(raw) == name


@pytest.mark.parametrize("raw", [".", "..", "dir/", "a/..", "x\x00y.txt", "/"])
def test_upload_name_refuses_names_that_name_no_file(raw):
    with pytest.raises(HTTPException) as e:
        upload_name(raw)
    assert e.value.status_code == 400 and e.value.detail["error"] == "invalid_filename"


@pytest.mark.parametrize("raw", ["../escaped.txt", "{tmp}/escaped.txt", "sub/../../escaped.txt"])
def test_workspace_upload_stays_in_uploads(client, ws, tmp_path, raw):
    # The absolute case names this test's own folder, so a regression never writes anywhere shared.
    r = client.post("/api/upload", files={"file": (raw.format(tmp=tmp_path), b"data")})
    assert r.status_code == 200, r.text
    path = r.json()["path"]
    assert os.path.dirname(path) == str(ws / "_uploads") and os.path.basename(path).startswith("escaped")
    assert not (tmp_path / "escaped.txt").exists() and not (ws / "escaped.txt").exists()


@pytest.mark.parametrize("raw", [".", ".."])
def test_workspace_upload_refuses_dot_names(client, raw):
    r = client.post("/api/upload", files={"file": (raw, b"data")})
    assert r.status_code == 400 and r.json()["detail"]["error"] == "invalid_filename"


def test_project_upload_stays_in_the_project(client, ws):
    proj = ws / "proj"
    proj.mkdir()
    (proj / "project.json").write_text(json.dumps({"id": "p-up"}))
    r = client.post("/api/projects/p-up/upload-asset", files={"file": ("../../outside.png", b"img")})
    assert r.status_code == 200, r.text
    assert r.json()["path"] == str(proj / "outside.png")
    assert not (ws / "outside.png").exists() and not (ws.parent / "outside.png").exists()
    r = client.post("/api/projects/p-up/upload-asset", files={"file": ("..", b"img")})
    assert r.status_code == 400


def test_an_upload_never_writes_through_a_link_or_over_a_file(client, ws, tmp_path):
    uploads = ws / "_uploads"
    uploads.mkdir()
    target = tmp_path / "target.txt"
    target.write_text("KEEP")
    (uploads / "a.txt").symlink_to(target)
    (uploads / "b.txt").symlink_to(tmp_path / "made-through-link.txt")   # dangling
    for name in ("a.txt", "b.txt"):
        r = client.post("/api/upload", files={"file": (name, b"new")})
        assert r.status_code == 200, r.text
        assert os.path.basename(r.json()["path"]) == name.replace(".txt", "_1.txt")
    assert target.read_text() == "KEEP"
    assert not (tmp_path / "made-through-link.txt").exists()
