"""Integration tests for remote I/O in the API layer (Task 4).

Covers:
  - POST /api/run with remoteClips / remoteAssets body fields (request-time
    validation only for error cases; happy-path tests mock subprocess.run and
    subprocess.Popen so the command is constructed but not actually executed).
  - POST /api/projects/{id}/upload (push_from_disk_async stubbed in-process).
"""
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from starlette.testclient import TestClient

from serve.server import app
from serve.sse import SSEBroadcaster

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _broadcaster(monkeypatch):
    """Ensure app.state.broadcaster exists so endpoints that broadcast don't crash."""
    if not hasattr(app.state, "broadcaster"):
        app.state.broadcaster = SSEBroadcaster()


@pytest.fixture
def client():
    return TestClient(app, raise_server_exceptions=False)


def _make_project(workspace: Path, project_id: str = "proj-upload-test") -> Path:
    """Create a minimal project.json and return the project dir."""
    project_dir = workspace / "2026-05-04-test"
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "project.json").write_text(json.dumps({
        "version": "0.2",
        "id": project_id,
        "status": "pending",
        "name": "test",
        "workflow": "clean_cut",
        "editingPrompt": "test",
        "settings": {"resolution": [1920, 1080], "fps": 30},
        "tracks": [],
        "assets": [],
        "audio": {},
    }))
    return project_dir


# ---------------------------------------------------------------------------
# POST /api/run — remoteClips validation tests
# ---------------------------------------------------------------------------

class TestRunRemoteClipsValidation:
    """Request-level validation for remoteClips and remoteAssets on POST /run."""

    def test_remote_clips_not_a_list_returns_400(self, client, monkeypatch):
        """remoteClips that isn't a list → 400 invalid_field."""
        resp = client.post("/api/run", json={
            "prompt": "test",
            "workflow": "clean_cut",
            "remoteClips": "not-a-list",
        })
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "invalid_field"
        assert "remoteClips" in detail["message"]

    def test_remote_assets_not_a_list_returns_400(self, client, monkeypatch):
        """remoteAssets that isn't a list → 400 invalid_field."""
        resp = client.post("/api/run", json={
            "prompt": "test",
            "workflow": "clean_cut",
            "remoteAssets": {"url": "https://example.com/x.mp4"},
        })
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "invalid_field"
        assert "remoteAssets" in detail["message"]

    def test_remote_clips_item_not_a_dict_returns_400(self, client, monkeypatch):
        """remoteClips item that is not an object → 400 invalid_remote_item."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")
        resp = client.post("/api/run", json={
            "prompt": "test",
            "workflow": "clean_cut",
            "remoteClips": ["not-a-dict"],
        })
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "invalid_remote_item"
        assert "remoteClips[0]" in detail["message"]
        assert "must be an object" in detail["message"]

    def test_remote_clips_item_missing_required_key_returns_400(self, client, monkeypatch):
        """remoteClips item missing a required key → 400 invalid_remote_item with key name."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")
        # Missing contentType and sizeBytes
        resp = client.post("/api/run", json={
            "prompt": "test",
            "workflow": "clean_cut",
            "remoteClips": [{"url": "https://example.com/clip.mp4", "destPath": "clips/c.mp4"}],
        })
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "invalid_remote_item"
        assert "missing required key" in detail["message"]
        # The message should name the missing key.
        assert "contentType" in detail["message"] or "sizeBytes" in detail["message"]

    def test_remote_clips_item_missing_url_returns_400(self, client, monkeypatch):
        """remoteClips item missing url → 400 invalid_remote_item."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")
        resp = client.post("/api/run", json={
            "prompt": "test",
            "workflow": "clean_cut",
            "remoteClips": [{"destPath": "clips/c.mp4", "contentType": "video/mp4", "sizeBytes": 100}],
        })
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "invalid_remote_item"
        assert "url" in detail["message"]

    def test_remote_clips_item_http_url_rejected(self, client, monkeypatch):
        """remoteClips item with http:// (not https://) → 400 invalid_remote_item."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")
        resp = client.post("/api/run", json={
            "prompt": "test",
            "workflow": "clean_cut",
            "remoteClips": [{
                "url": "http://example.com/clip.mp4",
                "destPath": "clips/c.mp4",
                "contentType": "video/mp4",
                "sizeBytes": 100,
            }],
        })
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "invalid_remote_item"
        assert "https://" in detail["message"]

    def test_remote_clips_with_allowlist_unset_returns_403(self, client, monkeypatch):
        """remoteClips present but MONTAJ_HTTP_ALLOWED_HOSTS unset → 403 allowlist_unset."""
        monkeypatch.delenv("MONTAJ_HTTP_ALLOWED_HOSTS", raising=False)
        resp = client.post("/api/run", json={
            "prompt": "test",
            "workflow": "clean_cut",
            "remoteClips": [{
                "url": "https://example.com/clip.mp4",
                "destPath": "clips/c.mp4",
                "contentType": "video/mp4",
                "sizeBytes": 100,
            }],
        })
        assert resp.status_code == 403
        detail = resp.json()["detail"]
        assert detail["error"] == "allowlist_unset"
        assert "MONTAJ_HTTP_ALLOWED_HOSTS" in detail["message"]

    def test_remote_clips_host_not_in_allowlist_returns_400(self, client, monkeypatch):
        """remoteClips item with a host not in allowlist → 400 invalid_remote_item."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "allowed.com")
        resp = client.post("/api/run", json={
            "prompt": "test",
            "workflow": "clean_cut",
            "remoteClips": [{
                "url": "https://blocked.com/clip.mp4",
                "destPath": "clips/c.mp4",
                "contentType": "video/mp4",
                "sizeBytes": 100,
            }],
        })
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "invalid_remote_item"
        assert "not allowed" in detail["message"]
        assert "blocked.com" in detail["message"]

    def test_shape_check_fires_before_allowlist_check(self, client, monkeypatch):
        """Per-item shape check (missing required key) fires before allowlist check.
        Even with allowlist unset, a malformed item should return invalid_remote_item
        (not allowlist_unset), because shape validation runs first."""
        monkeypatch.delenv("MONTAJ_HTTP_ALLOWED_HOSTS", raising=False)
        # Item missing required keys — this should be caught BEFORE allowlist check.
        # Shape validation iterates items first; allowlist check is after.
        # Because both shape check and allowlist check are before the allowlist-host
        # per-item loop, and allowlist_unset is checked before per-item host check:
        # shape check → allowlist_unset check → per-item host check.
        # So missing-key on a valid-shape-but-bad-url actually hits allowlist_unset first.
        # This test confirms missing key (not even a valid object) is caught by shape check.
        resp = client.post("/api/run", json={
            "prompt": "test",
            "workflow": "clean_cut",
            "remoteClips": [{"destPath": "clips/c.mp4"}],  # missing url, contentType, sizeBytes
        })
        # Shape check fires (missing required key) — error is invalid_remote_item
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "invalid_remote_item"

    def test_remote_clips_second_item_host_not_allowed(self, client, monkeypatch):
        """Host check reports correct item index when second item has disallowed host."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "good.com")
        resp = client.post("/api/run", json={
            "prompt": "test",
            "workflow": "clean_cut",
            "remoteClips": [
                {"url": "https://good.com/clip1.mp4", "destPath": "clips/c1.mp4",
                 "contentType": "video/mp4", "sizeBytes": 100},
                {"url": "https://bad.com/clip2.mp4", "destPath": "clips/c2.mp4",
                 "contentType": "video/mp4", "sizeBytes": 100},
            ],
        })
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "invalid_remote_item"
        assert "remoteClips[1]" in detail["message"]
        assert "bad.com" in detail["message"]


class TestRunRemoteClipsSubprocess:
    """Happy-path tests for POST /run with remoteClips using subprocess mocking."""

    def _make_item(self, host="example.com", dest="clips/clip.mp4"):
        return {
            "url": f"https://{host}/clip.mp4",
            "destPath": dest,
            "contentType": "video/mp4",
            "sizeBytes": 1024,
        }

    def test_remote_clips_cmd_includes_remote_clip_args(self, client, monkeypatch, tmp_path):
        """POST /run with remoteClips → cmd list passed to subprocess includes --remote-clip <json>."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")

        item = self._make_item()
        captured_cmd = []

        async def _fake_subprocess(*cmd_args, **kwargs):
            captured_cmd.extend(cmd_args)
            # Return a fake process that immediately returns a project.json path on stdout.
            project_json = tmp_path / "project.json"
            project_json.write_text(json.dumps({
                "version": "0.2", "id": "test-proj", "status": "pending",
                "name": "test", "workflow": "clean_cut", "editingPrompt": "test",
                "settings": {"resolution": [1920, 1080], "fps": 30},
                "tracks": [], "assets": [], "audio": {},
            }))
            # Simulate: stdout = project.json path, returncode = 0
            mock_proc = AsyncMock()
            mock_proc.returncode = 0

            async def _communicate():
                return (str(project_json).encode() + b"\n", b"")

            mock_proc.communicate = _communicate
            return mock_proc

        with patch("serve.routes.projects.asyncio.create_subprocess_exec", side_effect=_fake_subprocess):
            # Also patch run_subprocess since non-debug mode uses it:
            async def _fake_run_subprocess(cmd, **kwargs):
                captured_cmd.extend(cmd)
                project_json = tmp_path / "project.json"
                project_json.write_text(json.dumps({
                    "version": "0.2", "id": "test-proj", "status": "pending",
                    "name": "test", "workflow": "clean_cut", "editingPrompt": "test",
                    "settings": {"resolution": [1920, 1080], "fps": 30},
                    "tracks": [], "assets": [], "audio": {},
                }))
                return (str(project_json) + "\n", "", 0)

            with patch("serve.routes.projects.run_subprocess", side_effect=_fake_run_subprocess):
                resp = client.post("/api/run", json={
                    "prompt": "test remote clips",
                    "workflow": "clean_cut",
                    "remoteClips": [item],
                })

        assert resp.status_code == 201
        # The cmd must contain --remote-clip followed by the exact JSON of the item
        assert "--remote-clip" in captured_cmd
        idx = captured_cmd.index("--remote-clip")
        assert json.loads(captured_cmd[idx + 1]) == item

    def test_mixed_clips_and_remote_clips_cmd_args(self, client, monkeypatch, tmp_path):
        """POST /run with both local clips and remoteClips → cmd includes both."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")

        # Create a real local clip file so the is_file() check passes
        local_clip = tmp_path / "local.mp4"
        local_clip.write_bytes(b"fake")

        remote_item = self._make_item()
        captured_cmd = []

        async def _fake_run_subprocess(cmd, **kwargs):
            captured_cmd.extend(cmd)
            project_json = tmp_path / "project.json"
            project_json.write_text(json.dumps({
                "version": "0.2", "id": "test-proj", "status": "pending",
                "name": "test", "workflow": "clean_cut", "editingPrompt": "test",
                "settings": {"resolution": [1920, 1080], "fps": 30},
                "tracks": [], "assets": [], "audio": {},
            }))
            return (str(project_json) + "\n", "", 0)

        with patch("serve.routes.projects.run_subprocess", side_effect=_fake_run_subprocess):
            resp = client.post("/api/run", json={
                "prompt": "test mixed",
                "workflow": "clean_cut",
                "clips": [str(local_clip)],
                "remoteClips": [remote_item],
            })

        assert resp.status_code == 201
        # Both --clips and --remote-clip must appear
        assert "--clips" in captured_cmd
        assert "--remote-clip" in captured_cmd
        idx = captured_cmd.index("--remote-clip")
        assert json.loads(captured_cmd[idx + 1]) == remote_item

    def test_remote_clips_with_canvas_workflow_no_canvas_flag(self, client, monkeypatch, tmp_path):
        """POST /run with remoteClips and a canvas workflow → --canvas is NOT added to cmd."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")

        item = self._make_item()
        captured_cmd = []

        async def _fake_run_subprocess(cmd, **kwargs):
            captured_cmd.extend(cmd)
            project_json = tmp_path / "project.json"
            project_json.write_text(json.dumps({
                "version": "0.2", "id": "test-proj", "status": "pending",
                "name": "test", "workflow": "animations", "editingPrompt": "test",
                "settings": {"resolution": [1920, 1080], "fps": 30},
                "tracks": [], "assets": [], "audio": {},
            }))
            return (str(project_json) + "\n", "", 0)

        with patch("serve.routes.projects.run_subprocess", side_effect=_fake_run_subprocess):
            resp = client.post("/api/run", json={
                "prompt": "test no canvas",
                "workflow": "animations",  # requires_clips: false
                "remoteClips": [item],
            })

        assert resp.status_code == 201
        # --canvas must NOT appear — remoteClips count as footage
        assert "--canvas" not in captured_cmd
        # --remote-clip must appear
        assert "--remote-clip" in captured_cmd

    def test_canvas_workflow_without_remote_clips_adds_canvas_flag(self, client, monkeypatch, tmp_path):
        """POST /run with a canvas workflow and no clips → --canvas IS added (unchanged behavior)."""
        captured_cmd = []

        async def _fake_run_subprocess(cmd, **kwargs):
            captured_cmd.extend(cmd)
            project_json = tmp_path / "project.json"
            project_json.write_text(json.dumps({
                "version": "0.2", "id": "test-proj", "status": "pending",
                "name": "test", "workflow": "animations", "editingPrompt": "test",
                "settings": {"resolution": [1920, 1080], "fps": 30},
                "tracks": [], "assets": [], "audio": {},
            }))
            return (str(project_json) + "\n", "", 0)

        with patch("serve.routes.projects.run_subprocess", side_effect=_fake_run_subprocess):
            resp = client.post("/api/run", json={
                "prompt": "test canvas",
                "workflow": "animations",  # requires_clips: false
                # No clips or remoteClips → should add --canvas
            })

        assert resp.status_code == 201
        assert "--canvas" in captured_cmd


# ---------------------------------------------------------------------------
# POST /api/projects/{id}/upload tests
# ---------------------------------------------------------------------------

class TestProjectUpload:
    """Tests for POST /api/projects/{id}/upload."""

    PROJECT_ID = "proj-upload-api-test"

    def _setup_project(self, workspace: Path) -> Path:
        return _make_project(workspace, self.PROJECT_ID)

    def test_happy_path_single_upload_200(self, client, monkeypatch, tmp_path):
        """Single upload item that succeeds → 200 with results."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        self._setup_project(tmp_path)

        ok_result = [{"srcPath": "output/render.mp4", "status": "ok",
                      "bytesSent": 1234, "upstreamStatus": 200}]

        async def _push_stub(items, project_dir, allowed_hosts, *, transport=None):
            return ok_result

        monkeypatch.setattr("serve.routes.projects.push_from_disk_async", _push_stub)

        resp = client.post(f"/api/projects/{self.PROJECT_ID}/upload", json={
            "uploads": [{"srcPath": "output/render.mp4", "url": "https://cdn.example.com/render.mp4",
                         "method": "PUT", "headers": {"Content-Type": "video/mp4"}}],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "results" in data
        assert len(data["results"]) == 1
        assert data["results"][0]["status"] == "ok"
        assert data["results"][0]["srcPath"] == "output/render.mp4"

    def test_happy_path_multi_upload_all_succeed_200(self, client, monkeypatch, tmp_path):
        """Multiple upload items all succeeding → 200."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        self._setup_project(tmp_path)

        async def _push_stub(items, project_dir, allowed_hosts, *, transport=None):
            return [
                {"srcPath": item["srcPath"], "status": "ok",
                 "bytesSent": 100, "upstreamStatus": 200}
                for item in items
            ]

        monkeypatch.setattr("serve.routes.projects.push_from_disk_async", _push_stub)

        resp = client.post(f"/api/projects/{self.PROJECT_ID}/upload", json={
            "uploads": [
                {"srcPath": "output/render.mp4", "url": "https://cdn.example.com/render.mp4"},
                {"srcPath": "output/manifest.json", "url": "https://cdn.example.com/manifest.json"},
            ],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["results"]) == 2
        assert all(r["status"] == "ok" for r in data["results"])

    def test_partial_failure_returns_207(self, client, monkeypatch, tmp_path):
        """One item succeeds, one fails → 207 Multi-Status."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        self._setup_project(tmp_path)

        async def _push_stub(items, project_dir, allowed_hosts, *, transport=None):
            return [
                {"srcPath": "output/render.mp4", "status": "ok",
                 "bytesSent": 100, "upstreamStatus": 200},
                {"srcPath": "output/broken.mp4", "status": "error",
                 "error": "upstream_error", "upstreamStatus": 500,
                 "message": "Upstream returned 500"},
            ]

        monkeypatch.setattr("serve.routes.projects.push_from_disk_async", _push_stub)

        resp = client.post(f"/api/projects/{self.PROJECT_ID}/upload", json={
            "uploads": [
                {"srcPath": "output/render.mp4", "url": "https://cdn.example.com/render.mp4"},
                {"srcPath": "output/broken.mp4", "url": "https://cdn.example.com/broken.mp4"},
            ],
        })
        assert resp.status_code == 207
        data = resp.json()
        assert len(data["results"]) == 2
        statuses = {r["srcPath"]: r["status"] for r in data["results"]}
        assert statuses["output/render.mp4"] == "ok"
        assert statuses["output/broken.mp4"] == "error"

    def test_all_fail_returns_207(self, client, monkeypatch, tmp_path):
        """All uploads failing → still 207 (not 500)."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        self._setup_project(tmp_path)

        async def _push_stub(items, project_dir, allowed_hosts, *, transport=None):
            return [
                {"srcPath": item["srcPath"], "status": "error",
                 "error": "not_found", "message": "Source file not found"}
                for item in items
            ]

        monkeypatch.setattr("serve.routes.projects.push_from_disk_async", _push_stub)

        resp = client.post(f"/api/projects/{self.PROJECT_ID}/upload", json={
            "uploads": [{"srcPath": "output/missing.mp4", "url": "https://cdn.example.com/missing.mp4"}],
        })
        assert resp.status_code == 207
        data = resp.json()
        assert data["results"][0]["status"] == "error"

    def test_missing_uploads_field_returns_400(self, client, monkeypatch, tmp_path):
        """Body missing 'uploads' field → 400 invalid_body."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        self._setup_project(tmp_path)

        resp = client.post(f"/api/projects/{self.PROJECT_ID}/upload", json={
            "something_else": "value",
        })
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "invalid_body"
        assert "'uploads'" in detail["message"]

    def test_uploads_empty_list_returns_400(self, client, monkeypatch, tmp_path):
        """Body with 'uploads': [] (empty list) → 400 invalid_body."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        self._setup_project(tmp_path)

        resp = client.post(f"/api/projects/{self.PROJECT_ID}/upload", json={
            "uploads": [],
        })
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "invalid_body"

    def test_uploads_not_a_list_returns_400(self, client, monkeypatch, tmp_path):
        """Body with 'uploads': "string" (not a list) → 400 invalid_body."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        self._setup_project(tmp_path)

        resp = client.post(f"/api/projects/{self.PROJECT_ID}/upload", json={
            "uploads": "not-a-list",
        })
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "invalid_body"

    def test_allowlist_unset_returns_403(self, client, monkeypatch, tmp_path):
        """MONTAJ_HTTP_ALLOWED_HOSTS not set → 403 allowlist_unset."""
        monkeypatch.delenv("MONTAJ_HTTP_ALLOWED_HOSTS", raising=False)
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        self._setup_project(tmp_path)

        resp = client.post(f"/api/projects/{self.PROJECT_ID}/upload", json={
            "uploads": [{"srcPath": "output/render.mp4", "url": "https://cdn.example.com/render.mp4"}],
        })
        assert resp.status_code == 403
        detail = resp.json()["detail"]
        assert detail["error"] == "allowlist_unset"
        assert "MONTAJ_HTTP_ALLOWED_HOSTS" in detail["message"]

    def test_unknown_project_id_returns_404(self, client, monkeypatch, tmp_path):
        """Unknown project_id → 404 from get_project_dir Depends."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        # No project created in tmp_path

        resp = client.post("/api/projects/nonexistent-project/upload", json={
            "uploads": [{"srcPath": "output/render.mp4", "url": "https://cdn.example.com/render.mp4"}],
        })
        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert detail["error"] == "not_found"

    def test_unknown_project_with_malformed_body_still_404(self, client, monkeypatch, tmp_path):
        """Unknown project + malformed body → 404 (project check fires before body validation)."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        # No project in workspace

        resp = client.post("/api/projects/nonexistent-project/upload", json={
            "uploads": [],  # would be 400 if project existed
        })
        # FastAPI Depends (get_project_dir) fires before body params are processed
        # in endpoint logic — project not found → 404 takes priority
        assert resp.status_code == 404

    def test_push_stub_receives_correct_project_dir(self, client, monkeypatch, tmp_path):
        """push_from_disk_async is called with the resolved project_dir, not workspace root."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        project_dir = self._setup_project(tmp_path)

        received_project_dirs = []

        async def _push_stub(items, project_dir_arg, allowed_hosts, *, transport=None):
            received_project_dirs.append(project_dir_arg)
            return [{"srcPath": items[0]["srcPath"], "status": "ok",
                     "bytesSent": 10, "upstreamStatus": 200}]

        monkeypatch.setattr("serve.routes.projects.push_from_disk_async", _push_stub)

        resp = client.post(f"/api/projects/{self.PROJECT_ID}/upload", json={
            "uploads": [{"srcPath": "output/render.mp4", "url": "https://cdn.example.com/render.mp4"}],
        })
        assert resp.status_code == 200
        assert len(received_project_dirs) == 1
        assert received_project_dirs[0] == project_dir

    def test_allowed_hosts_parsed_from_env(self, client, monkeypatch, tmp_path):
        """MONTAJ_HTTP_ALLOWED_HOSTS is correctly parsed and forwarded to push_from_disk_async."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com, storage.other.io , backup.net")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        self._setup_project(tmp_path)

        received_allowed_hosts = []

        async def _push_stub(items, project_dir, allowed_hosts, *, transport=None):
            received_allowed_hosts.extend(allowed_hosts)
            return [{"srcPath": items[0]["srcPath"], "status": "ok",
                     "bytesSent": 10, "upstreamStatus": 200}]

        monkeypatch.setattr("serve.routes.projects.push_from_disk_async", _push_stub)

        resp = client.post(f"/api/projects/{self.PROJECT_ID}/upload", json={
            "uploads": [{"srcPath": "output/render.mp4", "url": "https://cdn.example.com/render.mp4"}],
        })
        assert resp.status_code == 200
        # All three hosts should be present (stripped, lowercased)
        assert "cdn.example.com" in received_allowed_hosts
        assert "storage.other.io" in received_allowed_hosts
        assert "backup.net" in received_allowed_hosts


# ---------------------------------------------------------------------------
# GET /api/projects/{id}/outputs tests
# ---------------------------------------------------------------------------

class TestProjectOutputs:
    """Tests for GET /api/projects/{id}/outputs."""

    PROJECT_ID = "proj-outputs-api-test"

    def _setup_project(self, workspace: Path) -> Path:
        return _make_project(workspace, self.PROJECT_ID)

    def test_output_dir_with_files_returns_listing(self, client, monkeypatch, tmp_path):
        """output/ exists with files → depth-1 listing, alpha-sorted, correct shape."""
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        project_dir = self._setup_project(tmp_path)

        output_dir = project_dir / "output"
        output_dir.mkdir()
        (output_dir / "render.mp4").write_bytes(b"x" * 512)
        (output_dir / "manifest.json").write_bytes(b"{}" )
        (output_dir / "audio.wav").write_bytes(b"w" * 1024)

        resp = client.get(f"/api/projects/{self.PROJECT_ID}/outputs")
        assert resp.status_code == 200
        data = resp.json()
        assert "outputs" in data
        outputs = data["outputs"]
        # Alphabetical order: audio.wav, manifest.json, render.mp4
        names = [o["path"] for o in outputs]
        assert names == ["output/audio.wav", "output/manifest.json", "output/render.mp4"]
        # Check shape fields
        for item in outputs:
            assert "path" in item
            assert "sizeBytes" in item
            assert "contentType" in item
            assert item["path"].startswith("output/")
            assert not item["path"].startswith("/")
        # Spot-check sizes
        sizes = {o["path"]: o["sizeBytes"] for o in outputs}
        assert sizes["output/render.mp4"] == 512
        assert sizes["output/audio.wav"] == 1024
        assert sizes["output/manifest.json"] == 2
        # Spot-check content types
        types = {o["path"]: o["contentType"] for o in outputs}
        assert "video" in types["output/render.mp4"]
        assert "audio" in types["output/audio.wav"]
        assert "json" in types["output/manifest.json"]

    def test_output_dir_exists_but_empty_returns_empty_list(self, client, monkeypatch, tmp_path):
        """output/ exists but is empty → {"outputs": []} with 200 (not 404)."""
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        project_dir = self._setup_project(tmp_path)
        (project_dir / "output").mkdir()

        resp = client.get(f"/api/projects/{self.PROJECT_ID}/outputs")
        assert resp.status_code == 200
        assert resp.json() == {"outputs": []}

    def test_output_dir_missing_returns_empty_list(self, client, monkeypatch, tmp_path):
        """output/ doesn't exist → {"outputs": []} with 200 (not 404)."""
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        self._setup_project(tmp_path)
        # No output/ dir created

        resp = client.get(f"/api/projects/{self.PROJECT_ID}/outputs")
        assert resp.status_code == 200
        assert resp.json() == {"outputs": []}

    def test_unknown_project_returns_404(self, client, monkeypatch, tmp_path):
        """Unknown project_id → 404 with standard not_found body."""
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        # No project created in tmp_path

        resp = client.get("/api/projects/nonexistent-outputs-project/outputs")
        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert detail["error"] == "not_found"

    def test_allowlist_unset_still_returns_200(self, client, monkeypatch, tmp_path):
        """MONTAJ_HTTP_ALLOWED_HOSTS unset → endpoint still returns 200 (not gated by allowlist)."""
        monkeypatch.delenv("MONTAJ_HTTP_ALLOWED_HOSTS", raising=False)
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        project_dir = self._setup_project(tmp_path)
        (project_dir / "output").mkdir()
        (project_dir / "output" / "render.mp4").write_bytes(b"x" * 100)

        resp = client.get(f"/api/projects/{self.PROJECT_ID}/outputs")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["outputs"]) == 1

    def test_unknown_extension_returns_octet_stream(self, client, monkeypatch, tmp_path):
        """Files with unknown extensions → contentType is application/octet-stream."""
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        project_dir = self._setup_project(tmp_path)
        output_dir = project_dir / "output"
        output_dir.mkdir()
        (output_dir / "data.weirdext").write_bytes(b"blob")

        resp = client.get(f"/api/projects/{self.PROJECT_ID}/outputs")
        assert resp.status_code == 200
        outputs = resp.json()["outputs"]
        assert len(outputs) == 1
        assert outputs[0]["contentType"] == "application/octet-stream"
        assert outputs[0]["path"] == "output/data.weirdext"

    def test_subdirectories_under_output_are_not_included(self, client, monkeypatch, tmp_path):
        """Subdirectories under output/ (depth > 1) are not included in the listing."""
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        project_dir = self._setup_project(tmp_path)
        output_dir = project_dir / "output"
        output_dir.mkdir()
        # A real file at depth 1
        (output_dir / "render.mp4").write_bytes(b"x" * 50)
        # A subdirectory with a file — should NOT appear
        sub = output_dir / "sub"
        sub.mkdir()
        (sub / "file.png").write_bytes(b"y" * 20)

        resp = client.get(f"/api/projects/{self.PROJECT_ID}/outputs")
        assert resp.status_code == 200
        outputs = resp.json()["outputs"]
        paths = [o["path"] for o in outputs]
        assert "output/render.mp4" in paths
        # The subdir file must not appear (neither as "output/sub" nor "output/sub/file.png")
        assert not any("sub" in p for p in paths)
        assert len(outputs) == 1

    def test_round_trip_with_upload(self, client, monkeypatch, tmp_path):
        """Round-trip: /outputs returns paths compatible as srcPath for /upload."""
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr("serve.common.resolve_workspace", lambda: tmp_path)
        project_dir = self._setup_project(tmp_path)
        output_dir = project_dir / "output"
        output_dir.mkdir()
        (output_dir / "render.mp4").write_bytes(b"x" * 256)

        # Get the listing
        list_resp = client.get(f"/api/projects/{self.PROJECT_ID}/outputs")
        assert list_resp.status_code == 200
        outputs = list_resp.json()["outputs"]
        assert len(outputs) == 1
        src_path = outputs[0]["path"]  # e.g. "output/render.mp4"

        # Stub push_from_disk_async
        upload_result = [{"srcPath": src_path, "status": "ok",
                          "bytesSent": 256, "upstreamStatus": 200}]

        async def _push_stub(items, project_dir_arg, allowed_hosts, *, transport=None):
            return upload_result

        monkeypatch.setattr("serve.routes.projects.push_from_disk_async", _push_stub)

        # Pass the path from /outputs verbatim as srcPath in /upload
        upload_resp = client.post(f"/api/projects/{self.PROJECT_ID}/upload", json={
            "uploads": [{"srcPath": src_path, "url": "https://cdn.example.com/render.mp4",
                          "method": "PUT", "headers": {}}],
        })
        assert upload_resp.status_code == 200
        upload_data = upload_resp.json()
        assert upload_data["results"][0]["status"] == "ok"
        assert upload_data["results"][0]["srcPath"] == src_path
