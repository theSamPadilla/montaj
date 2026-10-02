"""PL28: a YouTube link as a create's footage, downloaded by serve in the
background into a top-level `sourceDownload` record (serve/routes/projects.py).

yt-dlp never runs: `_spawn_ytdlp` is monkeypatched. Most tests get a fake
process whose output is a captured run from tests/fixtures/ytdlp. The cancel
and shutdown tests spawn a real `python -c sleep` in its own process group, so
the kill they check is a real kill of a process this test owns. No network.

The detached task is driven inside one `asyncio.run` (as tests/test_server_sources.py
drives `_run_ingest_detached`): a TestClient without `with` runs each request
on its own event loop and cancels whatever that request left running.
"""
import asyncio
import json
import os
import shutil
import sys
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest
from starlette.testclient import TestClient

import serve.routes.projects as projects_mod
from lib.proc import detached_kwargs, pid_alive
from lib.youtube import ytdlp_argv
from serve import jobs, lockfile
from serve.server import app
from serve.sse import SSEBroadcaster

client = TestClient(app, raise_server_exceptions=False)

FIX = Path(__file__).parent / "fixtures" / "ytdlp"
VID = "dQw4w9WgXcQ"
URL = f"https://www.youtube.com/watch?v={VID}"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fixture(name: str) -> tuple[int, str, str]:
    """(exit code, stdout, stderr) of a captured yt-dlp run."""
    text = (FIX / f"{name}.txt").read_text()
    head, rest = text.split("--- stdout\n", 1)
    stdout, stderr = rest.split("--- stderr\n", 1)
    code = int(next(l for l in head.splitlines() if l.startswith("exit:")).split(":", 1)[1])
    return code, stdout, stderr


def _ok_output(project_dir: Path) -> tuple[int, str, str]:
    """The captured successful run, its paths moved into this project."""
    code, out, err = _fixture("ok")
    out = out.replace("/work/bundled-ok", str(project_dir)).replace("jNQXAC9IVRw", VID)
    return code, out, err


def _write_project(project_dir: Path, pid: str, *, status="pending", record=None,
                   sources=None, items=None) -> None:
    project_dir.mkdir(parents=True, exist_ok=True)
    project = {
        "version": "0.2", "id": pid, "status": status, "projectType": "editing",
        "workflow": "broll", "editingPrompt": "find the clips",
        "sources": sources if sources is not None else [],
        "settings": {"resolution": [1920, 1080], "resolutionSource": "default",
                     "fps": 60, "fpsSource": "default", "colorSpace": "sdr_bt709"},
        "tracks": [{"id": "trk-0", "items": items if items is not None else []}],
        "assets": [], "audio": {},
    }
    if record is not None:
        project["sourceDownload"] = record
    (project_dir / "project.json").write_text(json.dumps(project, indent=2))


def _read(project_dir: Path) -> dict:
    return json.loads((project_dir / "project.json").read_text())


class _FakeProc:
    """What `_spawn_ytdlp` returns: canned output on real StreamReaders."""
    pid = None

    def __init__(self, returncode: int, stdout: str, stderr: str):
        self.returncode = None
        self._rc = returncode
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(stdout.encode())
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_data(stderr.encode())
        self.stderr.feed_eof()

    async def wait(self):
        self.returncode = self._rc
        return self._rc


def _stub_spawn(monkeypatch, output, *, writes=()):
    """yt-dlp stub: writes `writes` (as yt-dlp would), then exits with `output`
    ((code, stdout, stderr), or a callable of the argv returning one)."""
    calls: list[list[str]] = []

    async def fake_spawn(argv):
        calls.append(list(argv))
        for path in writes:
            Path(path).write_bytes(b"not really a video")
        result = output(argv) if callable(output) else output
        return _FakeProc(*result)

    monkeypatch.setattr(projects_mod, "_spawn_ytdlp", fake_spawn)
    return calls


def _stub_spawn_blocking(monkeypatch):
    """yt-dlp stub that never returns a process (the task waits until cancelled)."""
    calls: list[list[str]] = []

    async def fake_spawn(argv):
        calls.append(list(argv))
        await asyncio.Event().wait()

    monkeypatch.setattr(projects_mod, "_spawn_ytdlp", fake_spawn)
    return calls


def _stub_spawn_sleeper(monkeypatch):
    """yt-dlp stub that is a real process: a sleeping python in its own group."""
    procs: list = []

    async def fake_spawn(argv):
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "import time; time.sleep(60)",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **detached_kwargs(),
        )
        procs.append(proc)
        return proc

    monkeypatch.setattr(projects_mod, "_spawn_ytdlp", fake_spawn)
    return procs


def _reap_own(procs) -> None:
    """Safety net: never leave a sleeper behind (kills only this test's own pids)."""
    for proc in procs:
        if proc.returncode is None and pid_alive(proc.pid):
            try:
                os.kill(proc.pid, 9)
            except OSError:
                pass


class _Recorder:
    """Broadcaster stand-in: keeps every frame."""
    def __init__(self):
        self.frames: list[tuple[str, str]] = []

    def publish(self, project_id, data):
        self.frames.append((project_id, data))


def _data_frames(rec: _Recorder, pid: str) -> list[dict]:
    out = []
    for project_id, frame in rec.frames:
        if project_id == pid and frame.startswith("data: "):
            out.append(json.loads(frame[len("data: "):]))
    return out


def _download(pid: str, project_dir: Path, broadcaster=None):
    """Start a download the way serve does and wait for its task to end."""
    async def go():
        started = projects_mod._start_source_download(pid, project_dir, URL, VID, broadcaster)
        task = projects_mod._source_download_tasks[pid]
        await task
        return started
    return asyncio.run(go())


async def _passthrough(project_id, project_dir, project, broadcaster=None):
    return project


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _clean_state():
    for name in ("_source_download_tasks", "_source_download_procs"):
        getattr(projects_mod, name, {}).clear()
    projects_mod._look_migration_queue.clear()
    projects_mod._look_migration_current = None
    projects_mod._look_migration_worker = None
    yield
    for name in ("_source_download_tasks", "_source_download_procs"):
        getattr(projects_mod, name, {}).clear()
    projects_mod._look_migration_queue.clear()
    projects_mod._look_migration_current = None
    projects_mod._look_migration_worker = None


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setattr("serve.routes.projects.resolve_workspace", lambda: tmp_path)
    if not hasattr(app.state, "broadcaster"):
        app.state.broadcaster = SSEBroadcaster()
    return tmp_path


@pytest.fixture
def finalize_stubs(monkeypatch):
    """No ffmpeg: ingest, the proxy queue and the dims/canvas heal are recorded."""
    calls = {"ingest": [], "proxies": [], "dims": []}

    def fake_ingest(project_dir, path, color_space, normalize_mode="eager", *, proxy=True, clip_id=None):
        calls["ingest"].append({"path": path, "color_space": color_space,
                                "normalize": normalize_mode, "proxy": proxy})
        return {"type": "video", "src": os.path.abspath(path), "start": 0.0, "end": 0.0,
                "sourceDuration": 212.0, "sourceWidth": 1920, "sourceHeight": 1080}

    async def fake_warm(srcs):
        return None

    def fake_proxies(project_id, project_dir, project, broadcaster=None):
        calls["proxies"].append(_read(Path(project_dir)))
        return {"scheduled": 1, "alreadyFresh": 0}

    async def fake_dims(project_id, project_dir, project, broadcaster=None):
        calls["dims"].append(_read(Path(project_dir)))
        return project

    monkeypatch.setattr(projects_mod, "ingest_source", fake_ingest)
    monkeypatch.setattr(projects_mod, "_warm_proxy_inputs", fake_warm)
    monkeypatch.setattr(projects_mod, "_ensure_current_proxies", fake_proxies)
    monkeypatch.setattr(projects_mod, "ensure_source_dims", fake_dims)
    monkeypatch.setattr(projects_mod, "migrate_project_look", _passthrough)
    monkeypatch.setattr(projects_mod, "ensure_project_color_provenance", _passthrough)
    return calls


class _CapturedProc:
    """The init subprocess: succeeds and prints the project path."""
    def __init__(self, project_json):
        self.returncode = 0
        self._out = f"{project_json}\n".encode()

    async def communicate(self):
        return self._out, b""

    async def wait(self):
        return 0

    def kill(self):
        pass


@pytest.fixture
def init_spy(monkeypatch, workspace):
    """Capture init's argv; init 'creates' a canvas project in the workspace."""
    pid = str(uuid.uuid4())
    project_dir = workspace / "proj"
    _write_project(project_dir, pid)
    captured = {"pid": pid, "dir": project_dir}

    async def fake_exec(*args, **kwargs):
        captured["cmd"] = list(args)
        return _CapturedProc(project_dir / "project.json")

    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", fake_exec)
    return captured


# ---------------------------------------------------------------------------
# POST /api/run with clipUrls
# ---------------------------------------------------------------------------

def test_run_with_a_link_creates_a_canvas_project_with_a_download_record(init_spy, monkeypatch):
    spawned = _stub_spawn_blocking(monkeypatch)
    resp = client.post("/api/run", json={
        "workflow": "broll",
        "prompt": "find the clips",
        "clipUrls": ["https://youtu.be/dQw4w9WgXcQ?si=abc"],
    })
    assert resp.status_code == 201, resp.text
    cmd = init_spy["cmd"]
    assert "--canvas" in cmd
    assert "--clips" not in cmd

    record = resp.json()["sourceDownload"]
    job_id = record["jobId"]
    assert record == {"kind": "youtube", "url": URL, "status": "downloading", "jobId": job_id}
    assert len(job_id) == 32 and int(job_id, 16) >= 0
    assert _read(init_spy["dir"])["sourceDownload"] == record
    assert jobs.get_job(job_id) == {"status": "running"}
    # The task started (and was cancelled with the request's loop; the record
    # stays `downloading`, so the next open resumes it).
    assert len(spawned) == 1


@pytest.mark.parametrize("extra,code,needle", [
    ({"clipUrls": [URL], "clips": ["__CLIP__"]}, "mutually_exclusive", None),
    ({"clipUrls": ["https://www.youtube.com/shorts/dQw4w9WgXcQ"]}, "invalid_clip_url", "Shorts"),
    ({"clipUrls": ["https://vimeo.com/76979871"]}, "invalid_clip_url", None),
    ({"clipUrls": [URL, "https://youtu.be/aqz-KE-bpKQ"]}, "invalid_clip_url", None),
    ({"clipUrls": URL}, "invalid_field", None),
])
def test_run_refuses_a_bad_link(init_spy, tmp_path, extra, code, needle):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    body = {"workflow": "broll", "prompt": "find the clips", **extra}
    if body.get("clips") == ["__CLIP__"]:
        body["clips"] = [str(clip)]
    resp = client.post("/api/run", json=body)
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == code
    if needle:
        assert needle in detail["message"]
    assert "cmd" not in init_spy, "init must not run for a refused link"


# ---------------------------------------------------------------------------
# The task: finalize
# ---------------------------------------------------------------------------

def test_download_on_a_pending_project_puts_the_clip_on_the_timeline(tmp_path, monkeypatch, finalize_stubs):
    pid = str(uuid.uuid4())
    project_dir = tmp_path / "p"
    _write_project(project_dir, pid)
    target = project_dir / f"youtube-{VID}.mp4"
    spawned = _stub_spawn(monkeypatch, _ok_output(project_dir), writes=[target])
    rec = _Recorder()

    started = _download(pid, project_dir, rec)
    job_id = started["sourceDownload"]["jobId"]

    assert spawned == [ytdlp_argv(URL, project_dir, VID)]
    assert finalize_stubs["ingest"] == [{"path": str(target), "color_space": "sdr_bt709",
                                         "normalize": "lazy", "proxy": False}]
    project = _read(project_dir)
    clip = {"id": "clip-0", "type": "video", "src": str(target), "start": 0.0, "end": 0.0,
            "sourceDuration": 212.0, "sourceWidth": 1920, "sourceHeight": 1080}
    assert project["sources"] == [clip]
    assert project["tracks"][0]["items"] == [clip]
    assert project["sourceDownload"] == {"kind": "youtube", "url": URL, "status": "done", "clipId": "clip-0"}
    assert project["status"] == "pending"

    # The proxy is queued and the canvas heal runs only once the clip is on disk.
    assert finalize_stubs["proxies"] and finalize_stubs["proxies"][0]["sources"] == [clip]
    assert finalize_stubs["dims"] and finalize_stubs["dims"][0]["sourceDownload"]["status"] == "done"

    # The agent's wait: GET /api/steps/jobs/<jobId>, which get_step_result polls.
    resp = client.get(f"/api/steps/jobs/{job_id}")
    assert resp.status_code == 200
    assert resp.json() == {"status": "done", "result": clip}

    # The editor learns over the project's SSE stream.
    frames = _data_frames(rec, pid)
    assert frames[0]["sourceDownload"]["status"] == "downloading"
    assert any(f.get("sourceDownload", {}).get("status") == "done" and f["sources"] == [clip] for f in frames)


def test_download_on_a_draft_project_adds_the_source_only(tmp_path, monkeypatch, finalize_stubs):
    pid = str(uuid.uuid4())
    project_dir = tmp_path / "p"
    _write_project(project_dir, pid, status="draft")
    target = project_dir / f"youtube-{VID}.mp4"
    _stub_spawn(monkeypatch, _ok_output(project_dir), writes=[target])

    _download(pid, project_dir)

    project = _read(project_dir)
    assert [s["src"] for s in project["sources"]] == [str(target)]
    assert project["tracks"][0]["items"] == []
    assert project["sourceDownload"]["status"] == "done"
    assert project["sourceDownload"]["clipId"] == project["sources"][0]["id"]


def _reopen(pid: str, project_dir: Path):
    """GET /projects/{id} the way serve runs it, then wait for any task it started."""
    async def go():
        project = await projects_mod.get_project(pid, None, project_dir)
        task = projects_mod._source_download_tasks.get(pid)
        if task is not None:
            await task
        return project
    return asyncio.run(go())


def test_a_stale_save_then_an_open_finalizes_once(workspace, monkeypatch, finalize_stubs):
    pid = str(uuid.uuid4())
    project_dir = workspace / "stale"
    _write_project(project_dir, pid)
    target = project_dir / f"youtube-{VID}.mp4"
    spawned = _stub_spawn(monkeypatch, _ok_output(project_dir), writes=[target])
    _download(pid, project_dir)
    first = _read(project_dir)
    old_job = "0" * 32

    # An editor save from a copy older than the finalize puts the record back.
    resp = client.put(f"/api/projects/{pid}", json={
        "id": pid,
        "sourceDownload": {"kind": "youtube", "url": URL, "status": "downloading", "jobId": old_job},
    })
    assert resp.status_code == 200, resp.text

    opened = _reopen(pid, project_dir)
    assert opened["sourceDownload"]["status"] == "downloading"
    assert opened["sourceDownload"]["jobId"] != old_job

    project = _read(project_dir)
    assert len(spawned) == 1, "the complete file is reused, yt-dlp does not run again"
    assert project["sources"] == first["sources"]
    assert project["tracks"][0]["items"] == first["tracks"][0]["items"]
    assert project["sourceDownload"] == {"kind": "youtube", "url": URL, "status": "done", "clipId": "clip-0"}


def test_a_stale_save_that_dropped_the_clip_gets_it_back_once(workspace, monkeypatch, finalize_stubs):
    pid = str(uuid.uuid4())
    project_dir = workspace / "dropped"
    _write_project(project_dir, pid)
    target = project_dir / f"youtube-{VID}.mp4"
    _stub_spawn(monkeypatch, _ok_output(project_dir), writes=[target])
    _download(pid, project_dir)

    resp = client.put(f"/api/projects/{pid}", json={
        "id": pid, "sources": [], "tracks": [{"id": "trk-0", "items": []}],
        "sourceDownload": {"kind": "youtube", "url": URL, "status": "downloading", "jobId": "1" * 32},
    })
    assert resp.status_code == 200, resp.text

    _reopen(pid, project_dir)
    _reopen(pid, project_dir)  # a second open is a no-op on a `done` record

    project = _read(project_dir)
    assert [s["src"] for s in project["sources"]] == [str(target)]
    assert [i["src"] for i in project["tracks"][0]["items"]] == [str(target)]
    assert project["sourceDownload"]["status"] == "done"


# ---------------------------------------------------------------------------
# The task: failure
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("fixture,code", [
    ("unavailable", "unavailable"),
    ("too_long", "too_long"),
    ("too_large", "too_large"),
])
def test_failure_marks_the_record_and_removes_partials(tmp_path, monkeypatch, finalize_stubs, fixture, code):
    pid = str(uuid.uuid4())
    project_dir = tmp_path / "p"
    _write_project(project_dir, pid)
    keep = [project_dir / "clip.mp4", project_dir / "youtube-AAAAAAAAAAA.mp4"]
    for path in keep:
        path.write_bytes(b"x")
    partials = [project_dir / f"youtube-{VID}.f299.mp4.part",
                project_dir / f"youtube-{VID}.f299.mp4.ytdl",
                project_dir / f"youtube-{VID}.f258.m4a"]
    _stub_spawn(monkeypatch, _fixture(fixture), writes=partials)

    started = _download(pid, project_dir)
    job_id = started["sourceDownload"]["jobId"]

    project = _read(project_dir)
    assert project["sourceDownload"] == {"kind": "youtube", "url": URL, "status": "failed", "error": code}
    assert project["sources"] == [] and project["tracks"][0]["items"] == []
    assert finalize_stubs["ingest"] == []
    job = jobs.get_job(job_id)
    assert job["status"] == "error"
    assert job["error"]["error"] == code
    assert isinstance(job["error"]["message"], str) and job["error"]["message"]
    assert sorted(project_dir.glob(f"youtube-{VID}*")) == []
    assert all(path.exists() for path in keep)


# ---------------------------------------------------------------------------
# Resume on open
# ---------------------------------------------------------------------------

def test_open_resumes_a_dropped_download_with_one_task(tmp_path, monkeypatch, finalize_stubs):
    pid = str(uuid.uuid4())
    project_dir = tmp_path / "p"
    stale = "f" * 32
    _write_project(project_dir, pid, record={"kind": "youtube", "url": URL,
                                             "status": "downloading", "jobId": stale})
    spawned = _stub_spawn_blocking(monkeypatch)

    async def go():
        a, b = await asyncio.gather(
            projects_mod.get_project(pid, None, project_dir),
            projects_mod.get_project(pid, None, project_dir),
        )
        for _ in range(10):
            await asyncio.sleep(0)
        live = [t for t in projects_mod._source_download_tasks.values() if not t.done()]
        return a, b, len(live)

    a, b, live = asyncio.run(go())

    record = _read(project_dir)["sourceDownload"]
    assert record["status"] == "downloading"
    assert record["jobId"] != stale
    assert jobs.get_job(record["jobId"]) == {"status": "running"}
    assert live == 1
    assert len(spawned) == 1
    assert a["sourceDownload"] == record
    assert b["sourceDownload"] == record


@pytest.mark.parametrize("record", [
    {"kind": "youtube", "url": URL, "status": "done", "clipId": "clip-0"},
    {"kind": "youtube", "url": URL, "status": "failed", "error": "blocked"},
])
def test_open_leaves_a_finished_record_alone(tmp_path, monkeypatch, finalize_stubs, record):
    pid = str(uuid.uuid4())
    project_dir = tmp_path / "p"
    _write_project(project_dir, pid, record=record)
    spawned = _stub_spawn_blocking(monkeypatch)

    opened = _reopen(pid, project_dir)

    assert spawned == []
    assert opened["sourceDownload"] == record
    assert _read(project_dir)["sourceDownload"] == record


# ---------------------------------------------------------------------------
# Cancel on delete, kill on shutdown
# ---------------------------------------------------------------------------

async def _wait_for_proc(pid: str):
    for _ in range(400):
        proc = projects_mod._source_download_procs.get(pid)
        if proc is not None:
            return proc
        await asyncio.sleep(0.025)
    raise AssertionError("the download never spawned")


def test_delete_kills_the_download_before_removing_the_folder(tmp_path, monkeypatch):
    pid = str(uuid.uuid4())
    project_dir = tmp_path / "del"
    _write_project(project_dir, pid)
    procs = _stub_spawn_sleeper(monkeypatch)

    real_rmtree = shutil.rmtree
    seen = {}

    def spy_rmtree(path, *args, **kwargs):
        if Path(path) == project_dir:
            seen["returncode"] = procs[0].returncode
            seen["alive"] = pid_alive(procs[0].pid)
        return real_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(projects_mod.shutil, "rmtree", spy_rmtree)

    async def go():
        projects_mod._start_source_download(pid, project_dir, URL, VID, None)
        proc = await _wait_for_proc(pid)
        task = projects_mod._source_download_tasks[pid]
        resp = await projects_mod.delete_project(pid, preserve_assets=False, project_dir=project_dir)
        return proc, task, resp

    try:
        proc, task, resp = asyncio.run(go())
    finally:
        _reap_own(procs)

    assert resp.status_code == 204
    assert seen, "the project folder was never removed"
    assert seen["returncode"] is not None, "yt-dlp was still running when the folder was removed"
    assert seen["alive"] is False
    assert task.done()
    assert not project_dir.exists()
    assert pid not in projects_mod._source_download_procs


def test_shutdown_kills_live_downloads_and_keeps_the_record_resumable(tmp_path, monkeypatch):
    import serve.server as server_mod

    pid = str(uuid.uuid4())
    project_dir = tmp_path / "ws" / "shut"
    _write_project(project_dir, pid)
    procs = _stub_spawn_sleeper(monkeypatch)
    monkeypatch.setattr(lockfile, "_lockfile_path", lambda: tmp_path / "serve.json")
    monkeypatch.setattr(server_mod, "resolve_workspace", lambda: tmp_path / "ws")
    monkeypatch.setattr(server_mod, "HEADLESS", True)

    async def drive():
        with patch("serve.server.ProjectWatcher"), patch("serve.server.GlobalOverlayWatcher"):
            async with server_mod.lifespan(server_mod.app):
                projects_mod._start_source_download(pid, project_dir, URL, VID, None)
                proc = await _wait_for_proc(pid)
        returncode = await asyncio.wait_for(proc.wait(), timeout=5)
        await asyncio.sleep(0.1)  # let the cancelled task unwind
        return proc, returncode

    try:
        proc, returncode = asyncio.run(drive())
    finally:
        _reap_own(procs)

    assert returncode is not None
    assert not pid_alive(proc.pid)
    record = _read(project_dir)["sourceDownload"]
    assert record["status"] == "downloading", "a quit must leave the download to resume on open"
