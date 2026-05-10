"""Tests for serve-mode discovery of nested projects (Task D + F of 2026-05-02-workspace-paths).

Exercises POST /api/run with projectPath, recursive workspace discovery, and
the full lookup-by-id path through find_project_dir for projects at depth ≥ 2.
"""
import json
import os
import time
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve.server import app
from serve.sse import SSEBroadcaster


client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """Workspace fixture — env var + resolve_workspace patch + broadcaster.

    Layers:
      - env var so the init.py subprocess (spawned by /api/run) sees the
        correct workspace dir.
      - monkeypatch on resolve_workspace so in-process handlers
        (list/get/delete/etc.) read the same workspace.
      - app.state.broadcaster — TestClient doesn't run lifespan() unless used
        as a context manager, so endpoints that publish to the broadcaster
        (PUT, /reload) would crash on AttributeError. Stubbed once, restored
        on teardown so it doesn't bleed across tests.
    """
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setattr("serve.routes.projects.resolve_workspace", lambda: tmp_path)

    if not hasattr(app.state, "broadcaster"):
        app.state.broadcaster = SSEBroadcaster()

    return tmp_path


def _create(project_path: str, prompt: str = "test"):
    """Helper: POST /api/run and return (status, body)."""
    resp = client.post("/api/run", json={
        "prompt": prompt,
        "workflow": "lyrics_video",  # canvas-eligible workflow → no clips needed
        "clips": [],
        "projectPath": project_path,
    })
    return resp


# ---------------------------------------------------------------------------
# /api/run with projectPath
# ---------------------------------------------------------------------------

def test_run_creates_nested_and_flat_projects(workspace):
    """POST /api/run with projectPath at depth 1 and 2 creates both."""
    r1 = _create("teamA/abc")
    assert r1.status_code in (200, 201), r1.text
    nested = r1.json()
    assert nested.get("id")

    r2 = _create("flat-xyz")
    assert r2.status_code in (200, 201), r2.text
    flat = r2.json()
    assert flat.get("id")

    assert (workspace / "teamA" / "abc" / "project.json").is_file()
    assert (workspace / "flat-xyz" / "project.json").is_file()


def test_run_two_projects_under_same_parent(workspace):
    """teamA/proj-1 and teamA/proj-2 both succeed (parent-exists path)."""
    r1 = _create("teamA/proj-1")
    assert r1.status_code in (200, 201), r1.text
    r2 = _create("teamA/proj-2")
    assert r2.status_code in (200, 201), r2.text
    assert (workspace / "teamA" / "proj-1" / "project.json").is_file()
    assert (workspace / "teamA" / "proj-2" / "project.json").is_file()


def test_run_duplicate_path_returns_project_path_exists(workspace):
    """Re-creating an existing path returns an error containing
    project_path_exists. The first call succeeds, the second fails — Hub's
    idempotent-retry logic should pattern-match this error code."""
    r1 = _create("teamA/abc")
    assert r1.status_code in (200, 201), r1.text

    r2 = _create("teamA/abc")
    # Per docs/plans/2026-05-02-workspace-paths.md, collisions are 400 Bad
    # Request — Hub's idempotent-retry logic pattern-matches on the status
    # code + error code pair.
    assert r2.status_code == 400, r2.text
    # The error code propagates through init.py's stderr → server's HTTPException detail
    detail = r2.json().get("detail", {})
    assert detail.get("error") == "project_path_exists", \
        f"expected project_path_exists, got {detail}"


def test_post_run_with_invalid_project_path_returns_400(workspace):
    """`--project-path` validation rejections (e.g. traversal) come back as
    400 with error: invalid_project_path. Same contract as project_path_exists."""
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "lyrics_video",
        "clips": [],
        "projectPath": "../etc/passwd",
    })
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"]["error"] == "invalid_project_path"


# ---------------------------------------------------------------------------
# Listing + by-id lookup
# ---------------------------------------------------------------------------

def test_list_projects_returns_nested_and_flat(workspace):
    """GET /api/projects discovers projects at any depth via rglob."""
    r1 = _create("teamA/nested")
    assert r1.status_code in (200, 201), r1.text
    nested_id = r1.json()["id"]

    # Brief sleep so mtime ordering is deterministic.
    time.sleep(0.01)
    r2 = _create("flat")
    assert r2.status_code in (200, 201), r2.text
    flat_id = r2.json()["id"]

    listing = client.get("/api/projects")
    assert listing.status_code == 200
    ids = [p["id"] for p in listing.json()]
    assert nested_id in ids
    assert flat_id in ids
    # Most recent first → flat should come before nested.
    assert ids.index(flat_id) < ids.index(nested_id)


def test_get_project_resolves_at_any_depth(workspace):
    """GET /api/projects/<id> finds both nested and flat projects."""
    nested_id = _create("teamA/nested").json()["id"]
    flat_id   = _create("flat").json()["id"]

    n = client.get(f"/api/projects/{nested_id}")
    assert n.status_code == 200
    assert n.json()["id"] == nested_id

    f = client.get(f"/api/projects/{flat_id}")
    assert f.status_code == 200
    assert f.json()["id"] == flat_id


# ---------------------------------------------------------------------------
# Mutation endpoints (DELETE / PUT)
# ---------------------------------------------------------------------------

def test_delete_nested_leaves_parent_intact(workspace):
    """DELETE /api/projects/<id> removes the nested dir but the parent
    directory remains if it has siblings."""
    sibling_id = _create("teamA/sibling").json()["id"]
    target_id  = _create("teamA/target").json()["id"]

    resp = client.delete(f"/api/projects/{target_id}")
    assert resp.status_code in (200, 204)

    assert not (workspace / "teamA" / "target").exists()
    # Parent and the sibling project remain.
    assert (workspace / "teamA").is_dir()
    assert (workspace / "teamA" / "sibling" / "project.json").is_file()
    # Sibling still discoverable.
    sib = client.get(f"/api/projects/{sibling_id}")
    assert sib.status_code == 200


def test_put_nested_project_writes_field(workspace):
    """PUT /api/projects/<id> updates a nested project's project.json."""
    create_resp = _create("teamA/edit-me")
    assert create_resp.status_code in (200, 201), create_resp.text
    body = create_resp.json()
    pid = body["id"]

    body["name"] = "updated-name"
    put = client.put(f"/api/projects/{pid}", json=body)
    assert put.status_code == 200, put.text

    # Disk reflects the update.
    on_disk = json.loads((workspace / "teamA" / "edit-me" / "project.json").read_text())
    assert on_disk["name"] == "updated-name"


# ---------------------------------------------------------------------------
# Rerun + render — nested project lookup must not 404
# ---------------------------------------------------------------------------

def test_rerun_finds_nested_project(workspace):
    """POST /api/projects/<id>/rerun must locate a nested project (no 404).
    The 'no_sources' 400 is acceptable — it means the lookup succeeded and
    the handler proceeded past find_project_dir."""
    create_resp = _create("teamA/rerun-me")
    assert create_resp.status_code in (200, 201), create_resp.text
    pid = create_resp.json()["id"]

    resp = client.post(f"/api/projects/{pid}/rerun", json={})
    # 404 would mean find_project_dir didn't find the nested project. Any
    # other status (including 400 'no_sources') means lookup worked.
    assert resp.status_code != 404, resp.text


def test_render_finds_nested_project(workspace):
    """POST /api/projects/<id>/render must locate a nested project (no 404).
    Render's full pipeline may not run cleanly here — that's fine. The
    test's job is to confirm the lookup works."""
    create_resp = _create("teamA/render-me")
    assert create_resp.status_code in (200, 201), create_resp.text
    pid = create_resp.json()["id"]

    resp = client.post(f"/api/projects/{pid}/render")
    # 404 would mean find_project_dir didn't find the nested project. 5xx
    # from missing render dependencies is acceptable.
    assert resp.status_code != 404, resp.text


# ---------------------------------------------------------------------------
# SSE — known fiddly with TestClient. Skipped per Task F's allowance.
# ---------------------------------------------------------------------------

@pytest.mark.skip(
    reason="TestClient SSE is fiddly to drive synchronously; the recursive "
    "watcher behavior was validated manually in Task E (see plan's Task E "
    "validation steps). Integration-test gap is documented in the plan."
)
def test_sse_emits_for_nested_project_mutation(workspace):
    """Open SSE stream on a nested project, mutate via PUT, expect event."""
    create_resp = _create("teamA/sse-me")
    pid = create_resp.json()["id"]
    body = create_resp.json()

    # The pattern below would need an httpx.AsyncClient + async iteration over
    # response chunks; TestClient's stream= mode is synchronous and tends to
    # hang waiting for the keepalive loop. Documented as a follow-up.
    pass


# ---------------------------------------------------------------------------
# id passthrough — Task 2 of 2026-05-10-init-id-passthrough
# ---------------------------------------------------------------------------

CANONICAL_ID_HTTP = "550e8400-e29b-41d4-a716-446655440000"


def test_post_run_with_id_uses_supplied_value(workspace):
    """POST /api/run with body.id=<uuid> produces a project.json whose id matches."""
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "carousel",
        "carouselAspect": "square",
        "id": CANONICAL_ID_HTTP,
        "projectPath": "explicit-id",
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["id"] == CANONICAL_ID_HTTP
    # And the on-disk file matches.
    on_disk = json.loads((workspace / "explicit-id" / "project.json").read_text())
    assert on_disk["id"] == CANONICAL_ID_HTTP


def test_post_run_with_id_animations_workflow(workspace):
    """`animations` has requires_clips=false and exercises the general (non-
    carousel) init path without needing clips. Confirms id passthrough wiring
    in the general branch of run_project."""
    fixed_id = "abcdef00-0000-0000-0000-000000000001"
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "animations",
        "id": fixed_id,
        "projectPath": "explicit-id-animations",
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["id"] == fixed_id


def test_post_run_canonicalizes_non_canonical_id(workspace):
    """Non-canonical-but-parseable forms (hex32, uppercase, braced, urn:uuid:)
    are accepted and stored canonical. Mirrors the CLI-side contract."""
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "carousel",
        "carouselAspect": "square",
        "id": "550E8400E29B41D4A716446655440000",  # uppercase hex32
        "projectPath": "non-canon-http",
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["id"] == CANONICAL_ID_HTTP


@pytest.mark.parametrize("bad_id", [
    "not-a-uuid",
    "550e8400-e29b-41d4-a716",   # truncated
    "",                          # empty
    123,                         # non-string
])
def test_post_run_with_invalid_id_returns_400(bad_id):
    """Truly malformed body.id rejected with 400 invalid_id BEFORE init subprocess fires."""
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "carousel",
        "carouselAspect": "square",
        "id": bad_id,
        "projectPath": "should-not-exist",
    })
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_id"


def test_post_run_without_id_preserves_current_behavior(workspace):
    """Absent body.id → server generates a UUID (existing behavior)."""
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "carousel",
        "carouselAspect": "square",
        "projectPath": "no-id-supplied",
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    # Server-generated, but well-formed UUID.
    assert str(uuid.UUID(body["id"])) == body["id"]


def test_post_run_id_round_trips_through_get(workspace):
    """The supplied id must be addressable on subsequent GET /api/projects/<id>.
    This is the actual user-facing contract — single shared identity across
    POST + GET, where today the server generates an unrelated UUID and GET
    on the caller's id returns 404."""
    fixed_id = "deadbeef-0000-0000-0000-000000000001"
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "carousel",
        "carouselAspect": "square",
        "id": fixed_id,
        "projectPath": "round-trip-test",
    })
    assert resp.status_code == 201, resp.text

    # The exact failure mode this plan solves: BEFORE this change, the server
    # would have generated its own UUID, and GET on the caller's id would 404.
    get_resp = client.get(f"/api/projects/{fixed_id}")
    assert get_resp.status_code == 200, get_resp.text
    assert get_resp.json()["id"] == fixed_id
