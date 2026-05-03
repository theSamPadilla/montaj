"""Tests for /api/files allowlist scoping in serve/server.py (Task A of 2026-05-02-serve-hardening)."""
import pytest
from starlette.testclient import TestClient

from serve.server import app


@pytest.fixture
def roots(tmp_path, monkeypatch):
    """Synthetic allowlist roots, all under tmp_path so pytest auto-cleans them.

    Layout:
        tmp_path/
          workspace/
            2026-05-02-test/
              project.json
              clip.mp4
          .montaj/
            overlays/
              brand/
                Logo/
                  Logo.jsx
            profiles/
              default/
                sample_frames/
                  0.png
                overlays/
                  Title/
                    Title.jsx
            credentials.json   # sibling of allowed roots — must remain 403

    Patches serve.server._allowed_file_roots to return [workspace, overlays,
    profiles] from this layout. Using subdirectories of tmp_path (not tmp_path
    itself) lets traversal tests drop an "outside" file at tmp_path/outside.txt
    without leaking past pytest's cleanup.
    """
    ws       = tmp_path / "workspace"
    overlays = tmp_path / ".montaj" / "overlays"
    profiles = tmp_path / ".montaj" / "profiles"
    ws.mkdir()
    overlays.mkdir(parents=True)
    profiles.mkdir(parents=True)

    proj = ws / "2026-05-02-test"
    proj.mkdir()
    (proj / "project.json").write_text('{"id": "abc", "name": "test"}')
    (proj / "clip.mp4").write_bytes(b"\x00" * 1024)

    overlay_dir = overlays / "brand" / "Logo"
    overlay_dir.mkdir(parents=True)
    (overlay_dir / "Logo.jsx").write_text("export const Logo = () => null")

    profile_dir = profiles / "default"
    (profile_dir / "sample_frames").mkdir(parents=True)
    (profile_dir / "sample_frames" / "0.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (profile_dir / "overlays" / "Title").mkdir(parents=True)
    (profile_dir / "overlays" / "Title" / "Title.jsx").write_text("export const Title = () => null")

    # Sensitive sibling — must remain blocked.
    (tmp_path / ".montaj" / "credentials.json").write_text('{"api_key": "secret"}')

    monkeypatch.setattr("serve.server._allowed_file_roots", lambda: [ws, overlays, profiles])
    return {
        "workspace": ws,
        "overlays":  overlays,
        "profiles":  profiles,
        "tmp_path":  tmp_path,
    }


@pytest.fixture
def client(roots):
    return TestClient(app, raise_server_exceptions=False)


def test_files_inside_workspace_returns_200(client, roots):
    proj = roots["workspace"] / "2026-05-02-test"
    resp = client.get("/api/files", params={"path": str(proj / "project.json")})
    assert resp.status_code == 200
    assert resp.json() == {"id": "abc", "name": "test"}


def test_files_under_overlays_root_returns_200(client, roots):
    """Global overlay JSX (~/.montaj/overlays/<group>/<name>/<name>.jsx) is
    fetched by OverlaysPage.tsx and OverlayItemsLayer.tsx through /api/files
    and must remain reachable."""
    jsx = roots["overlays"] / "brand" / "Logo" / "Logo.jsx"
    resp = client.get("/api/files", params={"path": str(jsx)})
    assert resp.status_code == 200
    assert b"Logo" in resp.content


def test_files_under_profiles_root_returns_200(client, roots):
    """Profile sample frames (~/.montaj/profiles/<name>/sample_frames/*) are
    fetched by ProfilesPage.tsx via /api/files and must remain reachable.
    Same root also covers profile-scoped overlay JSX."""
    frame = roots["profiles"] / "default" / "sample_frames" / "0.png"
    resp = client.get("/api/files", params={"path": str(frame)})
    assert resp.status_code == 200


def test_files_montaj_credentials_returns_403(client, roots):
    """~/.montaj/credentials.json sits directly under ~/.montaj/, not under
    one of the allowed sub-roots (overlays, profiles). Must remain 403 — this
    is the load-bearing negative case that distinguishes the allowlist from
    a naive '~/.montaj is allowed' rule."""
    creds = roots["tmp_path"] / ".montaj" / "credentials.json"
    resp = client.get("/api/files", params={"path": str(creds)})
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "forbidden"


def test_files_absolute_outside_allowlist_returns_403(client):
    resp = client.get("/api/files", params={"path": "/etc/passwd"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "forbidden"


def test_files_traversal_outside_allowlist_returns_403(client, roots):
    # Create a real file outside every allowed root (but still inside tmp_path
    # so pytest cleans it up), then craft a traversal path from inside the
    # workspace that resolves to it. Using a real file ensures we hit the
    # scope check (403) rather than the is_file() check (404).
    outside = roots["tmp_path"] / "outside.txt"
    outside.write_text("secret")
    proj = roots["workspace"] / "2026-05-02-test"
    traversal = f"{proj}/../../{outside.name}"
    resp = client.get("/api/files", params={"path": traversal})
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "forbidden"


def test_files_symlink_outside_allowlist_returns_403(client, roots):
    proj = roots["workspace"] / "2026-05-02-test"
    link = proj / "leak"
    link.symlink_to("/etc/passwd")
    resp = client.get("/api/files", params={"path": str(link)})
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "forbidden"


def test_files_nonexistent_inside_workspace_returns_404(client, roots):
    proj = roots["workspace"] / "2026-05-02-test"
    resp = client.get("/api/files", params={"path": str(proj / "does-not-exist.mp4")})
    assert resp.status_code == 404


def test_files_nonexistent_outside_allowlist_returns_404(client):
    """A path that doesn't exist on disk returns 404 even if it's outside the
    allowlist — the is_file() check fires before the scope check.

    Intentional: the scope check has to run after the NBSP-fallback block,
    which itself runs after is_file(). Pinning behavior so a future refactor
    doesn't silently flip 404 ↔ 403 ordering.
    """
    resp = client.get("/api/files", params={"path": "/etc/does-not-exist-12345"})
    assert resp.status_code == 404


def test_files_nested_project_at_depth_2_returns_200(client, roots):
    """A project nested at depth 2 (workspace/teamA/sub/) is a legitimate
    layout under the workspace-paths plan. /api/files must serve files from
    it — the workspace-scoping check (Task A of serve-hardening) treats any
    path under the workspace root as in-scope, regardless of depth.
    """
    nested = roots["workspace"] / "teamA" / "sub"
    nested.mkdir(parents=True)
    (nested / "project.json").write_text('{"id": "nested-id", "name": "nested"}')

    resp = client.get("/api/files", params={"path": str(nested / "project.json")})
    assert resp.status_code == 200
    assert resp.json() == {"id": "nested-id", "name": "nested"}
