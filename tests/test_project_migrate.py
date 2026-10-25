"""Retired project shapes read as their current form (lib/project_migrate.py): the Lyric video's music_video
type and its ffmpeg-drawtext render mode. Pure rules first, then serve's open, revisions route and PUT on a
project shaped like the ones the retired lyrics-video skill wrote."""
import copy
import json

import pytest
from starlette.testclient import TestClient

import serve.common as common_mod
from lib.project_migrate import converge, migrate_project
from lib.project_revisions import revisions_of
from serve.server import app

PID = "6f1c2a9e-4b7d-4c3a-9e2f-1a2b3c4d5e6f"
LYRIC_JSX = "/Users/someone/Library/Application Support/Montaj/montaj/montaj_assets/render/templates/overlays/lyric-phrase.jsx"


def _phrase(i, start, end, words):
    step = (end - start) / len(words)
    return {
        "id": f"phrase-{i}", "type": "overlay", "src": LYRIC_JSX, "start": start, "end": end,
        "props": {"words": [{"word": w, "start": start + k * step, "end": start + (k + 1) * step} for k, w in enumerate(words)],
                  "variant": "pop", "transparent": False, "fontSize": 72, "textColor": "white", "position": "center",
                  "wordsPerLine": 3},
    }


def old_lyric_project():
    """A Lyric video project as the retired lyrics-video skill told agents to write it (its "project.json setup"):
    the background loop on trk-0, one lyric-phrase overlay per lyrics_sync segment on trk-1 as the editor preview,
    the same lyrics as word-by-word captions for the burned-in ffmpeg render, and the song with lyrics_sync's
    audioInPoint."""
    segments = [
        {"text": "drink le croix", "start": 0.5, "end": 1.8,
         "words": [{"word": "drink", "start": 0.5, "end": 0.9}, {"word": "le", "start": 0.9, "end": 1.2},
                   {"word": "croix", "start": 1.2, "end": 1.8}]},
        {"text": "every single day", "start": 2.0, "end": 3.4,
         "words": [{"word": "every", "start": 2.0, "end": 2.4}, {"word": "single", "start": 2.4, "end": 2.9},
                   {"word": "day", "start": 2.9, "end": 3.4}]},
    ]
    return {
        "version": "0.2", "id": PID, "name": "Le Croix", "status": "draft", "workflow": "lyrics_video",
        "projectType": "music_video", "editingPrompt": "dark moody vibe, white text, center position",
        "settings": {"resolution": [1080, 1920], "fps": 30},
        "renderMode": "ffmpeg-drawtext",
        "tracks": [
            {"id": "trk-0", "items": [{"id": "bg", "type": "video", "src": "/Users/someone/Montaj/le-croix/bg.mov",
                                       "start": 0, "end": 3.6, "inPoint": 0, "outPoint": 3.6}]},
            {"id": "trk-1", "items": [_phrase(0, 0.5, 1.8, ["drink", "le", "croix"]),
                                      _phrase(1, 2.0, 3.4, ["every", "single", "day"])]},
        ],
        "captions": {"style": "word-by-word", "segments": segments, "position": "center", "color": "white", "fontsize": 72},
        "audio": {"tracks": [{"id": "music", "src": "/Users/someone/Montaj/le-croix/song.mp3", "start": 0, "end": 3.6,
                              "inPoint": 12.25, "volume": 1.0, "label": "song"}]},
        "assets": [],
    }


# ── the rules ──────────────────────────────────────────────────────────────────

def test_an_old_lyric_project_reads_as_an_editing_project_whose_captions_draw_once():
    old = old_lyric_project()
    kept = copy.deepcopy(old)
    new = migrate_project(old)
    assert old == kept, "never mutates its input"
    assert new["projectType"] == "editing"
    assert "renderMode" not in new
    assert new["tracks"][0] is old["tracks"][0], "the background track is untouched"
    assert new["tracks"][1]["enabled"] is False, "the lyric preview track is off"
    assert new["tracks"][1]["items"] == old["tracks"][1]["items"], "nothing is deleted"
    rest = {k: v for k, v in new.items() if k not in ("projectType", "tracks")}
    assert rest == {k: v for k, v in old.items() if k not in ("projectType", "tracks", "renderMode")}


def test_a_current_project_comes_back_as_the_same_object():
    current = {"id": PID, "projectType": "editing", "tracks": [{"id": "trk-0", "items": []}]}
    assert migrate_project(current) is current
    assert converge(current) is current


@pytest.mark.parametrize("ptype", ["editing", "ai_video", "carousel", "broll", None])
def test_other_types_are_left_alone(ptype):
    p = {"id": PID, "projectType": ptype}
    assert migrate_project(p) is p


def test_a_music_video_without_the_render_mode_only_changes_its_type():
    old = {**old_lyric_project(), "renderMode": None}
    del old["renderMode"]
    new = migrate_project(old)
    assert new["projectType"] == "editing"
    assert new["tracks"] is old["tracks"], "the JSX path's overlays were the render: they stay on"


def test_only_tracks_holding_nothing_but_lyric_phrase_overlays_are_turned_off():
    p = old_lyric_project()
    p["tracks"].append({"id": "trk-2", "items": [_phrase(2, 0, 1, ["x"]),
                                                 {"id": "logo", "type": "overlay", "src": "/a/logo.jsx", "start": 0, "end": 1}]})
    p["tracks"].append({"id": "trk-3", "items": []})
    p["tracks"].append({"id": "trk-4", "items": [{**_phrase(3, 0, 1, ["y"]),
                                                  "src": "C:\\Users\\x\\montaj_assets\\render\\templates\\overlays\\lyric-phrase\\lyric-phrase.jsx"}]})
    new = migrate_project(p)
    assert [t.get("enabled", True) for t in new["tracks"]] == [True, False, True, True, False]


def test_converge_takes_a_legacy_tracks_list_too():
    p = old_lyric_project()
    p["tracks"] = [t["items"] for t in p["tracks"]]
    new = converge(p)
    assert isinstance(new["tracks"][0], dict) and new["tracks"][1]["enabled"] is False
    assert new["projectType"] == "editing"


# ── serve ──────────────────────────────────────────────────────────────────────

class _StubBroadcaster:
    def publish(self, *a, **k):
        pass


@pytest.fixture
def ws(tmp_path, monkeypatch):
    workspace = tmp_path / "Montaj"
    workspace.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(workspace))
    monkeypatch.delenv("MONTAJ_SYNC_STATE_DIR", raising=False)
    common_mod._project_dir_cache.clear()
    had, previous = hasattr(app.state, "broadcaster"), getattr(app.state, "broadcaster", None)
    app.state.broadcaster = _StubBroadcaster()
    try:
        yield workspace
    finally:
        # Restored as found: a later module sets its own broadcaster only when app.state has none at all.
        if had:
            app.state.broadcaster = previous
        else:
            del app.state.broadcaster
        common_mod._project_dir_cache.clear()


def _write(ws, doc):
    d = ws / "le-croix"
    d.mkdir()
    (d / "project.json").write_text(json.dumps(doc, indent=2))
    return d / "project.json"


def test_opening_an_old_lyric_project_serves_and_writes_it_converged_once(ws, monkeypatch):
    path = _write(ws, old_lyric_project())
    client = TestClient(app, raise_server_exceptions=False)
    body = client.get(f"/api/projects/{PID}").json()
    assert body["projectType"] == "editing" and "renderMode" not in body and body["tracks"][1]["enabled"] is False
    on_disk = json.loads(path.read_text())
    assert on_disk["projectType"] == "editing" and "renderMode" not in on_disk and on_disk["tracks"][1]["enabled"] is False
    text = path.read_text()
    mtime = path.stat().st_mtime_ns
    assert client.get(f"/api/projects/{PID}").json()["projectType"] == "editing"
    assert path.read_text() == text and path.stat().st_mtime_ns == mtime, "a second open writes nothing"


def test_the_revisions_route_answers_the_converged_fields_without_writing(ws, monkeypatch):
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    old = old_lyric_project()
    path = _write(ws, old)
    before = path.read_text()
    resp = TestClient(app, raise_server_exceptions=False).get(f"/api/projects/{PID}/revisions?fields=projectType,tracks")
    assert resp.status_code == 200, resp.text
    assert resp.json()["revisions"] == revisions_of(converge(old), ["projectType", "tracks"])
    assert path.read_text() == before


def test_a_put_carrying_the_retired_type_stores_the_current_one(ws):
    current = converge(old_lyric_project())
    path = _write(ws, current)
    resp = TestClient(app, raise_server_exceptions=False).put(
        f"/api/projects/{PID}", json={"id": PID, "projectType": "music_video", "renderMode": "ffmpeg-drawtext"})
    assert resp.status_code == 200, resp.text
    on_disk = json.loads(path.read_text())
    assert on_disk["projectType"] == "editing" and "renderMode" not in on_disk


# ── render reads the converged view ────────────────────────────────────────────

class _RenderRequest:
    def __init__(self, body=None):
        self.query_params = {"async": "1"}
        self._body = body or {}

    async def is_disconnected(self):
        return False

    async def json(self):
        return self._body


def _render(project_dir, monkeypatch):
    """POST /render with render.js stubbed: what the detached run would have been given (cmd and its input file)."""
    import asyncio
    import serve.routes.projects as projects_mod

    runtime = project_dir.parent / "runtime"
    runtime.mkdir(exist_ok=True)
    (runtime / "render.js").write_text("// stub")
    monkeypatch.setattr(projects_mod, "render_runtime_dir", lambda: str(runtime))
    monkeypatch.setattr(projects_mod.shutil, "which", lambda b: "/usr/bin/node")
    monkeypatch.setattr(projects_mod, "_git_commit_sync", lambda *a, **k: None)
    seen = {}

    async def _fake_detached(project_id, cmd, env, render_input, project_path, job, **kwargs):
        seen.update(cmd=cmd, render_input=render_input, project_path=project_path,
                    body=json.loads(open(render_input).read()))

    monkeypatch.setattr(projects_mod, "_run_render_detached", _fake_detached)
    try:
        asyncio.run(projects_mod.render_project(PID, _RenderRequest(), project_dir=project_dir))
    finally:
        projects_mod._active_renders.clear()
        projects_mod._render_jobs.clear()
        projects_mod._render_task_refs.clear()
    return seen


def test_an_old_lyric_project_never_opened_renders_converged_from_a_copy_beside_it(tmp_path, monkeypatch):
    """A project still in the retired shape on disk (never opened since the upgrade, or its open's write skipped
    for a Studio sync clash) must not draw its captions twice: render.js reads a converged copy in the project
    folder (relative paths still resolve), the run removes it after, and project.json is left to the open."""
    project_dir = tmp_path / "le-croix"
    project_dir.mkdir()
    old = old_lyric_project()
    (project_dir / "project.json").write_text(json.dumps(old))
    before = (project_dir / "project.json").read_text()
    seen = _render(project_dir, monkeypatch)
    assert seen["render_input"] != seen["project_path"]
    assert seen["render_input"].parent == project_dir
    assert str(seen["render_input"]) in seen["cmd"] and str(project_dir / "project.json") not in seen["cmd"]
    assert seen["body"] == converge(old)
    assert (project_dir / "project.json").read_text() == before


def test_a_current_project_renders_its_own_file(tmp_path, monkeypatch):
    project_dir = tmp_path / "current"
    project_dir.mkdir()
    (project_dir / "project.json").write_text(json.dumps(converge(old_lyric_project())))
    seen = _render(project_dir, monkeypatch)
    assert seen["render_input"] == seen["project_path"] == project_dir / "project.json"


# ── a version restore writes the converged shape ───────────────────────────────

def test_restoring_a_version_from_before_the_retirement_writes_it_converged(tmp_path):
    import subprocess
    from serve.common import get_project_dir
    env = {**__import__("os").environ, "GIT_AUTHOR_NAME": "montaj", "GIT_AUTHOR_EMAIL": "montaj@local",
           "GIT_COMMITTER_NAME": "montaj", "GIT_COMMITTER_EMAIL": "montaj@local"}
    project_dir = tmp_path / "le-croix"
    project_dir.mkdir()
    old = old_lyric_project()
    (project_dir / "project.json").write_text(json.dumps(old, indent=2))
    for cmd in (["git", "init", "-q"], ["git", "add", "project.json"], ["git", "commit", "-q", "-m", "version: run 1 — draft"]):
        subprocess.run(cmd, cwd=str(project_dir), env=env, check=True)
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(project_dir), env=env,
                            capture_output=True, text=True, check=True).stdout.strip()
    (project_dir / "project.json").write_text(json.dumps({**converge(old), "status": "final"}, indent=2))
    had, previous = hasattr(app.state, "broadcaster"), getattr(app.state, "broadcaster", None)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        resp = TestClient(app, raise_server_exceptions=False).post(f"/api/projects/{PID}/versions/{commit}/restore")
    finally:
        app.dependency_overrides.pop(get_project_dir, None)
        if had:
            app.state.broadcaster = previous
        else:
            del app.state.broadcaster
    assert resp.status_code == 200, resp.text
    on_disk = json.loads((project_dir / "project.json").read_text())
    assert on_disk == converge(old)
    assert resp.json()["projectType"] == "editing" and "renderMode" not in resp.json()


# ── §3d: the explicit '3d' type ────────────────────────────────────────────────

def old_3d_project(workflow="model-3d", project_type="editing"):
    """A model-3d project as the app made it before the '3d' type: an editing project from the model-3d template, its
    model3d pointer, the template's model3d_stage overlay over the whole duration."""
    doc = {
        "version": "0.2", "id": PID, "name": "Robot arm", "status": "draft", "workflow": workflow,
        "settings": {"resolution": [1080, 1920], "fps": 30},
        "model3d": {"slug": "robot-arm", "approved": True},
        "tracks": [
            {"id": "trk-0", "items": []},
            {"id": "trk-1", "items": [{"id": "stage", "type": "overlay", "src": "/Users/someone/Montaj/robot-arm/overlays/model3d_stage.jsx", "start": 0, "end": 6}]},
        ],
        "assets": [],
    }
    if project_type is not None:
        doc["projectType"] = project_type
    return doc


@pytest.mark.parametrize("workflow", ["model-3d", "toy-world-3d"])
@pytest.mark.parametrize("project_type", ["editing", None, "music_video"])
def test_an_old_3d_project_reads_as_the_3d_type(workflow, project_type):
    old = old_3d_project(workflow, project_type)
    kept = copy.deepcopy(old)
    new = migrate_project(old)
    assert old == kept
    assert new["projectType"] == "3d"
    assert {k: v for k, v in new.items() if k != "projectType"} == {k: v for k, v in old.items() if k != "projectType"}
    assert migrate_project(new) is new, "a '3d' project is current"


def test_a_3d_overlay_in_an_editing_project_keeps_it_editing():
    """save_model on any project sets model3d (a 3D overlay is allowed in every project): only the 3D templates make a
    project '3d', so an editing video with a 3D overlay stays an editing video."""
    p = {**old_3d_project(), "workflow": "overlays"}
    assert migrate_project(p) is p
    q = {**old_3d_project(), "workflow": "blank", "projectType": None}
    del q["projectType"]
    assert migrate_project(q) is q


@pytest.mark.parametrize("ptype", ["ai_video", "carousel", "broll"])
def test_another_type_from_a_3d_workflow_is_left_alone(ptype):
    p = old_3d_project(project_type=ptype)
    assert migrate_project(p) is p


@pytest.mark.parametrize("workflow", [[], {}, ["model-3d"], 3, None])
def test_a_workflow_that_is_not_a_string_is_left_alone(workflow):
    """A hand-edited file can hold anything in workflow: an unhashable one must not crash the open."""
    p = old_3d_project(workflow=workflow)
    assert migrate_project(p) is p

def test_opening_an_old_3d_project_serves_and_writes_3d(ws):
    path = _write(ws, old_3d_project())
    body = TestClient(app, raise_server_exceptions=False).get(f"/api/projects/{PID}").json()
    assert body["projectType"] == "3d"
    assert json.loads(path.read_text())["projectType"] == "3d"
