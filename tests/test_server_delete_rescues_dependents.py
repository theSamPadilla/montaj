"""Deleting a project first gives every other project that uses its files a
copy of them (§126 b, `_rescue_dependents` in serve/routes/projects.py).

Measured 2026-10-07: a project's outro sound pointed at another project's
`assets/outro.wav`; that project was deleted while the first one rendered, and
the render failed. A save copies new borrowed paths into the project since
5.24.15 (tests/test_server_save_copies_media.py); the delete covers paths saved
before that, and anything written past a save. A dependent that is rendering,
or whose files could not be copied, stops the delete (409) with nothing
deleted.

Every file lives under tmp_path; the workspace is pointed there with
MONTAJ_WORKSPACE_DIR (tests/test_server_delete_preserve.py's convention).
"""
import json
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import serve.routes.projects as projects_mod
import serve.save_media as save_media
from serve.server import app

client = TestClient(app, raise_server_exceptions=False)


class _RecordingBroadcaster:
    def __init__(self):
        self.published = []

    def publish(self, project_id, frame):
        self.published.append(project_id)


@pytest.fixture
def ws(tmp_path, monkeypatch):
    ws = (tmp_path / "ws").resolve()
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))

    # The follow-ups (proxy queueing, dims probing) would ffprobe these fake files.
    async def _no_previews(*a, **k):
        return None

    async def _no_dims(project_id, project_dir, project, broadcaster=None):
        return project

    monkeypatch.setattr(projects_mod, "_queue_previews_for_changed_items", _no_previews)
    monkeypatch.setattr(projects_mod, "ensure_source_dims", _no_dims)
    app.state.broadcaster = _RecordingBroadcaster()
    return ws


def _project(folder: Path, **fields) -> str:
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


def _on_disk(folder: Path) -> dict:
    return json.loads((folder / "project.json").read_text())


def _video(item_id, src):
    return {"id": item_id, "type": "video", "src": src, "start": 0.0, "end": 2.0}


def _delete(pid, **params):
    return client.delete(f"/api/projects/{pid}", params=params)


def test_a_dependent_gets_copies_of_the_files_it_uses_before_the_folder_goes(ws):
    doomed = ws / "2026-10-02-the-data-flywheel"
    outro = _file(doomed / "assets" / "outro.wav", b"outro-bytes" * 64)
    clip = _file(doomed / "assets" / "broll.mp4", b"broll-bytes" * 64)
    doomed_id = _project(doomed)
    user = ws / "3ed87f5b"
    user_id = _project(
        user,
        tracks=[{"id": "trk-0", "items": [_video("v1", clip)]}],
        audio={"tracks": [{"id": "a1", "src": outro, "start": 0.0}]},
    )
    bystander = ws / "unrelated"
    _project(bystander)
    bystander_before = (bystander / "project.json").read_text()

    r = _delete(doomed_id)

    assert r.status_code == 204, r.text
    assert not doomed.exists()
    saved = _on_disk(user)
    new_clip = saved["tracks"][0]["items"][0]["src"]
    new_outro = saved["audio"]["tracks"][0]["src"]
    for new, content in ((new_clip, b"broll-bytes" * 64), (new_outro, b"outro-bytes" * 64)):
        assert Path(new).parent == user / "assets"
        assert Path(new).read_bytes() == content
    assert (bystander / "project.json").read_text() == bystander_before
    # An open editor on the dependent hears about its new paths.
    assert user_id in app.state.broadcaster.published


def test_only_files_inside_the_deleted_folder_move(ws):
    doomed = ws / "doomed"
    inside = _file(doomed / "assets" / "a.mp4")
    doomed_id = _project(doomed)
    elsewhere = ws / "other-source"
    kept = _file(elsewhere / "assets" / "b.mp4")
    _project(elsewhere)
    outside = _file(ws.parent / "my-footage" / "c.mp4")   # the user's own file, outside the workspace
    user = ws / "user"
    _project(user, tracks=[{"id": "trk-0", "items": [_video("v1", inside), _video("v2", kept), _video("v3", outside)]}])

    assert _delete(doomed_id).status_code == 204

    items = _on_disk(user)["tracks"][0]["items"]
    assert Path(items[0]["src"]).parent == user / "assets"
    assert items[1]["src"] == kept
    assert items[2]["src"] == outside


def test_a_dependent_that_is_rendering_stops_the_delete(ws, monkeypatch):
    doomed = ws / "doomed"
    used = _file(doomed / "assets" / "outro.wav")
    doomed_id = _project(doomed)
    user = ws / "user"
    user_id = _project(user, name="Spring teaser", audio={"tracks": [{"id": "a1", "src": used}]})
    monkeypatch.setattr(projects_mod, "_active_renders", {user_id})
    before = (user / "project.json").read_text()

    r = _delete(doomed_id)

    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "in_use_by_render"
    assert "Spring teaser" in r.json()["detail"]["message"]
    assert doomed.exists() and Path(used).exists()
    assert (user / "project.json").read_text() == before


def test_a_file_that_cannot_be_copied_stops_the_delete(ws, monkeypatch):
    doomed = ws / "doomed"
    used = _file(doomed / "assets" / "big.mp4")
    doomed_id = _project(doomed)
    user = ws / "user"
    _project(user, name="Uses it", tracks=[{"id": "trk-0", "items": [_video("v1", used)]}])

    def fail(*a, **k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(save_media, "_copy_one", fail)

    r = _delete(doomed_id)

    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "in_use_not_copied"
    assert "Uses it" in r.json()["detail"]["message"]
    assert doomed.exists() and Path(used).exists()
    assert _on_disk(user)["tracks"][0]["items"][0]["src"] == used


def test_back_to_setup_rescues_dependents_before_moving_its_own_refs(ws):
    # preserve_assets moves the project's own image refs into _uploads/; a
    # dependent pointing at one must get its copy first, not a broken path.
    doomed = ws / "doomed"
    ref = _file(doomed / "refs" / "hero.png")
    doomed_id = _project(doomed, storyboard={"imageRefs": [{"id": "r1", "refImages": [ref]}], "styleRefs": [], "scenes": []})
    user = ws / "user"
    _project(user, assets=[{"id": "as1", "type": "image", "src": ref}])

    r = _delete(doomed_id, preserve_assets="true")

    assert r.status_code == 200, r.text
    copy = _on_disk(user)["assets"][0]["src"]
    assert Path(copy).parent == user / "assets" and Path(copy).is_file()


def test_borrowed_from_counts_unchanged_paths_and_skips_links_and_missing_files(ws):
    doomed = ws / "doomed"
    real = _file(doomed / "assets" / "a.mp4")
    link = doomed / "assets" / "link.mp4"
    link.symlink_to(real)
    missing = str(doomed / "assets" / "gone.mp4")
    _project(doomed)
    user = ws / "user"
    project = {"tracks": [{"id": "t", "items": [_video("v1", real), _video("v2", str(link)), _video("v3", missing)]}]}
    wanted = save_media.borrowed_from(project, user, doomed, ws)
    assert list(wanted.values()) == [real]
