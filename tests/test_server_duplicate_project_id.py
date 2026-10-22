"""§518: a copied project folder that kept the original's id must not silently
take over the real project.

serve resolved an id with `find_project_dir`'s rglob, FIRST MATCH WINS, so a
second (copied) folder with the same id could become the folder every GET/PUT/
render resolved to, and the per-folder lock never serialised the two. Now the
resolver detects the collision during its one scan and refuses: a requested id
held by two or more TOPMOST (non-nested) project.json folders raises
`DuplicateProjectId`, which serve maps to a 409 `duplicate_project_id` naming
every folder. `GET /projects` flags the colliding ids. A nested snapshot
(the Compare-versions case) is still not a duplicate.
"""
import asyncio
import json
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve import common as sc
from serve.routes import projects as routes
from serve.server import app


client = TestClient(app, raise_server_exceptions=False)


def _project(root: Path, rel: str, pid: str, **fields) -> Path:
    d = root / rel
    d.mkdir(parents=True, exist_ok=True)
    (d / "project.json").write_text(json.dumps({"id": pid, "status": "draft", **fields}))
    return d


def _snapshot(project_dir: Path, pid: str, commit: str = "4095644") -> Path:
    snap = project_dir / "render" / "versions" / commit
    snap.mkdir(parents=True)
    (snap / "project.json").write_text(json.dumps({"id": pid, "status": "draft", "name": "older"}))
    return snap


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    sc._project_dir_cache.clear()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setattr("serve.routes.projects.resolve_workspace", lambda: tmp_path)
    monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
    return tmp_path


# ---------------------------------------------------------------------------
# resolver
# ---------------------------------------------------------------------------

def test_find_project_dir_raises_on_a_duplicated_id(tmp_path):
    sc._project_dir_cache.clear()
    a = _project(tmp_path, "orig", "dup-1")
    b = _project(tmp_path, "copy", "dup-1")
    with pytest.raises(sc.DuplicateProjectId) as exc:
        sc.find_project_dir(tmp_path, "dup-1")
    assert exc.value.project_id == "dup-1"
    assert sorted(str(d) for d in exc.value.dirs) == sorted([str(a), str(b)])


def test_find_project_dir_still_resolves_a_unique_id(tmp_path):
    sc._project_dir_cache.clear()
    _project(tmp_path, "orig", "dup-1")
    _project(tmp_path, "copy", "dup-1")
    solo = _project(tmp_path, "solo", "uniq-1")
    assert sc.find_project_dir(tmp_path, "uniq-1") == solo


def test_nested_snapshot_is_not_a_duplicate(tmp_path):
    # The Compare-versions snapshot carries the project's own id but is nested
    # inside the project's folder, so it is skipped and never counts as a second
    # folder claiming the id.
    sc._project_dir_cache.clear()
    robotics = _project(tmp_path, "a-robotics", "p-robotics")
    _snapshot(robotics, "p-robotics")
    assert sc.find_project_dir(tmp_path, "p-robotics") == robotics


def test_cache_sentinel_raises_on_a_hit_when_a_duplicate_appears(tmp_path):
    # A duplicate introduced after a clean entry was cached must still be caught
    # once any scan records the sentinel; a later resolve of the id then raises
    # on the cache hit, not only on a fresh full scan.
    sc._project_dir_cache.clear()
    _project(tmp_path, "orig", "dup-1")
    _project(tmp_path, "other", "p-other")
    # Prime the cache with a clean single entry for dup-1 (and p-other).
    assert sc.find_project_dir(tmp_path, "p-other").name == "other"
    assert isinstance(sc._project_dir_cache["dup-1"], Path)
    # A copy appears; nothing has rescanned dup-1 yet, so it is still a clean hit.
    _project(tmp_path, "copy", "dup-1")
    # A scan for ANY id (here a miss) records the collision as a sentinel.
    assert sc.find_project_dir(tmp_path, "p-missing") is None
    assert isinstance(sc._project_dir_cache["dup-1"], sc._DuplicateIds)
    # Now a resolve of dup-1 raises on the cache hit.
    with pytest.raises(sc.DuplicateProjectId):
        sc.find_project_dir(tmp_path, "dup-1")


def test_sentinel_clears_when_the_duplicate_is_resolved(tmp_path):
    # Remove one of the two folders: the sentinel re-validates to a single live
    # folder, drops itself, and the remaining folder resolves again.
    sc._project_dir_cache.clear()
    a = _project(tmp_path, "orig", "dup-1")
    copy = _project(tmp_path, "copy", "dup-1")
    with pytest.raises(sc.DuplicateProjectId):
        sc.find_project_dir(tmp_path, "dup-1")
    assert isinstance(sc._project_dir_cache["dup-1"], sc._DuplicateIds)
    # Resolve the collision by removing the copy's project.json.
    (copy / "project.json").unlink()
    assert sc.find_project_dir(tmp_path, "dup-1") == a


# ---------------------------------------------------------------------------
# HTTP: every read and write for a duplicated id refuses with 409
# ---------------------------------------------------------------------------

def test_get_project_is_409_naming_both_folders(workspace):
    a = _project(workspace, "orig", "dup-1")
    b = _project(workspace, "copy", "dup-1")
    r = client.get("/api/projects/dup-1")
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "duplicate_project_id"
    assert detail["projectId"] == "dup-1"
    assert sorted(detail["folders"]) == sorted([str(a), str(b)])
    assert str(a) in detail["message"] and str(b) in detail["message"]


def test_list_projects_primes_the_cache_so_a_hit_is_409(workspace):
    # A clean single entry is cached, then a copy appears. GET /projects flags
    # it AND primes the sentinel, so the per-project route is 409 on a cache hit
    # with no find_project_dir scan in between.
    _project(workspace, "orig", "dup-1")
    assert client.get("/api/projects/dup-1").status_code == 200
    assert isinstance(sc._project_dir_cache["dup-1"], Path)
    _project(workspace, "copy", "dup-1")
    assert client.get("/api/projects/dup-1").status_code == 200  # still the hidden window
    listed = client.get("/api/projects").json()
    assert [p["duplicate"] for p in listed if p["id"] == "dup-1"] == [True, True]
    assert isinstance(sc._project_dir_cache["dup-1"], sc._DuplicateIds)
    r = client.get("/api/projects/dup-1")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "duplicate_project_id"


def test_put_project_is_409(workspace):
    _project(workspace, "orig", "dup-1")
    _project(workspace, "copy", "dup-1")
    r = client.put("/api/projects/dup-1", json={"id": "dup-1", "status": "draft"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "duplicate_project_id"


def test_get_a_unique_project_still_resolves(workspace):
    _project(workspace, "orig", "dup-1")
    _project(workspace, "copy", "dup-1")
    _project(workspace, "solo", "uniq-1")
    r = client.get("/api/projects/uniq-1")
    assert r.status_code == 200, r.text
    assert r.json()["id"] == "uniq-1"


# ---------------------------------------------------------------------------
# GET /projects flags the collision
# ---------------------------------------------------------------------------

def test_list_projects_flags_duplicated_ids(workspace):
    a = _project(workspace, "orig", "dup-1", name="Original")
    b = _project(workspace, "copy", "dup-1", name="Copy")
    _project(workspace, "solo", "uniq-1", name="Solo")
    listed = asyncio.run(routes.list_projects())
    dups = [p for p in listed if p["id"] == "dup-1"]
    uniq = [p for p in listed if p["id"] == "uniq-1"]
    # Both copies listed, both flagged, both naming the same two folders.
    assert len(dups) == 2
    for p in dups:
        assert p["duplicate"] is True
        assert sorted(p["duplicateFolders"]) == sorted([str(a), str(b)])
    # The unique id is untouched: no duplicate fields.
    assert len(uniq) == 1
    assert "duplicate" not in uniq[0]
    assert "duplicateFolders" not in uniq[0]


def test_list_projects_does_not_flag_a_version_snapshot(workspace):
    robotics = _project(workspace, "a-robotics", "p-robotics")
    _snapshot(robotics, "p-robotics")
    listed = asyncio.run(routes.list_projects())
    assert [p["id"] for p in listed] == ["p-robotics"]
    assert "duplicate" not in listed[0]
