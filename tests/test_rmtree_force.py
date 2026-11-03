"""rmtree_force + DELETE /api/projects/{id} under simulated Windows semantics:
unlinking a file without the user-write bit raises PermissionError(13)."""
import os
import shutil
import stat
import subprocess
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from lib.fs_remove import rmtree_force
from serve.server import app

client = TestClient(app, raise_server_exceptions=False)
_real_unlink = os.unlink


def _windows_unlink(path, *a, **kw):
    # shutil passes dir_fd for a relative name, so stat relative to it too.
    st = os.stat(path, dir_fd=kw["dir_fd"], follow_symlinks=False) if kw.get("dir_fd") is not None \
        else os.lstat(path)
    if not st.st_mode & stat.S_IWUSR:
        raise PermissionError(13, "Access is denied")
    return _real_unlink(path, *a, **kw)


@pytest.fixture
def windows_fs(monkeypatch):
    monkeypatch.setattr(os, "unlink", _windows_unlink)
    monkeypatch.setattr(os, "remove", _windows_unlink)
    # force the path-based walk, which calls os.unlink(path) like Windows does
    monkeypatch.setattr(shutil, "_use_fd_functions", False)


def _repo(d: Path):
    d.mkdir(parents=True)
    (d / "project.json").write_text("{}")
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    subprocess.run(["git", "init", "-q"], cwd=d, check=True, env=env)
    subprocess.run(["git", "add", "."], cwd=d, check=True, env=env)
    subprocess.run(["git", "commit", "-qm", "x"], cwd=d, check=True, env=env)
    ro = [p for p in (d / ".git" / "objects").rglob("*")
          if p.is_file() and not p.stat().st_mode & stat.S_IWUSR]
    assert ro, "git wrote no read-only object files"


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    ws = (tmp_path / "ws").resolve()
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    return ws


def _project(ws):
    pid = str(uuid.uuid4())
    d = ws / f"2026-10-06-{pid[:8]}"
    _repo(d)
    import json
    (d / "project.json").write_text(json.dumps({"version": "0.2", "id": pid, "status": "pending",
                                                "tracks": [], "sources": []}))
    return pid, d


def test_plain_rmtree_fails_on_windows_semantics(tmp_path, windows_fs):
    _repo(tmp_path / "p")
    with pytest.raises(PermissionError):
        shutil.rmtree(tmp_path / "p")


def test_rmtree_force_deletes_readonly_git_repo(tmp_path, windows_fs):
    _repo(tmp_path / "p")
    rmtree_force(tmp_path / "p")
    assert not (tmp_path / "p").exists()


def test_delete_route_removes_project(workspace, windows_fs):
    pid, d = _project(workspace)
    r = client.delete(f"/api/projects/{pid}")
    assert r.status_code == 204, r.text
    assert not d.exists()


def _busy_unlink(fails):
    state = {"n": 0}

    def unlink(path, *a, **kw):
        if state["n"] < fails:
            state["n"] += 1
            e = OSError(13, "in use")
            e.winerror = 32
            raise e
        return _real_unlink(path, *a, **kw)
    return unlink


def test_sharing_violation_is_retried(tmp_path, monkeypatch):
    d = tmp_path / "p"
    d.mkdir()
    (d / "f").write_text("x")
    monkeypatch.setattr("lib.fs_remove.time.sleep", lambda s: None)
    monkeypatch.setattr(os, "unlink", _busy_unlink(2))
    monkeypatch.setattr(shutil, "_use_fd_functions", False)
    rmtree_force(d)
    assert not d.exists()


def test_always_busy_propagates_and_route_answers_json(workspace, monkeypatch):
    pid, d = _project(workspace)
    monkeypatch.setattr("lib.fs_remove.time.sleep", lambda s: None)
    monkeypatch.setattr(os, "unlink", _busy_unlink(10**9))
    monkeypatch.setattr(shutil, "_use_fd_functions", False)
    with pytest.raises(OSError):
        rmtree_force(d)
    # §682: the folder is renamed out of the workspace first, so a file nobody can remove does not fail the delete.
    r = client.delete(f"/api/projects/{pid}")
    assert r.status_code == 204, r.text
    assert not d.exists() and not (d / "project.json").exists()


def test_a_folder_that_cannot_be_renamed_is_removed_in_place_and_a_failure_says_so_plainly(workspace, monkeypatch):
    pid, d = _project(workspace)
    monkeypatch.setattr("lib.fs_remove.time.sleep", lambda s: None)
    monkeypatch.setattr(os, "rename", lambda *a, **k: (_ for _ in ()).throw(OSError(18, "cross-device")))
    monkeypatch.setattr(os, "unlink", _busy_unlink(10**9))
    monkeypatch.setattr(shutil, "_use_fd_functions", False)
    r = client.delete(f"/api/projects/{pid}")
    assert r.status_code == 500
    detail = r.json()["detail"]
    assert detail["error"] == "delete_failed"
    assert str(d) not in r.text and "in use" not in r.text, "no raw path or errno text"


def test_the_deleted_folder_leaves_the_workspace_at_once_and_the_sweep_removes_leftovers(workspace):
    from serve.routes import projects as projects_mod
    from serve.common import DELETING_DIR, find_project_dir
    pid, d = _project(workspace)
    assert client.delete(f"/api/projects/{pid}").status_code == 204
    assert not (d / "project.json").exists()
    assert find_project_dir(workspace, pid) is None, "a project in .montaj-deleting is not a project"
    left = workspace / DELETING_DIR / f"{pid}-leftover"
    left.mkdir(parents=True)
    (left / "project.json").write_text("{}")
    projects_mod.sweep_deleting()
    assert not (workspace / DELETING_DIR).exists()


def test_ignore_errors_swallows(tmp_path, monkeypatch):
    d = tmp_path / "p"
    d.mkdir()
    (d / "f").write_text("x")
    monkeypatch.setattr("lib.fs_remove.time.sleep", lambda s: None)
    monkeypatch.setattr(os, "unlink", _busy_unlink(10**9))
    monkeypatch.setattr(shutil, "_use_fd_functions", False)
    rmtree_force(d, ignore_errors=True)
    assert d.exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX directory permissions")
def test_an_entry_in_a_read_only_folder_is_removed(tmp_path):
    d = tmp_path / "p"
    (d / "locked").mkdir(parents=True)
    (d / "locked" / "f").write_text("x")
    os.chmod(d / "locked", 0o555)
    try:
        rmtree_force(d)
    finally:
        if (d / "locked").exists():
            os.chmod(d / "locked", 0o755)
    assert not d.exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX directory permissions")
def test_the_parents_other_mode_bits_survive(tmp_path):
    team = tmp_path / "team"
    (team / "p" / "locked").mkdir(parents=True)
    (team / "p" / "locked" / "f").write_text("x")
    os.chmod(team / "p" / "locked", 0o555)
    os.chmod(team, 0o775)
    try:
        rmtree_force(team / "p")
    finally:
        mode = stat.S_IMODE(team.stat().st_mode)
        os.chmod(team, 0o755)
    assert mode == 0o775, oct(mode)
