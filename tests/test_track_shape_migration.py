"""Lazy track-shape migration at project open (tracks-as-objects T6).

`project["tracks"]` has two legal on-disk shapes: legacy (`[[item], [item]]`)
and object (`[{"id", "items"}, ...]`). Every reader tolerates both (see
`lib/project_tracks.py`); opening a project in the editor is the ONE place
that converges a legacy project to the object shape, riding GET
`/projects/{id}`'s existing lazy-migration pass — no button, no separate
command. `normalize_tracks` is idempotent and identity-preserving (returns
the SAME object when nothing needs to change), which is what lets an
already-converged project's second open skip the write entirely.

Conventions follow tests/test_look_migration.py (route coroutines driven
directly with asyncio.run) and tests/test_carousel_autorender.py (PUT driven
over TestClient with a stub broadcaster).
"""
import asyncio
import json
import os
import subprocess
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve.common import get_project_dir
from serve.server import app
from serve.routes.projects import get_project, _apply_project_edits, _sse_data_frame

PID = "77777777-7777-4777-8777-777777777777"


class _StubBroadcaster:
    def publish(self, *a, **k):
        pass


class _CapturingBroadcaster:
    """Records every `publish` call as a `(project_id, frame)` pair, so a test
    can assert on the exact SSE frame text a route sent — `_StubBroadcaster`
    above only silences the call."""
    def __init__(self):
        self.frames = []

    def publish(self, project_id, frame):
        self.frames.append((project_id, frame))


class _FakeState:
    def __init__(self, broadcaster):
        self.broadcaster = broadcaster


class _FakeApp:
    def __init__(self, broadcaster):
        self.state = _FakeState(broadcaster)


class _FakeRequest:
    """Just enough of a `Request` for `get_project` to reach
    `request.app.state.broadcaster` — the real `Request` isn't constructible
    outside an ASGI call, and `_open` below normally passes `request=None`,
    which is why sections 1/2/3/5 never exercise the broadcast at all."""
    def __init__(self, broadcaster):
        self.app = _FakeApp(broadcaster)


def _make_legacy_project(project_dir: Path, project_id: str = PID) -> dict:
    """A project whose tracks are still the pre-migration bare array-of-arrays.
    Items are `image` (not `video`) so the look-migration pass — which only
    ever touches `video` items — has nothing to do and can't interfere."""
    project_dir.mkdir(parents=True, exist_ok=True)
    project = {
        "id": project_id,
        "version": "0.2",
        "status": "draft",
        "projectType": "video",
        "settings": {"colorSpace": "sdr_bt709", "resolution": [1080, 1920], "fps": 30},
        "tracks": [
            [{"id": "clip-0", "type": "image", "src": "/tmp/does-not-matter.png",
              "start": 0.0, "end": 5.0}],
            [{"id": "logo-0", "type": "image", "src": "/tmp/logo.png",
              "start": 0.0, "end": 2.0}],
        ],
    }
    (project_dir / "project.json").write_text(json.dumps(project, indent=2))
    return project


def _make_object_project(project_dir: Path, project_id: str = PID) -> dict:
    """A project already in the object shape, with a track-level field
    (`volume`) that only the object shape has anywhere to hang."""
    project_dir.mkdir(parents=True, exist_ok=True)
    project = {
        "id": project_id,
        "version": "0.2",
        "status": "draft",
        "projectType": "video",
        "settings": {"colorSpace": "sdr_bt709", "resolution": [1080, 1920], "fps": 30},
        "tracks": [
            {"id": "trk-0", "items": [{"id": "clip-0", "type": "image",
             "src": "/tmp/does-not-matter.png", "start": 0.0, "end": 5.0}]},
            {"id": "trk-1", "items": [{"id": "logo-0", "type": "image",
             "src": "/tmp/logo.png", "start": 0.0, "end": 2.0}], "volume": 0.8},
        ],
    }
    (project_dir / "project.json").write_text(json.dumps(project, indent=2))
    return project


def _make_object_project_with_video(project_dir: Path, project_id: str = PID) -> dict:
    """Like `_make_object_project`, but `tracks[0]`'s item is `type: "video"`
    so `_look_migration_items` (and therefore `_apply_project_edits`) has
    something to walk — `_make_object_project`'s items are deliberately
    `image`-only so the look-migration pass has nothing to do."""
    project_dir.mkdir(parents=True, exist_ok=True)
    project = {
        "id": project_id,
        "version": "0.2",
        "status": "draft",
        "projectType": "video",
        "settings": {"colorSpace": "sdr_bt709", "resolution": [1080, 1920], "fps": 30},
        "tracks": [
            {"id": "trk-0", "items": [{"id": "clip-0", "type": "video",
             "src": "/tmp/does-not-matter.mp4", "start": 0.0, "end": 5.0}]},
            {"id": "trk-1", "items": [{"id": "logo-0", "type": "image",
             "src": "/tmp/logo.png", "start": 0.0, "end": 2.0}], "volume": 0.8},
        ],
    }
    (project_dir / "project.json").write_text(json.dumps(project, indent=2))
    return project


def _read(project_dir: Path) -> dict:
    return json.loads((project_dir / "project.json").read_text())


_GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "montaj", "GIT_AUTHOR_EMAIL": "montaj@local",
    "GIT_COMMITTER_NAME": "montaj", "GIT_COMMITTER_EMAIL": "montaj@local",
}


def _git_commit_legacy_version(project_dir: Path, project_id: str = PID) -> str:
    """Init a git repo in `project_dir`, write a legacy-shape project.json (the
    on-disk shape any commit made before the track-shape migration carries),
    and commit it — mirroring `_git_commit_sync`'s own `git add` + `git
    commit` (no `git init`, so tests supply that themselves). Returns the
    commit hash, for `POST /versions/{commit}/restore`."""
    _make_legacy_project(project_dir, project_id)
    subprocess.run(["git", "init", "-q"], cwd=str(project_dir), env=_GIT_ENV, check=True)
    subprocess.run(["git", "add", "project.json"], cwd=str(project_dir), env=_GIT_ENV, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "version: run 1 — draft"],
                    cwd=str(project_dir), env=_GIT_ENV, check=True)
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(project_dir), env=_GIT_ENV,
                             capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _open(project_dir: Path, project_id: str = PID) -> dict:
    return asyncio.run(get_project(project_id, project_dir=project_dir))


def _is_object_shape(tracks: list) -> bool:
    return all(isinstance(t, dict) and "id" in t and "items" in t for t in tracks)


# ---------------------------------------------------------------------------
# 1. Legacy -> object on open
# ---------------------------------------------------------------------------

def test_legacy_project_opens_to_object_shape(tmp_path):
    project_dir = tmp_path / "proj"
    _make_legacy_project(project_dir)

    body = _open(project_dir)

    assert _is_object_shape(body["tracks"])
    on_disk = _read(project_dir)
    assert _is_object_shape(on_disk["tracks"])
    # Items themselves, and their order, are untouched by the shape rewrite.
    assert on_disk["tracks"][0]["items"][0]["id"] == "clip-0"
    assert on_disk["tracks"][1]["items"][0]["id"] == "logo-0"


# ---------------------------------------------------------------------------
# 2. Second open of an already-converged project performs no write
# ---------------------------------------------------------------------------

def test_second_open_of_converged_project_writes_nothing(tmp_path, monkeypatch):
    project_dir = tmp_path / "proj"
    _make_legacy_project(project_dir)

    _open(project_dir)  # first open: converges legacy -> object shape on disk
    project_path = project_dir / "project.json"
    mtime_after_first = project_path.stat().st_mtime_ns
    text_after_first = project_path.read_text()

    # Belt and suspenders on top of the mtime check: prove the write path
    # itself is never even invoked on the second, already-converged open.
    real_replace = os.replace
    calls = []

    def _spy_replace(*a, **k):
        calls.append(a)
        return real_replace(*a, **k)

    monkeypatch.setattr(os, "replace", _spy_replace)

    body = _open(project_dir)

    assert calls == [], "second open on an already-converged project touched the write path"
    assert project_path.stat().st_mtime_ns == mtime_after_first, "second open rewrote the file"
    assert project_path.read_text() == text_after_first
    assert body["tracks"] == json.loads(text_after_first)["tracks"]


# ---------------------------------------------------------------------------
# 3. A project already in the object shape opens with no write at all
# ---------------------------------------------------------------------------

def test_already_object_shape_project_opens_with_no_write(tmp_path):
    project_dir = tmp_path / "proj"
    _make_object_project(project_dir)
    project_path = project_dir / "project.json"
    before = project_path.read_text()
    mtime_before = project_path.stat().st_mtime_ns

    body = _open(project_dir)

    assert project_path.read_text() == before
    assert project_path.stat().st_mtime_ns == mtime_before
    assert body["tracks"][1]["volume"] == 0.8  # track-level field survives untouched


# ---------------------------------------------------------------------------
# 4. Properties the `get_project` comment above asserts, made concrete
# ---------------------------------------------------------------------------

def test_convergence_broadcasts_the_exact_text_that_was_written(tmp_path):
    """`get_project`'s comment: the SSE frame published on convergence is the
    shape-write's own `text` variable, wrapped by `_sse_data_frame` — never a
    separately-serialized copy that could drift from what landed on disk."""
    project_dir = tmp_path / "proj"
    _make_legacy_project(project_dir)  # needs convergence, so a write happens
    project_path = project_dir / "project.json"

    broadcaster = _CapturingBroadcaster()
    asyncio.run(get_project(PID, request=_FakeRequest(broadcaster), project_dir=project_dir))

    # Items are `image`-only (see _make_legacy_project's docstring), so look
    # migration has nothing to do and the shape-convergence broadcast is the
    # only one — exactly one frame, not "at least one".
    assert len(broadcaster.frames) == 1
    published_id, frame = broadcaster.frames[0]
    assert published_id == PID
    assert frame == _sse_data_frame(project_path.read_text())


def test_look_migration_writeback_after_shape_write_preserves_object_shape(tmp_path):
    """`get_project`'s comment: a look-migration background write-back landing
    AFTER the shape write must preserve it — `_apply_project_edits` re-reads
    project.json fresh, mutates only the matched item's field in place, and
    re-serializes whatever `tracks` shape it found. Calling it directly on an
    already-converged file is the same thing a background job does whenever
    it lands after the open that converged the project."""
    project_dir = tmp_path / "proj"
    _make_object_project_with_video(project_dir)
    project_path = project_dir / "project.json"

    result = _apply_project_edits(
        project_path,
        [("clip-0", "/tmp/does-not-matter.mp4", "proxySrc", "/tmp/does-not-matter_proxy_vivid1.mp4")],
    )

    assert result is not None, "the edit should have matched clip-0 and changed something"
    updated_project, _text = result
    assert _is_object_shape(updated_project["tracks"])
    on_disk = _read(project_dir)
    assert _is_object_shape(on_disk["tracks"])
    assert on_disk["tracks"][0]["items"][0]["proxySrc"] == "/tmp/does-not-matter_proxy_vivid1.mp4"
    # Untouched by the edit — proves the write-back didn't rebuild `tracks`
    # from scratch (which would silently drop a field like this).
    assert on_disk["tracks"][1]["volume"] == 0.8


# ---------------------------------------------------------------------------
# 5. A failed write degrades to "not converged yet", never to a failed open
# ---------------------------------------------------------------------------

def test_write_failure_still_returns_normalized_body(tmp_path, monkeypatch):
    project_dir = tmp_path / "proj"
    _make_legacy_project(project_dir)

    def _boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", _boom)

    body = _open(project_dir)

    # The open still succeeds, and the RESPONSE is normalized in memory...
    assert _is_object_shape(body["tracks"])
    # ...even though the write genuinely failed, so disk still holds legacy shape.
    on_disk = _read(project_dir)
    assert isinstance(on_disk["tracks"][0], list)


# ---------------------------------------------------------------------------
# 6. PUT normalizes a legacy-shape body, merge semantics unchanged
# ---------------------------------------------------------------------------

def test_put_normalizes_legacy_body_and_preserves_merge_semantics(tmp_path):
    project_dir = tmp_path / "proj"
    _make_legacy_project(project_dir)  # existing on-disk project, pre-open

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        # Partial PUT — only id/status/tracks, tracks still in the legacy
        # shape — the exact agent pattern save_project's merge comment
        # describes (agents routinely PUT a partial body like this).
        resp = client.put(f"/api/projects/{PID}", json={
            "id": PID,
            "status": "draft",
            "tracks": [[{"id": "clip-0", "type": "image", "src": "/tmp/x.png",
                         "start": 0.0, "end": 3.0}]],
        })
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert _is_object_shape(body["tracks"])
    on_disk = _read(project_dir)
    assert _is_object_shape(on_disk["tracks"])
    assert on_disk["tracks"][0]["items"][0]["id"] == "clip-0"
    # Shallow-merge semantics unchanged: fields absent from the PUT body
    # (settings, projectType, ...) survive from the existing project.
    assert on_disk["settings"]["colorSpace"] == "sdr_bt709"
    assert on_disk["projectType"] == "video"
    # The second track from the original project (not present in the PUT
    # body's tracks) is gone — this IS the existing shallow-merge behaviour
    # (the whole `tracks` key was replaced, not deep-merged), unchanged by
    # normalization.
    assert len(on_disk["tracks"]) == 1


def test_put_explicit_null_still_clears_a_field(tmp_path):
    """Normalizing the merged result must not disturb the explicit-null
    clears-a-field convention `save_project` documents."""
    project_dir = tmp_path / "proj"
    _make_legacy_project(project_dir)

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        resp = client.put(f"/api/projects/{PID}", json={
            "id": PID,
            "status": "draft",
            "tracks": None,
        })
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 200, resp.text
    assert resp.json()["tracks"] is None
    assert _read(project_dir)["tracks"] is None


# ---------------------------------------------------------------------------
# 7. POST .../versions/{commit}/restore normalizes before writing
# ---------------------------------------------------------------------------

def test_restore_version_normalizes_a_legacy_shape_commit(tmp_path):
    """A version committed before the track-shape migration is legacy-shaped
    in git history. `restore_version` must normalize before writing to disk —
    same rule as `save_project` — so restoring an old version never leaves
    legacy tracks on disk (or broadcasts them to a live editor)."""
    project_dir = tmp_path / "proj"
    commit = _git_commit_legacy_version(project_dir)

    # Current on-disk state has since moved on (e.g. new content, still
    # legacy-shaped — restore_version's normalization must not depend on the
    # PRE-restore file being any particular shape, since it overwrites it
    # wholesale from git history rather than merging).
    project_dir.joinpath("project.json").write_text(json.dumps(
        {**_read(project_dir), "status": "final"}, indent=2,
    ))

    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        resp = client.post(f"/api/projects/{PID}/versions/{commit}/restore")
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 200, resp.text
    assert _is_object_shape(resp.json()["tracks"])
    on_disk = _read(project_dir)
    assert _is_object_shape(on_disk["tracks"])
    # The restored content itself — items/order from the committed (legacy)
    # version — survives the shape rewrite untouched.
    assert on_disk["tracks"][0]["items"][0]["id"] == "clip-0"
    assert on_disk["tracks"][1]["items"][0]["id"] == "logo-0"
    assert on_disk["status"] == "draft"  # the committed version's status, not "final"


def test_restore_version_broadcasts_the_normalized_shape(tmp_path):
    """The SSE frame `restore_version` publishes must carry the SAME
    normalized shape written to disk — not the raw legacy shape read out of
    git history — so a live editor subscribed to the project never receives
    tracks the object-shape reader/writer contract doesn't recognize."""
    project_dir = tmp_path / "proj"
    commit = _git_commit_legacy_version(project_dir)

    broadcaster = _CapturingBroadcaster()
    client = TestClient(app, raise_server_exceptions=False)
    app.state.broadcaster = broadcaster
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        resp = client.post(f"/api/projects/{PID}/versions/{commit}/restore")
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 200, resp.text
    assert len(broadcaster.frames) == 1
    published_id, frame = broadcaster.frames[0]
    assert published_id == PID
    assert _is_object_shape(json.loads(frame.removeprefix("data: ").strip())["tracks"])
