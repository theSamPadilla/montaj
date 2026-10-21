"""POST /api/files hardening (H3/H5) and the removed GET /api/pick-files (CRITICAL).

POST /api/files used to check only the parent folder, so a symlink planted at the destination redirected
the write outside the workspace. It now requires the final file's real path to stay inside the workspace
and opens with O_NOFOLLOW (a symlink at the target is refused, not written through), and refuses a `.git`
component. GET /api/pick-files built an AppleScript from the caller's prompt (command execution) and is gone.
"""
import pytest
from starlette.testclient import TestClient

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


def test_a_normal_write_is_allowed(client, ws):
    target = ws / "sub" / "overlay.jsx"
    r = client.post("/api/files", json={"path": str(target), "content": "export default 1"})
    assert r.status_code == 200, r.text
    assert target.read_text() == "export default 1"


def test_overwriting_an_existing_file_is_allowed(client, ws):
    target = ws / "spec.json"
    target.write_text("old")
    r = client.post("/api/files", json={"path": str(target), "content": "new"})
    assert r.status_code == 200, r.text
    assert target.read_text() == "new"


def test_a_symlink_at_the_target_pointing_outside_is_refused(client, ws, tmp_path):
    outside = tmp_path / "secret.txt"
    outside.write_text("KEEP")
    link = ws / "overlay.jsx"
    link.symlink_to(outside)
    r = client.post("/api/files", json={"path": str(link), "content": "pwned"})
    assert r.status_code == 403, r.text
    assert outside.read_text() == "KEEP"  # never written through the link


def test_a_symlinked_parent_escaping_the_workspace_is_refused(client, ws, tmp_path):
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    (ws / "link").symlink_to(outside_dir, target_is_directory=True)
    r = client.post("/api/files", json={"path": str(ws / "link" / "x.jsx"), "content": "x"})
    assert r.status_code == 403, r.text
    assert not (outside_dir / "x.jsx").exists()


def test_a_git_component_is_refused(client, ws):
    (ws / "proj" / ".git" / "hooks").mkdir(parents=True)
    r = client.post("/api/files", json={"path": str(ws / "proj" / ".git" / "hooks" / "pre-commit"),
                                        "content": "#!/bin/sh\n"})
    assert r.status_code == 400 and r.json()["detail"]["error"] == "project_file_protected"
    assert not (ws / "proj" / ".git" / "hooks" / "pre-commit").exists()
    # a link with an innocent name that resolves into .git is caught too
    (ws / "proj" / "sneaky").symlink_to(ws / "proj" / ".git", target_is_directory=True)
    r = client.post("/api/files", json={"path": str(ws / "proj" / "sneaky" / "config"), "content": "x"})
    assert r.status_code == 400


def test_pick_files_route_is_gone(client):
    # No picker handler remains, so the request falls through to the SPA fallback (HTML), never the
    # picker's JSON {"paths": [...]}. (serve returns index.html for any unmatched GET, so this is not a 404.)
    for url in ("/api/pick-files", "/api/pick-files?prompt=x", "/api/pick-files?prompt=$(whoami)"):
        r = client.get(url)
        assert "text/html" in r.headers.get("content-type", ""), (url, r.text[:80])
        assert "paths" not in r.text


def test_pick_files_handler_is_removed_from_the_module():
    import serve.routes.files as files_mod
    assert not hasattr(files_mod, "pick_files")
    assert not hasattr(files_mod, "_pick_files_sync")
