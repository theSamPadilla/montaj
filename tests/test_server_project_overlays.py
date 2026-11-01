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

    Uses blank (canvas-eligible) to avoid the carousel init subprocess
    chain — the project just needs to exist on disk for /overlays writes.
    """
    pid = str(uuid.uuid4())
    res = client.post("/api/run", json={
        "id": pid,
        "prompt": "overlay test fixture",
        "workflow": "blank",
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


def test_put_overlay_accepts_a_100kb_template_stage(project_id):
    # The 3D Hub templates install a ~80 KB stage component through this route;
    # under the old 64 KB cap every install failed with a 413.
    pad = "// " + "x" * 96 + "\n"
    body = "export default function Stage() {\n" + pad * 1000 + "  return null\n}\n"
    size = len(body.encode())
    assert 100_000 <= size < 128 * 1024
    res = client.put(
        f"/api/projects/{project_id}/overlays/model3d_stage",
        content=body.encode(),
        headers={"Content-Type": "text/plain"},
    )
    assert res.status_code == 201, res.text
    assert res.json()["bytes"] == size


def test_overlay_cap_is_512kb():
    from serve.routes.projects import OVERLAY_MAX_BYTES

    assert OVERLAY_MAX_BYTES == 512 * 1024


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


# §643: DELETE /api/projects/{id}/overlays/{name}
def _put(project_id, name, text="export default () => null;"):
    res = client.put(f"/api/projects/{project_id}/overlays/{name}", content=text, headers={"Content-Type": "text/plain"})
    assert res.status_code in (200, 201), res.text
    return Path(res.json()["path"])


def _set_tracks(path, tracks):
    import json
    pj = path.parent.parent / "project.json"
    data = json.loads(pj.read_text())
    data["tracks"] = tracks
    pj.write_text(json.dumps(data))


def test_delete_overlay_removes_an_unused_file(project_id):
    path = _put(project_id, "del-unused")
    res = client.delete(f"/api/projects/{project_id}/overlays/del-unused")
    assert res.status_code == 200, res.text
    assert res.json()["deleted"] is True
    assert not path.exists()


def test_delete_overlay_absent_file_is_safe(project_id):
    res = client.delete(f"/api/projects/{project_id}/overlays/never-written")
    assert res.status_code == 200
    assert res.json()["deleted"] is False


@pytest.mark.parametrize("name", ["bad name", "a.b", "x" * 65, "..%2F..%2Fproject"])
def test_delete_overlay_rejects_invalid_names(project_id, name):
    res = client.delete(f"/api/projects/{project_id}/overlays/{name}")
    assert res.status_code in (400, 404, 405, 422), res.text  # 405: an encoded slash never reaches the route


def test_delete_overlay_missing_project_returns_404(workspace):
    res = client.delete(f"/api/projects/{uuid.uuid4()}/overlays/headline")
    assert res.status_code == 404


def test_delete_overlay_refused_while_the_timeline_uses_it(project_id):
    path = _put(project_id, "del-onlane")
    _set_tracks(path, [[{"id": "item-a", "type": "overlay", "src": "overlays/del-onlane.jsx", "start": 0, "end": 1}]])
    res = client.delete(f"/api/projects/{project_id}/overlays/del-onlane")
    assert res.status_code == 409
    assert res.json()["detail"]["error"] == "overlay_in_use"
    assert "item-a" in res.json()["detail"]["message"]
    assert path.exists()
    _set_tracks(path, [])
    assert client.delete(f"/api/projects/{project_id}/overlays/del-onlane").json()["deleted"] is True


def test_delete_overlay_refused_while_another_overlay_imports_it(project_id):
    dep = _put(project_id, "del-dep")
    _put(project_id, "del-user", "import Dep from './del-dep';\nexport default () => <Dep />;")
    res = client.delete(f"/api/projects/{project_id}/overlays/del-dep")
    assert res.status_code == 409
    assert "del-user.jsx" in res.json()["detail"]["message"]
    assert dep.exists()
    # the importer itself is unused and goes
    assert client.delete(f"/api/projects/{project_id}/overlays/del-user").json()["deleted"] is True


def test_delete_overlay_refused_for_a_template_installed_file(project_id):
    path = _put(project_id, "del-tpl")
    res = client.post(f"/api/projects/{project_id}/provenance", json={"path": "overlays/del-tpl.jsx", "entry": {"kind": "template", "templateId": "t1"}})
    assert res.status_code == 200, res.text
    res = client.delete(f"/api/projects/{project_id}/overlays/del-tpl")
    assert res.status_code == 409
    assert "template" in res.json()["detail"]["message"]
    assert path.exists()


def test_delete_overlay_applies_the_sync_guard_and_keeps_the_file(project_id, monkeypatch):
    from fastapi import HTTPException
    from serve import save_guard

    calls = []

    def refuse(headers, pid, files=None):
        calls.append((pid, files))
        raise HTTPException(409, detail={"error": "sync_clash", "message": "clash"})

    path = _put(project_id, "del-sync")
    monkeypatch.setattr(save_guard, "check_sync", refuse)
    res = client.delete(f"/api/projects/{project_id}/overlays/del-sync")
    assert res.status_code == 409
    assert calls == [(project_id, ["overlays/del-sync.jsx"])]
    assert path.exists()


def test_delete_overlay_holds_the_project_lock(project_id, monkeypatch):
    import serve.routes.projects as pm

    held = []
    real = pm.project_lock_async

    def spy(path):
        held.append(path.name)
        return real(path)

    monkeypatch.setattr(pm, "project_lock_async", spy)
    _put(project_id, "del-lock")
    assert client.delete(f"/api/projects/{project_id}/overlays/del-lock").status_code == 200
    assert held == ["project.json"]


# §643 review fixes
def test_delete_overlay_refused_while_a_carousel_slide_uses_it(project_id):
    import json
    path = _put(project_id, "del-slide")
    pj = path.parent.parent / "project.json"
    data = json.loads(pj.read_text())
    data["slides"] = [{"elements": [{"overlay": {"template": str(path)}}]}]
    pj.write_text(json.dumps(data))
    res = client.delete(f"/api/projects/{project_id}/overlays/del-slide")
    assert res.status_code == 409
    assert "slide 1 element 1" in res.json()["detail"]["message"]
    assert path.exists()
    data.pop("slides")
    pj.write_text(json.dumps(data))
    assert client.delete(f"/api/projects/{project_id}/overlays/del-slide").json()["deleted"] is True


def test_delete_overlay_checks_ignore_case(project_id):
    path = _put(project_id, "del-case")
    _set_tracks(path, [[{"id": "item-c", "src": "overlays/del-case.jsx"}]])
    res = client.delete(f"/api/projects/{project_id}/overlays/Del-Case")
    # a case-sensitive disk has no such file (nothing to delete); a case-insensitive one reaches it and is refused
    assert res.status_code == 200 and res.json()["deleted"] is False or res.status_code == 409
    assert path.exists()
    _set_tracks(path, [[{"id": "item-c", "src": "/w/overlays/DEL-CASE.jsx"}]])
    assert client.delete(f"/api/projects/{project_id}/overlays/del-case").status_code == 409
    _set_tracks(path, [])
    assert client.delete(f"/api/projects/{project_id}/overlays/del-case").json()["deleted"] is True


def test_overlay_in_use_helper_is_case_insensitive(project_id):
    from serve.routes.projects import _overlay_in_use
    path = _put(project_id, "del-helper")
    _set_tracks(path, [[{"id": "i", "src": "overlays/del-helper.jsx"}]])
    assert _overlay_in_use(path.parent.parent, "Del-Helper")
    _set_tracks(path, [])
    _put(project_id, "del-helper-user", "import X from './DEL-HELPER';")
    assert "del-helper-user.jsx" in _overlay_in_use(path.parent.parent, "Del-Helper")
    client.delete(f"/api/projects/{project_id}/overlays/del-helper-user")
    client.delete(f"/api/projects/{project_id}/overlays/del-helper")


@pytest.mark.parametrize("ext,text", [
    ("jsx", "const X = await import('./del-imp.jsx');"),
    ("jsx", "const X = require ('./del-imp');"),
    ("jsx", "const X = await import(`./del-imp`);"),
    ("js", "import X from './del-imp';"),
    ("tsx", "import X from '../overlays/del-imp.jsx';"),
])
def test_delete_overlay_refused_for_each_import_form(project_id, ext, text):
    dep = _put(project_id, "del-imp")
    user = dep.parent / f"del-imp-user.{ext}"
    user.write_text(text)
    res = client.delete(f"/api/projects/{project_id}/overlays/del-imp")
    assert res.status_code == 409, text
    assert f"del-imp-user.{ext}" in res.json()["detail"]["message"]
    user.unlink()
    assert client.delete(f"/api/projects/{project_id}/overlays/del-imp").json()["deleted"] is True


def test_delete_overlay_only_template_entries_hold_it(project_id):
    path = _put(project_id, "del-prov")
    res = client.post(f"/api/projects/{project_id}/provenance", json={"path": "overlays/del-prov.jsx", "entry": {"kind": "montaj", "what": "preset"}})
    assert res.status_code == 200, res.text
    assert client.delete(f"/api/projects/{project_id}/overlays/del-prov").json()["deleted"] is True
    assert not path.exists()


def test_overlay_name_with_a_trailing_newline_is_refused(project_id):
    put = client.put(f"/api/projects/{project_id}/overlays/foo%0A", content="x", headers={"Content-Type": "text/plain"})
    assert put.status_code == 400, put.text
    assert client.delete(f"/api/projects/{project_id}/overlays/foo%0A").status_code == 400
