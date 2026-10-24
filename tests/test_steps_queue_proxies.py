"""A step job that ran against a project queues that project's editing proxies
when it finishes (serve/routes/steps.py `_queue_proxies_after_step`): an AI video
step writes its clip onto the first track with no `proxySrc`, and nothing else
would queue one. The step subprocess and the proxy queue are stubbed; no encode
and no vendor is called."""
import json
import threading
import time
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import serve.routes.projects as projects_mod
import serve.routes.steps as steps_mod
from serve.server import app

client = None   # one client for the module, entered: the queue runs in the background after the answer


@pytest.fixture(autouse=True, scope="module")
def _client():
    global client
    with TestClient(app) as c:
        client = c
        yield


def settle(state, n=1, timeout=3.0):
    """The proxy queue runs after the answer: wait until it has queued n projects."""
    end = time.time() + timeout
    while len(state["queued"]) < n and time.time() < end:
        time.sleep(0.01)


def quiet(state, wait=0.3):
    """Wait long enough for a queue that was going to run, then say it did not."""
    time.sleep(wait)
    return state["queued"] == []

SCHEMAS = {
    "fake_gen": {"name": "fake_gen", "description": "d", "input": {"type": "none"}, "output": {"type": "video"},
                 "params": [{"name": "project-id", "type": "string", "description": "p"},
                            {"name": "out", "type": "path", "description": "o"}]},
    "fake_proj": {"name": "fake_proj", "description": "d", "input": {"type": "project"}, "output": {"type": "json"},
                  "params": [{"name": "project", "type": "path", "description": "p"}]},
    "captions": {"name": "captions", "description": "d", "input": {"type": "project"}, "output": {"type": "json"},
                 "params": [{"name": "project", "type": "path", "description": "p"}]},
    "look": {"name": "look", "description": "d", "input": {"type": "project"}, "output": {"type": "json"},
             "params": [{"name": "project", "type": "path", "description": "p"}]},
    "place": {"name": "place", "description": "d", "input": {"type": "project"}, "output": {"type": "json"},
              "params": [{"name": "project", "type": "path", "description": "p"}]},
    "proxy": {"name": "proxy", "description": "d", "input": {"type": "none"}, "output": {"type": "json"},
              "params": [{"name": "project-id", "type": "string", "description": "p"}]},
}


@pytest.fixture()
def env(tmp_path, monkeypatch):
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-16-demo"
    pdir.mkdir(parents=True)
    pid = str(uuid.uuid4())
    (pdir / "project.json").write_text(json.dumps({
        "id": pid,
        "tracks": [{"id": "t0", "items": [{"id": "v1", "type": "video", "src": "/x/clip.mp4",
                                           "start": 0, "end": 2}]}]}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    steps_mod._RESERVED_OUTS.clear()
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {k: (v, Path("x.py")) for k, v in SCHEMAS.items()})
    state = {"rc": 0, "queued": [], "warmed": [], "raise": False, "gate": None}

    async def fake_run(cmd, **kw):
        if state["rc"]:
            return "", '{"error": "vendor_down", "message": "no"}', 1
        return json.dumps({"ok": True}) + "\n", "", 0

    async def fake_queue(project_id, project_dir, project, broadcaster=None):
        if state["raise"]:
            raise RuntimeError("boom")
        state["queued"].append((project_id, Path(project_dir), project))
        return {"scheduled": 1, "alreadyFresh": 0, "probeFailed": []}

    async def fake_warm(srcs):
        if state["gate"] is not None:
            import asyncio
            await asyncio.to_thread(state["gate"].wait)
        state["warmed"].extend(list(srcs))

    monkeypatch.setattr(steps_mod, "run_subprocess", fake_run)
    monkeypatch.setattr(projects_mod, "_ensure_current_proxies_async", fake_queue)
    monkeypatch.setattr(projects_mod, "_warm_proxy_inputs", fake_warm)
    return pid, pdir, state


def test_sync_step_with_project_queues_proxies(env):
    pid, pdir, state = env
    r = client.post("/api/steps/fake_gen", json={"project-id": pid})
    assert r.status_code == 200 and r.json() == {"ok": True}
    settle(state)
    assert len(state["queued"]) == 1
    qid, qdir, qproject = state["queued"][0]
    assert qid == pid and qdir == pdir.resolve() and qproject["tracks"][0]["items"][0]["id"] == "v1"
    assert state["warmed"] == ["/x/clip.mp4"]


def test_async_step_with_project_queues_proxies(env):
    pid, pdir, state = env
    r = client.post("/api/steps/fake_gen", json={"project-id": pid, "_async": True})
    assert r.status_code == 202
    job = client.get(f"/api/steps/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "done"
    settle(state)
    assert [q[0] for q in state["queued"]] == [pid]


def test_project_path_param_queues_proxies(env):
    pid, pdir, state = env
    r = client.post("/api/steps/fake_proj", json={"project": pid})
    assert r.status_code == 200
    settle(state)
    assert [q[1] for q in state["queued"]] == [pdir.resolve()]


def test_step_without_project_queues_nothing(env):
    _, _, state = env
    assert client.post("/api/steps/fake_gen", json={}).status_code == 200
    assert quiet(state)


def test_failed_step_queues_nothing(env):
    pid, _, state = env
    state["rc"] = 1
    assert client.post("/api/steps/fake_gen", json={"project-id": pid}).status_code == 500
    assert quiet(state)


def test_proxy_step_never_triggers_it(env):
    pid, _, state = env
    assert client.post("/api/steps/proxy", json={"project-id": pid}).status_code == 200
    assert quiet(state)


def test_queue_failure_never_changes_the_answer(env):
    pid, _, state = env
    state["raise"] = True
    r = client.post("/api/steps/fake_gen", json={"project-id": pid})
    assert r.status_code == 200 and r.json() == {"ok": True}


@pytest.mark.parametrize("name", ["look", "captions", "place"])
def test_a_step_that_writes_no_tracks_or_not_the_clips_queues_nothing(env, name):
    """§558 land review: look/captions queue nothing (their write-backs would change tracks in the next guarded
    write's window); place does write tracks, so it queues (the next test)."""
    pid, _, state = env
    assert client.post(f"/api/steps/{name}", json={"project": pid}).status_code == 200
    if name == "place":
        settle(state)
        assert len(state["queued"]) == 1
    else:
        assert quiet(state)


def test_the_answer_does_not_wait_for_the_queue(env):
    pid, _, state = env
    state["gate"] = threading.Event()
    try:
        r = client.post("/api/steps/fake_gen", json={"project-id": pid})
        assert r.status_code == 200 and r.json() == {"ok": True}
        assert state["queued"] == [], "the queue is still waiting on its gate"
    finally:
        state["gate"].set()
    settle(state)
    assert len(state["queued"]) == 1
