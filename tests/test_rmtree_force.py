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
    r = client.delete(f"/api/projects/{pid}")
    assert r.status_code == 500
    assert "delete_failed" in r.text


def test_ignore_errors_swallows(tmp_path, monkeypatch):
    d = tmp_path / "p"
    d.mkdir()
    (d / "f").write_text("x")
    monkeypatch.setattr("lib.fs_remove.time.sleep", lambda s: None)
    monkeypatch.setattr(os, "unlink", _busy_unlink(10**9))
    monkeypatch.setattr(shutil, "_use_fd_functions", False)
    rmtree_force(d, ignore_errors=True)
    assert d.exists()
