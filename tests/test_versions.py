"""Version-history endpoints (SP8b): manual "save version" checkpoints and
non-destructive restore.

Three behaviors landed in `serve/routes/projects.py` ahead of these tests:

  T1 (`render_project`, video branch, :2317) — auto-commits
     `f"version: run {run_count} — export"` before dispatching a detached
     render. T1 (export auto-commit) is not directly tested here; the commit
     call is a one-line `_git_commit_sync` invocation inside `render_project`'s
     video branch, identical in shape to the T2/T3 patterns this file DOES
     exercise, and the render path spawns detached subprocess work that isn't
     worth standing up for a fast unit test.

  T2 (`create_version`, :1697-1742) — `POST /projects/{id}/versions`. Commits
     `f"version: run {run_count} — {label}"` where `label` is the sanitized
     `name` from the body, or `"manual save"` when absent/blank. No track
     reset, no status change, no project.json write — purely a git checkpoint
     of whatever is already on disk.

  T3 (`restore_version`, :1748-1758) — commits
     `f"version: run {current_run_count} — autosave before restore"` BEFORE
     reading the target commit out of git history, so any uncommitted edit
     sitting in the working tree becomes a recoverable version instead of
     being silently discarded by the restore. `_git_commit_sync` is
     no-op-safe (skips the commit when there's nothing staged), so this only
     ever creates a version when there really was an uncommitted edit.

Conventions mirror `tests/test_track_shape_migration.py`: real git repos
under `tmp_path`, FastAPI `TestClient` with `get_project_dir` overridden to
the temp project directory, and a `_StubBroadcaster` so SSE publish calls are
harmless no-ops.
"""
import asyncio
import base64
import json
import os
import subprocess
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve.common import get_project_dir
from serve.server import app

PID = "77777777-7777-4777-8777-777777777777"


class _StubBroadcaster:
    def publish(self, *a, **k):
        pass


_GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "montaj", "GIT_AUTHOR_EMAIL": "montaj@local",
    "GIT_COMMITTER_NAME": "montaj", "GIT_COMMITTER_EMAIL": "montaj@local",
}


def _make_current_project(project_dir: Path, project_id: str = PID, run_count: int = 1) -> dict:
    """A minimally-valid current-shape (object tracks) project.json — enough
    for `create_version`/`list_versions`/`restore_version` to read `runCount`
    and round-trip `tracks` without touching anything else those routes
    don't need."""
    project_dir.mkdir(parents=True, exist_ok=True)
    project = {
        "id": project_id,
        "version": "0.2",
        "status": "draft",
        "projectType": "video",
        "runCount": run_count,
        "settings": {"colorSpace": "sdr_bt709", "resolution": [1080, 1920], "fps": 30},
        "tracks": [
            {"id": "trk-0", "items": [{"id": "clip-0", "type": "image",
             "src": "/tmp/does-not-matter.png", "start": 0.0, "end": 5.0}]},
        ],
    }
    (project_dir / "project.json").write_text(json.dumps(project, indent=2))
    return project


def _git_commit_current_version(project_dir: Path, project_id: str = PID, run_count: int = 1) -> str:
    """Init a git repo in `project_dir`, write a current-shape project.json,
    and commit it as `"version: run {run_count} — draft"` — mirroring the
    message shape the real save/rerun paths write. Returns the commit hash,
    for `POST /versions/{commit}/restore`."""
    _make_current_project(project_dir, project_id, run_count)
    subprocess.run(["git", "init", "-q"], cwd=str(project_dir), env=_GIT_ENV, check=True)
    subprocess.run(["git", "add", "project.json"], cwd=str(project_dir), env=_GIT_ENV, check=True)
    subprocess.run(["git", "commit", "-q", "-m", f"version: run {run_count} — draft"],
                    cwd=str(project_dir), env=_GIT_ENV, check=True)
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(project_dir), env=_GIT_ENV,
                             capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _read_project(project_dir: Path) -> dict:
    return json.loads((project_dir / "project.json").read_text())


def _write_project(project_dir: Path, project: dict) -> None:
    (project_dir / "project.json").write_text(json.dumps(project, indent=2))


def _git_log_entries(project_dir: Path) -> list[tuple[str, str]]:
    """(hash, message) pairs, newest first — same command shape (and same
    `-- project.json` path filter) `list_versions`/`create_version` use."""
    result = subprocess.run(
        ["git", "log", "--pretty=format:%H|%s", "--", "project.json"],
        cwd=str(project_dir), env=_GIT_ENV, capture_output=True, text=True, check=True,
    )
    entries = []
    for line in result.stdout.strip().splitlines():
        h, _, msg = line.partition("|")
        entries.append((h, msg))
    return entries


def _git_show_project(project_dir: Path, commit: str) -> dict:
    result = subprocess.run(
        ["git", "show", f"{commit}:project.json"],
        cwd=str(project_dir), env=_GIT_ENV, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


# ---------------------------------------------------------------------------
# T2 — POST /projects/{id}/versions (manual "save version" checkpoint)
# ---------------------------------------------------------------------------

def test_save_version_endpoint_commits_with_name(tmp_path):
    project_dir = tmp_path / "proj"
    _git_commit_current_version(project_dir, run_count=1)

    # An uncommitted edit — without this, _git_commit_sync's no-op guard
    # would skip the commit entirely.
    project = _read_project(project_dir)
    project["tracks"][0]["items"][0]["end"] = 6.0
    _write_project(project_dir, project)

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        resp = client.post(f"/api/projects/{PID}/versions", json={"name": "mid-edit checkpoint"})
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 200, resp.text
    versions = resp.json()
    assert isinstance(versions, list)
    assert versions[0]["message"] == "version: run 1 — mid-edit checkpoint"
    assert "—" in versions[0]["message"]  # em dash, not a hyphen
    assert " - " not in versions[0]["message"]

    entries = _git_log_entries(project_dir)
    assert len(entries) == 2  # initial draft commit + this new one
    assert entries[0][1] == "version: run 1 — mid-edit checkpoint"


@pytest.mark.parametrize("payload", [{}, {"name": ""}, {"name": "   "}])
def test_save_version_endpoint_defaults_to_manual_save(tmp_path, payload):
    project_dir = tmp_path / "proj"
    _git_commit_current_version(project_dir, run_count=1)

    project = _read_project(project_dir)
    project["tracks"].append({"id": "trk-marker", "items": [
        {"id": "marker-item", "type": "image", "src": "/tmp/marker.png", "start": 0.0, "end": 1.0},
    ]})
    _write_project(project_dir, project)

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        resp = client.post(f"/api/projects/{PID}/versions", json=payload)
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 200, resp.text
    versions = resp.json()
    assert versions[0]["message"] == "version: run 1 — manual save"


def test_save_version_endpoint_does_not_reset_tracks(tmp_path):
    project_dir = tmp_path / "proj"
    _git_commit_current_version(project_dir, run_count=1)

    project = _read_project(project_dir)
    project["tracks"].append({"id": "trk-new", "items": [
        {"id": "new-item", "type": "image", "src": "/tmp/new.png", "start": 0.0, "end": 3.0},
    ]})
    _write_project(project_dir, project)

    before_text = (project_dir / "project.json").read_text()
    before = json.loads(before_text)

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        resp = client.post(f"/api/projects/{PID}/versions", json={"name": "checkpoint"})
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 200, resp.text

    after_text = (project_dir / "project.json").read_text()
    after = json.loads(after_text)
    # Byte-identical: create_version must not rewrite project.json at all.
    assert after_text == before_text
    assert after["tracks"] == before["tracks"]
    assert after["runCount"] == before["runCount"]
    assert after["status"] == before["status"]


def test_save_version_endpoint_sanitizes_name(tmp_path):
    project_dir = tmp_path / "proj"
    _git_commit_current_version(project_dir, run_count=1)

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        # \r and \n are each replaced with a space (not stripped to nothing),
        # then the result is .strip()'d — see :1717.
        project = _read_project(project_dir)
        project["tracks"][0]["items"][0]["end"] = 6.0
        _write_project(project_dir, project)
        resp = client.post(f"/api/projects/{PID}/versions", json={"name": "foo\nbar\rbaz"})
        assert resp.status_code == 200, resp.text
        assert resp.json()[0]["message"] == "version: run 1 — foo bar baz"

        # A name over 120 chars is capped to exactly 120 (then .rstrip()'d) — :1718.
        project = _read_project(project_dir)
        project["tracks"][0]["items"][0]["end"] = 7.0
        _write_project(project_dir, project)
        resp = client.post(f"/api/projects/{PID}/versions", json={"name": "x" * 500})
        assert resp.status_code == 200, resp.text
        message = resp.json()[0]["message"]
        label = message.removeprefix("version: run 1 — ")
        assert label == "x" * 120
        assert len(label) == 120
    finally:
        app.dependency_overrides.pop(get_project_dir, None)


def test_save_version_no_op_on_unchanged_project(tmp_path):
    project_dir = tmp_path / "proj"
    _git_commit_current_version(project_dir, run_count=1)
    before_entries = _git_log_entries(project_dir)
    assert len(before_entries) == 1

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        resp = client.post(f"/api/projects/{PID}/versions", json={"name": "test"})
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 200, resp.text
    versions = resp.json()
    assert len(versions) == 1
    assert versions[0]["message"] == "version: run 1 — draft"

    after_entries = _git_log_entries(project_dir)
    assert after_entries == before_entries  # _git_commit_sync no-op'd — no new commit


# ---------------------------------------------------------------------------
# T3 — non-destructive restore
# ---------------------------------------------------------------------------

def test_restore_preserves_uncommitted_edit(tmp_path):
    project_dir = tmp_path / "proj"
    old_hash = _git_commit_current_version(project_dir, run_count=1)

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        # Bump runCount and commit that as "run 2 — draft" via the save endpoint.
        project = _read_project(project_dir)
        project["runCount"] = 2
        _write_project(project_dir, project)
        resp = client.post(f"/api/projects/{PID}/versions", json={"name": "draft"})
        assert resp.status_code == 200, resp.text
        assert resp.json()[0]["message"] == "version: run 2 — draft"

        # An uncommitted edit sitting on top — never committed before restore.
        project = _read_project(project_dir)
        project["tracks"][0]["items"].append({
            "id": "uncommitted-item", "type": "image",
            "src": "/tmp/uncommitted.png", "start": 0.0, "end": 1.0,
        })
        _write_project(project_dir, project)

        resp = client.post(f"/api/projects/{PID}/versions/{old_hash}/restore")
        assert resp.status_code == 200, resp.text
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    # On-disk project.json now reflects the restored (old, run-1) content.
    restored = _read_project(project_dir)
    assert restored["runCount"] == 1
    assert len(restored["tracks"][0]["items"]) == 1
    assert restored["tracks"][0]["items"][0]["id"] == "clip-0"

    # A new autosave commit landed between the restore's parent (run-2 draft)
    # and HEAD, preserving the uncommitted edit as a recoverable version.
    entries = _git_log_entries(project_dir)
    assert entries[0][1] == "version: run 2 — autosave before restore"
    assert entries[1][1] == "version: run 2 — draft"
    assert entries[2][1] == "version: run 1 — draft"

    autosaved = _git_show_project(project_dir, entries[0][0])
    assert any(item["id"] == "uncommitted-item" for item in autosaved["tracks"][0]["items"])


def test_restore_no_op_when_no_uncommitted_edit(tmp_path):
    project_dir = tmp_path / "proj"
    old_hash = _git_commit_current_version(project_dir, run_count=1)

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        project = _read_project(project_dir)
        project["runCount"] = 2
        _write_project(project_dir, project)
        resp = client.post(f"/api/projects/{PID}/versions", json={"name": "draft"})
        assert resp.status_code == 200, resp.text
        assert resp.json()[0]["message"] == "version: run 2 — draft"

        # No further edit before restoring — working tree matches HEAD exactly.
        resp = client.post(f"/api/projects/{PID}/versions/{old_hash}/restore")
        assert resp.status_code == 200, resp.text
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    entries = _git_log_entries(project_dir)
    autosave_commits = [msg for _, msg in entries if msg.endswith("— autosave before restore")]
    assert autosave_commits == []


def test_list_versions_after_save_and_restore(tmp_path):
    project_dir = tmp_path / "proj"
    old_hash = _git_commit_current_version(project_dir, run_count=1)

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        project = _read_project(project_dir)
        project["tracks"][0]["items"][0]["end"] = 9.0
        _write_project(project_dir, project)
        resp = client.post(f"/api/projects/{PID}/versions", json={"name": "checkpoint"})
        assert resp.status_code == 200, resp.text

        project = _read_project(project_dir)
        project["tracks"][0]["items"].append({
            "id": "uncommitted-item", "type": "image",
            "src": "/tmp/uncommitted.png", "start": 0.0, "end": 1.0,
        })
        _write_project(project_dir, project)
        resp = client.post(f"/api/projects/{PID}/versions/{old_hash}/restore")
        assert resp.status_code == 200, resp.text

        resp = client.get(f"/api/projects/{PID}/versions")
        assert resp.status_code == 200, resp.text
        versions = resp.json()
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    messages = [v["message"] for v in versions]
    assert messages == [
        "version: run 1 — autosave before restore",
        "version: run 1 — checkpoint",
        "version: run 1 — draft",
    ]
    for v in versions:
        assert {"hash", "message", "timestamp"}.issubset(v.keys())


# ---------------------------------------------------------------------------
# T8c — GET /projects/{id}/versions/{commit}/frame
# ---------------------------------------------------------------------------
#
# `version_frame` (serve/routes/projects.py:1783-1898) renders a single
# composited PNG at time `t` from a past version (or the live working copy for
# the `working` sentinel), caching real-commit frames under
# `render/samples/versions/<commit>/frame-<t>s.png`. A real render needs
# node + ffmpeg + a project whose `src` paths point at real media — none of
# which this fixture's placeholder `/tmp/does-not-matter.png` items satisfy —
# so these tests avoid the actual render step two different ways:
#
#   - a real (non-`working`) commit: pre-populate the endpoint's OWN cache
#     path before calling it, so its `cache_path.is_file()` short-circuit
#     serves the stub PNG straight back without ever invoking node/ffmpeg.
#   - `working`: never served from cache (see the endpoint's
#     `not is_working and cache_path.is_file()` guard), so this instead mocks
#     `asyncio.create_subprocess_exec` — the only subprocess call reached on
#     the `working` path — to "render" by writing the stub PNG to the `--out`
#     path the endpoint passed it.

_STUB_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVQI12P4DwABAQEAWk1v8QAAAABJRU5ErkJggg=="
)


def _stub_png() -> bytes:
    """A tiny (1x1) but structurally valid PNG — enough to stand in for a real
    rendered frame in tests that mock or short-circuit the render step."""
    return base64.b64decode(_STUB_PNG_B64)


def test_version_frame_endpoint_returns_png_for_valid_commit(tmp_path):
    project_dir = tmp_path / "proj"
    commit_hash = _git_commit_current_version(project_dir, run_count=1)

    # Pre-populate the cache path the endpoint itself would compute for
    # (commit_hash, t=1.0) — its `cache_path.is_file()` check short-circuits
    # straight to serving this file, with no git-show / node / ffmpeg involved.
    cache_path = project_dir / "render" / "samples" / "versions" / commit_hash / "frame-1.0s.png"
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_bytes(_stub_png())

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        resp = client.get(f"/api/projects/{PID}/versions/{commit_hash}/frame", params={"t": 1.0})
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "image/png"
    assert resp.content
    assert resp.content.startswith(b"\x89PNG\r\n\x1a\n")


def test_version_frame_endpoint_404_for_bad_commit(tmp_path):
    project_dir = tmp_path / "proj"
    _git_commit_current_version(project_dir, run_count=1)

    fake_commit = "deadbeef" * 5  # 40 hex chars — well-formed, but not a real commit here

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        resp = client.get(f"/api/projects/{PID}/versions/{fake_commit}/frame", params={"t": 1.0})
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 404, resp.text


def test_version_frame_endpoint_working_sentinel_renders_live_state(tmp_path, monkeypatch):
    project_dir = tmp_path / "proj"
    _make_current_project(project_dir, run_count=1)  # plain project.json — no git needed for `working`

    real_exec = asyncio.create_subprocess_exec

    async def fake_exec(*args, **kwargs):
        if "--out" in args:
            out_path = Path(args[args.index("--out") + 1])
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(_stub_png())

            class _FakeProc:
                returncode = 0

                async def communicate(self):
                    return b"", b""

            return _FakeProc()
        # No other subprocess call is expected on the `working` path (no git
        # rev-parse/show — those only run for a real commit); fall through to
        # the real implementation just in case.
        return await real_exec(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        resp = client.get(f"/api/projects/{PID}/versions/working/frame", params={"t": 1.0})
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "image/png"
    assert resp.content.startswith(b"\x89PNG\r\n\x1a\n")
    # Working-copy frames are never cacheable — the input can change on the
    # next edit — so the response must tell clients/proxies to revalidate.
    assert resp.headers.get("cache-control") == "no-store"


def test_version_frame_endpoint_rejects_negative_t(tmp_path):
    project_dir = tmp_path / "proj"
    project_dir.mkdir(parents=True, exist_ok=True)

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        resp = client.get(f"/api/projects/{PID}/versions/whatever/frame", params={"t": -1})
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 400, resp.text
