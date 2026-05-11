"""HTTP tests for PUT /api/projects/{id}/overlays/{name}.

Mirrors the workspace-fixture pattern from test_server_subnesting.py — env var
for the init.py subprocess + in-process resolve_workspace monkeypatch +
broadcaster stub. A single module-scoped project is shared across all tests
to avoid the per-test cost of /api/run subprocessing.
"""
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from serve.server import app
from serve.sse import SSEBroadcaster

client = TestClient(app)

HEADLINE_JSX = """
export const props = { staticFrame: 30 };
export default function Headline({ text }) {
  return <div style={{ fontSize: 96, fontWeight: 900 }}>{text}</div>;
}
""".strip()


@pytest.fixture(scope="module")
def workspace(tmp_path_factory):
    """Module-scoped workspace — one tmp dir shared across the whole file.

    Layers (same as test_server_subnesting.py:22-42):
      - MONTAJ_WORKSPACE_DIR so init.py subprocess sees it
      - resolve_workspace monkeypatch so in-process handlers agree
      - broadcaster stub so PUT/reload don't crash
    """
    import os
    tmp = tmp_path_factory.mktemp("ws")
    os.environ["MONTAJ_WORKSPACE_DIR"] = str(tmp)

    # Module-scoped monkeypatch (pytest's monkeypatch fixture is function-scoped,
    # so we patch + restore manually here).
    import serve.routes.projects as projects_module
    original_resolve = projects_module.resolve_workspace
    projects_module.resolve_workspace = lambda: tmp

    if not hasattr(app.state, "broadcaster"):
        app.state.broadcaster = SSEBroadcaster()

    yield tmp

    projects_module.resolve_workspace = original_resolve
    os.environ.pop("MONTAJ_WORKSPACE_DIR", None)


@pytest.fixture(scope="module")
def project_id(workspace) -> str:
    """Create one lightweight project shared across all tests in this file.

    Uses lyrics_video (canvas-eligible) to avoid the carousel init subprocess
    chain — the project just needs to exist on disk for /overlays writes.
    """
    pid = str(uuid.uuid4())
    res = client.post("/api/run", json={
        "id": pid,
        "prompt": "overlay test fixture",
        "workflow": "lyrics_video",
        "clips": [],
        "projectPath": "overlay-test",
    })
    assert res.status_code in (200, 201), res.text
    return pid


def test_put_overlay_writes_jsx_to_workspace(project_id):
    res = client.put(
        f"/api/projects/{project_id}/overlays/headline",
        content=HEADLINE_JSX,
        headers={"Content-Type": "text/plain"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["name"] == "headline"
    assert body["created"] is True
    assert body["bytes"] == len(HEADLINE_JSX.encode("utf-8"))
    assert body["path"].endswith("/overlays/headline.jsx")

    on_disk = Path(body["path"])
    assert on_disk.exists()
    assert on_disk.read_text() == HEADLINE_JSX


# Task 3: Idempotent overwrite
def test_put_overlay_overwrite_returns_200(project_id):
    first = client.put(
        f"/api/projects/{project_id}/overlays/overwrite-test",
        content="// v1",
        headers={"Content-Type": "text/plain"},
    )
    assert first.status_code == 201
    assert first.json()["created"] is True

    second = client.put(
        f"/api/projects/{project_id}/overlays/overwrite-test",
        content="// v2 — updated",
        headers={"Content-Type": "text/plain"},
    )
    assert second.status_code == 200
    assert second.json()["created"] is False
    assert Path(second.json()["path"]).read_text() == "// v2 — updated"


# Task 4: Name validation
@pytest.mark.parametrize("name", [
    "with.dot",
    "with space",
    "ünicode",
    "a" * 65,            # too long
])
def test_put_overlay_rejects_invalid_names(project_id, name):
    res = client.put(
        f"/api/projects/{project_id}/overlays/{name}",
        content="// body",
        headers={"Content-Type": "text/plain"},
    )
    assert res.status_code == 400, (name, res.status_code, res.text)
    assert res.json()["detail"]["error"] == "invalid_name"


# Task 5: Size cap and empty body
def test_put_overlay_rejects_oversized_body(project_id):
    from serve.routes.projects import OVERLAY_MAX_BYTES

    oversize = b"x" * (OVERLAY_MAX_BYTES + 1)
    res = client.put(
        f"/api/projects/{project_id}/overlays/big",
        content=oversize,
        headers={"Content-Type": "text/plain"},
    )
    assert res.status_code == 413
    assert res.json()["detail"]["error"] == "payload_too_large"


def test_put_overlay_rejects_empty_body(project_id):
    res = client.put(
        f"/api/projects/{project_id}/overlays/empty-body",
        content=b"",
        headers={"Content-Type": "text/plain"},
    )
    assert res.status_code == 400
    assert res.json()["detail"]["error"] == "empty_body"


# Task 6: Missing project → 404
def test_put_overlay_missing_project_returns_404(workspace):
    """workspace fixture must be passed so resolve_workspace is patched even
    though we don't use the shared project_id here."""
    bogus_id = str(uuid.uuid4())
    res = client.put(
        f"/api/projects/{bogus_id}/overlays/headline",
        content="// body",
        headers={"Content-Type": "text/plain"},
    )
    assert res.status_code == 404
    assert res.json()["detail"]["error"] == "not_found"


# Task 7: Read-back via existing /api/files
def test_overlay_readable_via_api_files(project_id):
    """Sanity check: an overlay written via PUT is readable via GET /api/files."""
    put = client.put(
        f"/api/projects/{project_id}/overlays/cta",
        content=HEADLINE_JSX,
        headers={"Content-Type": "text/plain"},
    )
    assert put.status_code == 201

    get = client.get("/api/files", params={"path": put.json()["path"]})
    assert get.status_code == 200
    assert get.text == HEADLINE_JSX
