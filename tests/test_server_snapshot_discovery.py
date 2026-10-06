"""Project discovery never takes a project.json nested inside another project.

Comparing versions writes `<project>/render/versions/<commit>/project.json`, a
snapshot carrying the project's own id. Discovery walked every project.json
under the workspace, so the project list showed the project twice, and
`find_project_dir`'s cache kept the LAST match per id while scanning for
another one, which pointed later reads and saves of that project at the
snapshot folder. A project folder is the topmost folder holding a
project.json; nested layouts such as `teamA/abc` (a plain folder above the
project) are unaffected.
"""
import asyncio
import json
from pathlib import Path

from serve import common as sc
from serve.routes import projects as routes


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


def test_list_projects_lists_a_project_once_with_a_version_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, "resolve_workspace", lambda: tmp_path)
    robotics = _project(tmp_path, "2026-10-02-robotics", "p-robotics", name="The Overlooked Middle of Robotics")
    _snapshot(robotics, "p-robotics")
    _project(tmp_path, "2026-10-04-brands", "p-brands", name="Brands")
    listed = asyncio.run(routes.list_projects())
    assert sorted(p["id"] for p in listed) == ["p-brands", "p-robotics"]
    assert [p["name"] for p in listed if p["id"] == "p-robotics"] == ["The Overlooked Middle of Robotics"]


def test_find_project_dir_never_caches_a_snapshot_while_scanning_for_another(tmp_path):
    sc._project_dir_cache.clear()
    robotics = _project(tmp_path, "a-robotics", "p-robotics")
    _snapshot(robotics, "p-robotics")
    other = _project(tmp_path, "z-other", "p-other")
    assert sc.find_project_dir(tmp_path, "p-other") == other
    # rglob walks breadth first, so a scan that stops early never reaches the
    # snapshot; a FULL scan does (an id that is gone, or a project deeper than
    # the snapshot), and caches every id it passes, the last match winning.
    sc._project_dir_cache.clear()
    assert sc.find_project_dir(tmp_path, "p-deleted") is None
    assert sc.find_project_dir(tmp_path, "p-robotics") == robotics
    # And a scan for it directly.
    sc._project_dir_cache.clear()
    assert sc.find_project_dir(tmp_path, "p-robotics") == robotics


def test_nested_layouts_without_a_project_above_are_still_projects(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, "resolve_workspace", lambda: tmp_path)
    sc._project_dir_cache.clear()
    a = _project(tmp_path, "teamA/abc", "p-a")
    b = _project(tmp_path, "teamA/deep/def", "p-b")
    assert sc.find_project_dir(tmp_path, "p-a") == a
    assert sc.find_project_dir(tmp_path, "p-b") == b
    assert sorted(p["id"] for p in asyncio.run(routes.list_projects())) == ["p-a", "p-b"]
