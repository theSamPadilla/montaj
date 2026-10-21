"""Async step execution + job-poll endpoint for POST /api/steps/{name}.

A reserved `_async` field in the step request body switches the runner from
blocking (200 sync wrap_output) to fire-and-forget: the route returns 202 with
a job id and runs the step in a background asyncio task. The result (or error)
is polled via GET /api/steps/jobs/{job_id}.

Invariants under test:
  - _async=true → 202 {job_id, status: running}, no blocking on the subprocess,
  - completed job → {status: done, result: <wrap_output payload>},
  - failed job → {status: error, error: <scrubbed error dict>},
  - every state carries `step`, the route's own step name (never the body's),
    as itself only for a native step, "custom:<name>" for one from ~/.montaj/steps,
  - unknown job id → 404 {detail: {error: job_not_found, ...}},
  - no _async → unchanged 200 sync behaviour.
"""
import json
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


GATED_SRC = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys, time
    # Runs until the gate file exists, so a test can see the job running.
    gate = os.environ["MONTAJ_TEST_GATE"]
    for _ in range(1000):
        if os.path.exists(gate):
            break
        time.sleep(0.01)
    print(json.dumps({"ok": True}))
""")


@pytest.fixture()
def gated_step(tmp_path, monkeypatch):
    """A step named export_editor that sits in the (patched) native steps folder."""
    native = tmp_path / "montaj" / "steps"
    (native / "render").mkdir(parents=True)
    py_path = native / "render" / "export_editor.py"
    py_path.write_text(GATED_SRC)
    gate = tmp_path / "gate"
    monkeypatch.setenv("MONTAJ_TEST_GATE", str(gate))
    monkeypatch.setattr(steps_mod, "NATIVE_STEPS_DIR", native)
    schema = {"name": "export_editor", "params": [{"name": "label", "type": "string"}], "output": {"type": "json"}}
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {"export_editor": (schema, py_path)})
    return gate


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


def test_the_job_carries_its_step_running_and_done(client, gated_step):
    resp = client.post("/api/steps/export_editor", json={"_async": True, "label": "hi"})
    assert resp.status_code == 202, resp.text
    job_id = resp.json()["job_id"]
    running = client.get(f"/api/steps/jobs/{job_id}").json()
    assert running == {"status": "running", "step": "export_editor"}
    gated_step.write_text("go")
    done = _poll_job(client, job_id, want_status="done").json()
    assert done["status"] == "done" and done["step"] == "export_editor"
    assert done["result"]["ok"] is True


def test_a_failed_job_keeps_its_step(client, leaky_step):
    # leaky lives in a temp folder, not the native steps: it is custom.
    job_id = client.post("/api/steps/leaky", json={"_async": True}).json()["job_id"]
    err = _poll_job(client, job_id, want_status="error").json()
    assert err["status"] == "error" and err["step"] == "custom:leaky"


CUSTOM_EXPORT_SRC = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json
    print(json.dumps({"dir": "/x", "open": "/x/evil.jsx", "openSha256": "0" * 64}))
""")


def test_a_custom_step_shadowing_export_editor_is_recorded_as_custom(client, tmp_path, monkeypatch):
    # The real scan: native steps, then a temp HOME's ~/.montaj/steps.
    home = tmp_path / "home"
    custom = home / ".montaj" / "steps"
    custom.mkdir(parents=True)
    (home / "Montaj").mkdir()
    (custom / "export_editor.json").write_text(json.dumps(
        {"name": "export_editor", "description": "shadow", "params": [], "output": {"type": "json"}}))
    (custom / "export_editor.py").write_text(CUSTOM_EXPORT_SRC)
    monkeypatch.setenv("HOME", str(home))
    assert steps_mod.scan_steps()["export_editor"][1] == custom / "export_editor.py"
    job_id = client.post("/api/steps/export_editor", json={"_async": True}).json()["job_id"]
    assert client.get(f"/api/steps/jobs/{job_id}").json()["step"] == "custom:export_editor"
    done = _poll_job(client, job_id, want_status="done").json()
    assert done["status"] == "done", done
    assert done["step"] == "custom:export_editor"
    assert done["result"]["openSha256"] == "0" * 64, "the custom step ran; only its record is marked"


def test_the_native_export_editor_is_recorded_by_its_name(client, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "empty-home"))
    schema, py_path = steps_mod.scan_steps()["export_editor"]
    assert py_path.resolve().is_relative_to(steps_mod.NATIVE_STEPS_DIR.resolve())
    assert steps_mod.job_step_name("export_editor", py_path) == "export_editor"
    # A project that is not there fails fast, without an export.
    resp = client.post("/api/steps/export_editor", json={"_async": True, "project": str(tmp_path / "nope" / "project.json")})
    job_id = resp.json()["job_id"]
    job = _poll_job(client, job_id, want_status="error").json()
    assert job["status"] == "error" and job["step"] == "export_editor"


def test_a_link_into_the_native_folder_under_another_name_is_custom(tmp_path):
    native_script = next(steps_mod.NATIVE_STEPS_DIR.rglob("export_editor.py"))
    custom = tmp_path / "steps"
    custom.mkdir()
    (custom / "other.py").symlink_to(native_script)
    assert steps_mod.job_step_name("other", custom / "other.py") == "custom:other"
    (custom / "export_editor.py").symlink_to(native_script)
    # The script is native, but the schema beside it is not.
    assert steps_mod.job_step_name("export_editor", custom / "export_editor.py") == "custom:export_editor"


def test_a_body_field_named_step_cannot_change_it(client, gated_step):
    resp = client.post("/api/steps/export_editor", json={"_async": True, "step": "render", "label": "hi"})
    job_id = resp.json()["job_id"]
    assert client.get(f"/api/steps/jobs/{job_id}").json()["step"] == "export_editor"
    gated_step.write_text("go")
    done = _poll_job(client, job_id, want_status="done").json()
    assert done["step"] == "export_editor"


def test_other_jobs_have_no_step():
    job_id = jobs_mod.create_job()
    assert jobs_mod.get_job(job_id) == {"status": "running", "step": None}
    jobs_mod.set_done(job_id, {"path": "/x"})
    assert jobs_mod.get_job(job_id) == {"status": "done", "step": None, "result": {"path": "/x"}}
    jobs_mod.set_error(job_id, {"error": "e"})
    assert jobs_mod.get_job(job_id)["step"] is None


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
