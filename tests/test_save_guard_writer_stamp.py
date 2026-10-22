"""§482 U-1: a guarded PUT's broadcast carries a named SSE event just before its project frame,
`event: writer` with `data: <writer class>[;origin=<origin>]`, so an open editor can tell a sync
pull (a `tool` write with origin `sync`) from every other write and prune its undo history for
that one only.

The origin comes from `x-montaj-write-origin` and is honoured only from a request carrying the
launch secret, the same rule as `x-montaj-writer` (save_guard.writer_of). serve's own
maintenance writes (the dims backfill, the copied-media patch) are never stamped, and with the
guard off nothing is. Real FastAPI app, real lock; every project lives under tmp_path."""
import asyncio
import json
import uuid

import pytest
from starlette.testclient import TestClient

import lib.normalize as normalize_mod
import serve.routes.projects as projects_mod
from lib.project_lock import write_json_atomic
from lib.project_revisions import revisions_of
from lib.project_tracks import normalize_tracks
from serve import save_guard
from serve.common import get_project_dir
from serve.server import app

PID = "stamp-proj"
SECRET = "5e" * 32
OTHER = "a1" * 32
TOOL = {"x-montaj-shell": SECRET, "x-montaj-writer": "tool"}
EDITOR = {"x-montaj-shell": SECRET, "x-montaj-writer": "editor", "x-montaj-guard": "advisory"}
SYNC = {"x-montaj-write-origin": "sync"}

_REAL_DIMS = projects_mod.ensure_source_dims


class _Recorder:
    def __init__(self):
        self.published = []

    def publish(self, project_id, data):
        self.published.append((project_id, data))


def _events(data):
    """The (event, data) pairs in one published string, read the way an EventSource reads them."""
    out = []
    for block in data.split("\n\n"):
        event, lines = "message", []
        for line in block.split("\n"):
            if not line or line.startswith(":"):
                continue
            field, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value
            if field == "event":
                event = value
            elif field == "data":
                lines.append(value)
        if lines:
            out.append((event, "\n".join(lines)))
    return out


def _frames(recorder, pid=PID):
    """One list of (event, data) pairs per publish for the project."""
    return [_events(data) for project_id, data in recorder.published if project_id == pid]


def _start(monkeypatch, *, guard=True):
    if guard:
        monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    else:
        monkeypatch.delenv("MONTAJ_ENGINE_GUARD", raising=False)
    monkeypatch.delenv("MONTAJ_SHELL_SECRET_STDIN", raising=False)
    save_guard._state.update({"secret": None, "logged": False, "secret_logged": False})
    save_guard._inject_secret_for_tests(SECRET)
    save_guard.startup()


@pytest.fixture
def recorder(monkeypatch):
    saved = dict(save_guard._state)
    previous = getattr(app.state, "broadcaster", None)

    async def _no_previews(*a, **k):
        return None

    async def _no_dims(project_id, project_dir, project, broadcaster=None):
        return project

    monkeypatch.setattr(projects_mod, "_queue_previews_for_changed_items", _no_previews)
    monkeypatch.setattr(projects_mod, "ensure_source_dims", _no_dims)
    rec = _Recorder()
    app.state.broadcaster = rec
    try:
        yield rec
    finally:
        app.state.broadcaster = previous
        save_guard._state.clear()
        save_guard._state.update(saved)


@pytest.fixture
def proj(tmp_path, recorder):
    project_dir = tmp_path / PID
    project_dir.mkdir()
    write_json_atomic(project_dir / "project.json", {
        "id": PID, "name": "first", "status": "draft", "tracks": [{"id": "trk-0", "items": []}], "sources": [],
    })
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        yield project_dir
    finally:
        app.dependency_overrides.pop(get_project_dir, None)


def _put(project_dir, body, headers, pid=PID):
    """A PUT that sends the revision of every field it changes, so any writer class passes the guard."""
    disk = json.loads((project_dir / "project.json").read_text())
    read = revisions_of(normalize_tracks(disk), list(body))
    resp = TestClient(app, raise_server_exceptions=False).put(
        f"/api/projects/{pid}", json={"id": pid, **body},
        headers={**headers, "x-montaj-read-revisions": json.dumps(read)})
    assert resp.status_code == 200, resp.text
    return resp


def test_a_trusted_tool_save_with_origin_sync_is_stamped_just_before_its_frame(proj, recorder, monkeypatch):
    _start(monkeypatch)
    _put(proj, {"name": "pulled"}, {**TOOL, **SYNC})
    # One publish: the stamp and its frame are adjacent on every connection.
    assert len(recorder.published) == 1
    [(event, stamp), (kind, data)] = _frames(recorder)[0]
    assert (event, stamp) == ("writer", "tool;origin=sync")
    assert kind == "message"
    assert json.loads(data)["name"] == "pulled"


@pytest.mark.parametrize("headers", [
    TOOL,
    EDITOR,
    {**EDITOR, **SYNC},
    {"x-montaj-shell": SECRET, "x-montaj-writer": "ai", **SYNC},
], ids=["plain-tool", "editor", "editor-naming-sync", "trusted-ai-naming-sync"])
def test_only_a_trusted_tool_sync_save_is_stamped(proj, recorder, monkeypatch, headers):
    """Narrowed: a plain tool, an editor (even naming sync) and an ai save get no stamp."""
    _start(monkeypatch)
    _put(proj, {"name": "second"}, headers)
    assert [e for e, _ in _frames(recorder)[0]] == ["message"]


@pytest.mark.parametrize("headers", [
    {"x-montaj-writer": "tool", **SYNC},
    {"x-montaj-shell": OTHER, "x-montaj-writer": "tool", **SYNC},
], ids=["no-secret", "wrong-secret"])
def test_an_untrusted_request_naming_sync_is_not_stamped(proj, recorder, monkeypatch, headers):
    _start(monkeypatch)
    _put(proj, {"name": "second"}, headers)
    assert [e for e, _ in _frames(recorder)[0]] == ["message"]


@pytest.mark.parametrize("origin", ["Sync", "sync;origin=x", "sync pull", "a" * 33, "", "other"])
def test_an_origin_other_than_exactly_sync_is_not_stamped(proj, recorder, monkeypatch, origin):
    _start(monkeypatch)
    _put(proj, {"name": "second"}, {**TOOL, "x-montaj-write-origin": origin})
    assert [e for e, _ in _frames(recorder)[0]] == ["message"]


def test_with_the_guard_off_no_save_is_stamped(proj, recorder, monkeypatch):
    _start(monkeypatch, guard=False)
    _put(proj, {"name": "second"}, {**TOOL, **SYNC})
    assert [e for e, _ in _frames(recorder)[0]] == ["message"]


def test_the_dims_backfill_is_never_stamped(tmp_path, recorder, monkeypatch):
    _start(monkeypatch)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"not probed: probe_video is stubbed")
    project_dir = tmp_path / PID
    project_dir.mkdir()
    project = {"id": PID, "name": "n", "status": "draft", "sources": [],
               "tracks": [{"id": "trk-0", "items": [{"id": "clip-1", "type": "video", "src": str(clip), "start": 0, "end": 1}]}]}
    write_json_atomic(project_dir / "project.json", project)
    monkeypatch.setattr(normalize_mod, "probe_video", lambda src: {"display_width": 3840, "display_height": 2160})
    asyncio.run(_REAL_DIMS(PID, project_dir, project, recorder))
    frames = _frames(recorder)
    assert frames, "the backfill broadcast its write"
    assert all(event == "message" for frame in frames for event, _ in frame)
    item = json.loads(frames[0][0][1])["tracks"][0]["items"][0]
    assert (item["sourceWidth"], item["sourceHeight"]) == (3840, 2160)


def test_the_copied_media_patch_after_a_sync_save_is_not_stamped(tmp_path, recorder, monkeypatch):
    _start(monkeypatch)
    ws = (tmp_path / "ws").resolve()
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    pid = f"p-{uuid.uuid4().hex[:12]}"
    folder = ws / "2026-10-21-this"
    folder.mkdir()
    write_json_atomic(folder / "project.json", {
        "id": pid, "name": "this", "status": "draft", "tracks": [{"id": "trk-0", "items": []}],
        "sources": [], "assets": [], "audio": {"tracks": []},
    })
    other = ws / "2026-10-01-other"
    (other / "assets").mkdir(parents=True)
    write_json_atomic(other / "project.json", {"id": f"p-{uuid.uuid4().hex[:12]}", "name": "other", "status": "draft"})
    src = other / "assets" / "still.png"
    src.write_bytes(b"media:still.png" * 8)
    item = {"id": "it-1", "type": "image", "src": str(src), "start": 0.0, "end": 2.0}

    _put(folder, {"tracks": [{"id": "trk-0", "items": [item]}]}, {**TOOL, **SYNC}, pid=pid)

    frames = _frames(recorder, pid)
    assert len(frames) == 2, "the save's frame, then the patch's"
    assert [e for e, _ in frames[0]] == ["writer", "message"]
    assert frames[0][0][1] == "tool;origin=sync"
    assert [e for e, _ in frames[1]] == ["message"]
    assert json.loads(frames[1][0][1])["tracks"][0]["items"][0]["src"] == str(folder / "assets" / "still.png")


def test_dark_parity_no_unread_header_and_broadcasts_byte_identical_to_before_the_stamp(proj, recorder, monkeypatch):
    """With no sync-origin write, serve behaves as at df0f1602: no x-montaj-unread on any answer,
    and each broadcast is exactly the one string that commit emitted, `data: ` + json.dumps of the
    saved document (default separators) + a blank line. No `event: writer` anywhere."""
    _start(monkeypatch)
    client = TestClient(app, raise_server_exceptions=False)
    steps = [
        ({"name": "t1"}, TOOL),
        ({"name": "a1"}, {}),
        ({"status": "final"}, {"x-montaj-shell": SECRET, "x-montaj-writer": "ai"}),
        ({"name": "e1"}, EDITOR),
        ({"status": "draft"}, EDITOR),
    ]
    for n, (body, headers) in enumerate(steps, start=1):
        if headers is EDITOR:
            resp = client.put(f"/api/projects/{PID}", json={"id": PID, **body}, headers=headers)
            assert resp.status_code == 200, resp.text
        else:
            resp = _put(proj, body, headers)
        assert "x-montaj-unread" not in resp.headers
        saved = json.loads((proj / "project.json").read_text())
        published = [data for pid, data in recorder.published if pid == PID]
        assert len(published) == n
        assert published[-1] == "data: " + json.dumps(saved) + "\n\n"
