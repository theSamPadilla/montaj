"""Tests for POST /api/projects/<id>/sources and GET /api/proxies/status.

Three behaviours shipped with the source-ingest route and none had a
route-level test (tests/test_ingest.py only covers lib/ingest.py's
ingest_source, not the server driver around it):

  1. `_run_ingest_detached`'s persist-then-enqueue ordering: the new clip must
     be appended to project["sources"] AND WRITTEN to project.json before
     `_ensure_current_proxies` is called, because that function resolves its
     write-back targets by re-reading project.json from disk and matching on
     (item_id, item_src). Enqueue-before-persist means the encode lands with
     nowhere to write its proxySrc.
  2. `ingest_source` is always called with proxy=False — the encode is moved
     off the request path onto the background queue, not run inline.
  3. GET /api/proxies/status counts only kind == "proxy" units and never
     errors, since a mounted UI component polls it every few seconds.

Conventions follow tests/test_render_name_cover.py and
tests/test_look_migration.py: the async detached-job coroutine is driven
directly with `asyncio.run` (no real ffmpeg — ingest_source and
_ensure_current_proxies are monkeypatched), and the module-level
look-migration queue is reset by an autouse fixture so these tests can't
leak state into the rest of the suite.
"""
import asyncio
import json
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import serve.routes.projects as projects_mod
from serve.routes.projects import _IngestJob, _run_ingest_detached
from serve.server import app
from serve.sse import SSEBroadcaster

client = TestClient(app, raise_server_exceptions=False)

PID = "77777777-7777-4777-8777-777777777777"


@pytest.fixture(autouse=True)
def _clean_look_migration_state():
    """The look-migration queue is module-level (serve/routes/projects.py);
    GET /api/proxies/status reads it directly. Reset to the empty baseline
    before and after every test so nothing here leaks into unrelated tests
    (mirrors tests/test_look_migration.py and test_render_name_cover.py)."""
    projects_mod._look_migration_queue.clear()
    projects_mod._look_migration_current = None
    projects_mod._look_migration_worker = None
    yield
    projects_mod._look_migration_queue.clear()
    projects_mod._look_migration_current = None
    projects_mod._look_migration_worker = None


def _write_project(project_dir: Path, sources=None) -> None:
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "project.json").write_text(json.dumps({
        "version": "0.2",
        "id": PID,
        "status": "final",
        "workflow": "default",
        "editingPrompt": "test",
        "settings": {"resolution": [1080, 1920], "fps": 30, "colorSpace": "sdr-bt709"},
        "sources": sources if sources is not None else [],
        "tracks": [],
        "assets": [],
        "audio": {},
    }))


# ---------------------------------------------------------------------------
# 1. Persist-then-enqueue ordering (the money test)
# ---------------------------------------------------------------------------

def test_ingest_persists_clip_before_enqueueing_proxy(tmp_path, monkeypatch):
    """`_ensure_current_proxies` must see the new clip both in the `project`
    dict it's handed AND on disk — the latter is the assertion that actually
    distinguishes correct code from the append/write-before-enqueue bug,
    because the `project` dict is mutated in memory before either the write
    or the enqueue call, so a dict-only check would pass even if the on-disk
    write happened AFTER the enqueue."""
    project_dir = tmp_path / "proj"
    _write_project(project_dir)

    staged_src = str(tmp_path / "staged-clip.mp4")

    def fake_ingest_source(*args, **kwargs):
        return {"type": "video", "src": staged_src, "start": 0.0, "end": 0.0,
                "sourceDuration": 5.0}

    monkeypatch.setattr(projects_mod, "ingest_source", fake_ingest_source)

    captured = {}

    def fake_ensure_current_proxies(project_id, project_dir_arg, project, broadcaster):
        # What the in-memory project dict looks like at call time.
        captured["project_arg_sources"] = list(project.get("sources") or [])
        # What's ACTUALLY on disk at call time — this is the assertion that
        # fails if _ensure_current_proxies is enqueued before the write lands.
        on_disk = json.loads((Path(project_dir_arg) / "project.json").read_text())
        captured["on_disk_sources"] = on_disk.get("sources") or []
        return {"scheduled": 1, "alreadyFresh": 0}

    monkeypatch.setattr(projects_mod, "_ensure_current_proxies", fake_ensure_current_proxies)

    job = _IngestJob()
    broadcaster = SSEBroadcaster()

    asyncio.run(_run_ingest_detached(
        PID, project_dir, "/some/input.mp4", "sdr-bt709", broadcaster, job,
    ))

    assert job.status == "done", job.error
    assert "on_disk_sources" in captured, "_ensure_current_proxies was never called"

    assert len(captured["on_disk_sources"]) == 1
    assert captured["on_disk_sources"][0]["src"] == staged_src

    assert len(captured["project_arg_sources"]) == 1
    assert captured["project_arg_sources"][0]["src"] == staged_src

    # And the on-disk project.json still has it after the job finished.
    final = json.loads((project_dir / "project.json").read_text())
    assert [s["src"] for s in final["sources"]] == [staged_src]


# ---------------------------------------------------------------------------
# 2. ingest_source is always called with proxy=False
# ---------------------------------------------------------------------------

def test_ingest_calls_ingest_source_with_proxy_false(tmp_path, monkeypatch):
    project_dir = tmp_path / "proj"
    _write_project(project_dir)

    calls = []

    def fake_ingest_source(*args, **kwargs):
        calls.append((args, kwargs))
        return {"type": "video", "src": str(tmp_path / "staged.mp4"), "start": 0.0, "end": 0.0}

    monkeypatch.setattr(projects_mod, "ingest_source", fake_ingest_source)
    monkeypatch.setattr(
        projects_mod, "_ensure_current_proxies",
        lambda *a, **k: {"scheduled": 0, "alreadyFresh": 0},
    )

    job = _IngestJob()
    asyncio.run(_run_ingest_detached(
        PID, project_dir, "/some/input.mp4", "sdr-bt709", SSEBroadcaster(), job,
    ))

    assert job.status == "done", job.error
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert kwargs.get("proxy") is False, f"expected proxy=False, got args={args!r} kwargs={kwargs!r}"


# ---------------------------------------------------------------------------
# 3. GET /api/proxies/status
# ---------------------------------------------------------------------------

def test_proxies_status_empty_queue_is_zeros():
    resp = client.get("/api/proxies/status")
    assert resp.status_code == 200
    assert resp.json() == {"running": 0, "queued": 0}


def test_proxies_status_counts_only_proxy_kind():
    projects_mod._look_migration_current = projects_mod._LookMigrationUnit(
        "proxy", "/src.mp4", "/out-proxy.mp4", "sdr-bt709",
    )
    projects_mod._look_migration_queue.extend([
        projects_mod._LookMigrationUnit("proxy", "/a.mp4", "/a-proxy.mp4", "sdr-bt709"),
        projects_mod._LookMigrationUnit("normalize", "/b.mp4", "/b-norm.mp4", "sdr-bt709"),
        projects_mod._LookMigrationUnit("proxy", "/c.mp4", "/c-proxy.mp4", "sdr-bt709"),
    ])

    resp = client.get("/api/proxies/status")
    assert resp.status_code == 200
    # running=1 (the current unit is kind=="proxy"); queued=2 (the two proxy
    # units — the normalize unit must NOT count).
    assert resp.json() == {"running": 1, "queued": 2}


def test_proxies_status_normalize_in_flight_does_not_count_as_running():
    projects_mod._look_migration_current = projects_mod._LookMigrationUnit(
        "normalize", "/src.mp4", "/out-norm.mp4", "sdr-bt709",
    )
    resp = client.get("/api/proxies/status")
    assert resp.status_code == 200
    assert resp.json() == {"running": 0, "queued": 0}


def test_proxies_status_never_errors_on_uninitialised_queue(monkeypatch):
    # Simulate a broken/uninitialised queue (e.g. None instead of a list) —
    # the route must degrade to zeros, never 500, since it's polled on a timer.
    monkeypatch.setattr(projects_mod, "_look_migration_queue", None)
    resp = client.get("/api/proxies/status")
    assert resp.status_code == 200
    assert resp.json() == {"running": 0, "queued": 0}


# ---------------------------------------------------------------------------
# 4. Post-init auto-queue: a successful /api/run that deferred its proxies
#    triggers _ensure_current_proxies once, on the freshly-created project.
# ---------------------------------------------------------------------------

class _CapturedInitProc:
    """Minimal stand-in for the init subprocess: succeeds, emits a project path."""
    def __init__(self, project_json):
        self.returncode = 0
        self._out = f"{project_json}\n".encode()

    async def communicate(self):
        return self._out, b""

    async def wait(self):
        return 0

    def kill(self):
        pass


def test_post_init_auto_queues_deferred_proxies(tmp_path, monkeypatch):
    project_json = tmp_path / "initproj" / "project.json"
    project_json.parent.mkdir(parents=True, exist_ok=True)
    project_json.write_text(json.dumps({"version": "0.2", "id": "init-pid", "status": "pending"}))

    async def _fake_exec(*args, **kwargs):
        return _CapturedInitProc(project_json)

    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", _fake_exec)

    calls = []

    def fake_ensure_current_proxies(project_id, project_dir_arg, project, broadcaster):
        calls.append((project_id, project_dir_arg, project))
        return {"scheduled": 1, "alreadyFresh": 0}

    monkeypatch.setattr(projects_mod, "_ensure_current_proxies", fake_ensure_current_proxies)

    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    resp = client.post("/api/run", json={
        "workflow": "clean_cut", "prompt": "clean it", "clips": [str(clip)],
    })
    assert resp.status_code == 201, resp.text

    assert len(calls) == 1
    called_id, called_dir, called_project = calls[0]
    assert called_id == "init-pid"
    assert Path(called_dir) == project_json.parent
    assert called_project["id"] == "init-pid"
