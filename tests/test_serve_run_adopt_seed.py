"""§631: POST /api/run with `adoptSeed` turns the seed project `id` into the real
project in place (project/init.py --adopt-seed), holding the project's lock while
init runs. Run through the route, init in its real subprocess."""
import hashlib
import json
import threading
import time
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve.server import app
from serve.sse import SSEBroadcaster
import serve.routes.projects as projects_mod
from lib.project_lock import ProjectLockTimeout, project_lock, project_lock_async

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    ws = (tmp_path / "ws").resolve()
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    monkeypatch.setattr("serve.routes.projects.resolve_workspace", lambda: ws)
    monkeypatch.setattr("serve.common.resolve_workspace", lambda: ws)
    monkeypatch.setattr(app.state, "broadcaster", SSEBroadcaster(), raising=False)
    return ws


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _make_seed(ws):
    """A seed as the app makes one: a blank project through the route, then seed
    and a source written into its project.json."""
    seed_id = str(uuid.uuid4())
    r = client.post("/api/run", json={"prompt": "seed", "workflow": "blank", "id": seed_id})
    assert r.status_code == 201, r.text
    pj = next(ws.rglob("project.json"))
    project = json.loads(pj.read_text())
    project.update({
        "seed": True, "status": "draft",
        "sources": [{"id": "take-1", "type": "audio", "src": "take-1.m4a", "kind": "take"}],
    })
    pj.write_text(json.dumps(project, indent=2))
    return seed_id, pj


def _adopt_body(seed_id, **extra):
    return {"prompt": "make it good", "workflow": "blank", "id": seed_id, "adoptSeed": True, **extra}


def test_adopt_keeps_folder_and_sources_and_drops_seed(workspace):
    seed_id, pj = _make_seed(workspace)
    r = client.post("/api/run", json=_adopt_body(seed_id))
    assert r.status_code == 201, r.text
    assert r.json()["id"] == seed_id
    assert [p.parent for p in workspace.rglob("project.json")] == [pj.parent]
    after = json.loads(pj.read_text())
    assert after["id"] == seed_id
    assert "seed" not in after
    assert [s["id"] for s in after["sources"]] == ["take-1"]
    assert r.json() == after or r.json()["id"] == after["id"]


def test_adopt_broadcasts_the_new_project(workspace):
    seed_id, pj = _make_seed(workspace)
    published = []
    app.state.broadcaster.publish = lambda pid, frame: published.append((pid, frame))
    r = client.post("/api/run", json=_adopt_body(seed_id))
    assert r.status_code == 201, r.text
    frames = [f for pid, f in published if pid == seed_id]
    assert frames and '"seed"' not in frames[0] and seed_id in frames[0]


@pytest.mark.parametrize("extra,code,status", [
    ({"adoptSeed": "yes"}, "invalid_field", 400),
    ({"adoptSeed": 1}, "invalid_field", 400),
    ({"projectPath": "x/y"}, "invalid_field", 400),
    ({"clipUrls": ["https://youtu.be/dQw4w9WgXcQ"]}, "invalid_field", 400),
    ({"remoteClips": [{"url": "https://example.com/a.mp4"}]}, "invalid_field", 400),
    ({"remoteAssets": [{"url": "https://example.com/a.png"}]}, "invalid_field", 400),
    ({"workflow": "carousel"}, "adopt_unsupported", 400),
])
def test_refusals_leave_project_json_byte_identical(workspace, extra, code, status):
    seed_id, pj = _make_seed(workspace)
    before = _digest(pj)
    body = _adopt_body(seed_id, **extra)
    if extra.get("workflow") == "carousel":
        body["carouselAspect"] = "4:5"
    r = client.post("/api/run", json=body)
    assert r.status_code == status, r.text
    assert r.json()["detail"]["error"] == code
    assert _digest(pj) == before


def test_adopt_needs_an_id(workspace):
    seed_id, pj = _make_seed(workspace)
    before = _digest(pj)
    body = _adopt_body(seed_id)
    del body["id"]
    r = client.post("/api/run", json=body)
    assert r.status_code == 400 and r.json()["detail"]["error"] == "missing_field"
    assert _digest(pj) == before


def test_adopt_unknown_id_is_404(workspace):
    _make_seed(workspace)
    r = client.post("/api/run", json=_adopt_body(str(uuid.uuid4())))
    assert r.status_code == 404 and r.json()["detail"]["error"] == "adopt_not_found"


def test_adopt_of_a_non_seed_is_400_and_untouched(workspace):
    seed_id, pj = _make_seed(workspace)
    project = json.loads(pj.read_text())
    project.pop("seed")
    pj.write_text(json.dumps(project))
    before = _digest(pj)
    r = client.post("/api/run", json=_adopt_body(seed_id))
    assert r.status_code == 400 and r.json()["detail"]["error"] == "adopt_refused"
    assert _digest(pj) == before


def test_adopt_holds_the_project_lock_while_init_runs(workspace, monkeypatch):
    """A save arriving mid-adopt waits for it: the lock is held across the init
    subprocess, by a thread, so a task on the loop thread cannot reenter it."""
    seed_id, pj = _make_seed(workspace)
    seen = {}
    real = projects_mod.run_subprocess

    async def spy(cmd, **kw):
        # Inside init's run: the lock must be taken by another thread.
        got = threading.Event()

        def probe():
            try:
                with project_lock(pj, timeout=0.2):
                    seen["free"] = True
            except Exception as exc:
                seen["busy"] = type(exc).__name__
            got.set()

        t = threading.Thread(target=probe)
        t.start()
        t.join()
        # And from this very event-loop thread (a PUT or an ingest is such a
        # task): the lock is not reentrant here, it waits and times out.
        try:
            async with project_lock_async(pj, timeout=0.2):
                seen["loop_free"] = True
        except ProjectLockTimeout:
            seen["loop_busy"] = True
        return await real(cmd, **kw)

    monkeypatch.setattr(projects_mod, "run_subprocess", spy)
    r = client.post("/api/run", json=_adopt_body(seed_id))
    assert r.status_code == 201, r.text
    assert seen == {"busy": "ProjectLockTimeout", "loop_busy": True}
    # Released afterwards.
    with project_lock(pj, timeout=1):
        pass


def test_non_adopt_create_is_unchanged(workspace):
    r = client.post("/api/run", json={"prompt": "plain", "workflow": "blank"})
    assert r.status_code == 201, r.text
    assert "seed" not in r.json()
    assert len(list(workspace.rglob("project.json"))) == 1


# ---------------------------------------------------------------------------
# Review fixes
# ---------------------------------------------------------------------------

import asyncio
import os
import signal
import sys as _sys

import lib.project_lock as project_lock_mod
from serve.common import run_subprocess


def _seed_with_take_file(ws):
    """`_make_seed`, with the take really on disk: (id, project.json, take path)."""
    seed_id, pj = _make_seed(ws)
    take = pj.parent / "take-1.m4a"
    take.write_bytes(b"recorded take bytes")
    return seed_id, pj, take


def test_adopt_into_a_footage_workflow_with_no_new_clips(workspace):
    """overlays requires clips; an adopt's footage is the seed's takes, so it is
    neither refused `clips_required` nor made a --canvas project."""
    seed_id, pj, take = _seed_with_take_file(workspace)
    sources_before = json.loads(pj.read_text())["sources"]
    take_before = _digest(take)
    r = client.post("/api/run", json=_adopt_body(seed_id, workflow="overlays"))
    assert r.status_code == 201, r.text
    after = json.loads(pj.read_text())
    assert after["workflow"] == "overlays" and "seed" not in after
    assert after["sources"] == sources_before                    # verbatim
    assert _digest(take) == take_before


def test_adopt_does_not_pass_canvas(workspace, monkeypatch):
    seed_id, pj, _take = _seed_with_take_file(workspace)
    seen = []
    real = projects_mod.run_subprocess

    async def spy(cmd, **kw):
        seen.append(list(cmd))
        return await real(cmd, **kw)
    monkeypatch.setattr(projects_mod, "run_subprocess", spy)
    r = client.post("/api/run", json=_adopt_body(seed_id, workflow="overlays"))
    assert r.status_code == 201, r.text
    [cmd] = seen
    assert "--adopt-seed" in cmd and "--canvas" not in cmd


def test_an_ingest_waits_past_the_default_lock_timeout(tmp_path, monkeypatch):
    """An adopt may hold the lock for a whole init: the ingest's append waits for
    it rather than failing at the default timeout (cut to 0.2 s here, the lock
    held 0.8 s), and the take reaches `sources`."""
    monkeypatch.setattr(project_lock_mod, "DEFAULT_TIMEOUT", 0.2)
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    pj = project_dir / "project.json"
    pj.write_text(json.dumps({"id": "p1", "settings": {"colorSpace": "sdr_bt709"}, "sources": [], "tracks": []}))
    staged = str(project_dir / "take-2.mp4")
    monkeypatch.setattr(projects_mod, "ingest_source",
                        lambda *a, **k: {"type": "video", "src": staged, "start": 0.0, "end": 0.0})
    monkeypatch.setattr(projects_mod, "_ensure_current_proxies",
                        lambda *a, **k: {"scheduled": 0, "alreadyFresh": 0})

    held, release = threading.Event(), threading.Event()

    def holder():
        with project_lock(pj, timeout=5):
            held.set()
            release.wait(5)
    t = threading.Thread(target=holder)
    t.start()
    held.wait(5)
    threading.Timer(0.8, release.set).start()

    job = projects_mod._IngestJob("p1")
    started = time.monotonic()
    asyncio.run(projects_mod._run_ingest_detached("p1", project_dir, staged, "sdr_bt709", SSEBroadcaster(), job))
    t.join(5)
    assert job.status == "done", job.error
    assert time.monotonic() - started >= 0.7                      # it did wait, past 0.2 s
    assert [s["src"] for s in json.loads(pj.read_text())["sources"]] == [staged]


def test_delete_is_refused_while_an_ingest_runs(workspace, monkeypatch):
    """The recorder writes a take into the seed's folder before the ingest job
    appends it to `sources`: deleting the (still empty-looking) seed meanwhile
    would delete the only copy."""
    seed_id, pj, take = _seed_with_take_file(workspace)
    monkeypatch.setattr(projects_mod, "_ingest_jobs", {})

    async def never_finishes(*a, **k):   # the job stays "running"
        return None
    monkeypatch.setattr(projects_mod, "_run_ingest_detached", never_finishes)
    new_take = pj.parent / "take-2.mp4"
    new_take.write_bytes(b"second take")
    r = client.post(f"/api/projects/{seed_id}/sources", json={"path": str(new_take)})
    assert r.status_code == 202, r.text
    job = projects_mod._ingest_jobs[r.json()["job_id"]]
    assert job.project_id == seed_id

    r = client.delete(f"/api/projects/{seed_id}")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "ingest_running"
    assert new_take.is_file() and take.is_file() and pj.is_file()

    # Another project's ingest does not block this one; a finished job does not either.
    job.project_id = "someone-else"
    assert not projects_mod._ingest_running(seed_id)
    job.project_id = seed_id
    job.status = "done"
    r = client.delete(f"/api/projects/{seed_id}")
    assert r.status_code in (200, 204), r.text
    assert not pj.parent.exists()


def _lock_is_free(pj, timeout=2.0) -> bool:
    out = {}

    def probe():
        try:
            with project_lock(pj, timeout=timeout):
                out["free"] = True
        except ProjectLockTimeout:
            out["free"] = False
    t = threading.Thread(target=probe)
    t.start()
    t.join(timeout + 5)
    return out.get("free", False)


def test_a_cancel_while_waiting_for_the_lock_leaves_it_free(tmp_path):
    """Cancelled while its worker thread still waits for the lock: the worker,
    once it gets the lock, lets go at once instead of holding it for good."""
    pj = tmp_path / "project.json"
    pj.write_text("{}")
    held, release = threading.Event(), threading.Event()

    def other_holder():
        with project_lock(pj, timeout=5):
            held.set()
            release.wait(5)
    t = threading.Thread(target=other_holder)
    t.start()
    held.wait(5)

    async def scenario():
        async def adopt():
            async with projects_mod._hold_project_lock_in_thread(pj):
                await asyncio.sleep(30)
        task = asyncio.create_task(adopt())
        await asyncio.sleep(0.2)                                    # the worker waits on the lock
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    release.set()                                                   # now the worker gets it...
    t.join(5)
    time.sleep(0.3)
    assert _lock_is_free(pj)                                        # ...and lets it go


_CHILD = r"""
import os, signal, sys, time
marks = sys.argv[1]
lock_file = sys.argv[2]
def on_term(*_):
    held = "unknown"
    try:
        import fcntl
        fd = os.open(lock_file, os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            held = "free"
        except OSError:
            held = "held"
    except ImportError:
        pass
    time.sleep(0.5)                       # an undo that takes a moment
    open(os.path.join(marks, "terminated"), "w").write(held)
    sys.exit(1)
signal.signal(signal.SIGTERM, on_term)
open(os.path.join(marks, "started"), "w").write("1")
time.sleep(60)
"""


def _wait_for(path: Path, seconds=10.0):
    deadline = time.monotonic() + seconds
    while not path.exists():
        if time.monotonic() > deadline:
            raise AssertionError(f"{path} never appeared")
        time.sleep(0.02)


@pytest.mark.skipif(_sys.platform == "win32", reason="SIGTERM handler: POSIX (Windows TerminateProcess has none)")
def test_a_cancel_during_an_adopting_init_stops_it_before_the_lock_goes(tmp_path):
    """The init child is terminated (SIGTERM: its undo runs), and the project's
    lock is released only after it has exited, never while it still runs."""
    folder = tmp_path / "seed"
    folder.mkdir()
    pj = folder / "project.json"
    pj.write_text("{}")
    marks = tmp_path / "marks"
    marks.mkdir()
    cmd = [_sys.executable, "-c", _CHILD, str(marks), str(folder / project_lock_mod.LOCK_NAME)]

    async def scenario():
        task = asyncio.create_task(projects_mod._run_init_subprocess(cmd, hold_lock=pj))
        await asyncio.to_thread(_wait_for, marks / "started")
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        # By the time the cancel lands, the child has exited.
        assert (marks / "terminated").exists()

    asyncio.run(scenario())
    assert (marks / "terminated").read_text() == "held"             # still locked while it undid
    assert _lock_is_free(pj)


@pytest.mark.skipif(_sys.platform == "win32", reason="SIGTERM handler: POSIX")
def test_run_subprocess_stop_grace_terminates_on_timeout(tmp_path):
    """With `stop_grace` the timeout sends SIGTERM (the child's undo runs) before
    any kill; without it the child is killed outright, as before."""
    marks = tmp_path / "marks"
    marks.mkdir()
    cmd = [_sys.executable, "-c", _CHILD, str(marks), str(tmp_path / ".lock")]
    with pytest.raises(projects_mod.HTTPException) as e:
        asyncio.run(run_subprocess(cmd, timeout=2, stop_grace=5))
    assert e.value.status_code == 504
    assert (marks / "terminated").exists()

    marks2 = tmp_path / "marks2"
    marks2.mkdir()
    cmd2 = [_sys.executable, "-c", _CHILD, str(marks2), str(tmp_path / ".lock")]
    with pytest.raises(projects_mod.HTTPException):
        asyncio.run(run_subprocess(cmd2, timeout=2))
    assert (marks2 / "started").exists() and not (marks2 / "terminated").exists()


@pytest.mark.skipif(_sys.platform == "win32", reason="SIGTERM handler: POSIX")
def test_run_subprocess_without_stop_grace_leaves_a_cancelled_child_running(tmp_path):
    """Non-adopt behaviour is unchanged: a cancel does not stop the child."""
    marks = tmp_path / "marks"
    marks.mkdir()
    cmd = [_sys.executable, "-c", _CHILD, str(marks), str(tmp_path / ".lock")]
    pids = []
    real_exec = asyncio.create_subprocess_exec

    async def scenario():
        async def spawn(*a, **k):
            proc = await real_exec(*a, **k)
            pids.append(proc.pid)
            return proc
        asyncio.create_subprocess_exec = spawn
        try:
            task = asyncio.create_task(run_subprocess(cmd, timeout=60))
            await asyncio.to_thread(_wait_for, marks / "started")
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            asyncio.create_subprocess_exec = real_exec

    asyncio.run(scenario())
    try:
        os.kill(pids[0], 0)                                          # still alive
        assert not (marks / "terminated").exists()
    finally:
        os.kill(pids[0], signal.SIGKILL)
