"""§682: DELETE /api/projects/{id} stops the project's own writers, takes `?folder=` when two folders claim the id,
and answers 404 for a project that is already gone."""
import json
import uuid

import pytest
from starlette.testclient import TestClient

from serve import common
from serve.routes import projects as projects_mod
from serve.server import app

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    common._project_dir_cache.clear()
    return tmp_path


def _project(ws, folder, pid):
    d = ws / folder
    d.mkdir(parents=True)
    (d / "project.json").write_text(json.dumps({"version": "0.2", "id": pid, "status": "pending", "tracks": [], "sources": []}))
    return d


class _Proc:
    def __init__(self):
        self.returncode = None
        self.killed = False
        self.pid = 2 ** 22 + 12345   # no such process: kill_tree falls back to kill()

    def kill(self):
        self.killed = True
        self.returncode = -9


def test_two_folders_with_one_id_delete_only_the_one_asked_for(workspace):
    pid = str(uuid.uuid4())
    a, b = _project(workspace, "a-copy", pid), _project(workspace, "b-orig", pid)
    r = client.delete(f"/api/projects/{pid}")
    assert r.status_code == 409 and r.json()["detail"]["error"] == "duplicate_project_id"
    assert a.exists() and b.exists()
    # By the folder's name, or its path; one that is none of them is still the refusal.
    assert client.delete(f"/api/projects/{pid}", params={"folder": "elsewhere"}).status_code == 409
    assert client.delete(f"/api/projects/{pid}", params={"folder": "a-copy"}).status_code == 204
    assert not a.exists() and b.exists()
    assert client.delete(f"/api/projects/{pid}", params={"folder": str(b)}).status_code == 204
    assert not b.exists()


def test_a_repeated_delete_of_one_copy_never_deletes_the_other(workspace):
    pid = str(uuid.uuid4())
    a, b = _project(workspace, "a-copy", pid), _project(workspace, "b-orig", pid)
    assert client.delete(f"/api/projects/{pid}", params={"folder": "a-copy"}).status_code == 204
    again = client.delete(f"/api/projects/{pid}", params={"folder": "a-copy"})
    assert again.status_code == 404, again.text
    assert b.exists() and (b / "project.json").exists()
    # With no folder named, a single remaining claimant is deleted as before.
    assert client.delete(f"/api/projects/{pid}").status_code == 204


def test_a_project_already_gone_answers_404(workspace):
    r = client.delete(f"/api/projects/{uuid.uuid4()}")
    assert r.status_code == 404


def test_delete_kills_the_projects_render_and_steps(workspace, monkeypatch):
    pid = str(uuid.uuid4())
    d = _project(workspace, "p", pid)
    render, step, other = _Proc(), _Proc(), _Proc()
    monkeypatch.setattr(projects_mod, "_render_procs", {pid: render})
    monkeypatch.setattr(projects_mod, "_kill_render_proc", lambda p: p.kill())
    projects_mod._active_renders.add(pid)
    common._project_procs.clear()
    common._project_procs[pid] = {step}
    common._project_procs["someone-else"] = {other}
    r = client.delete(f"/api/projects/{pid}")
    assert r.status_code == 204, r.text
    assert render.killed and step.killed and not other.killed
    assert pid not in projects_mod._active_renders and not d.exists()


def test_a_step_run_tracked_under_its_project_is_listed_while_it_runs_and_not_after(workspace):
    import asyncio
    seen = []

    async def go():
        task = asyncio.ensure_future(common.run_subprocess(
            ["python3", "-c", "import time; time.sleep(0.3)"], timeout=10, track="p1"))
        await asyncio.sleep(0.1)
        seen.append(len(common._project_procs.get("p1", ())))
        await task
        seen.append(len(common._project_procs.get("p1", ())))
    asyncio.run(go())
    assert seen == [1, 0]
