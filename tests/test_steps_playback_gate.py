"""§683 through the step route: a heavy step that starts while the editor preview
plays waits for the pause (capped); a light one runs at once; every step runs
niced. The step subprocess is stubbed."""
import json
import sys
import threading
import time
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import serve.routes.projects as projects_mod
import serve.routes.steps as steps_mod
from serve import context as context_store
from serve import playback_gate as gate
from serve.server import app

SCHEMAS = {
    "look": {"name": "look", "description": "d", "input": {"type": "project"}, "output": {"type": "json"},
             "params": [{"name": "project", "type": "path", "description": "p"}]},
    "fake_proj": {"name": "fake_proj", "description": "d", "input": {"type": "project"}, "output": {"type": "json"},
                  "params": [{"name": "project", "type": "path", "description": "p"}]},
}


@pytest.fixture()
def env(tmp_path, monkeypatch):
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-11-02-demo"
    pdir.mkdir(parents=True)
    pid = str(uuid.uuid4())
    (pdir / "project.json").write_text(json.dumps({"id": pid, "tracks": [{"id": "t0", "items": []}]}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    steps_mod._RESERVED_OUTS.clear()
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {k: (v, Path("x.py")) for k, v in SCHEMAS.items()})
    monkeypatch.setattr(gate, "POLL_SEC", 0.01)
    context_store.clear_all()
    ran: list[tuple[float, list[str]]] = []

    async def fake_run(cmd, **kw):
        ran.append((time.monotonic(), list(cmd)))
        return json.dumps({"ok": True}) + "\n", "", 0

    async def fake_queue(*a, **kw):
        return {"scheduled": 0, "alreadyFresh": 0, "probeFailed": []}

    monkeypatch.setattr(steps_mod, "run_subprocess", fake_run)
    monkeypatch.setattr(projects_mod, "_ensure_current_proxies_async", fake_queue)
    yield pid, pdir, ran
    context_store.clear_all()


def _playing(pid, playing):
    context_store.report(pid, {"playheadSec": 1.0, "playing": playing})


def test_a_heavy_step_waits_for_the_pause(env):
    pid, pdir, ran = env
    _playing(pid, True)
    out = {}
    with TestClient(app) as client:
        t = threading.Thread(target=lambda: out.setdefault("r", client.post("/api/steps/look", json={"project": str(pdir)})))
        t.start()
        time.sleep(0.3)
        assert ran == []  # held while the preview plays
        _playing(pid, False)
        t.join(5)
    assert out["r"].status_code == 200 and out["r"].json() == {"ok": True}
    assert len(ran) == 1


def test_a_heavy_step_runs_after_the_cap_even_while_playing(env, monkeypatch):
    pid, pdir, ran = env
    monkeypatch.setattr(gate, "HOLD_CAP_SEC", 0.2)
    _playing(pid, True)
    with TestClient(app) as client:
        r = client.post("/api/steps/look", json={"project": str(pdir)})
    assert r.status_code == 200 and len(ran) == 1


def test_a_light_step_runs_at_once_while_playing(env):
    pid, pdir, ran = env
    _playing(pid, True)
    with TestClient(app) as client:
        t0 = time.monotonic()
        r = client.post("/api/steps/fake_proj", json={"project": str(pdir)})
    assert r.status_code == 200 and time.monotonic() - t0 < gate.HOLD_CAP_SEC / 2
    assert len(ran) == 1


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX nice")
def test_every_step_runs_niced(env):
    pid, pdir, ran = env
    with TestClient(app) as client:
        assert client.post("/api/steps/fake_proj", json={"project": str(pdir)}).status_code == 200
    cmd = ran[0][1]
    assert cmd[0].endswith("nice") and cmd[1:3] == ["-n", str(gate.NICE_LEVEL)] and cmd[3] == sys.executable


def test_the_playback_route_answers_the_play_state(env):
    pid, pdir, ran = env
    with TestClient(app) as client:
        assert client.get("/api/playback").json() == {"playing": False}
        _playing(pid, True)
        assert client.get("/api/playback").json() == {"playing": True}
        _playing(pid, False)
        assert client.get("/api/playback").json() == {"playing": False}


def test_a_background_normalize_waits_for_the_pause(env, monkeypatch):
    pid, pdir, ran = env
    import asyncio as aio
    from serve.jobs import create_job, get_job
    calls = []
    monkeypatch.setattr(steps_mod, "_normalize_sync", lambda *a: calls.append(a) or {"path": "/x.mp4", "skipped": False})

    async def run():
        _playing(pid, True)
        job = create_job("normalize")
        task = aio.create_task(steps_mod.run_normalize_job(job, "/in.mov", "sdr"))
        await aio.sleep(0.2)
        held = list(calls)
        _playing(pid, False)
        await aio.wait_for(task, 2)
        return held, list(calls)

    held, after = aio.run(run())
    assert held == [] and len(after) == 1
