"""save_project copies media a project borrows from elsewhere in the workspace
into the project itself (§126, `serve/save_media.py`).

Measured 2026-10-07: a project's outro sound pointed at another project's
`assets/outro.wav`, so deleting that other project broke this one mid-render;
another pointed at seven files in the app's `.imports/` staging area. Every
writer (the AI, the editor, agents) goes through `PUT /projects/{id}`, so the
save is where a borrowed path is caught: a NEW or CHANGED `src` (track video and
image items, `sources`, `assets`, `audio.tracks`) under the workspace, inside
another project's folder, `.imports/` or `_uploads/`, is copied into
`<project>/assets/` and the path is rewritten. Clips links, shared `.sources`
originals, proxies and the user's own files are left alone.

Every file lives under tmp_path; the workspace is pointed there with
MONTAJ_WORKSPACE_DIR (tests/test_server_delete_preserve.py's convention).
"""
import asyncio
import collections
import ctypes
import errno
import json
import ntpath
import os
import shutil
import sys
import threading
import time
import types
import unicodedata
import uuid
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

import project.init as init_mod
import serve.routes.projects as projects_mod
import serve.save_media as save_media
from serve.common import get_project_dir
from serve.server import app

client = TestClient(app, raise_server_exceptions=False)


class _StubBroadcaster:
    def publish(self, *a, **k):
        pass


@pytest.fixture
def ws(tmp_path, monkeypatch):
    ws = (tmp_path / "ws").resolve()
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    # The save's follow-ups (proxy queueing, dims probing) would ffprobe these
    # fake files; they are not what these tests are about.

    async def _no_previews(*a, **k):
        return None

    async def _no_dims(project_id, project_dir, project, broadcaster=None):
        return project

    monkeypatch.setattr(projects_mod, "_queue_previews_for_changed_items", _no_previews)
    monkeypatch.setattr(projects_mod, "ensure_source_dims", _no_dims)
    app.state.broadcaster = _StubBroadcaster()
    return ws


def _project(folder: Path, **fields) -> str:
    """Write a project.json in `folder`; returns its (unique) id."""
    pid = f"p-{uuid.uuid4().hex[:12]}"
    folder.mkdir(parents=True, exist_ok=True)
    proj = {
        "id": pid,
        "name": folder.name,
        "status": "draft",
        "tracks": [{"id": "trk-0", "items": []}],
        "sources": [],
        "assets": [],
        "audio": {"tracks": []},
        **fields,
    }
    (folder / "project.json").write_text(json.dumps(proj))
    return pid


def _file(path: Path, content: bytes | None = None) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content if content is not None else f"media:{path.name}".encode() * 8)
    return str(path)


def _video(item_id, src, **over):
    return {"id": item_id, "type": "video", "src": src, "start": 0.0, "end": 2.0, **over}


def _image(item_id, src, **over):
    return {"id": item_id, "type": "image", "src": src, "start": 0.0, "end": 2.0, **over}


def _tracks(*items):
    return [{"id": "trk-0", "items": list(items)}]


def _put(pid, **body):
    return client.put(f"/api/projects/{pid}", json={"id": pid, **body})


def _on_disk(folder: Path) -> dict:
    return json.loads((folder / "project.json").read_text())


def _items(folder: Path) -> list:
    return _on_disk(folder)["tracks"][0]["items"]


def _assets(folder: Path) -> list:
    """The media in <project>/assets/, without the copy record (.copied.json)."""
    return sorted(p.name for p in (folder / "assets").iterdir() if not p.name.startswith("."))


@pytest.fixture
def this(ws):
    folder = ws / "2026-10-07-this"
    return _project(folder), folder


@pytest.fixture
def other(ws):
    folder = ws / "2026-10-01-other"
    _project(folder)
    return folder


# ---------------------------------------------------------------------------
# 1. A track item into another project's folder is copied.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("make", [_video, _image], ids=["video", "image"])
def test_track_item_into_another_project_is_copied(this, other, make):
    pid, folder = this
    name = "clip.mp4" if make is _video else "still.png"
    src = _file(other / "assets" / name)

    resp = _put(pid, tracks=_tracks(make("it-1", src)))

    assert resp.status_code == 200, resp.text
    dest = str(folder / "assets" / name)
    assert _items(folder)[0]["src"] == dest
    assert Path(dest).read_bytes() == Path(src).read_bytes()
    assert Path(src).is_file(), "the other project's file is left where it was"
    assert resp.json()["copied"] == [{"from": src, "to": dest}]
    assert "copied" not in _on_disk(folder), "the report is in the answer, never in project.json"
    assert "warnings" not in resp.json()


# ---------------------------------------------------------------------------
# 2. audio.tracks[].src into another project (the measured case).
# ---------------------------------------------------------------------------

def test_audio_track_into_another_project_is_copied(this, other):
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")

    resp = _put(pid, audio={"tracks": [{"id": "sfx-outro", "src": src, "start": 9.0}]})

    assert resp.status_code == 200, resp.text
    dest = str(folder / "assets" / "outro.wav")
    assert _on_disk(folder)["audio"]["tracks"][0]["src"] == dest
    assert Path(dest).read_bytes() == Path(src).read_bytes()
    assert resp.json()["copied"] == [{"from": src, "to": dest}]


# ---------------------------------------------------------------------------
# 3. The import staging area and uploads.
# ---------------------------------------------------------------------------

def test_imports_source_is_copied(this, ws):
    pid, folder = this
    src = _file(ws / ".imports" / "imp-123" / "clip.mp4")

    resp = _put(pid, sources=[_video("clip-0", src)], tracks=_tracks(_video("clip-0", src)))

    assert resp.status_code == 200, resp.text
    dest = str(folder / "assets" / "clip.mp4")
    disk = _on_disk(folder)
    assert disk["sources"][0]["src"] == dest
    assert disk["tracks"][0]["items"][0]["src"] == dest
    assert resp.json()["copied"] == [{"from": src, "to": dest}]


def test_uploads_asset_is_copied(this, ws):
    pid, folder = this
    src = _file(ws / "_uploads" / "logo.png")

    resp = _put(pid, assets=[{"id": "asset-0", "src": src, "type": "image", "name": "logo.png"}])

    assert resp.status_code == 200, resp.text
    dest = str(folder / "assets" / "logo.png")
    assert _on_disk(folder)["assets"][0]["src"] == dest
    assert Path(dest).read_bytes() == Path(src).read_bytes()
    assert resp.json()["copied"] == [{"from": src, "to": dest}]


# ---------------------------------------------------------------------------
# 4. A Clips child's link inside its own folder stays a link.
# ---------------------------------------------------------------------------

def test_symlink_inside_own_folder_into_parent_is_not_copied(this, other):
    pid, folder = this
    target = _file(other / "footage.mov")
    link = folder / "footage.mov"
    os.symlink(target, link)

    resp = _put(pid, tracks=_tracks(_video("clip-0", str(link))))

    assert resp.status_code == 200, resp.text
    assert _items(folder)[0]["src"] == str(link)
    assert "copied" not in resp.json()
    assert not (folder / "assets").exists()


# ---------------------------------------------------------------------------
# 5. Shared Clips originals under .sources stay shared.
# ---------------------------------------------------------------------------

def test_plain_path_into_shared_sources_is_not_copied(this, ws):
    pid, folder = this
    src = _file(ws / ".sources" / "src-abc" / "original.mov")
    # Even a shared folder that looks like a project stays shared.
    _file(ws / ".sources" / "src-abc" / "project.json", b'{"id": "not-a-project"}')

    resp = _put(pid, tracks=_tracks(_video("clip-0", src)), sources=[_video("clip-0", src)])

    assert resp.status_code == 200, resp.text
    assert _items(folder)[0]["src"] == src
    assert _on_disk(folder)["sources"][0]["src"] == src
    assert "copied" not in resp.json()


# ---------------------------------------------------------------------------
# 6. A nested child's plain path into its parent's folder: the parent is
#    another project, so it is copied. (serve never treats a nested folder as a
#    project of its own, find_project_dir, so the child is reached directly.)
# ---------------------------------------------------------------------------

def test_nested_child_plain_path_into_parent_is_copied(ws):
    parent = ws / "2026-10-02-parent"
    _project(parent)
    child = parent / "clips" / "child-1"
    pid = _project(child)
    src = _file(parent / "music.wav")
    app.dependency_overrides[get_project_dir] = lambda: child
    try:
        resp = _put(pid, audio={"tracks": [{"id": "mus-a", "src": src}]})
    finally:
        app.dependency_overrides.pop(get_project_dir, None)

    assert resp.status_code == 200, resp.text
    dest = str(child / "assets" / "music.wav")
    assert _on_disk(child)["audio"]["tracks"][0]["src"] == dest
    assert resp.json()["copied"] == [{"from": src, "to": dest}]


# ---------------------------------------------------------------------------
# 7. proxySrc is never copied or rewritten.
# ---------------------------------------------------------------------------

def test_proxy_src_into_another_project_is_untouched(this, other):
    pid, folder = this
    own = _file(folder / "own.mp4")
    foreign = _file(other / "clip.mp4")
    own_proxy = _file(other / "own_proxy.mp4")
    foreign_proxy = _file(other / "clip_proxy.mp4")

    resp = _put(pid, tracks=_tracks(
        _video("clip-0", own, proxySrc=own_proxy),
        _video("clip-1", foreign, proxySrc=foreign_proxy),
    ))

    assert resp.status_code == 200, resp.text
    items = _items(folder)
    assert items[0]["src"] == own
    assert items[0]["proxySrc"] == own_proxy
    assert items[1]["src"] == str(folder / "assets" / "clip.mp4")
    assert items[1]["proxySrc"] == foreign_proxy
    assert [c["from"] for c in resp.json()["copied"]] == [foreign]
    assert not (folder / "assets" / "own_proxy.mp4").exists()
    assert not (folder / "assets" / "clip_proxy.mp4").exists()


# ---------------------------------------------------------------------------
# 8. Paths the hook must never touch.
# ---------------------------------------------------------------------------

def _outside(ws, other):
    # A project folder of its own, but outside this workspace: still the
    # user's, never copied.
    _file(ws.parent / "my-footage" / "project.json", b'{"id": "elsewhere"}')
    return _file(ws.parent / "my-footage" / "clip.mp4")


def _missing(ws, other):
    return str(other / "gone.mp4")


def _link_in_other_project(ws, other):
    target = _file(ws.parent / "my-footage" / "real.mp4")
    link = other / "linked.mp4"
    os.symlink(target, link)
    return str(link)


def _loose_in_workspace(ws, other):
    return _file(ws / "loose.mp4")


@pytest.mark.parametrize("make_src", [_outside, _missing, _link_in_other_project, _loose_in_workspace],
                         ids=["outside-workspace", "missing", "symlink-in-other-project", "workspace-root-file"])
def test_paths_left_alone(this, other, ws, make_src):
    pid, folder = this
    src = make_src(ws, other)

    resp = _put(pid, tracks=_tracks(_video("clip-0", src)))

    assert resp.status_code == 200, resp.text
    assert _items(folder)[0]["src"] == src
    assert "copied" not in resp.json()
    assert "warnings" not in resp.json()
    assert not (folder / "assets").exists()


def test_relative_src_is_left_alone(this, other, ws, monkeypatch):
    """Relative even when serve's cwd would place it in another project."""
    pid, folder = this
    _file(other / "clip.mp4")
    monkeypatch.chdir(ws)
    src = "2026-10-01-other/clip.mp4"

    resp = _put(pid, tracks=_tracks(_video("clip-0", src)))

    assert resp.status_code == 200, resp.text
    assert _items(folder)[0]["src"] == src
    assert "copied" not in resp.json()
    assert not (folder / "assets").exists()


def test_non_string_src_is_left_alone(this):
    pid, folder = this
    resp = _put(pid, tracks=_tracks(_video("clip-0", None), _image("img-0", 7)),
                assets=[{"id": "asset-0", "src": ["x"]}], audio={"tracks": [{"id": "a", "src": {"p": 1}}]})
    assert resp.status_code == 200, resp.text
    items = _items(folder)
    assert items[0]["src"] is None and items[1]["src"] == 7
    assert "copied" not in resp.json()


# ---------------------------------------------------------------------------
# 9. An unchanged path is never copied, so repeat saves cost nothing.
# ---------------------------------------------------------------------------

def test_unchanged_src_already_in_another_project_is_not_copied(this, other):
    pid, folder = this
    src = _file(other / "clip.mp4")
    audio_src = _file(other / "outro.wav")
    on_disk = _on_disk(folder)
    on_disk["tracks"] = _tracks(_video("clip-0", src))
    on_disk["audio"] = {"tracks": [{"id": "sfx", "src": audio_src}]}
    (folder / "project.json").write_text(json.dumps(on_disk))

    # A save that changes something else on the same item and track...
    resp = _put(pid, tracks=_tracks(_video("clip-0", src, end=3.0)),
                audio={"tracks": [{"id": "sfx", "src": audio_src, "volume": 0.5}]})
    assert resp.status_code == 200, resp.text
    assert _items(folder)[0] == _video("clip-0", src, end=3.0)
    assert _on_disk(folder)["audio"]["tracks"][0]["src"] == audio_src
    assert "copied" not in resp.json()

    # ...and one that does not carry tracks at all.
    resp = _put(pid, name="renamed")
    assert resp.status_code == 200, resp.text
    assert _items(folder)[0]["src"] == src
    assert "copied" not in resp.json()
    assert not (folder / "assets").exists()


# ---------------------------------------------------------------------------
# 10. The same source in several places is copied once.
# ---------------------------------------------------------------------------

def test_same_source_in_two_items_is_copied_once(this, other):
    pid, folder = this
    src = _file(other / "clip.mp4")

    resp = _put(pid, tracks=_tracks(_video("clip-0", src), _video("clip-1", src, start=2.0, end=4.0)))

    assert resp.status_code == 200, resp.text
    dest = str(folder / "assets" / "clip.mp4")
    assert [i["src"] for i in _items(folder)] == [dest, dest]
    assert _assets(folder) == ["clip.mp4"]
    assert resp.json()["copied"] == [{"from": src, "to": dest}]


def test_resent_old_path_reuses_the_copy(this, other):
    """An editor or agent still holding the old path saves it again: the
    project's earlier copy is reused, never copied a second time."""
    pid, folder = this
    src = _file(other / "clip.mp4")
    dest = str(folder / "assets" / "clip.mp4")
    assert _put(pid, tracks=_tracks(_video("clip-0", src))).status_code == 200
    assert _items(folder)[0]["src"] == dest

    resp = _put(pid, tracks=_tracks(_video("clip-0", src), _video("clip-1", src)))

    assert resp.status_code == 200, resp.text
    assert [i["src"] for i in _items(folder)] == [dest, dest]
    assert _assets(folder) == ["clip.mp4"]
    assert resp.json()["copied"] == [{"from": src, "to": dest}]


def test_name_collision_gets_a_numbered_copy(this, other, ws):
    pid, folder = this
    _file(folder / "assets" / "clip.mp4", b"this project's own, different clip")
    src = _file(other / "clip.mp4")

    resp = _put(pid, tracks=_tracks(_video("clip-0", src)))

    assert resp.status_code == 200, resp.text
    dest = folder / "assets" / "clip_asset2.mp4"
    assert _items(folder)[0]["src"] == str(dest)
    assert dest.read_bytes() == Path(src).read_bytes()
    assert (folder / "assets" / "clip.mp4").read_bytes() == b"this project's own, different clip"


# ---------------------------------------------------------------------------
# 11. A failed copy leaves the path, warns, and still saves.
# ---------------------------------------------------------------------------

@pytest.mark.skipif(sys.platform == "win32" or (hasattr(os, "geteuid") and os.geteuid() == 0),
                    reason="chmod 000 does not stop root or Windows from reading")
def test_copy_failure_leaves_path_and_warns(this, other):
    pid, folder = this
    bad = _file(other / "locked.mp4")
    good = _file(other / "fine.wav")
    os.chmod(bad, 0)
    try:
        resp = _put(pid, name="still saved", tracks=_tracks(_video("clip-0", bad)),
                    audio={"tracks": [{"id": "a", "src": good}]})
    finally:
        os.chmod(bad, 0o644)

    assert resp.status_code == 200, resp.text
    disk = _on_disk(folder)
    assert disk["name"] == "still saved"
    assert disk["tracks"][0]["items"][0]["src"] == bad
    assert disk["audio"]["tracks"][0]["src"] == str(folder / "assets" / "fine.wav")
    body = resp.json()
    assert body["copied"] == [{"from": good, "to": str(folder / "assets" / "fine.wav")}]
    assert len(body["warnings"]) == 1 and bad in body["warnings"][0]
    assert _assets(folder) == ["fine.wav"], "no partial copy left behind"
    assert not [p for p in (folder / "assets").iterdir() if ".copying" in p.name], "no temp file left behind"


# ---------------------------------------------------------------------------
# 12. A file over the size cap is left where it is, with a warning.
# ---------------------------------------------------------------------------

def test_over_cap_file_is_left_with_a_warning(this, other, monkeypatch):
    """The cap is on a plain copy: where there is no clone, a file over it stays."""
    import project.init as init_mod
    import serve.save_media as save_media
    monkeypatch.setattr(init_mod, "_clonefile_fn", lambda: None)
    monkeypatch.setattr(save_media, "MAX_COPY_BYTES", 16)
    _plenty_of_disk(monkeypatch)
    pid, folder = this
    big = _file(other / "big.mp4", b"x" * 17)
    small = _file(other / "small.wav", b"y" * 16)

    resp = _put(pid, tracks=_tracks(_video("clip-0", big)), audio={"tracks": [{"id": "a", "src": small}]})

    assert resp.status_code == 200, resp.text
    assert _items(folder)[0]["src"] == big
    assert _on_disk(folder)["audio"]["tracks"][0]["src"] == str(folder / "assets" / "small.wav")
    body = resp.json()
    assert len(body["warnings"]) == 1 and big in body["warnings"][0]
    assert not (folder / "assets" / "big.mp4").exists()


# ---------------------------------------------------------------------------
# The workspace reached through a symlinked path: both spellings count.
# ---------------------------------------------------------------------------

def test_workspace_through_a_symlink(tmp_path, ws, monkeypatch):
    alias = tmp_path / "ws-alias"
    os.symlink(ws, alias)
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(alias))
    folder = alias / "2026-10-07-aliased"
    pid = _project(folder)
    _project(ws / "2026-10-01-donor")
    src = _file(ws / "2026-10-01-donor" / "outro.wav")          # real spelling
    own = _file(ws / "2026-10-07-aliased" / "own.wav")          # this project, real spelling

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": src}, {"id": "b", "src": own}]})

    assert resp.status_code == 200, resp.text
    tracks = _on_disk(folder)["audio"]["tracks"]
    assert tracks[0]["src"] == str(folder / "assets" / "outro.wav")
    assert tracks[1]["src"] == own


# ---------------------------------------------------------------------------
# The clone itself: an APFS clone where it can be, nothing where it cannot.
# ---------------------------------------------------------------------------

def test_try_clone_without_a_clone_makes_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(init_mod, "_clonefile_fn", lambda: None)
    src = _file(tmp_path / "a.wav")
    dest = tmp_path / "b.wav"

    assert init_mod._try_clone(src, str(dest)) is False
    assert not dest.exists()


@pytest.mark.skipif(sys.platform != "darwin", reason="clonefile is macOS only")
def test_try_clone_clones_on_apfs(tmp_path):
    src = _file(tmp_path / "a.wav")
    os.utime(src, ns=(1_600_000_000_123_456_789, 1_600_000_000_123_456_789))
    dest = str(tmp_path / "b.wav")

    assert init_mod._try_clone(src, dest) is True

    assert Path(dest).read_bytes() == Path(src).read_bytes()
    assert os.stat(dest).st_mtime_ns == os.stat(src).st_mtime_ns
    with pytest.raises(FileExistsError):
        init_mod._try_clone(_file(tmp_path / "c.wav", b"other"), dest)
    assert Path(dest).read_bytes() == Path(src).read_bytes(), "never overwrites"


# ===========================================================================
# §126 review: concurrency, ids, big files, the write, names, records.
# ===========================================================================

def _fake_clonefile(src, dest, flags):
    """clonefile(2) stand-in for any OS: makes the NEW file `dest` (never
    through or over an entry, as the real call), keeps the timestamps."""
    try:
        fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        ctypes.set_errno(errno.EEXIST)
        return -1
    with os.fdopen(fd, "wb") as out, open(src, "rb") as inp:
        out.write(inp.read())
    shutil.copystat(src, dest)
    return 0


def _plenty_of_disk(monkeypatch):
    """A plain copy checks the real free space; these tests are not about it."""
    monkeypatch.setattr(shutil, "disk_usage", lambda path: types.SimpleNamespace(total=10 ** 13, used=0, free=10 ** 13))


@pytest.fixture
def no_clone(monkeypatch):
    monkeypatch.setattr(init_mod, "_clonefile_fn", lambda: None)
    _plenty_of_disk(monkeypatch)


@pytest.fixture
def fake_clone(monkeypatch):
    monkeypatch.setattr(init_mod, "_clonefile_fn", lambda: _fake_clonefile)


class _SlowCopy:
    """Holds the save's copy (the part that runs off the event loop) until
    `release`, so a test can land other writes while it is in flight."""

    def __init__(self, monkeypatch):
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        real = projects_mod.copy_borrowed_media

        def slow(*a, **k):
            self.calls += 1
            self.started.set()
            assert self.release.wait(10), "copy never released"
            return real(*a, **k)

        monkeypatch.setattr(projects_mod, "copy_borrowed_media", slow)

    async def wait_started(self):
        for _ in range(2000):
            if self.started.is_set():
                return
            await asyncio.sleep(0.005)
        raise AssertionError("the copy never started")


class _Frames:
    """A broadcaster that keeps every project.json frame published."""

    def __init__(self):
        self.frames: list[dict] = []

    def publish(self, project_id, frame):
        if frame.startswith("data: "):
            self.frames.append(json.loads(frame[len("data: "):]))


async def _until(cond, timeout=5.0):
    for _ in range(int(timeout / 0.005)):
        if cond():
            return
        await asyncio.sleep(0.005)


def _aput(c, pid, **body):
    return c.put(f"/api/projects/{pid}", json={"id": pid, **body})


def _run(coro_fn):
    async def go():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://x") as c:
            return await coro_fn(c)
    return asyncio.run(go())


def _whole_body(folder: Path, **over) -> dict:
    """What the editor sends: the whole project as it holds it."""
    return {**_on_disk(folder), **over}


@pytest.fixture
def followups(ws, monkeypatch):
    """Records the project each of the save's follow-ups (proxy queueing,
    dims probing) was given."""
    seen = {"previews": [], "dims": []}

    async def previews(project_id, project_dir, previous, project, broadcaster):
        seen["previews"].append(json.loads(json.dumps(project)))

    async def dims(project_id, project_dir, project, broadcaster=None):
        seen["dims"].append(json.loads(json.dumps(project)))
        return project

    monkeypatch.setattr(projects_mod, "_queue_previews_for_changed_items", previews)
    monkeypatch.setattr(projects_mod, "ensure_source_dims", dims)
    return seen


# ---------------------------------------------------------------------------
# MUST 1: the save is written at once; the copy runs after it, off the loop
# and with no lock; a second synchronous write (the patch) swaps only the
# copied paths, so nothing that lands during the copy is lost.
# ---------------------------------------------------------------------------

def test_the_save_lands_before_the_copy_and_the_patch_is_announced(this, other, monkeypatch):
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    slow = _SlowCopy(monkeypatch)
    frames = _Frames()
    app.state.broadcaster = frames

    async def go(c):
        a = asyncio.create_task(_aput(c, pid, name="with sound", audio={"tracks": [{"id": "sfx", "src": src}]}))
        await slow.wait_started()
        during = _on_disk(folder)
        slow.release.set()
        return during, await a

    during, resp = _run(go)
    dest = str(folder / "assets" / "outro.wav")
    assert during["name"] == "with sound", "the save waited for the copy"
    assert during["audio"]["tracks"] == [{"id": "sfx", "src": src}]
    assert resp.status_code == 200, resp.text
    assert [f["audio"]["tracks"][0]["src"] for f in frames.frames] == [src, dest], \
        "the save and then the patch are each announced to open editors"
    assert _on_disk(folder)["audio"]["tracks"] == [{"id": "sfx", "src": dest}]
    assert resp.json()["copied"] == [{"from": src, "to": dest}]


def test_rename_during_a_slow_copy_lands_at_once_and_survives(this, other, monkeypatch):
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    slow = _SlowCopy(monkeypatch)

    async def go(c):
        a = asyncio.create_task(_aput(c, pid, audio={"tracks": [{"id": "sfx", "src": src}]}))
        await slow.wait_started()
        rb = await asyncio.wait_for(_aput(c, pid, name="renamed-during-copy"), 5)
        renamed = _on_disk(folder)["name"]
        slow.release.set()
        return await a, rb, renamed

    ra, rb, renamed = _run(go)
    assert ra.status_code == 200 and rb.status_code == 200, (ra.text, rb.text)
    assert renamed == "renamed-during-copy"
    disk = _on_disk(folder)
    assert disk["name"] == "renamed-during-copy", "the patch lost the rename"
    assert disk["audio"]["tracks"][0]["src"] == str(folder / "assets" / "outro.wav")
    assert slow.calls == 1


def test_ingest_append_during_a_slow_copy_survives_a_whole_body_save(this, other, monkeypatch):
    """The editor saves its whole project (tracks, sources, audio, ...); an
    ingest appends to `sources` with its own read and write
    (`_run_ingest_detached`) while the copy runs. The patch swaps one path and
    never merges the body again, so the append stays."""
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    slow = _SlowCopy(monkeypatch)
    body = _whole_body(folder, audio={"tracks": [{"id": "sfx", "src": src}]})
    assert {"tracks", "sources", "assets", "audio"} <= set(body)

    async def go(c):
        a = asyncio.create_task(c.put(f"/api/projects/{pid}", json=body))
        await slow.wait_started()
        proj = _on_disk(folder)
        proj.setdefault("sources", []).append({"id": "clip-9", "type": "video", "src": str(folder / "in.mp4")})
        (folder / "project.json").write_text(json.dumps(proj, indent=2))
        slow.release.set()
        return await a

    resp = _run(go)
    assert resp.status_code == 200, resp.text
    disk = _on_disk(folder)
    assert [s["id"] for s in disk["sources"]] == ["clip-9"], "the ingest's append was lost"
    assert disk["audio"]["tracks"][0]["src"] == str(folder / "assets" / "outro.wav")
    assert resp.json()["sources"] == disk["sources"], "the answer is what was written"


def test_a_save_removing_the_sound_during_its_copy_wins(this, other, monkeypatch):
    """The user removes the sound right after adding it, while its copy is
    still in flight: the patch finds nothing to swap. The copy stays, recorded."""
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    slow = _SlowCopy(monkeypatch)

    async def go(c):
        a = asyncio.create_task(_aput(c, pid, audio={"tracks": [{"id": "sfx", "src": src}]}))
        await slow.wait_started()
        rb = await asyncio.wait_for(_aput(c, pid, audio={"tracks": []}), 5)
        slow.release.set()
        return await a, rb

    ra, rb = _run(go)
    assert ra.status_code == 200 and rb.status_code == 200
    assert _on_disk(folder)["audio"]["tracks"] == [], "the earlier save overwrote the later one"
    assert "copied" not in ra.json()
    assert _assets(folder) == ["outro.wav"]


def test_the_patch_leaves_an_entry_someone_else_changed(this, other, monkeypatch):
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    own = _file(folder / "voice.wav")
    slow = _SlowCopy(monkeypatch)

    async def go(c):
        a = asyncio.create_task(_aput(c, pid, audio={"tracks": [{"id": "sfx", "src": src}]}))
        await slow.wait_started()
        rb = await asyncio.wait_for(_aput(c, pid, audio={"tracks": [{"id": "sfx", "src": own, "volume": 0.5}]}), 5)
        slow.release.set()
        return await a, rb

    ra, rb = _run(go)
    assert ra.status_code == 200 and rb.status_code == 200
    assert _on_disk(folder)["audio"]["tracks"] == [{"id": "sfx", "src": own, "volume": 0.5}]
    assert "copied" not in ra.json()


def test_a_second_save_still_holding_the_path_during_the_copy_makes_no_second_copy(this, other, fake_clone, monkeypatch):
    """The editor's next save still holds the borrowed path while the first
    copy is in flight: that path is on disk now, so it is not new, and the
    first save's patch swaps it under the second save's other changes."""
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    slow = _SlowCopy(monkeypatch)

    async def go(c):
        a = asyncio.create_task(_aput(c, pid, audio={"tracks": [{"id": "sfx", "src": src}]}))
        await slow.wait_started()
        rb = await asyncio.wait_for(
            _aput(c, pid, audio={"tracks": [{"id": "sfx", "src": src, "volume": 0.5}]}), 5)
        slow.release.set()
        return await a, rb

    ra, rb = _run(go)
    dest = str(folder / "assets" / "outro.wav")
    assert ra.status_code == 200 and rb.status_code == 200, (ra.text, rb.text)
    assert _assets(folder) == ["outro.wav"]
    assert _on_disk(folder)["audio"]["tracks"] == [{"id": "sfx", "src": dest, "volume": 0.5}]
    assert ra.json()["copied"] == [{"from": src, "to": dest}]
    assert "copied" not in rb.json() and "warnings" not in rb.json()
    assert slow.calls == 1


def test_an_editor_save_still_holding_the_path_after_the_patch_reuses_the_copy(this, other):
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    dest = str(folder / "assets" / "outro.wav")
    assert _put(pid, audio={"tracks": [{"id": "sfx", "src": src}]}).json()["copied"] == [{"from": src, "to": dest}]
    frames = _Frames()
    app.state.broadcaster = frames
    body = _whole_body(folder, audio={"tracks": [{"id": "sfx", "src": src, "volume": 0.5}]})

    resp = client.put(f"/api/projects/{pid}", json=body)

    assert resp.status_code == 200, resp.text
    assert _assets(folder) == ["outro.wav"], "a second copy was made"
    assert _on_disk(folder)["audio"]["tracks"] == [{"id": "sfx", "src": dest, "volume": 0.5}]
    assert resp.json()["copied"] == [{"from": src, "to": dest}]
    assert frames.frames[-1]["audio"]["tracks"][0]["src"] == dest


def test_a_save_with_nothing_to_copy_never_leaves_the_event_loop_and_writes_once(this, other, ws, monkeypatch):
    pid, folder = this
    own = _file(folder / "own.mp4")
    outside = _file(ws.parent / "my-footage" / "clip.mp4")
    kept = _file(other / "assets" / "outro.wav")     # borrowed, but already saved
    on_disk = _on_disk(folder)
    on_disk["audio"] = {"tracks": [{"id": "old", "src": kept}]}
    (folder / "project.json").write_text(json.dumps(on_disk))

    def no_thread(fn, *a, **k):
        raise AssertionError(f"a save with nothing to copy left the event loop: {fn}")

    writes = []
    real_write = projects_mod._write_project_json
    monkeypatch.setattr(asyncio, "to_thread", no_thread)
    monkeypatch.setattr(projects_mod, "_write_project_json", lambda p, proj: writes.append(p) or real_write(p, proj))

    resp = _put(pid, tracks=_tracks(_video("clip-0", own)),
                audio={"tracks": [{"id": "old", "src": kept}, {"id": "a", "src": outside}]})

    assert resp.status_code == 200, resp.text
    assert len(writes) == 1
    assert "copied" not in resp.json() and "warnings" not in resp.json()


def test_a_copy_past_the_wait_is_saved_when_it_finishes(this, other, fake_clone, followups, monkeypatch):
    """The save answers at the bound, saying the file is still copying; the
    copy goes on, and when it finishes the same patch swaps its path in: one
    more frame, one copy, and the save's follow-ups (previews, dims) are run
    again on the patched project. Later whole-body saves keep the copy."""
    monkeypatch.setattr(projects_mod, "_SAVE_COPY_WAIT_SECONDS", 0.2, raising=False)
    pid, folder = this
    src = _file(other / "assets" / "clip.mp4")
    dest = str(folder / "assets" / "clip.mp4")
    record = folder / "assets" / ".copied.json"
    slow = _SlowCopy(monkeypatch)
    frames = _Frames()
    app.state.broadcaster = frames

    async def go(c):
        loop = asyncio.get_running_loop()
        started = loop.time()
        resp = await asyncio.wait_for(_aput(c, pid, tracks=_tracks(_video("clip-0", src))), 5)
        took = loop.time() - started
        answered = _on_disk(folder)
        slow.release.set()
        await _until(lambda: _items(folder)[0]["src"] == dest)
        await _until(lambda: len(followups["dims"]) == 2)
        return resp, took, answered

    resp, took, answered = _run(go)
    assert resp.status_code == 200, resp.text
    assert took < 3, took
    body = resp.json()
    assert "copied" not in body
    assert len(body["warnings"]) == 1 and src in body["warnings"][0] and "Still copying" in body["warnings"][0]
    assert answered["tracks"][0]["items"][0]["src"] == src
    assert _items(folder)[0]["src"] == dest, "the late copy was never saved"
    assert [f["tracks"][0]["items"][0]["src"] for f in frames.frames] == [src, dest]
    assert slow.calls == 1 and _assets(folder) == ["clip.mp4"]
    assert json.loads(record.read_text())[os.path.realpath(src)]["name"] == "clip.mp4", "the late copy is recorded"
    assert [p["tracks"][0]["items"][0]["src"] for p in followups["previews"]] == [src, dest]
    assert [p["tracks"][0]["items"][0]["src"] for p in followups["dims"]] == [src, dest]

    for n in range(2):     # the editor's whole-body saves afterwards
        assert client.put(f"/api/projects/{pid}", json=_whole_body(folder, name=f"edit{n}")).status_code == 200
    assert _items(folder)[0]["src"] == dest
    assert _assets(folder) == ["clip.mp4"] and slow.calls == 1

    # Placing the old path again after it was removed is new, and gets the
    # late copy rather than a second one.
    assert _put(pid, tracks=_tracks()).status_code == 200
    again = _put(pid, tracks=_tracks(_video("clip-2", src)))
    assert again.json()["copied"] == [{"from": src, "to": dest}]
    assert _assets(folder) == ["clip.mp4"]


def test_a_dropped_request_still_gets_its_copy_saved(this, other, fake_clone, monkeypatch):
    """The client goes away (the request is cancelled) while the copy runs:
    the copy finishes and its path is still swapped in."""
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    dest = str(folder / "assets" / "outro.wav")
    slow = _SlowCopy(monkeypatch)
    frames = _Frames()
    app.state.broadcaster = frames

    async def go(c):
        a = asyncio.create_task(_aput(c, pid, audio={"tracks": [{"id": "sfx", "src": src}]}))
        await slow.wait_started()
        a.cancel()
        try:
            await a
        except BaseException:
            pass
        slow.release.set()
        await _until(lambda: _on_disk(folder)["audio"]["tracks"][0]["src"] == dest)

    _run(go)
    assert _on_disk(folder)["audio"]["tracks"] == [{"id": "sfx", "src": dest}]
    assert [f["audio"]["tracks"][0]["src"] for f in frames.frames] == [src, dest]
    assert slow.calls == 1 and _assets(folder) == ["outro.wav"]


def test_an_in_time_copy_gives_the_follow_ups_the_patched_project(this, other, followups):
    pid, folder = this
    src = _file(other / "clip.mp4")
    dest = str(folder / "assets" / "clip.mp4")

    resp = _put(pid, tracks=_tracks(_video("clip-0", src)))

    assert resp.json()["copied"] == [{"from": src, "to": dest}]
    assert [p["tracks"][0]["items"][0]["src"] for p in followups["previews"]] == [dest]
    assert [p["tracks"][0]["items"][0]["src"] for p in followups["dims"]] == [dest]


def test_an_overlay_400_copies_nothing_and_writes_nothing(this, other):
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    before = (folder / "project.json").read_text()
    bad = {"id": "ov-0", "type": "overlay", "src": "/abs/overlays/hook.jsx", "props": {"text": "Hook"},
           "start": 0.0, "end": 3.0, "googleFonts": [{"family": "Anton"}]}

    resp = _put(pid, tracks=_tracks(bad), audio={"tracks": [{"id": "a", "src": src}]})

    assert resp.status_code == 400, resp.text
    assert (folder / "project.json").read_text() == before
    assert not (folder / "assets").exists()


def test_project_json_temp_names_are_unique(tmp_path, monkeypatch):
    """Two writers at once (serve, or the CLI render's colour heal in another
    process) never share a temp file."""
    path = tmp_path / "project.json"
    path.write_text("{}")
    temps = []
    real_replace = os.replace

    def spy(src, dst, *a, **k):
        temps.append(os.fspath(src))
        return real_replace(src, dst, *a, **k)

    monkeypatch.setattr(os, "replace", spy)
    barrier = threading.Barrier(2)
    errors = []

    def write(n):
        try:
            barrier.wait(5)
            projects_mod._write_project_json(path, {"n": n})
        except Exception as e:  # pragma: no cover - reported below
            errors.append(e)

    threads = [threading.Thread(target=write, args=(n,)) for n in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)

    assert errors == []
    assert len(set(temps)) == 2, temps
    assert all(t.startswith(f"{path}.{os.getpid()}.") and t.endswith(".tmp") for t in temps), temps
    assert json.loads(path.read_text())["n"] in (0, 1)
    assert sorted(os.listdir(tmp_path)) == ["project.json"]


# ---------------------------------------------------------------------------
# MUST 2: a path the project already had is unchanged under a new id.
# ---------------------------------------------------------------------------

def test_id_less_audio_track_saved_with_an_id_is_not_copied(ws, other):
    """The editor gives id-less audio tracks an id on open
    (normalizeAudioTracks) and saves it with the next edit."""
    src = _file(other / "assets" / "outro.wav")
    folder = ws / "2026-10-07-backfill"
    pid = _project(folder, audio={"tracks": [{"src": src}]})

    resp = _put(pid, audio={"tracks": [{"id": "aud-0", "src": src}]})

    assert resp.status_code == 200, resp.text
    assert "copied" not in resp.json()
    assert _on_disk(folder)["audio"]["tracks"][0]["src"] == src
    assert not (folder / "assets").exists()


def test_split_clip_half_with_a_new_id_is_not_copied(ws, other):
    src = _file(other / "clip.mp4")
    folder = ws / "2026-10-07-split"
    item = _video("clip-0", src)
    pid = _project(folder, tracks=_tracks(item))

    resp = _put(pid, tracks=_tracks({**item, "end": 1.0}, {**item, "id": "clip-0-b", "start": 1.0}))

    assert resp.status_code == 200, resp.text
    assert "copied" not in resp.json()
    assert [i["src"] for i in _items(folder)] == [src, src]
    assert not (folder / "assets").exists()


def test_asset_placed_on_a_track_is_not_copied(ws, other):
    src = _file(other / "logo.png")
    folder = ws / "2026-10-07-placed"
    asset = {"id": "asset-0", "src": src, "type": "image", "name": "logo.png"}
    pid = _project(folder, assets=[asset])

    resp = _put(pid, assets=[asset], tracks=_tracks(_image("img-1", src)))

    assert resp.status_code == 200, resp.text
    assert "copied" not in resp.json()
    assert _items(folder)[0]["src"] == src
    assert not (folder / "assets").exists()


# ---------------------------------------------------------------------------
# SHOULD 3: clone at any size; plain copies have a cap, a budget and need disk.
# ---------------------------------------------------------------------------

def test_over_cap_file_is_cloned_where_it_can_be(this, other, fake_clone, monkeypatch):
    monkeypatch.setattr(save_media, "MAX_COPY_BYTES", 16)
    pid, folder = this
    big = _file(other / "big.mp4", b"x" * 17)

    resp = _put(pid, tracks=_tracks(_video("clip-0", big)))

    assert resp.status_code == 200, resp.text
    dest = folder / "assets" / "big.mp4"
    assert _items(folder)[0]["src"] == str(dest)
    assert dest.read_bytes() == b"x" * 17
    assert "warnings" not in resp.json()


def test_plain_copies_past_the_save_budget_are_left(this, other, no_clone, monkeypatch):
    monkeypatch.setattr(save_media, "COPY_BUDGET_BYTES", 20, raising=False)
    pid, folder = this
    first = _file(other / "first.wav", b"a" * 16)
    second = _file(other / "second.wav", b"b" * 16)

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": first}, {"id": "b", "src": second}]})

    assert resp.status_code == 200, resp.text
    tracks = _on_disk(folder)["audio"]["tracks"]
    assert tracks[0]["src"] == str(folder / "assets" / "first.wav")
    assert tracks[1]["src"] == second
    body = resp.json()
    assert body["copied"] == [{"from": first, "to": tracks[0]["src"]}]
    assert len(body["warnings"]) == 1 and second in body["warnings"][0]
    assert _assets(folder) == ["first.wav"]


def test_plain_copy_without_disk_headroom_is_left(this, other, no_clone, monkeypatch):
    monkeypatch.setattr(shutil, "disk_usage", lambda path: types.SimpleNamespace(total=10 ** 12, used=10 ** 12, free=0))
    pid, folder = this
    src = _file(other / "outro.wav")

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": src}]})

    assert resp.status_code == 200, resp.text
    assert _on_disk(folder)["audio"]["tracks"][0]["src"] == src
    body = resp.json()
    assert "copied" not in body
    assert len(body["warnings"]) == 1 and src in body["warnings"][0]
    assert not (folder / "assets" / "outro.wav").exists()


# ---------------------------------------------------------------------------
# SHOULD 4: project.json is replaced whole or not at all.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("copies", [False, True], ids=["no-copy", "copy"])
def test_a_failed_write_leaves_the_old_project_json(this, other, monkeypatch, copies):
    pid, folder = this
    before = (folder / "project.json").read_text()
    real = Path.write_text

    def half(self, data, *a, **k):
        real(self, data[: len(data) // 2], *a, **k)
        raise OSError(errno.ENOSPC, "No space left on device")

    body = {"name": "never written"}
    if copies:
        body["audio"] = {"tracks": [{"id": "a", "src": _file(other / "outro.wav")}]}
    monkeypatch.setattr(Path, "write_text", half)
    resp = _put(pid, **body)
    monkeypatch.undo()

    assert resp.status_code == 500
    assert (folder / "project.json").read_text() == before


# ---------------------------------------------------------------------------
# SHOULD 5: a dangling symlink in assets/ is a taken name, never written through.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("clone", [False, True], ids=["plain-copy", "clone"])
def test_dangling_symlink_in_assets_gets_a_numbered_copy(this, other, tmp_path, monkeypatch, clone):
    monkeypatch.setattr(init_mod, "_clonefile_fn", lambda: _fake_clonefile if clone else None)
    pid, folder = this
    (tmp_path / "elsewhere").mkdir()
    target = tmp_path / "elsewhere" / "target.wav"
    (folder / "assets").mkdir()
    os.symlink(target, folder / "assets" / "clip.wav")
    src = _file(other / "clip.wav")

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": src}]})

    assert resp.status_code == 200, resp.text
    dest = folder / "assets" / "clip_asset2.wav"
    assert _on_disk(folder)["audio"]["tracks"][0]["src"] == str(dest)
    assert dest.read_bytes() == Path(src).read_bytes()
    assert not target.exists(), "written through the link"
    assert os.path.islink(folder / "assets" / "clip.wav")


def test_copy_into_workspace_skips_a_dangling_symlink(tmp_path):
    (tmp_path / "dest").mkdir()
    target = tmp_path / "nowhere.mov"
    os.symlink(target, tmp_path / "dest" / "a.mov")
    src = _file(tmp_path / "src" / "a.mov")

    dest = init_mod._copy_into_workspace(src, str(tmp_path / "dest"), "clip")

    assert dest == str(tmp_path / "dest" / "a_clip2.mov")
    assert Path(dest).read_bytes() == Path(src).read_bytes()
    assert not target.exists(), "written through the link"


# ---------------------------------------------------------------------------
# NIT 6: "inside this project" is decided by the folder itself, however spelled.
# ---------------------------------------------------------------------------

def _fs_folds(tmp_path, a, b) -> bool:
    probe = tmp_path / a
    probe.mkdir()
    try:
        return (tmp_path / b).exists()
    finally:
        probe.rmdir()


def test_own_file_through_a_case_different_folder_is_not_borrowed(ws, tmp_path):
    if not _fs_folds(tmp_path, "CaseProbe", "caseprobe"):
        pytest.skip("case-sensitive file system")
    folder = ws / "My-Proj"
    pid = _project(folder)
    own = _file(folder / "assets" / "x.wav")
    alt = own.replace("My-Proj", "my-proj")

    assert not save_media.borrowed(alt, folder, ws)
    resp = _put(pid, audio={"tracks": [{"id": "a", "src": alt}]})
    assert resp.status_code == 200, resp.text
    assert "copied" not in resp.json()
    assert _on_disk(folder)["audio"]["tracks"][0]["src"] == alt


def test_own_file_through_a_decomposed_folder_name_is_not_borrowed(ws, tmp_path):
    nfc, nfd = unicodedata.normalize("NFC", "Canción"), unicodedata.normalize("NFD", "Canción")
    if not _fs_folds(tmp_path, nfc, nfd):
        pytest.skip("file system keeps NFC and NFD names apart")
    folder = ws / nfc
    _project(folder)
    own = _file(folder / "x.wav")

    assert not save_media.borrowed(unicodedata.normalize("NFD", own), folder, ws)


# ---------------------------------------------------------------------------
# NIT 7: an earlier copy is reused only from the record of what was copied.
# ---------------------------------------------------------------------------

def test_a_different_file_with_the_same_name_size_and_time_is_copied(ws, this):
    pid, folder = this
    _project(ws / "one")
    _project(ws / "two")
    first = _file(ws / "one" / "take.wav", b"A" * 32)
    second = _file(ws / "two" / "take.wav", b"B" * 32)
    for f in (first, second):
        os.utime(f, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
    assert _put(pid, audio={"tracks": [{"id": "a", "src": first}]}).status_code == 200
    copy_one = str(folder / "assets" / "take.wav")

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": copy_one}, {"id": "b", "src": second}]})

    assert resp.status_code == 200, resp.text
    copy_two = folder / "assets" / "take_asset2.wav"
    assert _on_disk(folder)["audio"]["tracks"][1]["src"] == str(copy_two)
    assert copy_two.read_bytes() == b"B" * 32
    assert resp.json()["copied"] == [{"from": second, "to": str(copy_two)}]


def test_the_copy_record_names_each_copy_and_a_changed_source_is_copied_again(this, other):
    pid, folder = this
    src = _file(other / "clip.mp4", b"v1" * 8)
    assert _put(pid, tracks=_tracks(_video("clip-0", src))).status_code == 200
    record = json.loads((folder / "assets" / ".copied.json").read_text())
    assert record[os.path.realpath(src)]["name"] == "clip.mp4"

    Path(src).write_bytes(b"version two!" * 3)       # the source changed since
    resp = _put(pid, tracks=_tracks(_video("clip-0", str(folder / "assets" / "clip.mp4")), _video("clip-1", src)))

    assert resp.status_code == 200, resp.text
    fresh = folder / "assets" / "clip_asset2.mp4"
    assert _items(folder)[1]["src"] == str(fresh)
    assert fresh.read_bytes() == b"version two!" * 3
    assert (folder / "assets" / "clip.mp4").read_bytes() == b"v1" * 8


# ---------------------------------------------------------------------------
# NIT 8: a workspace set as ~/... is the same folder.
# ---------------------------------------------------------------------------

@pytest.mark.skipif(sys.platform == "win32", reason="expanduser reads USERPROFILE there")
def test_workspace_spelled_with_a_tilde(tmp_path, monkeypatch):
    home = (tmp_path / "home").resolve()
    monkeypatch.setenv("HOME", str(home))
    ws = home / "Montaj"
    folder = ws / "this"
    _project(folder)
    _project(ws / "other")
    src = _file(ws / "other" / "a.wav")

    assert save_media.borrowed(src, folder, "~/Montaj")


# ---------------------------------------------------------------------------
# The rule with Windows path logic (ntpath), on any OS.
# ---------------------------------------------------------------------------

def test_borrowed_with_windows_paths(monkeypatch):
    files = [r"C:\Users\x\Montaj\other\project.json", r"C:\Users\x\Montaj\other\a.wav",
             r"C:\Users\x\Montaj\this\project.json", r"C:\Users\x\Montaj\this\own.wav",
             r"C:\Users\x\Montaj\.imports\imp-1\c.mp4", r"C:\Users\x\Montaj\.sources\s\o.mov",
             r"D:\footage\project.json", r"D:\footage\d.wav"]
    files = {ntpath.normcase(f) for f in files}
    dirs = set()
    for f in files:
        d = ntpath.dirname(f)
        while d not in dirs and ntpath.dirname(d) != d:
            dirs.add(d)
            d = ntpath.dirname(d)
    inodes = {p: n for n, p in enumerate(sorted(files | dirs), start=1)}

    class WindowsPath:
        def __getattr__(self, name):
            return getattr(ntpath, name)

        @staticmethod
        def isfile(p):
            return ntpath.normcase(ntpath.normpath(p)) in files

        @staticmethod
        def islink(p):
            return False

        @staticmethod
        def realpath(p, **k):
            return ntpath.normpath(p)

        @staticmethod
        def expanduser(p):
            return p

    def stat(p, *a, **k):
        key = ntpath.normcase(ntpath.normpath(p))
        if key not in inodes:
            raise FileNotFoundError(p)
        return os.stat_result((0o40755 if key in dirs else 0o100644, inodes[key], 7, 1, 0, 0, 0, 0, 0, 0))

    monkeypatch.setattr(save_media, "_p", WindowsPath(), raising=False)
    monkeypatch.setattr(save_media, "_stat", stat, raising=False)
    ws, this = r"C:\Users\x\Montaj", r"C:\Users\x\Montaj\this"

    assert save_media.borrowed(r"C:\Users\x\Montaj\other\a.wav", this, ws)
    assert save_media.borrowed(r"c:\users\x\montaj\.IMPORTS\imp-1\c.mp4", this, ws)
    assert save_media.borrowed("C:/Users/x/Montaj/other/a.wav", this, ws)
    assert not save_media.borrowed(r"C:\USERS\X\MONTAJ\THIS\own.wav", this, ws)
    assert not save_media.borrowed(r"C:\Users\x\Montaj\.sources\s\o.mov", this, ws)
    assert not save_media.borrowed(r"D:\footage\d.wav", this, ws)
    assert not save_media.borrowed(r"other\a.wav", this, ws)


# ===========================================================================
# §126 re-review: the rule's cost, leftovers, the budget, a known path.
# ===========================================================================

def test_an_outside_path_costs_no_stat_beyond_the_workspace_root(ws, this, monkeypatch):
    """The workspace is checked first, as a string (and, failing that, by its
    own realpath): a path outside it is answered with no stat of its own."""
    pid, folder = this
    outside = _file(ws.parent / "my-footage" / "clip.mp4")
    root_check = {str(ws)} | {str(p) for p in ws.parents}
    seen: list[str] = []

    def spy(real):
        def call(path, *a, **k):
            seen.append(os.fspath(path) if not isinstance(path, int) else str(path))
            return real(path, *a, **k)
        return call

    monkeypatch.setattr(save_media, "_stat", spy(os.stat))
    monkeypatch.setattr(os, "lstat", spy(os.lstat))
    monkeypatch.setattr(os, "stat", spy(os.stat))

    is_borrowed = save_media.borrowed(outside, folder, ws)
    planned = save_media.plan_borrowed_media({}, {"audio": {"tracks": [{"id": "a", "src": outside}]}}, folder, ws)
    calls = list(seen)

    assert is_borrowed is False and planned == {}
    assert [p for p in calls if p not in root_check] == []


def test_stale_copy_temps_are_swept_before_a_copy(this, other, monkeypatch):
    """What a copy or a record write left when serve died part way (a
    `.copying-*` file, a `.copied.json.*.tmp`) is removed once it is an hour
    old; nothing else in assets/ is touched."""
    pid, folder = this
    assets = folder / "assets"
    stale = [_file(assets / ".copying-0123abcd.wav"), _file(assets / ".copied.json.0123abcd.tmp")]
    kept = [_file(assets / "keep.wav"), _file(assets / "x.copying-1.wav"), _file(assets / ".copied.json.tmp.bak"),
            _file(assets / ".copied.json", b"{}")]
    (assets / ".copying-dir").mkdir()
    src = _file(other / "outro.wav")
    later = time.time() + 2 * 3600
    monkeypatch.setattr(save_media, "_now", lambda: later, raising=False)

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": src}]})

    assert resp.status_code == 200, resp.text
    assert [p for p in stale if os.path.lexists(p)] == []
    assert all(os.path.exists(p) for p in kept)
    assert (assets / ".copying-dir").is_dir()
    assert _on_disk(folder)["audio"]["tracks"][0]["src"] == str(assets / "outro.wav")


def test_fresh_copy_temps_are_left_alone(this, other):
    """A temp file younger than an hour may be another save's copy in flight."""
    pid, folder = this
    fresh = [_file(folder / "assets" / ".copying-0123abcd.wav"),
             _file(folder / "assets" / ".copied.json.0123abcd.tmp")]
    old = 1_600_000_000
    for f in fresh:
        os.utime(f, (old, old))   # a clone or copy2 keeps the source's old mtime
    src = _file(other / "outro.wav")

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": src}]})

    assert resp.status_code == 200, resp.text
    assert all(os.path.exists(p) for p in fresh)


def test_the_first_plain_copy_may_pass_the_save_budget_and_later_ones_must_fit(this, other, no_clone, monkeypatch):
    """The budget counts what one save has already copied: a first file up to
    the cap is copied whatever its size, a later one only within what is left."""
    monkeypatch.setattr(save_media, "COPY_BUDGET_BYTES", 20)
    monkeypatch.setattr(save_media, "MAX_COPY_BYTES", 64)
    pid, folder = this
    big = _file(other / "big.wav", b"a" * 30)
    small = _file(other / "small.wav", b"b" * 4)

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": big}, {"id": "b", "src": small}]})

    assert resp.status_code == 200, resp.text
    tracks = _on_disk(folder)["audio"]["tracks"]
    assert tracks[0]["src"] == str(folder / "assets" / "big.wav")
    assert tracks[1]["src"] == small
    warnings = resp.json()["warnings"]
    assert len(warnings) == 1 and small in warnings[0]
    assert "already copied 30 B" in warnings[0] and "20 B" in warnings[0], warnings[0]


def test_a_known_entry_repointed_at_a_path_another_entry_has_is_not_copied(ws, other):
    """A value the saved project has anywhere is unchanged, whatever entry
    holds it now: a known audio track repointed at the borrowed path another
    one already uses is not copied."""
    src = _file(other / "assets" / "outro.wav")
    folder = ws / "2026-10-07-repoint"
    own = _file(folder / "voice.wav")
    pid = _project(folder, audio={"tracks": [{"id": "a", "src": src}, {"id": "b", "src": own}]})

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": src}, {"id": "b", "src": src}]})

    assert resp.status_code == 200, resp.text
    assert "copied" not in resp.json()
    assert [t["src"] for t in _on_disk(folder)["audio"]["tracks"]] == [src, src]
    assert not (folder / "assets").exists()


# ===========================================================================
# §126 final review: the answer's own fields, a held temp file, retries, path
# matching, legacy tracks, the workspace, the record, project.json's writes.
# ===========================================================================

def test_an_answer_saved_back_never_stores_its_own_fields(this, other):
    """An editor or agent that saves the answer back sends `copied` and
    `warnings` too: they are the answer's, never the project's."""
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    first = _put(pid, audio={"tracks": [{"id": "s", "src": src}]}).json()
    assert first["copied"]

    again = client.put(f"/api/projects/{pid}", json={**first, "name": "x", "warnings": ["stale"]})

    assert again.status_code == 200, again.text
    assert "copied" not in again.json() and "warnings" not in again.json()
    disk = _on_disk(folder)
    assert disk["name"] == "x" and "copied" not in disk and "warnings" not in disk


def test_a_copy_whose_temp_cannot_be_removed_is_still_used(this, other, no_clone, monkeypatch):
    """Windows: an antivirus or indexer holds the fresh temp file, so removing
    it after the hard link fails. The copy stands; the sweep takes the leftover."""
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    real_unlink = os.unlink

    def held(path, *a, **k):
        if os.path.basename(os.fspath(path)).startswith(".copying-"):
            raise PermissionError(errno.EACCES, "in use", os.fspath(path))
        return real_unlink(path, *a, **k)

    monkeypatch.setattr(os, "unlink", held)
    made, warnings = save_media.copy_borrowed_media({save_media._key(src): src}, folder)

    dest = str(folder / "assets" / "outro.wav")
    assert warnings == [] and made == {save_media._key(src): dest}
    assert Path(dest).read_bytes() == Path(src).read_bytes()


@pytest.mark.parametrize("next_save", ["whole-body", "rename"])
def test_a_failed_copy_is_tried_again_on_the_next_save(this, other, monkeypatch, next_save):
    """The path is on disk after a failed copy, so it is no longer new; the
    next save (whatever it carries) still tries it again, and swaps it in."""
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    dest = str(folder / "assets" / "outro.wav")
    real = save_media._copy_one
    calls = []

    def flaky(*a, **k):
        calls.append(a[0])
        if len(calls) == 1:
            raise OSError(errno.EIO, "Input/output error")
        return real(*a, **k)

    monkeypatch.setattr(save_media, "_copy_one", flaky)
    first = _put(pid, audio={"tracks": [{"id": "s", "src": src}]})
    assert "Input/output error" in first.json()["warnings"][0]
    assert _on_disk(folder)["audio"]["tracks"][0]["src"] == src

    if next_save == "whole-body":
        resp = client.put(f"/api/projects/{pid}", json=_whole_body(folder, name="next"))
    else:
        resp = _put(pid, name="next")

    assert resp.status_code == 200, resp.text
    assert resp.json()["copied"] == [{"from": src, "to": dest}]
    disk = _on_disk(folder)
    assert disk["audio"]["tracks"] == [{"id": "s", "src": dest}] and disk["name"] == "next"
    assert len(calls) == 2
    assert "copied" not in _put(pid, name="later").json()
    assert len(calls) == 2, "a copy that landed is not tried again"


def test_a_file_left_on_purpose_is_not_tried_again(this, other, no_clone, monkeypatch):
    monkeypatch.setattr(save_media, "MAX_COPY_BYTES", 16)
    pid, folder = this
    big = _file(other / "big.mp4", b"x" * 17)
    assert _put(pid, audio={"tracks": [{"id": "a", "src": big}]}).json()["warnings"]

    resp = client.put(f"/api/projects/{pid}", json=_whole_body(folder, name="next"))

    assert resp.status_code == 200, resp.text
    assert "warnings" not in resp.json() and "copied" not in resp.json()


def test_the_retry_list_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(save_media, "_pending", collections.OrderedDict())
    per = save_media._PENDING_PER_PROJECT
    for n in range(save_media._PENDING_PROJECTS + 3):
        save_media.retry_later(tmp_path / f"p{n}", {f"k{i}": f"/x/{i}" for i in range(per + 3)})

    assert len(save_media._pending) == save_media._PENDING_PROJECTS
    assert all(len(keys) == per for keys in save_media._pending.values())
    assert save_media.pending_media(tmp_path / "p0") == {}, "the oldest project goes first"
    assert "k0" not in save_media.pending_media(tmp_path / f"p{save_media._PENDING_PROJECTS}")


def test_the_workspace_and_project_folder_are_looked_up_once_per_save(ws, this, monkeypatch):
    """Twenty borrowed paths: the workspace and project folder are spelled,
    and each folder stat'ed, once for the whole save, not once per path."""
    pid, folder = this
    _project(ws / "donor")
    srcs = [_file(ws / "donor" / "assets" / f"c{i}.wav") for i in range(20)]
    calls = []

    class Spy:
        def __getattr__(self, name):
            return getattr(os.path, name)

        @staticmethod
        def realpath(path, *a, **k):
            calls.append(("realpath", os.fspath(path)))
            return os.path.realpath(path, *a, **k)

    def stat(path, *a, **k):
        calls.append(("stat", os.fspath(path)))
        return os.stat(path, *a, **k)

    monkeypatch.setattr(save_media, "_p", Spy())
    monkeypatch.setattr(save_media, "_stat", stat)
    project = {"audio": {"tracks": [{"id": f"a{i}", "src": s} for i, s in enumerate(srcs)]}}

    wanted = save_media.plan_borrowed_media({}, project, folder, ws)

    assert len(wanted) == 20
    repeated = [c for c in set(calls) if calls.count(c) > 1]
    assert repeated == [], repeated


def test_a_known_path_spelled_another_way_is_unchanged(ws, other):
    src = _file(other / "assets" / "outro.wav")
    folder = ws / "2026-10-07-respelled"
    pid = _project(folder, audio={"tracks": [{"id": "old", "src": src}]})
    respelled = src.replace(f"{os.sep}assets{os.sep}", f"{os.sep}.{os.sep}assets{os.sep}")

    resp = _put(pid, audio={"tracks": [{"id": "old", "src": src}, {"id": "new", "src": respelled}]})

    assert resp.status_code == 200, resp.text
    assert "copied" not in resp.json()
    assert [t["src"] for t in _on_disk(folder)["audio"]["tracks"]] == [src, respelled]
    assert not (folder / "assets").exists()


def test_a_known_windows_path_spelled_another_way_is_unchanged(monkeypatch):
    class WindowsPath:
        def __getattr__(self, name):
            return getattr(ntpath, name)

    monkeypatch.setattr(save_media, "_p", WindowsPath(), raising=False)
    known = r"C:\Users\x\Montaj\other\a.wav"
    previous = {"audio": {"tracks": [{"id": "a", "src": known}]}}
    project = {"audio": {"tracks": [{"id": "a", "src": known},
                                    {"id": "b", "src": "C:/Users/x/Montaj/other/a.wav"},
                                    {"id": "c", "src": r"c:\users\x\montaj\OTHER\.\a.wav"}]}}

    assert save_media._changed_entries(previous, project) == []


def test_the_patch_swaps_into_legacy_tracks_written_during_the_copy(this, other, monkeypatch):
    """Another writer (an older CLI, an agent's own file write) leaves the
    list-of-lists tracks shape while the copy runs: the patch reads it in
    the current shape, so the swap still lands."""
    pid, folder = this
    src = _file(other / "clip.mp4")
    dest = str(folder / "assets" / "clip.mp4")
    real = projects_mod.copy_borrowed_media

    def during(*a, **k):
        proj = _on_disk(folder)
        proj["tracks"] = [[_video("c0", src)]]
        (folder / "project.json").write_text(json.dumps(proj))
        return real(*a, **k)

    monkeypatch.setattr(projects_mod, "copy_borrowed_media", during)

    resp = _put(pid, tracks=_tracks(_video("c0", src)))

    assert resp.status_code == 200, resp.text
    assert resp.json()["copied"] == [{"from": src, "to": dest}]
    tracks = _on_disk(folder)["tracks"]
    assert isinstance(tracks[0], dict) and tracks[0]["items"][0]["src"] == dest


def test_a_workspace_that_cannot_be_resolved_never_fails_the_save(this, other, monkeypatch):
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")

    def broken():
        raise RuntimeError("workspace unavailable")

    monkeypatch.setattr(projects_mod, "resolve_workspace", broken)

    resp = _put(pid, name="saved", audio={"tracks": [{"id": "a", "src": src}]})

    assert resp.status_code == 200, resp.text
    assert _on_disk(folder)["name"] == "saved"
    assert _on_disk(folder)["audio"]["tracks"][0]["src"] == src
    assert "copied" not in resp.json()


def test_a_source_spelled_with_another_case_reuses_its_copy(this, other, tmp_path):
    """The record knows a source by its file (device and inode) as well as
    its path, so a case-different spelling of it gets the same copy."""
    if not _fs_folds(tmp_path, "CaseProbe", "caseprobe"):
        pytest.skip("case-sensitive file system")
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    dest = str(folder / "assets" / "outro.wav")
    assert _put(pid, audio={"tracks": [{"id": "a", "src": src}]}).json()["copied"] == [{"from": src, "to": dest}]
    upper = src.replace(other.name, other.name.upper())

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": dest}, {"id": "b", "src": upper}]})

    assert resp.status_code == 200, resp.text
    assert resp.json()["copied"] == [{"from": upper, "to": dest}]
    assert _assets(folder) == ["outro.wav"]


def test_a_copy_changed_since_it_was_made_is_not_reused(this, other):
    """Edited in place to the same size: its modification time no longer
    matches the record, so the source is copied afresh."""
    pid, folder = this
    src = _file(other / "assets" / "outro.wav", b"o" * 32)
    copy = folder / "assets" / "outro.wav"
    assert _put(pid, audio={"tracks": [{"id": "a", "src": src}]}).status_code == 200
    copy.write_bytes(b"e" * 32)
    st = copy.stat()
    os.utime(copy, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": str(copy)}, {"id": "b", "src": src}]})

    fresh = folder / "assets" / "outro_asset2.wav"
    assert resp.json()["copied"] == [{"from": src, "to": str(fresh)}]
    assert fresh.read_bytes() == b"o" * 32


def test_a_copy_is_reused_when_its_record_could_not_be_written(this, other, monkeypatch):
    pid, folder = this
    src = _file(other / "assets" / "outro.wav")
    dest = str(folder / "assets" / "outro.wav")

    def unwritable(*a, **k):
        raise OSError(errno.EACCES, "Permission denied")

    monkeypatch.setattr(save_media, "_write_record", unwritable)
    assert _put(pid, audio={"tracks": [{"id": "a", "src": src}]}).json()["copied"] == [{"from": src, "to": dest}]

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": dest}, {"id": "b", "src": src}]})

    assert resp.json()["copied"] == [{"from": src, "to": dest}]
    assert _assets(folder) == ["outro.wav"]


def test_project_json_replace_is_retried_while_another_program_holds_it(this, monkeypatch):
    """Windows: an antivirus or indexer briefly holding project.json makes
    the replace fail with a PermissionError; the write tries again."""
    pid, folder = this
    real = os.replace
    held = {"n": 2}

    def replace(src, dst, *a, **k):
        if os.path.basename(os.fspath(dst)) == "project.json" and held["n"]:
            held["n"] -= 1
            raise PermissionError(errno.EACCES, "Access is denied", os.fspath(dst))
        return real(src, dst, *a, **k)

    monkeypatch.setattr(os, "replace", replace)

    resp = _put(pid, name="saved")

    assert resp.status_code == 200, resp.text
    assert _on_disk(folder)["name"] == "saved" and held["n"] == 0
    assert sorted(p.name for p in folder.iterdir()) == ["project.json"]


def test_project_json_replace_gives_up_and_leaves_no_temp(this, monkeypatch):
    pid, folder = this
    before = (folder / "project.json").read_text()

    def replace(src, dst, *a, **k):
        raise PermissionError(errno.EACCES, "Access is denied", os.fspath(dst))

    monkeypatch.setattr(os, "replace", replace)
    resp = _put(pid, name="never")
    monkeypatch.undo()

    assert resp.status_code == 500
    assert (folder / "project.json").read_text() == before
    assert sorted(p.name for p in folder.iterdir()) == ["project.json"]


def test_stale_project_json_temps_are_swept_by_a_copying_save(this, other, monkeypatch):
    """What a write of project.json left when serve (or the CLI) died part
    way is removed once it is an hour old, by a save that copies; a save that
    copies nothing does no file work beyond its own write."""
    pid, folder = this
    stale = [_file(folder / "project.json.4242.0123abcd.tmp", b"{}"), _file(folder / "project.json.tmp", b"{}")]
    kept = [_file(folder / "project.json.bak", b"{}"), _file(folder / "notes.json.1.tmp", b"{}")]
    later = time.time() + 2 * 3600
    monkeypatch.setattr(save_media, "_now", lambda: later, raising=False)

    assert _put(pid, name="no copy").status_code == 200
    assert all(os.path.exists(p) for p in stale)

    resp = _put(pid, audio={"tracks": [{"id": "a", "src": _file(other / "outro.wav")}]})

    assert resp.status_code == 200, resp.text
    assert [p for p in stale if os.path.lexists(p)] == []
    assert all(os.path.exists(p) for p in kept)
