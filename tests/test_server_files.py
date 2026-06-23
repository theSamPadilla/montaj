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
          render/
            templates/
              overlays/
                static-text/
                  static-text.jsx   # shipped overlay template
            credentials.json        # sibling outside templates/overlays/ — must remain 403

    Patches serve.server._allowed_file_roots to return [workspace, overlays,
    profiles, shipped_templates] from this layout. Using subdirectories of
    tmp_path (not tmp_path itself) lets traversal tests drop an "outside" file
    at tmp_path/outside.txt without leaking past pytest's cleanup.

    The shipped-templates root is constructed directly here (without patching
    render_runtime_dir) because _allowed_file_roots is already fully replaced by
    monkeypatch — the test controls the exact list returned, so there is no need
    for a second layer of patching.
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

    # Shipped overlay templates root — mirrors the production path expression
    # (Path(render_runtime_dir()) / "templates" / "overlays").resolve().
    shipped_templates = (tmp_path / "render" / "templates" / "overlays").resolve()
    shipped_templates.mkdir(parents=True)
    st_overlay_dir = shipped_templates / "static-text"
    st_overlay_dir.mkdir()
    (st_overlay_dir / "static-text.jsx").write_text("export const StaticText = () => null")

    # Sensitive sibling outside templates/overlays/ — must remain blocked.
    (tmp_path / "render" / "credentials.json").write_text('{"api_key": "secret"}')

    monkeypatch.setattr(
        "serve.routes.files._allowed_file_roots",
        lambda: [ws, overlays, profiles, shipped_templates],
    )
    return {
        "workspace":         ws,
        "overlays":          overlays,
        "profiles":          profiles,
        "shipped_templates": shipped_templates,
        "tmp_path":          tmp_path,
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


def test_files_under_shipped_templates_root_returns_200(client, roots):
    """A shipped overlay JSX (render/templates/overlays/<name>/<name>.jsx) must
    be served by /api/files so the frontend can fetch system overlay templates
    the same way it fetches user-installed overlays (Task 5 of
    2026-05-24-add-text-overlay)."""
    jsx = roots["shipped_templates"] / "static-text" / "static-text.jsx"
    resp = client.get("/api/files", params={"path": str(jsx)})
    assert resp.status_code == 200
    assert b"StaticText" in resp.content


def test_files_serves_symlinked_source_under_workspace(roots, client):
    """Clips-workflow shared source: a child clip project references the
    original source via a symlink. The editor previews it through /api/files.
    The symlink RESOLVES under the workspace root, so it is intentionally
    servable — containment is unchanged because the resolved target is still
    in-scope (cf. test_files_symlink_outside_allowlist_returns_403)."""
    # source project holds the real file; a sibling child project symlinks to it
    ws = roots["workspace"]
    source = ws / "src-proj" / "clips" / "big.mp4"
    source.parent.mkdir(parents=True); source.write_bytes(b"\x00" * 2048)
    child_dir = ws / "child-proj" / "clips"; child_dir.mkdir(parents=True)
    link = child_dir / "big.mp4"; link.symlink_to(source)
    r = client.get("/api/files", params={"path": str(link)})
    assert r.status_code == 200
    assert len(r.content) == 2048


def test_files_sibling_of_shipped_templates_returns_403(client, roots):
    """A file that is a sibling of templates/overlays/ inside the render dir
    (e.g., render/credentials.json) must not be reachable — only the
    templates/overlays/ subtree is in the allowlist, not the render root."""
    sibling = roots["tmp_path"] / "render" / "credentials.json"
    resp = client.get("/api/files", params={"path": str(sibling)})
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "forbidden"


# ── POST /api/files write-endpoint tests ──────────────────────────────────────

@pytest.fixture
def write_client(roots, monkeypatch):
    """TestClient whose workspace is the synthetic roots["workspace"] dir.

    Patches both the _allowed_file_roots (for GET) and resolve_workspace (for
    POST /api/files) so both endpoints see the same synthetic layout.
    """
    ws = roots["workspace"]
    monkeypatch.setattr("serve.routes.files.resolve_workspace", lambda: ws)
    return TestClient(app, raise_server_exceptions=False)


def test_write_file_happy_path(write_client, roots):
    """POST /api/files writes a new file under the workspace and returns
    {path, bytes} with the correct byte count."""
    ws = roots["workspace"]
    target = ws / "2026-05-02-test" / "spec.json"
    payload = {"path": str(target), "content": '{"keeps": []}'}

    resp = write_client.post("/api/files", json=payload)

    assert resp.status_code == 200
    body = resp.json()
    assert body["path"] == str(target)
    assert body["bytes"] == len('{"keeps": []}'.encode("utf-8"))
    assert target.read_text() == '{"keeps": []}'


def test_write_file_creates_parent_dirs(write_client, roots):
    """POST /api/files creates intermediate directories that don't exist yet."""
    ws = roots["workspace"]
    target = ws / "new-project" / "subdir" / "data.json"

    resp = write_client.post("/api/files", json={"path": str(target), "content": "hello"})

    assert resp.status_code == 200
    assert target.exists()
    assert target.read_text() == "hello"


def test_write_file_traversal_rejected(write_client, roots):
    """A path whose resolved parent escapes the workspace via .. returns 403."""
    ws = roots["workspace"]
    # Build a path that starts inside the workspace but escapes via ..
    traversal = str(ws / "2026-05-02-test" / ".." / ".." / "evil.txt")

    resp = write_client.post("/api/files", json={"path": traversal, "content": "bad"})

    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "forbidden"


def test_write_file_outside_workspace_rejected(write_client):
    """An absolute path outside the workspace (e.g. /tmp or /etc) returns 403."""
    for evil_path in ["/tmp/evil.txt", "/etc/x"]:
        resp = write_client.post("/api/files", json={"path": evil_path, "content": "bad"})
        assert resp.status_code == 403, f"Expected 403 for {evil_path}, got {resp.status_code}"
        assert resp.json()["detail"]["error"] == "forbidden"


def test_write_file_readonly_library_root_rejected(write_client, roots):
    """The write endpoint confines to the WORKSPACE root only — the read-only
    library roots that GET /api/files serves from (overlays, profiles) are NOT
    writable. A path under the overlay library returns 403. This is the
    confinement that distinguishes write from the GET allowlist."""
    for root_key in ("overlays", "profiles"):
        target = roots[root_key] / "injected.jsx"
        resp = write_client.post("/api/files", json={"path": str(target), "content": "x"})
        assert resp.status_code == 403, f"Expected 403 under {root_key} root, got {resp.status_code}"
        assert resp.json()["detail"]["error"] == "forbidden"


def test_write_file_missing_path_rejected(write_client):
    """A request with no path returns 400."""
    resp = write_client.post("/api/files", json={"content": "x"})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "bad_request"


def test_write_file_non_string_content_rejected(write_client, roots):
    """A non-string content returns 400 (no file is written)."""
    target = roots["workspace"] / "bad.json"
    resp = write_client.post("/api/files", json={"path": str(target), "content": {"not": "a string"}})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "bad_request"
    assert not target.exists()
