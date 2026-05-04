"""Tests for /api/profiles/{name}/assets* + project include-asset endpoint.

Pattern: monkeypatch HOME so Path.home() / ".montaj" / "profiles" / ... lands
under tmp_path. Mirrors test_server_workspace.py's HOME-patching style.
"""
import json
import os
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve.server import app
from serve.sse import SSEBroadcaster
from serve.routes import profile_assets as pa


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("MONTAJ_WORKSPACE_DIR", raising=False)
    # TestClient doesn't run lifespan() unless used as a context manager,
    # so endpoints that publish to app.state.broadcaster would crash.
    # Stub once; matches the pattern in test_server_subnesting.py.
    if not hasattr(app.state, "broadcaster"):
        app.state.broadcaster = SSEBroadcaster()
    return tmp_path


@pytest.fixture
def profile(home):
    """Create ~/.montaj/profiles/alpha/ (no assets dir yet)."""
    p = home / ".montaj" / "profiles" / "alpha"
    p.mkdir(parents=True)
    return p


@pytest.fixture
def client(home):
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# GET — list
# ---------------------------------------------------------------------------

def test_list_unknown_profile_returns_404(client, home):
    resp = client.get("/api/profiles/ghost/assets")
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "not_found"


def test_list_empty_when_assets_dir_missing(client, profile):
    resp = client.get("/api/profiles/alpha/assets")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "files":    [],
        "manifest": {"summary": "", "files": {}},
        "drift":    {"filesWithoutEntry": [], "entriesWithoutFile": []},
    }


def test_list_populated_and_alpha_sorted(client, profile):
    assets = profile / "assets"
    assets.mkdir()
    (assets / "z.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (assets / "a.txt").write_text("a")
    (assets / "m.mp4").write_bytes(b"\x00" * 100)

    resp = client.get("/api/profiles/alpha/assets")
    assert resp.status_code == 200
    body = resp.json()
    names = [f["filename"] for f in body["files"]]
    assert names == ["a.txt", "m.mp4", "z.png"]
    # mime is extension-derived
    by_name = {f["filename"]: f for f in body["files"]}
    assert by_name["z.png"]["mime"] == "image/png"
    assert by_name["m.mp4"]["mime"] == "video/mp4"
    # mtime is a unix epoch float
    assert isinstance(by_name["z.png"]["mtime"], (int, float))
    assert by_name["a.txt"]["size"] == 1
    # path is the absolute filesystem path for each file
    assert by_name["z.png"]["path"].endswith("z.png")
    assert by_name["a.txt"]["path"].endswith("a.txt")


def test_list_excludes_manifest_json_from_files(client, profile):
    assets = profile / "assets"
    assets.mkdir()
    (assets / "a.txt").write_text("a")
    (assets / "manifest.json").write_text('{"summary":"","files":{}}')
    resp = client.get("/api/profiles/alpha/assets")
    body = resp.json()
    names = [f["filename"] for f in body["files"]]
    assert names == ["a.txt"]


def test_list_drift_both_directions(client, profile):
    assets = profile / "assets"
    assets.mkdir()
    (assets / "real.png").write_bytes(b"x")
    (assets / "orphan.txt").write_text("orphan")  # no manifest entry
    manifest = {
        "summary": "",
        "files": {
            "real.png":  {"description": "ok"},
            "ghost.png": {"description": "missing on disk"},
        },
    }
    (assets / "manifest.json").write_text(json.dumps(manifest))

    resp = client.get("/api/profiles/alpha/assets")
    body = resp.json()
    assert body["drift"]["filesWithoutEntry"]  == ["orphan.txt"]
    assert body["drift"]["entriesWithoutFile"] == ["ghost.png"]


def test_list_corrupt_manifest_falls_back_to_default(client, profile):
    assets = profile / "assets"
    assets.mkdir()
    (assets / "a.txt").write_text("a")
    (assets / "manifest.json").write_text("{not valid json")
    resp = client.get("/api/profiles/alpha/assets")
    body = resp.json()
    assert body["manifest"] == {"summary": "", "files": {}}
    # drift detection still works
    assert body["drift"]["filesWithoutEntry"] == ["a.txt"]


# ---------------------------------------------------------------------------
# POST — upload
# ---------------------------------------------------------------------------

def test_upload_small_file(client, profile):
    resp = client.post(
        "/api/profiles/alpha/assets",
        files={"file": ("hello.txt", b"hi there", "text/plain")},
    )
    assert resp.status_code == 200
    assert resp.json() == {"filename": "hello.txt"}
    assert (profile / "assets" / "hello.txt").read_bytes() == b"hi there"


def test_upload_does_not_seed_manifest(client, profile):
    client.post(
        "/api/profiles/alpha/assets",
        files={"file": ("hello.txt", b"hi", "text/plain")},
    )
    # manifest.json should NOT be auto-created or have an entry
    mf = profile / "assets" / "manifest.json"
    if mf.exists():
        data = json.loads(mf.read_text())
        assert "hello.txt" not in data.get("files", {})
    # And drift should pick it up
    body = client.get("/api/profiles/alpha/assets").json()
    assert body["drift"]["filesWithoutEntry"] == ["hello.txt"]


def test_upload_collision_appends_suffix(client, profile):
    r1 = client.post(
        "/api/profiles/alpha/assets",
        files={"file": ("hello.txt", b"first", "text/plain")},
    )
    r2 = client.post(
        "/api/profiles/alpha/assets",
        files={"file": ("hello.txt", b"second", "text/plain")},
    )
    r3 = client.post(
        "/api/profiles/alpha/assets",
        files={"file": ("hello.txt", b"third", "text/plain")},
    )
    assert r1.json()["filename"] == "hello.txt"
    assert r2.json()["filename"] == "hello_1.txt"
    assert r3.json()["filename"] == "hello_2.txt"


def test_upload_overflow_returns_413_and_cleans_partial(client, profile, monkeypatch):
    # Shrink the cap so we don't have to upload 2 GB.
    monkeypatch.setattr(pa, "MAX_ASSET_BYTES", 1024)
    payload = b"X" * 4096  # 4 KB > 1 KB cap
    resp = client.post(
        "/api/profiles/alpha/assets",
        files={"file": ("big.bin", payload, "application/octet-stream")},
    )
    assert resp.status_code == 413
    assert resp.json()["detail"]["error"] == "payload_too_large"
    # Partial file MUST have been cleaned up.
    assert not (profile / "assets" / "big.bin").exists()


def test_upload_invalid_profile_name(client, profile):
    resp = client.post(
        "/api/profiles/..ev/assets",
        files={"file": ("x.txt", b"y", "text/plain")},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_name"


def test_upload_invalid_filename(client, profile):
    resp = client.post(
        "/api/profiles/alpha/assets",
        files={"file": (".hidden", b"y", "application/octet-stream")},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_filename"


# ---------------------------------------------------------------------------
# DELETE
# ---------------------------------------------------------------------------

def test_delete_file_and_entry(client, profile):
    assets = profile / "assets"
    assets.mkdir()
    (assets / "a.txt").write_text("a")
    (assets / "manifest.json").write_text(json.dumps({
        "summary": "", "files": {"a.txt": {"description": "x"}},
    }))
    resp = client.delete("/api/profiles/alpha/assets/a.txt")
    assert resp.status_code == 204
    assert not (assets / "a.txt").exists()
    data = json.loads((assets / "manifest.json").read_text())
    assert "a.txt" not in data["files"]


def test_delete_only_file_present(client, profile):
    assets = profile / "assets"
    assets.mkdir()
    (assets / "a.txt").write_text("a")
    resp = client.delete("/api/profiles/alpha/assets/a.txt")
    assert resp.status_code == 204
    assert not (assets / "a.txt").exists()


def test_delete_only_entry_present(client, profile):
    assets = profile / "assets"
    assets.mkdir()
    (assets / "manifest.json").write_text(json.dumps({
        "summary": "", "files": {"ghost.png": {"description": "x"}},
    }))
    resp = client.delete("/api/profiles/alpha/assets/ghost.png")
    assert resp.status_code == 204
    data = json.loads((assets / "manifest.json").read_text())
    assert "ghost.png" not in data["files"]


def test_delete_neither_returns_404(client, profile):
    (profile / "assets").mkdir()
    resp = client.delete("/api/profiles/alpha/assets/missing.txt")
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "not_found"


# ---------------------------------------------------------------------------
# PUT — manifest summary
# ---------------------------------------------------------------------------

def test_put_summary_updates_manifest(client, profile):
    resp = client.put(
        "/api/profiles/alpha/assets/manifest/summary",
        json={"summary": "Brand assets — keep these aligned with the visual ID."},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["summary"].startswith("Brand assets")
    on_disk = json.loads((profile / "assets" / "manifest.json").read_text())
    assert on_disk["summary"] == body["summary"]


def test_put_summary_rejects_non_string(client, profile):
    resp = client.put(
        "/api/profiles/alpha/assets/manifest/summary",
        json={"summary": 123},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_summary"


# ---------------------------------------------------------------------------
# PUT — manifest files/{filename}
# ---------------------------------------------------------------------------

def test_put_file_entry_creates_entry(client, profile):
    assets = profile / "assets"
    assets.mkdir()
    (assets / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    resp = client.put(
        "/api/profiles/alpha/assets/manifest/files/logo.png",
        json={"description": "primary logo", "tags": ["brand", "logo"]},
    )
    assert resp.status_code == 200
    assert resp.json() == {"description": "primary logo", "tags": ["brand", "logo"]}
    on_disk = json.loads((assets / "manifest.json").read_text())
    assert on_disk["files"]["logo.png"]["description"] == "primary logo"


def test_put_file_entry_omits_tags_when_absent(client, profile):
    assets = profile / "assets"
    assets.mkdir()
    (assets / "logo.png").write_bytes(b"x")
    resp = client.put(
        "/api/profiles/alpha/assets/manifest/files/logo.png",
        json={"description": "primary logo"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"description": "primary logo"}
    assert "tags" not in resp.json()


def test_put_file_entry_rejects_missing_file_on_disk(client, profile):
    (profile / "assets").mkdir()
    resp = client.put(
        "/api/profiles/alpha/assets/manifest/files/ghost.png",
        json={"description": "nope"},
    )
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "not_found"


def test_put_file_entry_rejects_bad_description(client, profile):
    assets = profile / "assets"
    assets.mkdir()
    (assets / "logo.png").write_bytes(b"x")
    resp = client.put(
        "/api/profiles/alpha/assets/manifest/files/logo.png",
        json={"description": 5},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_description"


def test_put_file_entry_rejects_bad_tags(client, profile):
    assets = profile / "assets"
    assets.mkdir()
    (assets / "logo.png").write_bytes(b"x")
    resp = client.put(
        "/api/profiles/alpha/assets/manifest/files/logo.png",
        json={"description": "ok", "tags": ["a", 5]},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_tags"


def test_put_file_entry_rejects_empty_body(client, profile):
    """Body with neither description nor tags must return 400 invalid_body."""
    assets = profile / "assets"
    assets.mkdir()
    (assets / "logo.png").write_bytes(b"x")
    resp = client.put(
        "/api/profiles/alpha/assets/manifest/files/logo.png",
        json={},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_body"


def test_put_file_entry_description_only_preserves_tags(client, profile):
    """Regression: a description-only PUT must not erase pre-existing tags."""
    assets = profile / "assets"
    assets.mkdir()
    (assets / "logo.png").write_bytes(b"x")

    # First PUT: set both description and tags.
    r1 = client.put(
        "/api/profiles/alpha/assets/manifest/files/logo.png",
        json={"description": "original desc", "tags": ["brand", "logo"]},
    )
    assert r1.status_code == 200

    # Second PUT: update description only (UI debounce keystroke — no tags key).
    r2 = client.put(
        "/api/profiles/alpha/assets/manifest/files/logo.png",
        json={"description": "updated desc"},
    )
    assert r2.status_code == 200

    # GET manifest and assert tags survived.
    get_resp = client.get("/api/profiles/alpha/assets")
    assert get_resp.status_code == 200
    entry = get_resp.json()["manifest"]["files"]["logo.png"]
    assert entry["description"] == "updated desc"
    assert entry["tags"] == ["brand", "logo"], "tags must survive a description-only PUT"


def test_put_file_entry_tags_only_preserves_description(client, profile):
    """A tags-only PUT must succeed and preserve the pre-existing description."""
    assets = profile / "assets"
    assets.mkdir()
    (assets / "logo.png").write_bytes(b"x")

    # First PUT: set both description and tags.
    r1 = client.put(
        "/api/profiles/alpha/assets/manifest/files/logo.png",
        json={"description": "keep me", "tags": ["old"]},
    )
    assert r1.status_code == 200

    # Second PUT: update tags only — no description key in body.
    r2 = client.put(
        "/api/profiles/alpha/assets/manifest/files/logo.png",
        json={"tags": ["new", "updated"]},
    )
    assert r2.status_code == 200

    # GET manifest and assert description survived.
    get_resp = client.get("/api/profiles/alpha/assets")
    assert get_resp.status_code == 200
    entry = get_resp.json()["manifest"]["files"]["logo.png"]
    assert entry["description"] == "keep me", "description must survive a tags-only PUT"
    assert entry["tags"] == ["new", "updated"]


# ---------------------------------------------------------------------------
# Validation — name + filename + traversal
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("bad_name", [".dot", "evil\\name", "with space", "evil;ls"])
def test_get_invalid_name_rejected(client, bad_name):
    """Names that match the URL path-param shape but fail _NAME_RE → 400.

    Names with raw "/" or ".." don't even reach this route — the URL router
    splits on "/" and ".." gets normalized by the URL machinery. Those cases
    are blocked at a different layer (404/405) and aren't a route-validation
    concern.
    """
    resp = client.get(f"/api/profiles/{bad_name}/assets")
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_name"


@pytest.mark.parametrize("bad_filename", [".hidden", "..", "a/b.txt", "a\\b.txt", "-leading-dash"])
def test_delete_invalid_filename_rejected(client, profile, bad_filename):
    resp = client.delete(f"/api/profiles/alpha/assets/{bad_filename}")
    # ".." and slashes don't match the path param at all → router 404.
    # Anything that does match the param but fails our regex → 400.
    assert resp.status_code in (400, 404, 405)
    if resp.status_code == 400:
        assert resp.json()["detail"]["error"] == "invalid_filename"


def test_post_resolution_traversal_blocked(client, profile, monkeypatch):
    """Even if a filename slipped past the regex, _resolve_under_assets must
    reject anything that resolves outside the assets dir.

    We can't easily force the regex to admit "../"; instead we directly call
    the helper to lock in its behavior — belt-and-suspenders sanity check.
    """
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        # Directly call with a name that would escape (regex would normally block).
        pa._resolve_under_assets("alpha", "../etc/passwd")
    assert exc_info.value.status_code == 403
    assert exc_info.value.detail["error"] == "traversal"


# Manifest helper unit tests live in tests/test_lib_profile_assets.py
# (they exercise lib/profile_assets.py directly — the canonical home for
# pure manifest I/O). This file covers the HTTP layer only.


# ---------------------------------------------------------------------------
# Project include-asset (single happy-path test)
# ---------------------------------------------------------------------------

def test_project_include_profile_asset_happy_path(client, home, monkeypatch, tmp_path):
    # Workspace with a real project that has profile=alpha.
    ws = home / "Montaj"
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))

    proj_dir = ws / "2026-05-04-test"
    proj_dir.mkdir()
    project = {
        "version": "0.2",
        "id":      "proj-1",
        "status":  "draft",
        "profile": "alpha",
        "assets":  [],
    }
    (proj_dir / "project.json").write_text(json.dumps(project, indent=2))

    # Profile with one asset on disk.
    p_assets = home / ".montaj" / "profiles" / "alpha" / "assets"
    p_assets.mkdir(parents=True)
    (p_assets / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n")

    resp = client.post(
        "/api/projects/proj-1/assets",
        json={"from": {"profile": "alpha", "filename": "logo.png"}},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["assets"]) == 1
    a = body["assets"][0]
    assert a["id"]   == "asset-0"
    assert a["type"] == "image"
    assert a["name"] == "logo.png"
    assert (proj_dir / "logo.png").exists()
    # Persisted on disk
    on_disk = json.loads((proj_dir / "project.json").read_text())
    assert on_disk["assets"][0]["id"] == "asset-0"


def test_project_include_profile_asset_mismatch_400(client, home, monkeypatch):
    ws = home / "Montaj"
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))

    proj_dir = ws / "p"
    proj_dir.mkdir()
    (proj_dir / "project.json").write_text(json.dumps({
        "id": "proj-2", "profile": "beta", "assets": [],
    }))

    p_assets = home / ".montaj" / "profiles" / "alpha" / "assets"
    p_assets.mkdir(parents=True)
    (p_assets / "x.png").write_bytes(b"x")

    resp = client.post(
        "/api/projects/proj-2/assets",
        json={"from": {"profile": "alpha", "filename": "x.png"}},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "profile_mismatch"


def test_project_include_profile_asset_collision_suffix(client, home, monkeypatch, tmp_path):
    """Second include of the same asset should produce <base>_asset2<ext>."""
    ws = home / "Montaj"
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))

    proj_dir = ws / "2026-05-04-collision"
    proj_dir.mkdir()
    project = {
        "version": "0.2",
        "id":      "proj-col",
        "status":  "draft",
        "profile": "alpha",
        "assets":  [],
    }
    (proj_dir / "project.json").write_text(json.dumps(project, indent=2))

    p_assets = home / ".montaj" / "profiles" / "alpha" / "assets"
    p_assets.mkdir(parents=True)
    (p_assets / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n")

    # First include — no collision.
    r1 = client.post(
        "/api/projects/proj-col/assets",
        json={"from": {"profile": "alpha", "filename": "logo.png"}},
    )
    assert r1.status_code == 200
    assert r1.json()["assets"][0]["name"] == "logo.png"

    # Second include — collision → _asset2.
    r2 = client.post(
        "/api/projects/proj-col/assets",
        json={"from": {"profile": "alpha", "filename": "logo.png"}},
    )
    assert r2.status_code == 200
    names = [a["name"] for a in r2.json()["assets"]]
    assert "logo_asset2.png" in names, f"expected logo_asset2.png in {names}"


def test_project_include_profile_asset_broadcasts_sse(client, home, monkeypatch):
    """Mutating include-asset must publish to the SSE broadcaster so that
    subscribed UIs see the new asset entry without waiting for a watcher
    debounce. Mirrors the broadcast in save_project / restore_version."""
    ws = home / "Montaj"
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))

    proj_dir = ws / "p"
    proj_dir.mkdir()
    (proj_dir / "project.json").write_text(json.dumps({
        "id": "proj-3", "profile": "alpha", "assets": [],
    }))

    p_assets = home / ".montaj" / "profiles" / "alpha" / "assets"
    p_assets.mkdir(parents=True)
    (p_assets / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n")

    # Capture broadcaster.publish calls. The TestClient triggers FastAPI's
    # lifespan, which initializes app.state.broadcaster — so we patch the
    # method on the live instance after the first request boots the app.
    calls: list[tuple[str, str]] = []

    # Trigger lifespan start by issuing one cheap request, then patch.
    boot = client.get("/api/profiles")  # cheap, registered route
    assert boot.status_code in (200, 404)  # either is fine; we just need lifespan up

    original_publish = app.state.broadcaster.publish

    def _capture(project_id: str, data: str) -> None:
        calls.append((project_id, data))
        return original_publish(project_id, data)

    monkeypatch.setattr(app.state.broadcaster, "publish", _capture)

    resp = client.post(
        "/api/projects/proj-3/assets",
        json={"from": {"profile": "alpha", "filename": "logo.png"}},
    )
    assert resp.status_code == 200, resp.text

    # Exactly one publish to project_id="proj-3", framed as an SSE data line,
    # carrying the updated project body (must contain the new asset id).
    matching = [c for c in calls if c[0] == "proj-3"]
    assert len(matching) == 1
    _, payload = matching[0]
    assert payload.startswith("data: ")
    assert payload.endswith("\n\n")
    assert "asset-0" in payload
    assert "logo.png" in payload
