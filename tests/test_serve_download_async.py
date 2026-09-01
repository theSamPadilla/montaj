"""Async opt-in for POST /projects/{id}/download.

The sync path is covered by TestProjectDownload in test_serve_remote_io.py and
is deliberately not re-tested here. This file covers only the _async branch.

Uses a module-scoped TestClient as a context manager, per test_steps_async.py:
a function-scoped client tears down its event-loop portal when the POST returns,
so a detached task would never run to completion.
"""
import json
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve.server import app

PROJECT_ID = "11111111111111111111111111111111"


@pytest.fixture(scope="module")
def client():
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture(autouse=True)
def _broadcaster():
    if not hasattr(app.state, "broadcaster"):
        pytest.skip("broadcaster not initialised")
    yield


def _setup_project(tmp_path: Path) -> Path:
    project_dir = tmp_path / PROJECT_ID
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "project.json").write_text(json.dumps({"id": PROJECT_ID, "tracks": []}))
    return project_dir


def _poll(client, job_id, *, tries=200, delay=0.02):
    last = None
    for _ in range(tries):
        resp = client.get(f"/api/projects/{PROJECT_ID}/download/jobs/{job_id}")
        last = resp
        if resp.status_code == 200 and resp.json().get("status") != "running":
            return resp
        time.sleep(delay)
    return last


class TestProjectDownloadAsync:
    def test_async_returns_202_with_job_id(self, client, monkeypatch, tmp_path):
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        _setup_project(tmp_path)

        async def _fetch_stub(items, project_dir, allowed_hosts, *, transport=None):
            return [{"destPath": "assets/a.mp4", "status": "ok", "bytesWritten": 100}]

        monkeypatch.setattr("serve.routes.projects.fetch_to_disk_async", _fetch_stub)

        resp = client.post(
            f"/api/projects/{PROJECT_ID}/download",
            json={
                "_async": True,
                "downloads": [{
                    "url": "https://cdn.example.com/a.mp4",
                    "destPath": "assets/a.mp4",
                    "contentType": "video/mp4",
                    "sizeBytes": 100,
                }],
            },
        )
        assert resp.status_code == 202
        assert resp.json()["status"] == "running"
        assert len(resp.json()["job_id"]) == 32

    def test_job_reaches_done_and_preserves_the_results_envelope(self, client, monkeypatch, tmp_path):
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        _setup_project(tmp_path)

        async def _fetch_stub(items, project_dir, allowed_hosts, *, transport=None):
            return [{"destPath": "assets/a.mp4", "status": "ok", "bytesWritten": 2048}]

        monkeypatch.setattr("serve.routes.projects.fetch_to_disk_async", _fetch_stub)

        job_id = client.post(
            f"/api/projects/{PROJECT_ID}/download",
            json={"_async": True, "downloads": [{
                "url": "https://cdn.example.com/a.mp4", "destPath": "assets/a.mp4",
                "contentType": "video/mp4", "sizeBytes": 2048}]},
        ).json()["job_id"]

        done = _poll(client, job_id)
        assert done.status_code == 200
        body = done.json()
        assert body["status"] == "done"
        # The envelope is preserved verbatim: async wraps the sync payload.
        assert body["result"] == {
            "results": [{"destPath": "assets/a.mp4", "status": "ok", "bytesWritten": 2048}]
        }

    def test_per_item_failure_is_a_done_job_not_an_error_job(self, client, monkeypatch, tmp_path):
        """A failed item is data, not a job failure — same split as 207 vs 4xx."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        _setup_project(tmp_path)

        async def _fetch_stub(items, project_dir, allowed_hosts, *, transport=None):
            return [{"destPath": "assets/a.mp4", "status": "error",
                     "error": "upstream_error", "upstreamStatus": 500,
                     "message": "Upstream returned 500"}]

        monkeypatch.setattr("serve.routes.projects.fetch_to_disk_async", _fetch_stub)

        job_id = client.post(
            f"/api/projects/{PROJECT_ID}/download",
            json={"_async": True, "downloads": [{
                "url": "https://cdn.example.com/a.mp4", "destPath": "assets/a.mp4",
                "contentType": "video/mp4", "sizeBytes": 100}]},
        ).json()["job_id"]

        done = _poll(client, job_id)
        assert done.json()["status"] == "done"
        assert done.json()["result"]["results"][0]["error"] == "upstream_error"

    def test_raised_exception_becomes_an_error_job(self, client, monkeypatch, tmp_path):
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        _setup_project(tmp_path)

        async def _boom(items, project_dir, allowed_hosts, *, transport=None):
            raise RuntimeError("disk exploded")

        monkeypatch.setattr("serve.routes.projects.fetch_to_disk_async", _boom)

        job_id = client.post(
            f"/api/projects/{PROJECT_ID}/download",
            json={"_async": True, "downloads": [{
                "url": "https://cdn.example.com/a.mp4", "destPath": "assets/a.mp4",
                "contentType": "video/mp4", "sizeBytes": 100}]},
        ).json()["job_id"]

        done = _poll(client, job_id)
        assert done.json()["status"] == "error"
        assert done.json()["error"]["error"] == "download_failed"
        assert "disk exploded" in done.json()["error"]["message"]

    def test_unknown_job_id_is_404(self, client, monkeypatch, tmp_path):
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        _setup_project(tmp_path)
        resp = client.get(f"/api/projects/{PROJECT_ID}/download/jobs/{'0' * 32}")
        assert resp.status_code == 404

    def test_sync_path_is_unchanged_when_async_absent(self, client, monkeypatch, tmp_path):
        """The whole compatibility story rests on this."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        _setup_project(tmp_path)

        async def _fetch_stub(items, project_dir, allowed_hosts, *, transport=None):
            return [{"destPath": "assets/a.mp4", "status": "ok", "bytesWritten": 100}]

        monkeypatch.setattr("serve.routes.projects.fetch_to_disk_async", _fetch_stub)

        resp = client.post(
            f"/api/projects/{PROJECT_ID}/download",
            json={"downloads": [{
                "url": "https://cdn.example.com/a.mp4", "destPath": "assets/a.mp4",
                "contentType": "video/mp4", "sizeBytes": 100}]},
        )
        assert resp.status_code == 200
        assert "job_id" not in resp.json()
        assert resp.json()["results"][0]["status"] == "ok"

    def test_allowlist_unset_still_403s_before_a_job_is_created(self, client, monkeypatch, tmp_path):
        monkeypatch.delenv("MONTAJ_HTTP_ALLOWED_HOSTS", raising=False)
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        _setup_project(tmp_path)
        resp = client.post(
            f"/api/projects/{PROJECT_ID}/download",
            json={"_async": True, "downloads": [{
                "url": "https://cdn.example.com/a.mp4", "destPath": "assets/a.mp4",
                "contentType": "video/mp4", "sizeBytes": 100}]},
        )
        assert resp.status_code == 403
