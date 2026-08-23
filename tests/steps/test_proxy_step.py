"""Tests for steps/transform/proxy.py and POST /api/proxy.

Step CLI tests run a real (tiny) ffmpeg encode against the shared lavfi SDR
fixture (tests/conftest.py's `test_video`) — same approach as
tests/steps/test_normalize_window.py and tests/test_proxy.py. Endpoint tests
drive the same step through the actual HTTP route (no mocking of scan_steps)
to prove the job-pattern wiring end to end: 202 + job_id -> poll
GET /api/steps/jobs/{id} -> done, plus the fresh-skip short-circuit.
"""
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from tests.conftest import REPO_ROOT, assert_error, assert_file_output, run_step

HAS_FFMPEG = shutil.which("ffmpeg") is not None
pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")


# ── step CLI ─────────────────────────────────────────────────────────────────

def test_proxy_step_basic(test_video, tmp_path):
    """Step encodes an all-intra H.264+Opus 720p proxy and prints the output path."""
    out = tmp_path / "proxy.mp4"
    proc = run_step(
        "proxy.py",
        "--input", str(test_video),
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    result = assert_file_output(proc)
    assert result == out

    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", str(out)],
        capture_output=True, text=True, timeout=30,
    )
    assert r.returncode == 0, r.stderr
    streams = json.loads(r.stdout)["streams"]
    video = next(s for s in streams if s["codec_type"] == "video")
    audio = next(s for s in streams if s["codec_type"] == "audio")
    assert video["codec_name"] == "h264"
    assert audio["codec_name"] == "opus"
    assert video["height"] == 720  # test_video is 640x480 landscape


def test_proxy_step_missing_input(tmp_path):
    """Step fails with a structured JSON error when the input file is absent."""
    out = tmp_path / "out.mp4"
    proc = run_step(
        "proxy.py",
        "--input", "/no/such/file.mp4",
        "--out", str(out),
    )
    assert_error(proc, "file_not_found")


def test_proxy_step_help():
    """Step's argparse --help exits cleanly (exit 0)."""
    script = REPO_ROOT / "steps" / "transform" / "proxy.py"
    r = subprocess.run([sys.executable, str(script), "--help"], capture_output=True, text=True)
    assert r.returncode == 0
    assert "--input" in r.stdout
    assert "--tonemap" in r.stdout
    assert "--out" in r.stdout


# ── POST /api/proxy — job pattern ───────────────────────────────────────────

@pytest.fixture(scope="module")
def client():
    """Persistent client (context-managed so the background job's asyncio
    task survives across the POST and the follow-up poll GETs — same
    reasoning as tests/test_steps_async.py's `client` fixture)."""
    from serve.server import app
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _poll_job(client, job_id, *, tries=300, delay=0.05):
    """Poll the job-status endpoint until it leaves `running` (or timeout)."""
    last = None
    for _ in range(tries):
        resp = client.get(f"/api/steps/jobs/{job_id}")
        last = resp
        if resp.status_code == 200 and resp.json().get("status") != "running":
            return resp
        time.sleep(delay)
    return last


def test_proxy_endpoint_missing_input_400(client):
    resp = client.post("/api/proxy", json={"input": "/no/such/file.mp4"})
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"]["error"] == "missing_input"


def test_proxy_endpoint_job_lifecycle(client, test_video, tmp_path):
    """POST /api/proxy -> 202 + job_id -> poll GET /api/steps/jobs/{id} -> done."""
    out = tmp_path / "endpoint_proxy.mp4"
    resp = client.post("/api/proxy", json={"input": str(test_video), "out": str(out)})
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert isinstance(body["job_id"], str) and body["job_id"]
    assert body["status"] == "running"

    done = _poll_job(client, body["job_id"])
    assert done is not None and done.status_code == 200, getattr(done, "text", None)
    payload = done.json()
    assert payload["status"] == "done", payload
    assert payload["result"]["path"] == str(out)
    assert payload["result"]["skipped"] is False
    assert out.exists() and out.stat().st_size > 0


def test_proxy_endpoint_fresh_skip_returns_200_no_job(client, test_video, tmp_path, monkeypatch):
    """A pre-existing, source-fresher proxy short-circuits synchronously (200,
    no job started) — the endpoint's idempotent fast path."""
    from lib.proxy import proxy_path_for

    # S7 routes outside-workspace sources to .sources/_proxycache; declare
    # tmp_path as the workspace so the sibling path this test pre-creates is
    # the one the endpoint computes.
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    src_copy = tmp_path / "clip.mp4"
    shutil.copyfile(test_video, src_copy)
    out = proxy_path_for(str(src_copy))
    time.sleep(0.05)
    Path(out).write_bytes(b"fake-fresh-proxy")  # newer than src -> "fresh"

    resp = client.post("/api/proxy", json={"input": str(src_copy)})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"path": out, "skipped": True}
    # Untouched — the fresh short-circuit never re-encodes.
    assert Path(out).read_bytes() == b"fake-fresh-proxy"
