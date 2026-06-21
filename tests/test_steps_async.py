"""Async step execution + job-poll endpoint for POST /api/steps/{name}.

A reserved `_async` field in the step request body switches the runner from
blocking (200 sync wrap_output) to fire-and-forget: the route returns 202 with
a job id and runs the step in a background asyncio task. The result (or error)
is polled via GET /api/steps/jobs/{job_id}.

Invariants under test:
  - _async=true → 202 {job_id, status: running}, no blocking on the subprocess,
  - completed job → {status: done, result: <wrap_output payload>},
  - failed job → {status: error, error: <scrubbed error dict>},
  - unknown job id → 404 {detail: {error: job_not_found, ...}},
  - no _async → unchanged 200 sync behaviour.
"""
import textwrap
import time

import pytest
from starlette.testclient import TestClient

from serve.server import app
import serve.routes.steps as steps_mod
import serve.jobs as jobs_mod


@pytest.fixture(scope="module")
def client():
    """Persistent client.

    Entered as a context manager so Starlette runs ONE long-lived event-loop
    portal for the whole module — a bare TestClient() tears the loop down when
    the POST returns, so the background task would never run. (Task *survival*
    against GC is handled in the route by the module-level _BACKGROUND_TASKS
    strong-reference set, independent of this; the context manager only keeps
    the loop alive across the POST→poll GETs.)
    """
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ── fake steps ───────────────────────────────────────────────────────────────

OK_SRC = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, sys
    # Echo a JSON payload so wrap_output passes it straight through.
    print(json.dumps({"ok": True, "argv": sys.argv[1:]}))
""")

LEAKY_SRC = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    # Simulate an upstream provider echoing the caller's own key in its error.
    key = os.environ.get("OPENAI_API_KEY") or "<none>"
    print(json.dumps({"error": "api_error",
                      "message": "Incorrect API key provided: " + key}),
          file=sys.stderr)
    sys.exit(1)
""")


@pytest.fixture()
def ok_step(tmp_path, monkeypatch):
    py_path = tmp_path / "okstep.py"
    py_path.write_text(OK_SRC)
    schema = {
        "name": "okstep",
        "params": [{"name": "label", "type": "string"}],
        "output": {"type": "file"},
    }
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {"okstep": (schema, py_path)})
    return py_path


@pytest.fixture()
def leaky_step(tmp_path, monkeypatch):
    py_path = tmp_path / "leaky.py"
    py_path.write_text(LEAKY_SRC)
    schema = {"name": "leaky", "params": [], "output": {"type": "file"}}
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {"leaky": (schema, py_path)})
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    return py_path


def _poll_job(client, job_id, *, want_status, tries=200, delay=0.02):
    """Poll the job-status endpoint until it leaves `running` (or timeout)."""
    last = None
    for _ in range(tries):
        resp = client.get(f"/api/steps/jobs/{job_id}")
        last = resp
        if resp.status_code == 200 and resp.json().get("status") != "running":
            return resp
        time.sleep(delay)
    return last


# ── 202 + job lifecycle ──────────────────────────────────────────────────────

def test_async_returns_202_with_job_id(client, ok_step):
    resp = client.post("/api/steps/okstep", json={"_async": True, "label": "hi"})
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert isinstance(body["job_id"], str) and body["job_id"]
    assert body["status"] == "running"


def test_async_done_job_carries_wrap_output_result(client, ok_step):
    resp = client.post("/api/steps/okstep", json={"_async": True, "label": "hi"})
    job_id = resp.json()["job_id"]
    done = _poll_job(client, job_id, want_status="done")
    assert done.status_code == 200, done.text
    payload = done.json()
    assert payload["status"] == "done"
    assert payload["result"]["ok"] is True
    assert "--label" in payload["result"]["argv"]


def test_async_failed_job_carries_scrubbed_error(client, leaky_step):
    resp = client.post("/api/steps/leaky", json={
        "_async": True,
        "credentials": {"openai": {"api_key": "sk-SUPER-SECRET-XYZ"}},
    })
    assert resp.status_code == 202, resp.text
    job_id = resp.json()["job_id"]
    done = _poll_job(client, job_id, want_status="error")
    assert done.status_code == 200, done.text
    payload = done.json()
    assert payload["status"] == "error"
    assert isinstance(payload["error"], dict)
    assert "sk-SUPER-SECRET-XYZ" not in done.text
    assert "[redacted]" in done.text


def test_unknown_job_id_404(client, ok_step):
    resp = client.get("/api/steps/jobs/does-not-exist")
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "job_not_found"


# ── regression: sync path unchanged ──────────────────────────────────────────

def test_sync_path_unchanged_returns_200(client, ok_step):
    resp = client.post("/api/steps/okstep", json={"label": "hi"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert "--label" in body["argv"]
