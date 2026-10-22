"""§482 M4, serve's backstop: with MONTAJ_SYNC_STATE_DIR set (the app passes it when Studio sync is on), serve
refuses every non-human write that touches a field or file in an open Studio sync clash, even when the app shell
is bypassed. The shell writes a names-only sidecar per project, `<dir>/<projectId>/clash-set.json`
(`{v:1, projectId, fields, files, clashes:[{id, fields, files}]}`), and serve reads it under the project lock.

Allowed through: the trusted window (`editor` with the launch secret and no write origin), the shell's Studio sync
pull (trusted `tool` + origin `sync`) and the shell's human resolve (trusted `tool` + origin `resolve` +
`x-montaj-sync-resolve: <an open clash id>`). Everything else (`ai`, a request without the secret, plain `tool`,
`tool` + `app`, `editor` + `drive`, a step run by any of them, serve's own maintenance heals) is refused with the
binding 409 `{"error": "sync_conflict", "fields": [...], "message": "..."}` when it touches a clashed name.

Unset: serve never reads a sidecar and behaves exactly as before. Set but unreadable (a corrupt or unknown
sidecar, a state folder that exists but cannot be read, an id that cannot name a folder): fail closed, every non-human
write is refused. A state folder that does not exist at all records no clash (review 40, 3a).

The design is montaj-app docs/plans/s482-m4-design.md §4 (its 15 pytest cases are marked `case N`). Real FastAPI
app, real lock; every path lives under tmp_path."""
import builtins
import json
import os
import subprocess
import sys
import threading
import unicodedata
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import serve.common as common_mod
import serve.routes.projects as projects_mod
import serve.routes.steps as steps_mod
from lib.project_lock import project_lock, write_json_atomic
from lib.project_revisions import revisions_of
from lib.project_tracks import normalize_tracks
from serve import save_guard
from serve.server import app

PID = "sync-proj"
SECRET = "7c" * 32
TOOL = {"x-montaj-shell": SECRET, "x-montaj-writer": "tool"}
EDITOR = {"x-montaj-shell": SECRET, "x-montaj-writer": "editor", "x-montaj-guard": "advisory"}
AI = {}
TRUSTED_AI = {"x-montaj-shell": SECRET, "x-montaj-writer": "ai"}
SYNC = {**TOOL, "x-montaj-write-origin": "sync"}
APP = {**TOOL, "x-montaj-write-origin": "app"}
DRIVE = {**EDITOR, "x-montaj-write-origin": "drive"}


def RESOLVE(clash_id="c1"):
    return {**TOOL, "x-montaj-write-origin": "resolve", "x-montaj-sync-resolve": clash_id}


def _message(names):
    """The app wrapper's syncConflictText (desktop/mcp/app-tools.mjs), word for word."""
    return (f"This project has an open Studio sync clash on {', '.join(names)}, so nothing was saved. A person must "
            f"resolve it in Montaj. Do not retry, and do not edit those fields.")


def _sc():
    import lib.sync_clash as sc
    return sc


# ── fixtures ──────────────────────────────────────────────────────────────────


class _Recorder:
    def __init__(self):
        self.published = []

    def publish(self, project_id, data):
        self.published.append((project_id, data))


def _start(monkeypatch, *, guard=True):
    """The guard as the app runs it: switched on, the launch secret received."""
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
    had = hasattr(app.state, "broadcaster")
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
        # Restored as found: a later module sets its own broadcaster only when app.state has none at all.
        if had:
            app.state.broadcaster = previous
        else:
            del app.state.broadcaster
        save_guard._state.clear()
        save_guard._state.update(saved)


@pytest.fixture
def ws(tmp_path, monkeypatch, recorder):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(workspace))
    monkeypatch.delenv("MONTAJ_SYNC_STATE_DIR", raising=False)
    monkeypatch.delenv("MONTAJ_WRITE_ORIGIN", raising=False)
    common_mod._project_dir_cache.clear()
    _start(monkeypatch)
    try:
        yield workspace
    finally:
        common_mod._project_dir_cache.clear()


@pytest.fixture
def state(tmp_path, monkeypatch, ws):
    """The app's studio-sync folder, named to serve by MONTAJ_SYNC_STATE_DIR."""
    d = tmp_path / "studio-sync"
    d.mkdir()
    monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", str(d))
    return d


def _sidecar(state, pid=PID, fields=(), files=(), clashes=None, **extra):
    folder = state / pid
    folder.mkdir(exist_ok=True)
    if clashes is None:
        clashes = [{"id": "c1", "fields": list(fields), "files": list(files)}] if (fields or files) else []
    doc = {"v": 1, "projectId": pid, "fields": list(fields), "files": list(files), "clashes": clashes, **extra}
    path = folder / "clash-set.json"
    path.write_text(json.dumps(doc))
    return path


def _project(ws, pid=PID, folder=None, **fields):
    d = ws / (folder or pid)
    d.mkdir(parents=True, exist_ok=True)
    doc = {"id": pid, "name": "first", "status": "draft", "tracks": [{"id": "trk-0", "items": []}],
           "sources": [], "notes": [{"id": "n1", "text": "a"}], **fields}
    write_json_atomic(d / "project.json", doc)
    return d


def _client():
    return TestClient(app, raise_server_exceptions=False)


def _put(ws, body, headers, pid=PID, *, read=True, folder=None):
    """A PUT; with `read`, it sends the revision of every field it changes, so it passes the §477 guard."""
    hdrs = dict(headers)
    if read:
        d = folder or common_mod.find_project_dir(ws, pid)
        disk = json.loads((d / "project.json").read_text())
        hdrs["x-montaj-read-revisions"] = json.dumps(revisions_of(normalize_tracks(disk), list(body)))
    return _client().put(f"/api/projects/{pid}", json={"id": pid, **body}, headers=hdrs)


def _refused(resp, names):
    assert resp.status_code == 409, resp.text
    body = resp.json()["detail"]
    assert body == {"error": "sync_conflict", "fields": list(names), "message": _message(names)}


def _disk(d):
    return (d / "project.json").read_bytes()


# ── case 1 and dark parity: no env var ────────────────────────────────────────


class _Spy:
    """Every path os.open, open, os.stat, os.lstat, os.listdir and os.scandir are given."""

    def __init__(self, monkeypatch):
        self.paths = []
        for mod, name in ((os, "open"), (os, "stat"), (os, "lstat"), (os, "listdir"), (os, "scandir"),
                          (builtins, "open")):
            real = getattr(mod, name)
            monkeypatch.setattr(mod, name, self._wrap(real))

    def _wrap(self, real):
        def spy(*args, **kwargs):
            if args:
                try:
                    self.paths.append(os.fspath(args[0]))
                except TypeError:
                    pass
            return real(*args, **kwargs)
        return spy

    def touched(self, needle):
        return [p for p in self.paths if needle in str(p)]


@pytest.mark.parametrize("headers", [TOOL, AI, EDITOR, TRUSTED_AI], ids=["tool", "ai", "editor", "trusted-ai"])
def test_case1_no_env_var_never_reads_a_sidecar_and_saves_as_before(ws, tmp_path, monkeypatch, recorder, headers):
    d = _project(ws)
    # A sidecar that would refuse, in a folder serve was never told about.
    unnamed = tmp_path / "studio-sync"
    unnamed.mkdir()
    _sidecar(unnamed, fields=["tracks", "notes"])
    spy = _Spy(monkeypatch)
    resp = _put(ws, {"tracks": [{"id": "trk-0", "items": []}], "notes": []}, headers)
    assert resp.status_code == 200, resp.text
    assert spy.touched("studio-sync") == [] and spy.touched("clash-set") == []
    assert json.loads(_disk(d))["notes"] == [] or "notes" not in json.loads(_disk(d))


def _answer(resp):
    headers = {k: v for k, v in resp.headers.items() if k.lower() not in ("server-timing", "date")}
    return resp.status_code, resp.content, headers


@pytest.mark.parametrize("headers", [TOOL, AI, EDITOR, SYNC], ids=["tool", "ai", "editor", "sync"])
def test_dark_parity_answers_and_frames_are_byte_identical_with_the_var_unset_and_with_no_sidecar(
        ws, tmp_path, monkeypatch, recorder, headers):
    """Case 1 and 2 against each other: the same save, var unset and var set with no sidecar for the project,
    answers the same bytes and publishes the same frames. And no new header is required: the bare AI save with no
    revisions and the guard off still lands."""
    body = {"name": "second", "tracks": [{"id": "trk-0", "items": []}]}
    runs = []
    for var in (None, str(tmp_path / "studio-sync")):
        if var is None:
            monkeypatch.delenv("MONTAJ_SYNC_STATE_DIR", raising=False)
        else:
            Path(var).mkdir(exist_ok=True)
            monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", var)
        d = _project(ws)
        recorder.published.clear()
        resp = _put(ws, body, headers)
        runs.append((_answer(resp), list(recorder.published), _disk(d)))
    assert runs[0] == runs[1]
    assert runs[0][0][0] == 200


def test_dark_parity_the_guard_off_bare_ai_save_needs_no_new_header(ws, monkeypatch, recorder):
    _start(monkeypatch, guard=False)
    d = _project(ws)
    resp = _client().put(f"/api/projects/{PID}", json={"id": PID, "notes": []})
    assert resp.status_code == 200, resp.text
    assert "x-montaj-sync-conflict" not in {k.lower() for k in resp.headers}
    assert json.loads(_disk(d))["notes"] == [] or "notes" not in json.loads(_disk(d))


# ── case 2: the var set, no sidecar for the project ──────────────────────────


@pytest.mark.parametrize("headers", [TOOL, AI, TRUSTED_AI], ids=["tool", "ai", "trusted-ai"])
def test_case2_no_sidecar_for_the_project_is_no_clash(ws, state, headers):
    _sidecar(state, pid="another-project", fields=["tracks"])
    d = _project(ws)
    resp = _put(ws, {"tracks": [{"id": "trk-0", "items": []}]}, headers)
    assert resp.status_code == 200, resp.text


def test_case2_an_empty_per_project_folder_is_no_clash(ws, state):
    (state / PID).mkdir()
    _project(ws)
    assert _put(ws, {"notes": []}, AI).status_code == 200


# ── case 3: a sidecar with tracks ─────────────────────────────────────────────


@pytest.mark.parametrize("headers", [AI, TRUSTED_AI, TOOL, APP], ids=["ai", "trusted-ai", "tool", "tool-app"])
def test_case3_a_write_of_a_clashed_field_is_409_nothing_written_no_frame(ws, state, recorder, headers):
    d = _project(ws)
    _sidecar(state, fields=["tracks"])
    before = _disk(d)
    resp = _put(ws, {"tracks": [{"id": "trk-1", "items": []}]}, headers)
    _refused(resp, ["tracks"])
    assert _disk(d) == before
    assert recorder.published == []


def test_case3_an_unclashed_field_saves(ws, state):
    d = _project(ws)
    _sidecar(state, fields=["tracks"])
    assert _put(ws, {"notes": []}, AI).status_code == 200


def test_case3_one_clashed_field_refuses_the_whole_body(ws, state):
    d = _project(ws)
    _sidecar(state, fields=["tracks"])
    before = _disk(d)
    _refused(_put(ws, {"notes": [], "tracks": [{"id": "trk-1", "items": []}], "name": "x"}, AI), ["tracks"])
    assert _disk(d) == before


def test_case3_fields_are_named_from_the_clash_list_not_the_top_level_list_only(ws, state):
    """A clash's own fields count too (the sidecar's top-level lists are their union, but serve takes both)."""
    _project(ws)
    _sidecar(state, fields=[], clashes=[{"id": "c9", "fields": ["captions"], "files": []}])
    _refused(_put(ws, {"captions": {"segments": []}}, AI), ["captions"])


# ── case 4: before the revisions ──────────────────────────────────────────────


def test_case4_sync_conflict_wins_over_read_required(ws, state):
    _project(ws)
    _sidecar(state, fields=["tracks"])
    _refused(_put(ws, {"tracks": []}, AI, read=False), ["tracks"])


def test_case4_sync_conflict_wins_over_project_changed(ws, state):
    _project(ws)
    _sidecar(state, fields=["tracks"])
    stale = {"x-montaj-read-revisions": json.dumps({"tracks": "0" * 16})}
    _refused(_put(ws, {"tracks": []}, {**TOOL, **stale}, read=False), ["tracks"])


# ── case 5: trusted origins ───────────────────────────────────────────────────


def test_case5_the_sync_pull_passes(ws, state, recorder):
    d = _project(ws)
    _sidecar(state, fields=["tracks"])
    resp = _put(ws, {"tracks": [{"id": "trk-9", "items": []}]}, SYNC)
    assert resp.status_code == 200, resp.text
    assert json.loads(_disk(d))["tracks"][0]["id"] == "trk-9"


def test_case5_the_resolve_with_an_open_clash_id_passes(ws, state):
    d = _project(ws)
    _sidecar(state, fields=["tracks"])
    resp = _put(ws, {"tracks": [{"id": "trk-9", "items": []}]}, RESOLVE("c1"))
    assert resp.status_code == 200, resp.text


def test_case5_the_resolve_with_another_id_is_refused(ws, state):
    _project(ws)
    _sidecar(state, fields=["tracks"])
    _refused(_put(ws, {"tracks": []}, RESOLVE("c2")), ["tracks"])


@pytest.mark.parametrize("clash_id", ["", None], ids=["empty", "absent"])
def test_case5_a_resolve_with_no_clash_id_is_refused(ws, state, clash_id):
    _project(ws)
    _sidecar(state, fields=["tracks"])
    headers = RESOLVE()
    if clash_id is None:
        headers.pop("x-montaj-sync-resolve")
    else:
        headers["x-montaj-sync-resolve"] = clash_id
    _refused(_put(ws, {"tracks": []}, headers), ["tracks"])


def test_case5_a_plain_tool_is_refused(ws, state):
    _project(ws)
    _sidecar(state, fields=["tracks"])
    _refused(_put(ws, {"tracks": []}, TOOL), ["tracks"])


def test_case5_tool_with_origin_app_is_plain_tool(ws, state):
    _project(ws)
    _sidecar(state, fields=["tracks"])
    _refused(_put(ws, {"tracks": []}, APP), ["tracks"])


def test_case5_the_window_passes_advisory_as_today(ws, state):
    d = _project(ws)
    _sidecar(state, fields=["tracks"])
    resp = _put(ws, {"tracks": [{"id": "trk-9", "items": []}]}, EDITOR, read=False)
    assert resp.status_code == 200, resp.text
    assert json.loads(_disk(d))["tracks"][0]["id"] == "trk-9"


@pytest.mark.parametrize("origin", ["drive", "sync", "resolve", "app", "human"])
def test_case5_the_window_with_any_origin_is_not_the_human(ws, state, origin):
    _project(ws)
    _sidecar(state, fields=["tracks"])
    headers = {**EDITOR, "x-montaj-write-origin": origin, "x-montaj-sync-resolve": "c1"}
    _refused(_put(ws, {"tracks": []}, headers, read=False), ["tracks"])


@pytest.mark.parametrize("headers", [
    {"x-montaj-writer": "tool", "x-montaj-write-origin": "sync"},
    {"x-montaj-writer": "tool", "x-montaj-write-origin": "resolve", "x-montaj-sync-resolve": "c1"},
    {"x-montaj-writer": "editor"},
    {"x-montaj-shell": "a1" * 32, "x-montaj-writer": "tool", "x-montaj-write-origin": "sync"},
    {"x-montaj-shell": "a1" * 32, "x-montaj-writer": "editor"},
], ids=["sync-no-secret", "resolve-no-secret", "editor-no-secret", "sync-wrong-secret", "editor-wrong-secret"])
def test_case5_a_forged_origin_or_writer_without_the_secret_is_the_ai(ws, state, headers):
    _project(ws)
    _sidecar(state, fields=["tracks"])
    _refused(_put(ws, {"tracks": []}, headers), ["tracks"])


def test_case5_the_trust_rule_holds_with_the_guard_switch_off(ws, state, monkeypatch):
    """The revision guard may step aside (switch off, canary mismatch); the sync check does not, and still
    believes only the launch secret."""
    _start(monkeypatch, guard=False)
    _project(ws)
    _sidecar(state, fields=["tracks"])
    _refused(_put(ws, {"tracks": []}, AI, read=False), ["tracks"])
    assert _put(ws, {"tracks": []}, EDITOR, read=False).status_code == 200
    assert _put(ws, {"tracks": []}, SYNC, read=False).status_code == 200


# ── case 6: translation and the overlay PUT ───────────────────────────────────


def test_case6_translation_is_refused_on_a_captions_clash_before_its_read_check(ws, state):
    d = _project(ws, captions={"segments": []})
    _sidecar(state, fields=["captions"])
    before = _disk(d)
    resp = _client().post(f"/api/projects/{PID}/captions/translation", json={"show": ["source"]}, headers=AI)
    _refused(resp, ["captions"])
    assert _disk(d) == before


def test_case6_translation_by_the_window_passes_the_sync_check(ws, state):
    _project(ws, captions={"segments": []})
    _sidecar(state, fields=["captions"])
    resp = _client().post(f"/api/projects/{PID}/captions/translation", json={"show": ["source"]}, headers=EDITOR)
    assert resp.status_code != 409 and "sync_conflict" not in resp.text, resp.text


def test_case6_the_overlay_put_is_refused_on_its_file_and_leaves_it_byte_identical(ws, state):
    d = _project(ws)
    (d / "overlays").mkdir()
    (d / "overlays" / "title.jsx").write_text("mine")
    _sidecar(state, files=["overlays/title.jsx"])
    resp = _client().put(f"/api/projects/{PID}/overlays/title", content=b"theirs", headers=AI)
    _refused(resp, ["overlays/title.jsx"])
    assert (d / "overlays" / "title.jsx").read_text() == "mine"
    resp = _client().put(f"/api/projects/{PID}/overlays/other", content=b"new", headers=AI)
    assert resp.status_code == 201, resp.text


def test_case6_the_overlay_put_on_a_clashed_overlays_folder_is_refused(ws, state):
    _project(ws)
    _sidecar(state, files=["overlays/"])
    _refused(_client().put(f"/api/projects/{PID}/overlays/any", content=b"x", headers=AI), ["overlays/"])


def test_case6_the_overlay_put_holds_the_project_lock(ws, state, monkeypatch):
    import lib.project_lock as lock_mod
    d = _project(ws)
    _sidecar(state, files=["overlays/elsewhere.jsx"])
    monkeypatch.setattr(lock_mod, "DEFAULT_TIMEOUT", 0.3)
    with project_lock(d / "project.json"):
        resp = _client().put(f"/api/projects/{PID}/overlays/title", content=b"x", headers=AI)
    assert resp.status_code == 503, resp.text
    assert not (d / "overlays" / "title.jsx").exists()


# ── case 7: POST /files, any spelling ─────────────────────────────────────────


def _write_file(path, headers=AI):
    return _client().post("/api/files", json={"path": str(path), "content": "theirs"}, headers=headers)


@pytest.fixture
def clashed_overlay(ws, state):
    d = _project(ws)
    (d / "overlays").mkdir()
    (d / "assets").mkdir()
    (d / "overlays" / "title.jsx").write_text("mine")
    _sidecar(state, files=["overlays/title.jsx"])
    return d


def test_case7_files_refuses_the_clashed_relpath(clashed_overlay):
    d = clashed_overlay
    _refused(_write_file(d / "overlays" / "title.jsx"), ["overlays/title.jsx"])
    assert (d / "overlays" / "title.jsx").read_text() == "mine"


def test_case7_files_refuses_a_dot_spelling(clashed_overlay):
    d = clashed_overlay
    _refused(_write_file(f"{d}/./overlays/title.jsx"), ["overlays/title.jsx"])


def test_case7_files_refuses_a_dotdot_spelling(clashed_overlay):
    d = clashed_overlay
    _refused(_write_file(f"{d}/assets/../overlays/title.jsx"), ["overlays/title.jsx"])


def test_case7_files_refuses_through_a_symlinked_parent(clashed_overlay, ws):
    d = clashed_overlay
    (ws / "alias").symlink_to(d, target_is_directory=True)
    _refused(_write_file(ws / "alias" / "overlays" / "title.jsx"), ["overlays/title.jsx"])
    assert (d / "overlays" / "title.jsx").read_text() == "mine"


def test_case7_files_refuses_another_case(clashed_overlay):
    """Case-folded always: on a case-insensitive disk it is the same file, on a case-sensitive one a refusal is
    the fail-closed side."""
    d = clashed_overlay
    _refused(_write_file(d / "overlays" / "TITLE.jsx"), ["overlays/title.jsx"])


def test_case7_files_refuses_another_unicode_form(ws, state):
    d = _project(ws)
    (d / "overlays").mkdir()
    nfc = unicodedata.normalize("NFC", "overlays/café.jsx")
    _sidecar(state, files=[nfc])
    nfd = unicodedata.normalize("NFD", "café.jsx")
    _refused(_write_file(d / "overlays" / nfd), [nfc])


def test_case7_files_outside_a_synced_project_passes(clashed_overlay, ws):
    other = _project(ws, pid="other-proj")
    (other / "overlays").mkdir()
    assert _write_file(other / "overlays" / "title.jsx").status_code == 200
    assert _write_file(ws / "loose.txt").status_code == 200
    assert _write_file(clashed_overlay / "overlays" / "other.jsx").status_code == 200


def test_case7_files_by_the_window_passes(clashed_overlay):
    assert _write_file(clashed_overlay / "overlays" / "title.jsx", EDITOR).status_code == 200


def test_case7_files_finds_the_topmost_project_folder(ws, state):
    """A project.json nested in a project folder (a versions snapshot) is not a project of its own: the write's
    relpath is the outer project's."""
    d = _project(ws)
    snap = d / "render" / "versions" / "abc"
    snap.mkdir(parents=True)
    write_json_atomic(snap / "project.json", {"id": PID})
    _sidecar(state, files=["render/versions/abc/notes.txt"])
    _refused(_write_file(snap / "notes.txt"), ["render/versions/abc/notes.txt"])


# ── case 8: steps ─────────────────────────────────────────────────────────────


@pytest.fixture
def ran(monkeypatch):
    """Records each step subprocess instead of running it."""
    calls = []

    async def fake(cmd, *, timeout, cwd=None, env=None, **kwargs):
        calls.append({"cmd": cmd, "env": env})
        return "{}", "", 0

    monkeypatch.setattr(steps_mod, "run_subprocess", fake)
    return calls


def _step(name, body, headers=AI):
    return _client().post(f"/api/steps/{name}", json=body, headers=headers)


@pytest.mark.parametrize("name", ["jump_cut", "montage", "cross_cut"])
def test_case8_cut_steps_are_refused_on_a_tracks_clash_before_they_run(ws, state, ran, name):
    d = _project(ws)
    _sidecar(state, fields=["tracks"])
    before = _disk(d)
    _refused(_step(name, {"project-id": PID, "clip-id": "clip-0", "cuts": "[]"}), ["tracks"])
    assert ran == [] and _disk(d) == before


def test_case8_speech_edit_is_refused_on_a_tracks_clash(ws, state, ran):
    d = _project(ws)
    _sidecar(state, fields=["tracks"])
    _refused(_step("speech_edit", {"project": PID, "text": str(d / "speech-text.md")}), ["tracks"])
    assert ran == []


def test_case8_speech_edit_is_refused_on_its_text_file(ws, state, ran):
    d = _project(ws)
    _sidecar(state, files=["speech-text.md"])
    _refused(_step("speech_edit", {"project": str(d), "text": str(d / "speech-text.md")}), ["speech-text.md"])
    assert ran == []


def test_case8_generate_captions_is_refused_on_a_captions_clash(ws, state, ran):
    _project(ws)
    _sidecar(state, fields=["captions"])
    _refused(_step("generate_captions", {"project-id": PID}), ["captions"])
    assert ran == []


@pytest.mark.parametrize("name", ["kling_generate", "veo_generate"])
@pytest.mark.parametrize("field", ["tracks", "storyboard", "status"])
def test_case8_video_generation_is_refused_on_its_fields(ws, state, ran, name, field):
    _project(ws)
    _sidecar(state, fields=[field])
    _refused(_step(name, {"project-id": PID, "scene-id": "s1", "prompt": "x"}), [field])
    assert ran == []


def test_case8_sample_frame_runs_on_a_clashed_project(ws, state, ran):
    _project(ws)
    _sidecar(state, fields=["tracks", "settings"])
    resp = _step("sample_frame", {"project": PID, "at": 1.0})
    assert resp.status_code == 200, resp.text
    assert len(ran) == 1


def test_case8_a_step_the_table_does_not_know_is_refused_while_any_clash_is_open(ws, state, ran):
    _project(ws)
    _sidecar(state, fields=["markers"])
    _refused(_step("track_pose", {"project-id": PID, "input": "x.mp4"}), ["markers"])
    assert ran == []


def test_case8_a_step_run_by_the_window_runs_with_origin_human(ws, state, ran):
    _project(ws)
    _sidecar(state, fields=["tracks"])
    resp = _step("jump_cut", {"project-id": PID, "clip-id": "clip-0", "cuts": "[]"}, EDITOR)
    assert resp.status_code == 200, resp.text
    assert ran[0]["env"]["MONTAJ_WRITE_ORIGIN"] == "human"


@pytest.mark.parametrize("headers", [AI, TOOL, SYNC, DRIVE], ids=["ai", "tool", "sync", "drive"])
def test_case8_any_other_step_run_carries_origin_ai(ws, state, ran, headers):
    _project(ws)
    _sidecar(state, fields=["settings"])
    resp = _step("jump_cut", {"project-id": PID, "clip-id": "clip-0", "cuts": "[]"}, headers)
    assert resp.status_code == 200, resp.text
    assert ran[0]["env"]["MONTAJ_WRITE_ORIGIN"] == "ai"


def test_case8_a_step_env_never_inherits_a_human_origin(ws, state, ran, monkeypatch):
    monkeypatch.setenv("MONTAJ_WRITE_ORIGIN", "human")
    save_guard.startup()
    _project(ws)
    _step("jump_cut", {"project-id": PID, "clip-id": "clip-0", "cuts": "[]"}, AI)
    assert ran[0]["env"]["MONTAJ_WRITE_ORIGIN"] == "ai"
    assert "MONTAJ_WRITE_ORIGIN" not in os.environ


def test_case8_dark_a_step_env_is_unchanged_with_the_var_unset(ws, ran):
    _project(ws)
    _step("jump_cut", {"project-id": PID, "clip-id": "clip-0", "cuts": "[]"}, AI)
    assert ran[0]["env"] is None


def test_case8_a_step_out_into_a_clashed_file_is_refused(ws, state, ran):
    d = _project(ws)
    (d / "assets").mkdir()
    _sidecar(state, files=["assets/hero.png"])
    _refused(_step("generate_image", {"prompt": "x", "out": str(d / "assets" / "hero.png")}), ["assets/hero.png"])
    assert ran == []


def test_case8_a_step_into_a_project_assets_folder_with_a_clashed_asset_is_refused(ws, state, ran):
    d = _project(ws)
    _sidecar(state, files=["assets/hero.png"])
    _refused(_step("generate_image", {"prompt": "x", "_project": PID}), ["assets/hero.png"])
    assert ran == []


def test_case8_a_step_writing_beside_a_clashed_project_file_is_refused(ws, state, ran):
    d = _project(ws)
    (d / "clip.mp4").write_bytes(b"x")
    _sidecar(state, files=["clip.mp4"])
    _refused(_step("extract_audio", {"input": str(d / "clip.mp4")}), ["clip.mp4"])
    assert ran == []


def test_case8_a_step_refusal_from_under_the_lock_answers_the_binding_409(ws, state, monkeypatch):
    body = {"error": "sync_conflict", "fields": ["tracks"], "message": _message(["tracks"])}

    async def fake(cmd, *, timeout, cwd=None, env=None, **kwargs):
        return "", json.dumps(body), 1

    monkeypatch.setattr(steps_mod, "run_subprocess", fake)
    _project(ws)
    resp = _step("jump_cut", {"project-id": PID, "clip-id": "clip-0", "cuts": "[]"})
    _refused(resp, ["tracks"])


# case 8, the step's own write under the lock (lib/project_lock.update_project)


def _lib_project(tmp_path, pid=PID):
    d = tmp_path / "lib-proj"
    d.mkdir()
    write_json_atomic(d / "project.json", {"id": pid, "tracks": [], "notes": [], "captions": {}})
    return d / "project.json"


def test_case8_lib_update_project_refuses_a_clashed_field_and_writes_nothing(tmp_path, state, monkeypatch):
    from lib.project_lock import update_project
    path = _lib_project(tmp_path)
    _sidecar(state, fields=["tracks"])
    before = path.read_bytes()

    def apply(p):
        p["tracks"] = [{"id": "trk-1", "items": []}]
        return p

    with pytest.raises(_sc().SyncConflict) as e:
        update_project(path, apply)
    assert e.value.body == {"error": "sync_conflict", "fields": ["tracks"], "message": _message(["tracks"])}
    assert path.read_bytes() == before


def test_case8_lib_update_project_writes_an_unclashed_field(tmp_path, state):
    from lib.project_lock import update_project
    path = _lib_project(tmp_path)
    _sidecar(state, fields=["tracks"])

    def apply(p):
        p["notes"] = [{"id": "n2"}]
        return p

    update_project(path, apply)
    assert json.loads(path.read_text())["notes"] == [{"id": "n2"}]


def test_case8_lib_update_project_with_origin_human_writes(tmp_path, state, monkeypatch):
    from lib.project_lock import update_project
    monkeypatch.setenv("MONTAJ_WRITE_ORIGIN", "human")
    path = _lib_project(tmp_path)
    _sidecar(state, fields=["tracks"])

    def apply(p):
        p["tracks"] = [{"id": "trk-1", "items": []}]
        return p

    update_project(path, apply)
    assert json.loads(path.read_text())["tracks"][0]["id"] == "trk-1"


def test_case8_lib_update_project_or_fail_exits_with_the_binding_body(tmp_path, state, capsys):
    from lib.project_lock import update_project_or_fail
    path = _lib_project(tmp_path)
    _sidecar(state, fields=["captions"])

    def apply(p):
        p["captions"] = {"segments": [1]}
        return p

    def fail(code, message):
        raise AssertionError(f"fail({code}) instead of the sync refusal")

    with pytest.raises(SystemExit) as e:
        update_project_or_fail(path, apply, fail)
    assert e.value.code == 1
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err == {"error": "sync_conflict", "fields": ["captions"], "message": _message(["captions"])}


def test_case8_lib_update_project_dark_reads_no_sidecar(tmp_path, ws, monkeypatch):
    from lib.project_lock import update_project
    path = _lib_project(tmp_path)
    spy = _Spy(monkeypatch)
    update_project(path, lambda p: {**p, "tracks": [1]})
    assert spy.touched("clash-set") == [] and spy.touched("studio-sync") == []


def _speech_env(tmp_path):
    import shutil
    from lib.speech_text import derive, render
    from tests import test_speech_apply as sa
    pdir = tmp_path / "speech"
    shutil.copytree(sa.FIX, pdir)
    pj = pdir / "project.json"
    pj.write_text(pj.read_text().replace("/FIXTURE", str(pdir)))
    sa._git(pdir, "init", "-q")
    sa._git(pdir, "add", "project.json")
    sa._git(pdir, "commit", "-q", "-m", "init")
    project = json.loads(pj.read_text())
    text = render(derive(project, str(pdir)), project.get("name") or project["id"])
    return pj, project["id"], sa.delete_row(text, "A4")


@pytest.mark.parametrize("clash", [{"fields": ["tracks"]}, {"files": ["speech-text.md"]}], ids=["tracks", "text-file"])
def test_case8_speech_apply_is_refused_on_its_fields_and_file_with_nothing_written(tmp_path, state, capsys, clash):
    """speech_apply writes project.json and speech-text.md itself: it checks both before anything is written."""
    from lib import speech_apply
    pj, pid, edited = _speech_env(tmp_path)
    _sidecar(state, pid=pid, **clash)
    before = pj.read_bytes()
    with pytest.raises(SystemExit):
        speech_apply.apply(str(pj), edited, preview=False, max_pause=None, feel="tight")
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    names = clash.get("fields") or clash.get("files")
    assert err == {"error": "sync_conflict", "fields": names, "message": _message(names)}
    assert pj.read_bytes() == before
    assert not (pj.parent / "speech-text.md").exists() or clash.get("files")


def test_case8_speech_apply_with_origin_human_applies(tmp_path, state, monkeypatch):
    from lib import speech_apply
    monkeypatch.setenv("MONTAJ_WRITE_ORIGIN", "human")
    pj, pid, edited = _speech_env(tmp_path)
    _sidecar(state, pid=pid, fields=["tracks"])
    before = pj.read_bytes()
    assert speech_apply.apply(str(pj), edited, preview=False, max_pause=None, feel="tight")["applied"] is True
    assert pj.read_bytes() != before


# ── case 9: sources and upload-asset ──────────────────────────────────────────


def test_case9_sources_is_refused_on_a_sources_clash(ws, state, tmp_path):
    _project(ws, settings={"colorSpace": "sdr_bt709"})
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"x")
    _sidecar(state, fields=["sources"])
    _refused(_client().post(f"/api/projects/{PID}/sources", json={"path": str(clip)}, headers=AI), ["sources"])


def test_case9_a_late_ingest_landing_is_refused_with_the_request_class(ws, state, monkeypatch):
    """The ingest checks again under the lock when it lands, as the request's writer: a clash recorded while it
    ran refuses the AI's clip, and the job reports it."""
    d = _project(ws, settings={"colorSpace": "sdr_bt709"})
    monkeypatch.setattr(projects_mod, "ingest_source", lambda *a, **k: {"src": str(d / "c.mp4"), "type": "video"})
    _sidecar(state, fields=["sources"])
    job = projects_mod._IngestJob()
    before = _disk(d)
    import asyncio
    asyncio.run(projects_mod._run_ingest_detached(PID, d, "x.mp4", "sdr_bt709", _Recorder(), job,
                                                  who=save_guard.sync_who(AI)))
    assert job.status == "error" and job.error == _message(["sources"])
    assert _disk(d) == before
    job = projects_mod._IngestJob()
    asyncio.run(projects_mod._run_ingest_detached(PID, d, "x.mp4", "sdr_bt709", _Recorder(), job,
                                                  who=save_guard.sync_who(EDITOR)))
    assert job.status == "done", job.error


def _upload(name, headers=AI):
    return _client().post(f"/api/projects/{PID}/upload-asset", files={"file": (name, b"data")}, headers=headers)


def test_case9_upload_asset_of_a_clashed_name_is_refused(ws, state):
    d = _project(ws)
    (d / "cover.png").write_bytes(b"mine")
    _sidecar(state, files=["cover.png"])
    _refused(_upload("cover.png"), ["cover.png"])
    assert (d / "cover.png").read_bytes() == b"mine"
    assert sorted(p.name for p in d.iterdir()) == ["cover.png", "project.json"]


def test_case9_a_new_asset_lands(ws, state):
    d = _project(ws)
    _sidecar(state, files=["cover.png"])
    resp = _upload("other.png")
    assert resp.status_code == 200, resp.text
    assert (d / "other.png").read_bytes() == b"data"


# ── case 10: restore, rerun, include-asset ────────────────────────────────────


def _commit(d):
    subprocess.run(["git", "init", "-q"], cwd=str(d), check=True)
    projects_mod._git_commit_sync(d, "version: before the clash")
    out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(d), capture_output=True, text=True)
    return out.stdout.strip()


def test_case10_restore_by_the_window_passes_and_under_drive_is_refused(ws, state):
    d = _project(ws)
    sha = _commit(d)
    _sidecar(state, fields=["notes"])
    _refused(_client().post(f"/api/projects/{PID}/versions/{sha}/restore", headers=DRIVE), ["notes"])
    assert _client().post(f"/api/projects/{PID}/versions/{sha}/restore", headers=EDITOR).status_code == 200


def test_case10_restore_with_the_guard_off_still_refuses_the_ai(ws, state, monkeypatch):
    _start(monkeypatch, guard=False)
    d = _project(ws)
    sha = _commit(d)
    _sidecar(state, files=["overlays/a.jsx"])
    _refused(_client().post(f"/api/projects/{PID}/versions/{sha}/restore", headers=AI), ["overlays/a.jsx"])


def test_case10_rerun_by_the_window_passes_and_under_drive_is_refused(ws, state):
    d = _project(ws, sources=[{"id": "clip-0", "src": "/x.mp4"}])
    _sidecar(state, fields=["tracks"])
    before = _disk(d)
    _refused(_client().post(f"/api/projects/{PID}/rerun", json={}, headers=DRIVE), ["tracks"])
    assert _disk(d) == before
    assert _client().post(f"/api/projects/{PID}/rerun", json={}, headers=EDITOR).status_code == 200


def test_case10_include_asset_by_the_window_passes_and_under_drive_is_refused(ws, state, tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".montaj" / "profiles" / "brand" / "assets").mkdir(parents=True)
    (home / ".montaj" / "profiles" / "brand" / "assets" / "logo.png").write_bytes(b"png")
    monkeypatch.setenv("HOME", str(home))
    d = _project(ws, profile="brand", assets=[])
    _sidecar(state, fields=["assets"])
    body = {"from": {"profile": "brand", "filename": "logo.png"}}
    _refused(_client().post(f"/api/projects/{PID}/assets", json=body, headers=DRIVE), ["assets"])
    assert not any(p.name.startswith("logo") for p in d.rglob("*"))
    assert _client().post(f"/api/projects/{PID}/assets", json=body, headers=EDITOR).status_code == 200


# ── case 11: DELETE /projects/{id} ────────────────────────────────────────────


@pytest.mark.parametrize("field", ["tracks", "sources", "audio", "assets"])
def test_case11_delete_is_refused_when_a_dependent_has_a_clash_on_what_it_would_patch(ws, state, monkeypatch, field):
    doomed = _project(ws, pid="doomed")
    dependent = _project(ws)
    monkeypatch.setattr(projects_mod, "_dependents_of",
                        lambda pid, pdir: [(PID, dependent, json.loads(_disk(dependent)), {"k": "src"})])
    _sidecar(state, fields=[field])
    _refused(_client().delete("/api/projects/doomed", headers=AI), [field])
    assert doomed.is_dir()


def test_case11_delete_of_a_synced_project_with_any_clash_is_refused(ws, state):
    doomed = _project(ws)
    _sidecar(state, fields=["notes"], files=["overlays/a.jsx"])
    _refused(_client().delete(f"/api/projects/{PID}", headers=AI), ["notes", "overlays/a.jsx"])
    assert doomed.is_dir()


def test_case11_delete_by_the_window_passes(ws, state):
    doomed = _project(ws)
    _sidecar(state, fields=["notes"])
    assert _client().delete(f"/api/projects/{PID}", headers=EDITOR).status_code == 204
    assert not doomed.exists()


# ── case 12: maintenance heals ────────────────────────────────────────────────


def _legacy(ws):
    return _project(ws, tracks=[[{"id": "clip-0", "type": "video", "src": "/x.mp4", "start": 0, "end": 1}]])


def test_case12_an_open_heal_of_a_clashed_field_is_skipped_and_retried_when_it_closes(ws, state):
    d = _legacy(ws)
    side = _sidecar(state, fields=["tracks"])
    before = _disk(d)
    resp = _client().get(f"/api/projects/{PID}", headers=AI)
    assert resp.status_code == 200
    assert resp.json()["tracks"][0]["items"][0]["id"] == "clip-0"   # served converged, in memory
    assert _disk(d) == before                                       # but not written
    side.unlink()
    assert _client().get(f"/api/projects/{PID}", headers=AI).status_code == 200
    assert isinstance(json.loads(_disk(d))["tracks"][0], dict)


def test_case12_an_open_heal_of_an_unclashed_field_still_runs(ws, state):
    d = _legacy(ws)
    _sidecar(state, fields=["settings"])
    assert _client().get(f"/api/projects/{PID}", headers=AI).status_code == 200
    assert isinstance(json.loads(_disk(d))["tracks"][0], dict)


def test_case12_an_open_heal_is_skipped_on_an_unsure_sidecar(ws, state):
    d = _legacy(ws)
    (state / PID).mkdir()
    (state / PID / "clash-set.json").write_text("{not json")
    before = _disk(d)
    assert _client().get(f"/api/projects/{PID}", headers=EDITOR).status_code == 200
    assert _disk(d) == before


def test_case12_a_settings_write_back_canvas_size_skips_a_clashed_settings(ws, state):
    d = _project(ws, settings={"resolution": [1080, 1920]})
    side = _sidecar(state, fields=["settings"])
    assert projects_mod._apply_project_edits(d / "project.json", [], settings={"resolution": [1920, 1080]}) is None
    assert json.loads(_disk(d))["settings"]["resolution"] == [1080, 1920]
    side.unlink()
    assert projects_mod._apply_project_edits(d / "project.json", [], settings={"resolution": [1920, 1080]})
    assert json.loads(_disk(d))["settings"]["resolution"] == [1920, 1080]


def test_case12_an_item_write_back_skips_only_a_clashed_owner(ws, state):
    item = {"id": "clip-0", "type": "video", "src": "/x.mp4", "start": 0, "end": 1}
    d = _project(ws, tracks=[{"id": "trk-0", "items": [dict(item)]}], sources=[dict(item)])
    _sidecar(state, fields=["sources"])
    result = projects_mod._apply_project_edits(d / "project.json", [("clip-0", "/x.mp4", "proxySrc", "/p.mp4")])
    assert result is None, "the edit lands in sources too, which is clashed"
    _sidecar(state, fields=["settings"])
    assert projects_mod._apply_project_edits(d / "project.json", [("clip-0", "/x.mp4", "proxySrc", "/p.mp4")])


def test_case12_a_late_save_copy_patch_of_the_ai_is_kept_for_the_next_save(ws, state, monkeypatch):
    """The copy patch after a save is the save's follow-up: checked again under its lock as the save's writer,
    and kept for the next save when refused."""
    d = _project(ws)
    _sidecar(state, fields=["tracks"])
    previous = json.loads(_disk(d))

    def swap(prev, project, made, also):
        project["tracks"] = [{"id": "trk-0", "items": [{"id": "clip-0", "src": "/copied.mp4"}]}]
        return ["/copied.mp4"]

    monkeypatch.setattr(projects_mod, "apply_borrowed_media", swap)
    before = _disk(d)
    out = projects_mod._patch_copied_media(d / "project.json", previous, {"k": "/copied.mp4"}, project_id=PID,
                                           who=save_guard.sync_who(AI))
    assert out is projects_mod._PATCH_SYNC_CLASH and _disk(d) == before
    out = projects_mod._patch_copied_media(d / "project.json", previous, {"k": "/copied.mp4"}, project_id=PID,
                                           who=save_guard.sync_who(EDITOR))
    assert isinstance(out, tuple) and json.loads(_disk(d))["tracks"][0]["items"][0]["src"] == "/copied.mp4"


# ── case 13: corrupt, unreadable, unknown ─────────────────────────────────────


def _corrupt(state, how, pid=PID):
    folder = state / pid
    if how == "no-state-dir":
        os.environ["MONTAJ_SYNC_STATE_DIR"] = str(state / "missing")
        return
    if how == "state-dir-is-a-file":
        f = state / "a-file"
        f.write_text("x")
        os.environ["MONTAJ_SYNC_STATE_DIR"] = str(f)
        return
    if how == "project-folder-is-a-file":
        folder.write_text("x")
        return
    folder.mkdir()
    side = folder / "clash-set.json"
    if how == "not-json":
        side.write_text("{tracks")
    elif how == "torn":
        side.write_text(json.dumps({"v": 1, "projectId": pid, "fields": ["notes"], "files": [], "clashes": []})[:30])
    elif how == "v2":
        side.write_text(json.dumps({"v": 2, "projectId": pid, "fields": [], "files": [], "clashes": []}))
    elif how == "v-true":
        side.write_text(json.dumps({"v": True, "projectId": pid, "fields": [], "files": [], "clashes": []}))
    elif how == "other-project":
        side.write_text(json.dumps({"v": 1, "projectId": "nope", "fields": [], "files": [], "clashes": []}))
    elif how == "fields-not-a-list":
        side.write_text(json.dumps({"v": 1, "projectId": pid, "fields": "tracks", "files": [], "clashes": []}))
    elif how == "no-clashes":
        side.write_text(json.dumps({"v": 1, "projectId": pid, "fields": [], "files": []}))
    elif how == "bad-clash":
        side.write_text(json.dumps({"v": 1, "projectId": pid, "fields": [], "files": [], "clashes": [{"id": 3}]}))
    elif how == "array":
        side.write_text("[]")
    elif how == "a-folder":
        side.mkdir()
    elif how == "huge":
        side.write_text(" " * (5 * 1024 * 1024) + "{}")
    elif how == "unreadable":
        side.write_text(json.dumps({"v": 1, "projectId": pid, "fields": [], "files": [], "clashes": []}))
        side.chmod(0)
    else:
        raise AssertionError(how)


# "no-state-dir" is not here: a state folder that does not exist records no clash (review 40, 3a, below).
CORRUPT = ["state-dir-is-a-file", "project-folder-is-a-file", "not-json", "torn", "v2", "v-true",
           "other-project", "fields-not-a-list", "no-clashes", "bad-clash", "array", "a-folder", "huge", "unreadable"]


@pytest.fixture
def corrupt(request, ws, state, monkeypatch):
    how = request.param
    if how == "unreadable" and (os.name == "nt" or (hasattr(os, "geteuid") and os.geteuid() == 0)):
        pytest.skip("a mode-0 file is readable here")
    monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", str(state))
    _corrupt(state, how)
    try:
        yield how
    finally:
        side = state / PID / "clash-set.json"
        if side.exists() and not side.is_dir():
            side.chmod(0o644)


@pytest.mark.parametrize("corrupt", CORRUPT, indirect=True)
@pytest.mark.parametrize("headers", [AI, TOOL, APP, DRIVE], ids=["ai", "tool", "tool-app", "drive"])
def test_case13_an_unsure_clash_set_refuses_every_non_human_write(ws, corrupt, headers):
    d = _project(ws)
    before = _disk(d)
    _refused(_put(ws, {"notes": []}, headers, read=headers is not DRIVE), ["notes"])
    assert _disk(d) == before


@pytest.mark.parametrize("corrupt", CORRUPT, indirect=True)
@pytest.mark.parametrize("headers", [EDITOR, SYNC, RESOLVE("any-open-or-not")], ids=["editor", "sync", "resolve"])
def test_case13_an_unsure_clash_set_lets_the_human_and_the_shell_through(ws, corrupt, headers):
    _project(ws)
    assert _put(ws, {"notes": []}, headers, read=headers is not EDITOR).status_code == 200


def test_case13_an_unsure_set_refuses_a_whole_project_write_with_a_star(ws, state):
    _project(ws)
    (state / PID).mkdir()
    (state / PID / "clash-set.json").write_text("nope")
    _refused(_client().delete(f"/api/projects/{PID}", headers=AI), ["*"])


# ── case 14: no stale cache ───────────────────────────────────────────────────


def test_case14_a_rewritten_sidecar_is_seen_by_the_next_write(ws, state):
    _project(ws)
    side = _sidecar(state, fields=["audio"])
    st = side.stat()
    assert _put(ws, {"notes": []}, AI).status_code == 200
    # Same size, same inode, same mtime: an in-place rewrite a (ino, size, mtime) cache would miss.
    text = side.read_text().replace('"audio"', '"notes"')
    with open(side, "r+") as f:
        f.write(text)
    os.utime(side, ns=(st.st_atime_ns, st.st_mtime_ns))
    assert side.stat().st_size == st.st_size and side.stat().st_ino == st.st_ino
    _refused(_put(ws, {"notes": []}, AI), ["notes"])


def test_case14_an_atomic_rename_is_seen_by_the_next_write(ws, state):
    _project(ws)
    side = _sidecar(state, fields=["tracks"])
    _refused(_put(ws, {"tracks": []}, AI), ["tracks"])
    tmp = side.with_name(".clash-set.json.0123456789ab.tmp")
    tmp.write_text(json.dumps({"v": 1, "projectId": PID, "fields": [], "files": [], "clashes": []}))
    os.replace(tmp, side)
    assert _put(ws, {"tracks": []}, AI).status_code == 200


# ── case 15: a duplicate id ───────────────────────────────────────────────────


def test_case15_two_folders_with_one_id_share_its_sidecar_and_both_refuse(ws, state):
    a = _project(ws, folder="copy-a")
    b = _project(ws, folder="copy-b")
    _sidecar(state, fields=["tracks"], files=["overlays/title.jsx"])
    for folder in (a, b):
        app.dependency_overrides[common_mod.get_project_dir] = lambda folder=folder: folder
        try:
            _refused(_put(ws, {"tracks": []}, AI, folder=folder), ["tracks"])
        finally:
            app.dependency_overrides.pop(common_mod.get_project_dir, None)
        (folder / "overlays").mkdir()
        _refused(_write_file(folder / "overlays" / "title.jsx"), ["overlays/title.jsx"])


def test_case15_run_with_an_explicit_synced_id_is_refused(ws, state):
    pid = "0f8fad5b-d9cb-469f-a165-70867728950e"
    _project(ws, pid=pid)
    _sidecar(state, pid=pid, fields=["tracks"])
    resp = _client().post("/api/run", json={"id": pid, "workflow": "overlays", "prompt": "x"}, headers=AI)
    _refused(resp, ["tracks"])


# ── the project id in the path ────────────────────────────────────────────────


BAD_IDS = ["../x", "..", ".", "a/b", "/abs", "a\\b", "C:\\x", "x\x00y", "caf\u00e9", unicodedata.normalize("NFD", "caf\u00e9"),
           "a\uff0eb", "\uff0e\uff0e", "abc.", "CON", "nul.txt", "Com1", "lpt9", "", " a", "a b", "-a", "_a",
           "a" * 65, "a\n", "a\u2024b", 7, None]


@pytest.mark.parametrize("pid", BAD_IDS, ids=[repr(p) for p in BAD_IDS])
def test_id_rule_refuses_every_traversal_and_odd_spelling(pid):
    assert _sc().valid_project_id(pid) is False


@pytest.mark.parametrize("pid", ["a", "0f8fad5b-d9cb-469f-a165-70867728950e", "proj.v2", "a_b-c", "A" * 64, "conx",
                                 "console", "nul0"])
def test_id_rule_takes_the_state_ids(pid):
    assert _sc().valid_project_id(pid) is True


@pytest.mark.parametrize("pid", [p for p in BAD_IDS if isinstance(p, str)], ids=lambda p: repr(p))
def test_id_rule_a_bad_id_reads_as_unsure_and_never_builds_a_path(state, monkeypatch, pid):
    spy = _Spy(monkeypatch)
    assert _sc().load(pid).unsure is True
    assert spy.touched("clash-set") == []


def test_id_rule_a_project_with_a_bad_id_fails_closed(ws, state):
    pid = "bad id"
    _project(ws, pid=pid)
    _refused(_put(ws, {"notes": []}, AI, pid=pid), ["notes"])
    assert _put(ws, {"notes": []}, EDITOR, pid=pid, read=False).status_code == 200


def test_id_rule_a_project_folder_that_resolves_outside_the_state_dir_fails_closed(ws, state, tmp_path):
    _project(ws)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "clash-set.json").write_text(
        json.dumps({"v": 1, "projectId": PID, "fields": [], "files": [], "clashes": []}))
    (state / PID).symlink_to(elsewhere, target_is_directory=True)
    _refused(_put(ws, {"notes": []}, AI), ["notes"])


def test_id_rule_a_project_folder_linked_to_a_sibling_fails_closed(ws, state):
    _project(ws)
    _sidecar(state, pid="sibling")
    (state / PID).symlink_to(state / "sibling", target_is_directory=True)
    _refused(_put(ws, {"notes": []}, AI), ["notes"])


def test_id_rule_a_symlinked_sidecar_fails_closed(ws, state, tmp_path):
    _project(ws)
    real = tmp_path / "real.json"
    real.write_text(json.dumps({"v": 1, "projectId": PID, "fields": [], "files": [], "clashes": []}))
    (state / PID).mkdir()
    (state / PID / "clash-set.json").symlink_to(real)
    _refused(_put(ws, {"notes": []}, AI), ["notes"])


def test_id_rule_without_o_nofollow_a_symlinked_sidecar_still_fails_closed(ws, state, tmp_path, monkeypatch):
    monkeypatch.delattr(os, "O_NOFOLLOW", raising=False)
    _project(ws)
    real = tmp_path / "real.json"
    real.write_text(json.dumps({"v": 1, "projectId": PID, "fields": [], "files": [], "clashes": []}))
    (state / PID).mkdir()
    (state / PID / "clash-set.json").symlink_to(real)
    _refused(_put(ws, {"notes": []}, AI), ["notes"])


def test_id_rule_without_o_nofollow_a_regular_sidecar_still_reads(ws, state, monkeypatch):
    monkeypatch.delattr(os, "O_NOFOLLOW", raising=False)
    monkeypatch.delattr(os, "O_NONBLOCK", raising=False)
    _project(ws)
    _sidecar(state, fields=["tracks"])
    assert _put(ws, {"notes": []}, AI).status_code == 200
    _refused(_put(ws, {"tracks": []}, AI), ["tracks"])


def test_id_rule_the_state_dir_given_through_a_symlink_still_reads(ws, state, tmp_path, monkeypatch):
    link = tmp_path / "state-link"
    link.symlink_to(state, target_is_directory=True)
    monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", str(link))
    _project(ws)
    _sidecar(state, fields=["tracks"])
    assert _put(ws, {"notes": []}, AI).status_code == 200
    _refused(_put(ws, {"tracks": []}, AI), ["tracks"])


# ── crash windows (the app writes the record, then the sidecar) ───────────────


def test_crash_after_the_record_cleared_a_clash_the_stale_sidecar_still_refuses(ws, state):
    """record()/resolve clear conflicts.json first and the sidecar second: a crash between them leaves a sidecar
    that still lists the clash. serve reads only the sidecar, so the write stays refused until it is rewritten."""
    _project(ws)
    _sidecar(state, fields=["tracks"])
    (state / PID / "conflicts.json").write_text(json.dumps({"v": 1, "headVersionId": "h2", "clashes": []}))
    _refused(_put(ws, {"tracks": []}, AI), ["tracks"])


def test_crash_while_record_holds_the_union_both_sets_refuse(ws, state):
    """record() first writes the sidecar as the union of the old and new sets: a crash then leaves both refused."""
    _project(ws)
    _sidecar(state, fields=["tracks", "captions"], clashes=[
        {"id": "old", "fields": ["tracks"], "files": []},
        {"id": "new", "fields": ["captions"], "files": []}])
    _refused(_put(ws, {"tracks": []}, AI), ["tracks"])
    _refused(_put(ws, {"captions": {}}, AI), ["captions"])
    assert _put(ws, {"captions": {}}, RESOLVE("new")).status_code == 200
    assert _put(ws, {"tracks": []}, RESOLVE("old")).status_code == 200


def test_crash_a_temp_sidecar_left_by_a_crash_is_ignored(ws, state):
    _project(ws)
    (state / PID).mkdir()
    (state / PID / ".clash-set.json.0123456789ab.tmp").write_text("{torn")
    assert _put(ws, {"tracks": []}, AI).status_code == 200
    _sidecar(state, fields=["tracks"])
    _refused(_put(ws, {"tracks": []}, AI), ["tracks"])


def test_crash_a_torn_sidecar_written_in_place_fails_closed(ws, state):
    _project(ws)
    side = _sidecar(state, fields=["captions"])
    side.write_text(side.read_text()[:-5])
    _refused(_put(ws, {"notes": []}, AI), ["notes"])
    assert _put(ws, {"notes": []}, EDITOR, read=False).status_code == 200


# ── models and model3d ────────────────────────────────────────────────────────


def test_models_a_put_of_model3d_is_refused_on_its_clash(ws, state):
    _project(ws, model3d={"scenes": []})
    _sidecar(state, fields=["model3d"])
    _refused(_put(ws, {"model3d": {"scenes": [1]}}, AI), ["model3d"])
    assert _put(ws, {"notes": []}, AI).status_code == 200


@pytest.mark.parametrize("clash", ["models/robot/", "models/robot/rig.json", "models/"])
def test_models_a_file_write_into_a_clashed_model_folder_is_refused(ws, state, clash):
    d = _project(ws)
    (d / "models" / "robot").mkdir(parents=True)
    _sidecar(state, files=[clash])
    _refused(_write_file(d / "models" / "robot" / "rig.json"), [clash])


def test_models_another_model_folder_passes(ws, state):
    d = _project(ws)
    (d / "models" / "robot").mkdir(parents=True)
    (d / "models" / "cat").mkdir(parents=True)
    _sidecar(state, files=["models/robot/"])
    assert _write_file(d / "models" / "cat" / "rig.json").status_code == 200


def test_models_a_step_out_into_a_clashed_model_is_refused(ws, state, ran):
    d = _project(ws)
    (d / "models" / "robot").mkdir(parents=True)
    _sidecar(state, files=["models/robot/"])
    _refused(_step("generate_model", {"prompt": "x", "out": str(d / "models" / "robot" / "mesh.glb")}),
             ["models/robot/"])
    assert ran == []


def test_models_a_download_into_a_clashed_model_is_refused(ws, state, monkeypatch):
    monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")
    d = _project(ws)
    _sidecar(state, files=["models/robot/mesh.glb"])
    body = {"downloads": [{"url": "https://example.com/a.glb", "destPath": "models/robot/mesh.glb"}]}
    _refused(_client().post(f"/api/projects/{PID}/download", json=body, headers=AI), ["models/robot/mesh.glb"])


def test_models_deleting_a_folder_holding_a_clashed_file_is_refused(ws, state):
    d = _project(ws)
    (d / "models" / "robot").mkdir(parents=True)
    (d / "models" / "robot" / "rig.json").write_text("{}")
    _sidecar(state, files=["models/robot/rig.json"])
    _refused(_client().request("DELETE", f"/api/projects/{PID}/files", json={"paths": ["models/robot"]},
                               headers=DRIVE), ["models/robot/rig.json"])
    assert (d / "models" / "robot" / "rig.json").exists()
    resp = _client().request("DELETE", f"/api/projects/{PID}/files", json={"paths": ["models/robot"]}, headers=EDITOR)
    assert resp.status_code == 200


# ── the other project routes ──────────────────────────────────────────────────


def test_routes_captions_regeneration_is_refused_on_a_captions_clash(ws, state):
    _project(ws)
    _sidecar(state, fields=["captions"])
    _refused(_client().post(f"/api/projects/{PID}/captions", json={}, headers=AI), ["captions"])


def test_routes_probe_duration_is_refused_on_a_sources_clash(ws, state, monkeypatch, tmp_path):
    clip = tmp_path / "x.mp4"
    clip.write_bytes(b"x")
    item = {"id": "clip-0", "type": "video", "src": str(clip)}
    d = _project(ws, sources=[dict(item)])
    monkeypatch.setattr(projects_mod, "_probe_source_duration", lambda p: 3.0)
    _sidecar(state, fields=["sources"])
    before = _disk(d)
    _refused(_client().post(f"/api/projects/{PID}/sources/clip-0/probe-duration", headers=AI), ["sources"])
    assert _disk(d) == before


def test_routes_source_download_retry_is_refused_on_its_fields(ws, state, monkeypatch):
    started = []
    monkeypatch.setattr(projects_mod, "_start_source_download", lambda *a, **k: started.append(a) or None)
    _project(ws, sourceDownload={"kind": "youtube", "url": "https://youtu.be/dQw4w9WgXcQ", "status": "failed"})
    _sidecar(state, fields=["sourceDownload"])
    _refused(_client().post(f"/api/projects/{PID}/source-download/retry", headers=AI), ["sourceDownload"])
    assert started == []


def test_routes_provenance_record_is_refused_on_its_file(ws, state):
    d = _project(ws)
    (d / "assets").mkdir()
    (d / "assets" / "a.png").write_bytes(b"x")
    _sidecar(state, files=["assets/.provenance.json"])
    body = {"path": "assets/a.png", "entry": {"kind": "user", "via": "drop"}}
    _refused(_client().post(f"/api/projects/{PID}/provenance", json=body, headers=TOOL), ["assets/.provenance.json"])


def test_routes_normalize_beside_a_clashed_project_file_is_refused(ws, state):
    from lib.normalize import normalized_output_path
    d = _project(ws)
    (d / "clip.mp4").write_bytes(b"x")
    out = normalized_output_path(str(d / "clip.mp4"), "sdr_bt709", tonemapped=False, sdr_stretch=False)
    rel = os.path.relpath(out, d).replace(os.sep, "/")
    _sidecar(state, files=[rel])
    _refused(_client().post("/api/normalize", json={"input": str(d / "clip.mp4")}, headers=AI), [rel])


def test_routes_proxy_out_onto_a_clashed_file_is_refused(ws, state):
    d = _project(ws)
    (d / "clip.mp4").write_bytes(b"x")
    _sidecar(state, files=["proxy.mp4"])
    body = {"input": str(d / "clip.mp4"), "out": str(d / "proxy.mp4")}
    _refused(_client().post("/api/proxy", json=body, headers=AI), ["proxy.mp4"])


# ── lib.sync_clash unit rules ─────────────────────────────────────────────────


def test_unit_touched_matches_folders_both_ways_and_star():
    sc = _sc()
    cs = sc.ClashSet(fields=frozenset({"tracks"}), files={sc.file_key("models/robot/"): "models/robot/",
                                                         sc.file_key("a/b.txt"): "a/b.txt"},
                     ids=frozenset({"c1"}))
    assert sc.touched(cs, files=["models/robot/x.glb"]) == ["models/robot/"]
    assert sc.touched(cs, files=["a/"]) == ["a/b.txt"]
    assert sc.touched(cs, files=["a/c.txt"]) == []
    assert sc.touched(cs, fields=["notes"]) == []
    assert sc.touched(cs, everything=True) == ["tracks", "a/b.txt", "models/robot/"]
    assert sc.touched(sc.ClashSet(fields=frozenset({"*"})), fields=["notes"]) == ["notes"]


def test_unit_message_is_the_wrappers_text():
    assert _sc().refusal(["tracks", "overlays/a.jsx"]) == {
        "error": "sync_conflict", "fields": ["tracks", "overlays/a.jsx"],
        "message": _message(["tracks", "overlays/a.jsx"])}


def test_unit_no_env_var_load_is_never_reached_by_check_sync(ws, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("read a sidecar with the var unset")

    monkeypatch.setattr(_sc(), "load", boom)
    save_guard.check_sync(AI, PID, fields=["tracks"])


# ══ review 40 (sg-review-40.md): the fixes ═══════════════════════════════════
#
# 1   a save is checked on every field it really changes on disk (after the merge and normalize_tracks), not only on
#     the body's keys, and a value that changes type counts as changed.
# 3a  a state folder that does not exist records no clash: a project never synced writes as with sync off. A state
#     folder that exists but cannot be read, a dangling link, or a project's own unreadable folder still fail closed.
# 3b  with no launch secret a resolve is refused `untrusted` (403), sidecar sure or not, so the app can say "restart".
# 4   a resolve writes only the fields and files of ITS clash id; a field it changes unnamed may not be another
#     clash's.
# lows: /files and delete_files check under the project lock; a download is checked again as it lands; speech_text
#     and glass_plate check their files again under the lock; the default outputs of sample_frame and export_editor
#     are guarded; Windows spellings of a relpath (a trailing dot or space, a `::$DATA` stream) match.

ROOT = Path(__file__).resolve().parent.parent
LEGACY_TRACKS = [[{"id": "clip-0", "type": "video", "src": "/x.mp4", "start": 0, "end": 1}]]
UNTRUSTED_MESSAGE = "Montaj could not confirm this resolve, so nothing was saved. Restart Montaj and try again."


def _untrusted(resp, names):
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == {"error": "untrusted", "fields": list(names), "message": UNTRUSTED_MESSAGE}


def _tracks(d):
    return json.loads(_disk(d))["tracks"]


# ── 1: the fields a save really changes ───────────────────────────────────────


@pytest.mark.parametrize("headers", [AI, TRUSTED_AI, TOOL, APP, DRIVE], ids=["ai", "trusted-ai", "tool", "tool-app",
                                                                          "drive"])
@pytest.mark.parametrize("body", [{"name": "second"}, {"notes": []}, {"status": "final"}],
                         ids=["name", "notes", "status"])
def test_r1_a_save_that_normalises_a_clashed_tracks_it_did_not_name_is_refused(ws, state, recorder, headers, body):
    """A1b/A1c: legacy tracks in clash, and a save of another field with valid reads. normalize_tracks would rewrite
    tracks, so the save is refused naming tracks, and nothing is written or published."""
    d = _legacy(ws)
    _sidecar(state, fields=["tracks"])
    before = _disk(d)
    _refused(_put(ws, body, headers, read=headers is not DRIVE), ["tracks"])
    assert _disk(d) == before
    assert recorder.published == []


def test_r1_a_legacy_save_with_tracks_unclashed_still_normalises(ws, state):
    d = _legacy(ws)
    _sidecar(state, fields=["settings"])
    assert _put(ws, {"name": "second"}, AI).status_code == 200
    assert isinstance(_tracks(d)[0], dict)


@pytest.mark.parametrize("headers", [EDITOR, SYNC], ids=["editor", "sync"])
def test_r1_the_window_and_the_pull_still_normalise_a_clashed_tracks(ws, state, headers):
    d = _legacy(ws)
    _sidecar(state, fields=["tracks"])
    assert _put(ws, {"name": "second"}, headers, read=headers is not EDITOR).status_code == 200
    assert isinstance(_tracks(d)[0], dict)


def test_r1_a_resolve_whose_save_normalises_another_clashs_field_is_refused(ws, state):
    d = _legacy(ws)
    _sidecar(state, fields=["name", "tracks"], clashes=[{"id": "c1", "fields": ["name"], "files": []},
                                                        {"id": "c2", "fields": ["tracks"], "files": []}])
    before = _disk(d)
    _refused(_put(ws, {"name": "second"}, RESOLVE("c1")), ["tracks"])
    assert _disk(d) == before


def test_r1_a_resolve_may_normalise_a_field_no_clash_names(ws, state):
    d = _legacy(ws)
    _sidecar(state, fields=["name"])
    resp = _put(ws, {"name": "second"}, RESOLVE("c1"))
    assert resp.status_code == 200, resp.text
    assert json.loads(_disk(d))["name"] == "second" and isinstance(_tracks(d)[0], dict)


def test_r1_changed_fields_counts_a_value_that_changes_type():
    """True == 1 == 1.0 in Python, never on disk: a write of 1 over true changes the field."""
    sc = _sc()
    before = {"a": True, "b": 1, "c": {"x": 1, "y": [1, "s"]}, "d": None}
    after = {"a": 1, "b": 1.0, "c": {"y": [1, "s"], "x": 1}, "d": None}
    assert sc.changed_fields(before, after) == ["a", "b"]
    assert sc.changed_fields({"a": [True]}, {"a": [1]}) == ["a"]


def test_r1_pin_a_step_that_normalises_a_clashed_tracks_it_did_not_mean_to_change_is_refused(tmp_path, state):
    from lib.project_lock import update_project
    d = tmp_path / "lib-proj"
    d.mkdir()
    write_json_atomic(d / "project.json", {"id": PID, "tracks": LEGACY_TRACKS, "notes": []})
    _sidecar(state, fields=["tracks"])
    before = (d / "project.json").read_bytes()
    with pytest.raises(_sc().SyncConflict) as e:
        update_project(d / "project.json", lambda p: {**normalize_tracks(p), "notes": [{"id": "n2"}]})
    assert e.value.body["fields"] == ["tracks"]
    assert (d / "project.json").read_bytes() == before


def test_r1_pin_translation_leaves_a_clashed_legacy_tracks_as_it_is(ws, state):
    d = _project(ws, tracks=LEGACY_TRACKS, captions={"segments": []})
    _sidecar(state, fields=["tracks"])
    read = {"x-montaj-read-revisions": json.dumps(revisions_of(normalize_tracks(json.loads(_disk(d))), ["captions"]))}
    resp = _client().post(f"/api/projects/{PID}/captions/translation", json={"show": ["source"]},
                          headers={**TOOL, **read})
    assert "sync_conflict" not in resp.text, resp.text
    assert _tracks(d) == LEGACY_TRACKS


def test_r1_pin_include_asset_leaves_a_clashed_legacy_tracks_as_it_is(ws, state, tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".montaj" / "profiles" / "brand" / "assets").mkdir(parents=True)
    (home / ".montaj" / "profiles" / "brand" / "assets" / "logo.png").write_bytes(b"png")
    monkeypatch.setenv("HOME", str(home))
    d = _project(ws, profile="brand", assets=[], tracks=LEGACY_TRACKS)
    _sidecar(state, fields=["tracks"])
    resp = _client().post(f"/api/projects/{PID}/assets", json={"from": {"profile": "brand", "filename": "logo.png"}},
                          headers=DRIVE)
    assert resp.status_code == 200, resp.text
    assert _tracks(d) == LEGACY_TRACKS


# ── 3a: a state folder that does not exist ────────────────────────────────────


@pytest.fixture
def no_state_dir(ws, tmp_path, monkeypatch):
    """MONTAJ_SYNC_STATE_DIR names a folder the app never made: nothing at that name at all."""
    missing = tmp_path / "runtime" / "studio-sync"
    monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", str(missing))
    return missing


@pytest.mark.parametrize("headers", [AI, TRUSTED_AI, TOOL, APP, DRIVE], ids=["ai", "trusted-ai", "tool", "tool-app",
                                                                          "drive"])
def test_r3a_a_missing_state_folder_is_no_clash_for_a_project_never_synced(ws, no_state_dir, headers):
    d = _project(ws)
    resp = _put(ws, {"notes": [], "tracks": [{"id": "trk-9", "items": []}]}, headers, read=headers is not DRIVE)
    assert resp.status_code == 200, resp.text
    assert _tracks(d)[0]["id"] == "trk-9"
    assert not no_state_dir.exists()


def test_r3a_a_missing_state_folder_lets_the_heals_and_the_steps_write(ws, no_state_dir, tmp_path):
    from lib.project_lock import update_project
    d = _legacy(ws)
    assert _client().get(f"/api/projects/{PID}", headers=AI).status_code == 200
    assert isinstance(_tracks(d)[0], dict)
    path = _lib_project(tmp_path)
    update_project(path, lambda p: {**p, "tracks": [{"id": "trk-1", "items": []}]})
    assert json.loads(path.read_text())["tracks"][0]["id"] == "trk-1"
    assert not no_state_dir.exists()


def test_r3a_pin_a_state_folder_that_is_a_dangling_link_fails_closed(ws, tmp_path, monkeypatch):
    link = tmp_path / "studio-sync"
    link.symlink_to(tmp_path / "nowhere", target_is_directory=True)
    monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", str(link))
    _project(ws)
    _refused(_put(ws, {"notes": []}, AI), ["notes"])


def test_r3a_pin_a_state_folder_under_a_file_fails_closed(ws, tmp_path, monkeypatch):
    (tmp_path / "a-file").write_text("x")
    monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", str(tmp_path / "a-file" / "studio-sync"))
    _project(ws)
    _refused(_put(ws, {"notes": []}, AI), ["notes"])


def _unreadable_dirs_apply():
    return not (os.name == "nt" or (hasattr(os, "geteuid") and os.geteuid() == 0))


@pytest.mark.skipif(not _unreadable_dirs_apply(), reason="a mode-0 folder is readable here")
def test_r3a_pin_an_unreadable_state_folder_fails_closed_for_every_project(ws, state):
    _project(ws)
    _project(ws, pid="never-synced")
    state.chmod(0)
    try:
        _refused(_put(ws, {"notes": []}, AI), ["notes"])
        _refused(_put(ws, {"notes": []}, AI, pid="never-synced"), ["notes"])
        assert _put(ws, {"notes": []}, EDITOR, read=False).status_code == 200
    finally:
        state.chmod(0o755)


@pytest.mark.skipif(not _unreadable_dirs_apply(), reason="a mode-0 folder is readable here")
def test_r3a_pin_a_project_whose_own_state_folder_is_unreadable_fails_closed(ws, state):
    _project(ws)
    _project(ws, pid="never-synced")
    (state / PID).mkdir()
    (state / PID).chmod(0)
    try:
        _refused(_put(ws, {"notes": []}, AI), ["notes"])
        assert _put(ws, {"notes": []}, AI, pid="never-synced").status_code == 200
    finally:
        (state / PID).chmod(0o755)


# ── 3b: a resolve when the launch secret never arrived ────────────────────────


def _no_secret(monkeypatch):
    """The guard asked for, the launch secret never received: serve trusts no request."""
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    monkeypatch.delenv("MONTAJ_SHELL_SECRET_STDIN", raising=False)
    save_guard._state.update({"secret": None, "stdin_done": True, "logged": False, "secret_logged": True})
    save_guard.startup()
    assert save_guard._state["secret"] is None


def test_r3b_without_the_launch_secret_a_resolve_is_untrusted_on_a_sure_sidecar(ws, state, monkeypatch):
    _no_secret(monkeypatch)
    d = _project(ws)
    _sidecar(state, fields=["tracks"])
    before = _disk(d)
    _untrusted(_put(ws, {"tracks": []}, RESOLVE("c1"), read=False), ["tracks"])
    assert _disk(d) == before


@pytest.mark.parametrize("corrupt", ["state-dir-is-a-file", "not-json", "other-project"], indirect=True)
def test_r3b_without_the_launch_secret_a_resolve_is_untrusted_on_an_unsure_sidecar(ws, corrupt, monkeypatch):
    _no_secret(monkeypatch)
    d = _project(ws)
    before = _disk(d)
    _untrusted(_put(ws, {"notes": []}, RESOLVE("c1"), read=False), ["notes"])
    assert _disk(d) == before


def test_r3b_without_the_launch_secret_every_other_write_keeps_the_binding_refusal(ws, state, monkeypatch):
    _no_secret(monkeypatch)
    _project(ws)
    _sidecar(state, fields=["tracks"])
    for headers in (AI, EDITOR, SYNC, TOOL, {**EDITOR, "x-montaj-write-origin": "resolve"}):
        _refused(_put(ws, {"tracks": []}, headers, read=False), ["tracks"])


def test_r3b_without_the_launch_secret_a_resolve_of_nothing_clashed_saves(ws, state, monkeypatch):
    _no_secret(monkeypatch)
    d = _project(ws)
    _sidecar(state, fields=["tracks"])
    assert _put(ws, {"notes": []}, RESOLVE("c1"), read=False).status_code == 200
    assert json.loads(_disk(d)).get("notes") in ([], None)


def test_r3b_pin_with_the_secret_a_resolve_without_it_is_still_the_binding_refusal(ws, state):
    _project(ws)
    _sidecar(state, fields=["tracks"])
    headers = {k: v for k, v in RESOLVE("c1").items() if k != "x-montaj-shell"}
    _refused(_put(ws, {"tracks": []}, headers, read=False), ["tracks"])


# ── 4: a resolve writes only its own clash ────────────────────────────────────


def test_r4_a_resolve_writes_only_its_own_clashs_fields(ws, state):
    d = _project(ws, captions={"segments": []})
    _sidecar(state, fields=["tracks", "captions"], clashes=[{"id": "c1", "fields": ["tracks"], "files": []},
                                                           {"id": "c2", "fields": ["captions"], "files": []}])
    before = _disk(d)
    _refused(_put(ws, {"tracks": [], "captions": {"segments": [1]}}, RESOLVE("c1")), ["captions"])
    _refused(_put(ws, {"tracks": [], "name": "renamed"}, RESOLVE("c1")), ["name"])
    _refused(_put(ws, {"notes": []}, RESOLVE("c2")), ["notes"])
    assert _disk(d) == before
    assert _put(ws, {"tracks": [{"id": "trk-9", "items": []}]}, RESOLVE("c1")).status_code == 200
    assert _put(ws, {"captions": {"segments": []}}, RESOLVE("c2")).status_code == 200


def test_r4_a_resolve_writes_only_its_own_clashs_files(ws, state):
    d = _project(ws)
    (d / "overlays").mkdir()
    (d / "models" / "robot").mkdir(parents=True)
    _sidecar(state, files=["overlays/a.jsx", "models/robot/"], clashes=[
        {"id": "c1", "fields": [], "files": ["overlays/a.jsx"]},
        {"id": "c2", "fields": [], "files": ["models/robot/"]}])
    _refused(_write_file(d / "overlays" / "b.jsx", RESOLVE("c1")), ["overlays/b.jsx"])
    _refused(_write_file(d / "models" / "robot" / "rig.json", RESOLVE("c1")), ["models/robot/rig.json"])
    _refused(_write_file(d / "overlays" / "a.jsx", RESOLVE("c2")), ["overlays/a.jsx"])
    assert not (d / "overlays" / "b.jsx").exists() and not (d / "models" / "robot" / "rig.json").exists()
    assert _write_file(d / "overlays" / "a.jsx", RESOLVE("c1")).status_code == 200
    assert _write_file(d / "models" / "robot" / "rig.json", RESOLVE("c2")).status_code == 200


def test_r4_a_resolve_of_a_whole_project_write_is_refused(ws, state):
    _sidecar(state, fields=["tracks"])
    assert save_guard.sync_refusal(PID, RESOLVE("c1"), everything=True) == _sc().refusal(["*"])


def test_r4_pin_a_resolve_on_an_unsure_set_still_passes(ws, state):
    _project(ws)
    (state / PID).mkdir()
    (state / PID / "clash-set.json").write_text("{not json")
    assert _put(ws, {"notes": [], "name": "x"}, RESOLVE("c1")).status_code == 200


# ── lows: the time-of-check gaps ──────────────────────────────────────────────


@pytest.fixture
def short_lock(monkeypatch):
    import lib.project_lock as lock_mod
    monkeypatch.setattr(lock_mod, "DEFAULT_TIMEOUT", 0.3)


def test_low_a_files_write_checks_and_writes_under_the_project_lock(ws, state, short_lock):
    d = _project(ws)
    (d / "overlays").mkdir()
    _sidecar(state, files=["overlays/elsewhere.jsx"])
    with project_lock(d / "project.json"):
        resp = _write_file(d / "overlays" / "title.jsx")
    assert resp.status_code == 503, resp.text
    assert not (d / "overlays" / "title.jsx").exists()
    assert _write_file(d / "overlays" / "title.jsx").status_code == 200


def test_low_delete_files_checks_and_deletes_under_the_project_lock(ws, state, short_lock):
    d = _project(ws)
    (d / "overlays").mkdir()
    (d / "overlays" / "title.jsx").write_text("x")
    _sidecar(state, files=["overlays/elsewhere.jsx"])
    with project_lock(d / "project.json"):
        resp = _client().request("DELETE", f"/api/projects/{PID}/files", json={"paths": ["overlays/title.jsx"]},
                                 headers=DRIVE)
    assert resp.status_code == 503, resp.text
    assert (d / "overlays" / "title.jsx").exists()


@pytest.mark.parametrize("headers", [EDITOR, SYNC], ids=["editor", "sync"])
def test_low_the_window_and_the_pull_take_no_lock_for_files_and_delete(ws, state, short_lock, headers):
    d = _project(ws)
    (d / "overlays").mkdir()
    (d / "overlays" / "old.jsx").write_text("x")
    _sidecar(state, files=["overlays/elsewhere.jsx"])
    with project_lock(d / "project.json"):
        assert _write_file(d / "overlays" / "title.jsx", headers).status_code == 200
        # (delete_files is the window's alone with the guard on: the pull's tool writer is 403 there.)
        resp = _client().request("DELETE", f"/api/projects/{PID}/files", json={"paths": ["overlays/old.jsx"]},
                                 headers=EDITOR)
        assert resp.status_code == 200, resp.text


def _mock_download(monkeypatch, handler):
    import httpx
    import lib.remote_io as rio
    real = rio._make_async_client
    monkeypatch.setattr(rio, "_make_async_client", lambda transport=None: real(httpx.MockTransport(handler)))
    monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_low_a_download_is_checked_again_as_it_lands(ws, state, monkeypatch, is_async):
    """A clash recorded while the file downloads: the landing is refused for that file, which is never created."""
    import httpx
    d = _project(ws)
    data = b"\x89PNG-bytes"

    def handler(request):
        _sidecar(state, files=["models/robot/mesh.png"])   # recorded while it downloads
        return httpx.Response(200, content=data, headers={"content-type": "image/png"})

    _mock_download(monkeypatch, handler)
    body = {"downloads": [{"url": "https://example.com/a.png", "destPath": "models/robot/mesh.png",
                           "contentType": "image/png", "sizeBytes": len(data)}], "_async": is_async}
    resp = _client().post(f"/api/projects/{PID}/download", json=body, headers=AI)
    if is_async:
        assert resp.status_code == 202, resp.text
        job = _client().get(f"/api/projects/{PID}/download/jobs/{resp.json()['job_id']}").json()
        results = job["result"]["results"] if "result" in job else job["results"]
    else:
        assert resp.status_code == 207, resp.text
        results = resp.json()["results"]
    assert results[0]["status"] == "error" and results[0]["error"] == "sync_conflict", results
    assert results[0]["fields"] == ["models/robot/mesh.png"]
    folder = d / "models" / "robot"
    assert not (folder / "mesh.png").exists()
    assert [p.name for p in folder.iterdir()] == [] if folder.is_dir() else True


def test_low_a_download_by_the_window_lands_after_a_clash_is_recorded(ws, state, monkeypatch):
    import httpx
    d = _project(ws)
    data = b"\x89PNG-bytes"

    def handler(request):
        _sidecar(state, files=["models/robot/mesh.png"])
        return httpx.Response(200, content=data, headers={"content-type": "image/png"})

    _mock_download(monkeypatch, handler)
    body = {"downloads": [{"url": "https://example.com/a.png", "destPath": "models/robot/mesh.png",
                           "contentType": "image/png", "sizeBytes": len(data)}]}
    resp = _client().post(f"/api/projects/{PID}/download", json=body, headers=EDITOR)
    assert resp.status_code == 200, resp.text
    assert (d / "models" / "robot" / "mesh.png").read_bytes() == data


def _run_speech_text(pj, state, origin):
    env = {**os.environ, "MONTAJ_SYNC_STATE_DIR": str(state), "MONTAJ_WRITE_ORIGIN": origin}
    return subprocess.run([sys.executable, str(ROOT / "steps" / "speech" / "speech_text.py"), "--project", str(pj)],
                          capture_output=True, text=True, env=env, cwd=str(ROOT))


def test_low_speech_text_checks_its_file_again_under_the_lock(tmp_path, state):
    pj, pid, _edited = _speech_env(tmp_path)
    _sidecar(state, pid=pid, files=["speech-text.md"])
    out = _run_speech_text(pj, state, "ai")
    assert out.returncode == 1, out.stdout + out.stderr
    assert json.loads(out.stderr.strip().splitlines()[-1]) == _sc().refusal(["speech-text.md"])
    assert not (pj.parent / "speech-text.md").exists()
    out = _run_speech_text(pj, state, "human")
    assert out.returncode == 0, out.stderr
    assert (pj.parent / "speech-text.md").exists()


def _glass_plate_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("glass_plate_step_r40", ROOT / "steps" / "render" / "glass_plate.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_low_glass_plate_checks_its_frames_folder_again_under_the_lock(tmp_path, state, monkeypatch, capsys):
    gp = _glass_plate_module()
    d = tmp_path / "gp"
    d.mkdir()
    write_json_atomic(d / "project.json", {"id": PID, "settings": {}, "tracks": [
        {"id": "trk-0", "items": [{"id": "ov", "type": "overlay", "start": 0, "end": 1}]}]})

    def fake_run(cmd, **kwargs):
        stage = cmd[cmd.index("--out-dir") + 1]
        frame = os.path.join(stage, "0000.jpg")
        with open(frame, "wb") as f:
            f.write(b"jpg")
        _sidecar(state, files=["plates/ov/"])   # recorded while the plate rendered
        out = json.dumps({"frames": [frame], "fps": 30, "size": [2, 2]}).encode()
        return subprocess.CompletedProcess(cmd, 0, out, b"")

    monkeypatch.setattr(gp.subprocess, "run", fake_run)
    monkeypatch.setenv("MONTAJ_WRITE_ORIGIN", "ai")
    monkeypatch.setattr(sys, "argv", ["glass_plate", "--project", str(d / "project.json"), "--item", "ov"])
    with pytest.raises(SystemExit) as e:
        gp.main()
    assert e.value.code == 1
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1]) == _sc().refusal(["plates/ov/"])
    assert not (d / "plates" / "ov" / "0000.jpg").exists()


# ── lows: the default outputs inside the project ─────────────────────────────


def test_low_sample_frame_with_no_out_is_guarded_on_its_default_folder(ws, state, ran):
    _project(ws)
    _sidecar(state, files=["render/samples/frame-1.000s.png"])
    _refused(_step("sample_frame", {"project": PID, "at": 1.0}), ["render/samples/frame-1.000s.png"])
    assert ran == []


def test_low_export_editor_with_no_out_is_guarded_on_its_default_folder(ws, state, ran):
    _project(ws)
    _sidecar(state, files=["export/"])
    _refused(_step("export_editor", {"project": PID}), ["export/"])
    assert ran == []


def test_low_default_outputs_run_beside_other_clashes_and_with_an_out_elsewhere(ws, state, ran, tmp_path):
    d = _project(ws)
    _sidecar(state, fields=["tracks"], files=["overlays/a.jsx", "export/"])
    assert _step("sample_frame", {"project": PID, "at": 1.0}).status_code == 200
    (d / "elsewhere").mkdir()
    resp = _step("export_editor", {"project": PID, "out": str(d / "elsewhere")})
    assert resp.status_code == 200, resp.text
    assert len(ran) == 2


# ── lows: Windows spellings of a relpath ──────────────────────────────────────


@pytest.mark.parametrize("spelling", ["assets/new.png.", "assets/new.png ", "assets/new.png. .", "assets./new.png",
                                      "assets /new.png", "Assets/NEW.png", "assets/new.png::$DATA",
                                      "assets\\new.png."])
def test_low_windows_spellings_of_a_relpath_compare_equal(spelling):
    sc = _sc()
    assert sc.file_key(spelling) == sc.file_key("assets/new.png")


def test_low_windows_folder_spellings_keep_their_folder_mark():
    sc = _sc()
    assert sc.file_key("models/robot./") == sc.file_key("models/robot/") == "models/robot/"
    assert sc.file_key("..") == ".." and sc.file_key("a/../b") == "a/../b"


def test_low_a_trailing_dot_cannot_create_a_clashed_file_that_does_not_exist_yet(ws, state):
    d = _project(ws)
    (d / "assets").mkdir()
    _sidecar(state, files=["assets/new.png"])
    _refused(_write_file(d / "assets" / "new.png."), ["assets/new.png"])
    _refused(_write_file(d / "assets" / "new.png "), ["assets/new.png"])
    assert sorted(p.name for p in (d / "assets").iterdir()) == []
    _sidecar(state, files=["assets/other.png."])
    _refused(_write_file(d / "assets" / "other.png"), ["assets/other.png."])


# ── dark parity for all of the above ──────────────────────────────────────────


@pytest.mark.parametrize("headers", [AI, TOOL, EDITOR, SYNC, RESOLVE("c1")], ids=["ai", "tool", "editor", "sync",
                                                                               "resolve"])
def test_dark_r40_a_legacy_save_is_byte_identical_with_the_var_unset_and_with_no_sidecar(
        ws, tmp_path, monkeypatch, recorder, headers):
    body = {"name": "second", "notes": []}
    runs = []
    for var in (None, str(tmp_path / "studio-sync")):
        if var is None:
            monkeypatch.delenv("MONTAJ_SYNC_STATE_DIR", raising=False)
        else:
            Path(var).mkdir(exist_ok=True)
            monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", var)
        d = _legacy(ws)
        recorder.published.clear()
        resp = _put(ws, body, headers, read=headers is not EDITOR)
        runs.append((_answer(resp), list(recorder.published), _disk(d)))
    assert runs[0] == runs[1]
    assert runs[0][0][0] == 200


def test_dark_r40_with_the_var_unset_nothing_new_is_read_compared_or_locked(ws, tmp_path, monkeypatch, short_lock):
    d = _legacy(ws)
    (d / "overlays").mkdir()
    (d / "overlays" / "old.jsx").write_text("x")
    unnamed = tmp_path / "studio-sync"
    unnamed.mkdir()
    _sidecar(unnamed, fields=["tracks", "name"], files=["overlays/a.jsx", "overlays/old.jsx"])
    compared = []
    monkeypatch.setattr(_sc(), "changed_fields", lambda *a, **k: compared.append(a) or [])
    spy = _Spy(monkeypatch)
    with project_lock(d / "project.json"):
        assert _write_file(d / "overlays" / "a.jsx", DRIVE).status_code == 200
        resp = _client().request("DELETE", f"/api/projects/{PID}/files", json={"paths": ["overlays/old.jsx"]},
                                 headers=DRIVE)
        assert resp.status_code == 200, resp.text
    assert _put(ws, {"name": "second"}, AI).status_code == 200
    assert _put(ws, {"name": "third"}, RESOLVE("c9")).status_code == 200
    assert isinstance(_tracks(d)[0], dict)
    assert compared == []
    assert spy.touched("studio-sync") == [] and spy.touched("clash-set") == []


# ── 1, the audit: include-asset lands a file too ──────────────────────────────


@pytest.fixture
def brand_logo(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".montaj" / "profiles" / "brand" / "assets").mkdir(parents=True)
    (home / ".montaj" / "profiles" / "brand" / "assets" / "logo.png").write_bytes(b"png")
    monkeypatch.setenv("HOME", str(home))
    return {"from": {"profile": "brand", "filename": "logo.png"}}


def test_r1_audit_include_asset_is_checked_on_the_file_it_lands(ws, state, brand_logo):
    """A clashed file that does not exist here yet (theirs only) could be created by an asset include."""
    d = _project(ws, profile="brand", assets=[])
    _sidecar(state, files=["logo.png"])
    before = _disk(d)
    _refused(_client().post(f"/api/projects/{PID}/assets", json=brand_logo, headers=DRIVE), ["logo.png"])
    assert not (d / "logo.png").exists() and _disk(d) == before
    assert _client().post(f"/api/projects/{PID}/assets", json=brand_logo, headers=EDITOR).status_code == 200


def test_r1_audit_include_asset_is_checked_on_the_name_it_really_lands_on(ws, state, brand_logo, monkeypatch):
    d = _project(ws, profile="brand", assets=[])
    (d / "logo.png").write_bytes(b"mine")
    _sidecar(state, files=["logo_asset2.png"])
    before = _disk(d)
    _refused(_client().post(f"/api/projects/{PID}/assets", json=brand_logo, headers=DRIVE), ["logo_asset2.png"])
    assert sorted(p.name for p in d.iterdir() if not p.name.startswith(".")) == ["logo.png", "project.json"]
    assert _disk(d) == before


# ── nulls: a trusted sync pull deletes the top-level fields it sends as null ──
#
# The pull writes the merged head, and a field the head no longer has is sent as null. Only a trusted `tool` PUT with
# x-montaj-write-origin: sync (the launch secret, the same trust as G-2) drops each top-level key it sends as null,
# exactly as serve already drops `markers` and `notes` for everyone. Every other request stores the null as before.

_REAL_DIMS = projects_mod.ensure_source_dims
_REAL_PREVIEWS = projects_mod._queue_previews_for_changed_items

NULLED = ("captions", "audio", "voiceover", "storyboard")


def _with_fields(ws, **more):
    return _project(ws, captions={"segments": [{"id": "s1", "text": "hi", "start": 0, "end": 1}]},
                    audio={"tracks": []}, voiceover={"src": "/vo.mp3"}, storyboard={"beats": []}, **more)


def _frame_docs(recorder, pid=PID):
    """The project document of every default (unnamed) data frame published for pid, in order."""
    docs = []
    for project_id, data in recorder.published:
        if project_id != pid:
            continue
        for block in data.split("\n\n"):
            lines = [line for line in block.split("\n") if line]
            if lines and not any(line.startswith("event:") for line in lines):
                docs.append(json.loads("\n".join(line[len("data: "):] for line in lines)))
    return docs


@pytest.mark.parametrize("sync_on", [False, True], ids=["sync-off", "sync-on"])
def test_nulls_a_trusted_sync_pull_drops_every_top_level_key_it_sends_as_null(ws, tmp_path, monkeypatch, recorder,
                                                                              sync_on):
    if sync_on:
        (tmp_path / "studio-sync").mkdir()
        monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", str(tmp_path / "studio-sync"))
        _sidecar(tmp_path / "studio-sync", fields=["tracks"])
    d = _with_fields(ws, markers=[{"id": "m1", "time": 1}])
    resp = _put(ws, {**{k: None for k in NULLED}, "markers": None, "name": "pulled"}, SYNC)
    assert resp.status_code == 200, resp.text
    disk = json.loads(_disk(d))
    for key in (*NULLED, "markers"):
        assert key not in disk, key
        assert key not in resp.json(), key           # (e) the answer has it really absent, not null
        assert key not in _frame_docs(recorder)[-1], key
    assert disk["name"] == "pulled" and disk["notes"] == [{"id": "n1", "text": "a"}]


def test_nulls_a_trusted_sync_pull_drops_nulls_with_the_guard_switch_off(ws, monkeypatch, recorder):
    """The trust is the launch secret, as for the sync check (case 5): the revision guard stepping aside changes
    nothing here."""
    _start(monkeypatch, guard=False)
    d = _with_fields(ws)
    resp = _put(ws, {"voiceover": None}, SYNC, read=False)
    assert resp.status_code == 200, resp.text
    assert "voiceover" not in json.loads(_disk(d)) and "voiceover" not in resp.json()


UNTRUSTED_OR_OTHER = [
    {"x-montaj-writer": "tool", "x-montaj-write-origin": "sync"},
    {"x-montaj-shell": "a1" * 32, "x-montaj-writer": "tool", "x-montaj-write-origin": "sync"},
    AI,
    TRUSTED_AI,
    {**TRUSTED_AI, "x-montaj-write-origin": "sync"},
    EDITOR,
    {**EDITOR, "x-montaj-write-origin": "sync"},
    TOOL,
    APP,
    RESOLVE("c1"),
]
UNTRUSTED_OR_OTHER_IDS = ["sync-no-secret", "sync-wrong-secret", "ai", "trusted-ai", "ai-naming-sync", "editor",
                          "editor-naming-sync", "tool", "tool-app", "resolve"]


@pytest.mark.parametrize("headers", UNTRUSTED_OR_OTHER, ids=UNTRUSTED_OR_OTHER_IDS)
def test_nulls_every_other_request_stores_the_null_exactly_as_before(ws, recorder, headers):
    d = _with_fields(ws, markers=[{"id": "m1", "time": 1}])
    resp = _put(ws, {"captions": None, "voiceover": None, "markers": None}, headers,
                read=headers.get("x-montaj-writer") != "editor")
    assert resp.status_code == 200, resp.text
    disk = json.loads(_disk(d))
    assert "captions" in disk and disk["captions"] is None
    assert "voiceover" in disk and disk["voiceover"] is None
    assert "markers" not in disk                       # markers and notes: dropped for everyone, as before
    assert resp.json()["captions"] is None and resp.json()["voiceover"] is None
    frame = _frame_docs(recorder)[-1]
    assert frame["captions"] is None and frame["voiceover"] is None


def test_nulls_top_level_only_a_nested_null_is_stored(ws, recorder):
    d = _with_fields(ws, settings={"resolution": [1080, 1920], "fps": 30})
    body = {"settings": {"resolution": [1080, 1920], "fps": None}, "captions": {"segments": None},
            "audio": {"tracks": [None]}}
    resp = _put(ws, body, SYNC)
    assert resp.status_code == 200, resp.text
    disk = json.loads(_disk(d))
    assert "fps" in disk["settings"] and disk["settings"]["fps"] is None
    assert disk["captions"] == {"segments": None} and disk["audio"] == {"tracks": [None]}
    assert resp.json()["captions"] == {"segments": None}


@pytest.mark.parametrize("gone", [["tracks"], ["status"], ["settings"], ["sources"],
                                  ["tracks", "status", "settings", "sources", "name", *NULLED]],
                         ids=["tracks", "status", "settings", "sources", "all"])
def test_nulls_a_pull_deleting_a_field_serve_reads_crashes_nothing(ws, monkeypatch, recorder, gone):
    """(c) Through the save's own readers (normalize_tracks, the overlay check, the media plan, the previews and
    dims follow-ups, check_save), the SSE frame, the open-time heals of GET, the project list, and the next guarded
    write, which reads the field as absent."""
    monkeypatch.setattr(projects_mod, "ensure_source_dims", _REAL_DIMS)
    monkeypatch.setattr(projects_mod, "_queue_previews_for_changed_items", _REAL_PREVIEWS)
    d = _with_fields(ws, settings={"resolution": [1080, 1920], "fps": 30})
    resp = _put(ws, {k: None for k in gone}, SYNC)
    assert resp.status_code == 200, resp.text
    disk = json.loads(_disk(d))
    assert not set(gone) & set(disk) and not set(gone) & set(resp.json())
    assert normalize_tracks(disk) is disk
    assert not set(gone) & set(_frame_docs(recorder)[-1])
    for headers in (EDITOR, AI):
        got = _client().get(f"/api/projects/{PID}", headers=headers)
        assert got.status_code == 200, got.text
        assert not set(gone) & set(got.json())
    listed = _client().get("/api/projects")
    assert listed.status_code == 200, listed.text
    again = _put(ws, {"tracks": [{"id": "trk-0", "items": []}], "status": "draft", "name": "back"}, AI)
    assert again.status_code == 200, again.text
    assert json.loads(_disk(d))["status"] == "draft"


def test_nulls_a_pull_deleting_a_clash_free_field_reads_removed_with_a_concurrent_editor_save(ws, state, recorder):
    """(d) The pull deletes voiceover (clash-free; captions is in clash) while the open window still holds the
    document from before it. Serve sees voiceover removed everywhere, never as a null that differs from absent."""
    d = _with_fields(ws)
    _sidecar(state, fields=["captions"])
    pre = json.loads(_disk(d))
    seen = revisions_of(normalize_tracks(pre), list(pre))          # what the open window read
    absent = revisions_of({}, ["voiceover"])["voiceover"]

    pulled = _put(ws, {"voiceover": None}, SYNC)
    assert pulled.status_code == 200, pulled.text
    assert json.loads(pulled.headers["x-montaj-revisions"])["voiceover"] == absent
    head = {k: v for k, v in pre.items() if k != "voiceover"}     # the document the pull meant
    assert _sc().changed_fields(head, json.loads(_disk(d))) == []

    # The window saves an edit of tracks on its pre-pull read: applied, nothing overridden, voiceover still gone.
    edit = {"tracks": [{"id": "trk-0", "items": []}, {"id": "trk-1", "items": []}]}
    saved = _put(ws, edit, {**EDITOR, "x-montaj-read-revisions": json.dumps({"tracks": seen["tracks"]})}, read=False)
    assert saved.status_code == 200, saved.text
    assert "x-montaj-overrode" not in saved.headers and "x-montaj-unread" not in saved.headers
    assert "voiceover" not in json.loads(_disk(d))

    # A fresh read and an AI save on it: voiceover reads absent, and neither the sync check nor the revisions count it.
    got = _client().get(f"/api/projects/{PID}?fields=voiceover,name", headers=AI)
    assert "voiceover" not in got.json()
    assert json.loads(got.headers["x-montaj-revisions"])["voiceover"] == absent
    ai = _put(ws, {"name": "third"}, AI)
    assert ai.status_code == 200, ai.text
    assert _sc().changed_fields({**head, "tracks": edit["tracks"], "name": "third"}, json.loads(_disk(d))) == []

    # The window's stale whole document, the old voiceover in it, is an override of the removal (reported).
    stale = _put(ws, {"voiceover": pre["voiceover"]},
                 {**EDITOR, "x-montaj-read-revisions": json.dumps({"voiceover": seen["voiceover"]})}, read=False)
    assert stale.status_code == 200 and stale.headers.get("x-montaj-overrode") == "voiceover"


def test_nulls_the_editor_save_first_then_the_pull_deleting_a_clash_free_field(ws, state, recorder):
    """(d), the other order: the window's save lands first, then the pull on its earlier read of voiceover alone."""
    d = _with_fields(ws)
    _sidecar(state, fields=["captions"])
    pre = json.loads(_disk(d))
    pull_read = {"x-montaj-read-revisions": json.dumps(revisions_of(normalize_tracks(pre), ["voiceover"]))}
    edit = {"tracks": [{"id": "trk-0", "items": []}, {"id": "trk-1", "items": []}]}
    assert _put(ws, edit, EDITOR, read=False).status_code == 200
    pulled = _put(ws, {"voiceover": None}, {**SYNC, **pull_read}, read=False)
    assert pulled.status_code == 200, pulled.text
    disk = json.loads(_disk(d))
    assert "voiceover" not in disk and "voiceover" not in pulled.json()
    assert disk["tracks"] == edit["tracks"]
    assert _sc().changed_fields({**{k: v for k, v in pre.items() if k != "voiceover"}, **edit}, disk) == []
    assert _put(ws, {"name": "third"}, AI).status_code == 200


def test_nulls_pin_a_pulled_removal_is_marked_like_any_pulled_change(ws, recorder):
    _with_fields(ws)
    assert _put(ws, {"voiceover": None}, SYNC).status_code == 200
    resp = _put(ws, {"voiceover": {"src": "/new.mp3"}}, EDITOR, read=False)
    assert resp.status_code == 200 and resp.headers.get("x-montaj-unread") == "voiceover"


@pytest.mark.parametrize("headers", UNTRUSTED_OR_OTHER, ids=UNTRUSTED_OR_OTHER_IDS)
def test_nulls_dark_without_a_trusted_sync_origin_bytes_answers_and_frames_match_a_null_kept(ws, recorder, headers):
    """(f) With no trusted sync origin, a body with nulls writes exactly what the shallow merge always wrote (markers
    and notes dropped, every other null kept) and answers and publishes it: compared with the text that merge writes."""
    from lib.project_lock import write_json_atomic as _w
    d = _with_fields(ws, markers=[{"id": "m1", "time": 1}])
    existing = json.loads(_disk(d))
    body = {"captions": None, "storyboard": None, "markers": None, "notes": None, "name": "x"}
    expected = {k: v for k, v in {**existing, **body}.items() if not (k in ("markers", "notes") and v is None)}
    resp = _put(ws, body, headers, read=headers.get("x-montaj-writer") != "editor")
    assert resp.status_code == 200, resp.text
    ref = d.parent / "ref" / "project.json"
    ref.parent.mkdir()
    _w(ref, expected)
    assert _disk(d) == ref.read_bytes()
    assert resp.json() == expected
    assert _frame_docs(recorder)[-1] == expected


# ── review folds ──────────────────────────────────────────────────────────────


def test_fold_speech_apply_checks_the_file_as_on_disk_under_the_lock(tmp_path, state, capsys, monkeypatch):
    """A legacy tracks on disk is written back in object form by any speech edit, so under a tracks clash that is a
    write of tracks, even when the edit leaves tracks as a reader sees them: the check compares the raw file."""
    import copy as _copy
    from lib import speech_apply
    pj, pid, edited = _speech_env(tmp_path)
    doc = json.loads(pj.read_text())
    pj.write_text(json.dumps({**doc, "tracks": [doc["tracks"][0]["items"], *doc["tracks"][1:]]}, indent=2))
    assert normalize_tracks(json.loads(pj.read_text()))["tracks"] == doc["tracks"]

    def carry_leaving_tracks(project, ti, items, tmap, fps, report=None):
        return {**_copy.deepcopy(project), "editingPrompt": "edited"}, report

    monkeypatch.setattr(speech_apply, "carry", carry_leaving_tracks)
    _sidecar(state, pid=pid, fields=["tracks"])
    before = pj.read_bytes()
    with pytest.raises(SystemExit):
        speech_apply.apply(str(pj), edited, preview=False, max_pause=None, feel="tight")
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err == {"error": "sync_conflict", "fields": ["tracks"], "message": _message(["tracks"])}
    assert pj.read_bytes() == before


def test_fold_speech_apply_pin_the_same_edit_with_tracks_unclashed_applies(tmp_path, state, monkeypatch):
    import copy as _copy
    from lib import speech_apply
    pj, pid, edited = _speech_env(tmp_path)
    doc = json.loads(pj.read_text())
    pj.write_text(json.dumps({**doc, "tracks": [doc["tracks"][0]["items"], *doc["tracks"][1:]]}, indent=2))
    monkeypatch.setattr(speech_apply, "carry",
                        lambda project, ti, items, tmap, fps, report=None:
                        ({**_copy.deepcopy(project), "editingPrompt": "edited"}, report))
    _sidecar(state, pid=pid, fields=["settings"])
    assert speech_apply.apply(str(pj), edited, preview=False, max_pause=None, feel="tight")["applied"] is True
    assert json.loads(pj.read_text())["editingPrompt"] == "edited"


STAR_CLASHES = [{"id": "c1", "fields": ["*"], "files": ["*"]},
                {"id": "c2", "fields": ["captions"], "files": ["overlays/a.jsx"]}]


def test_fold_a_star_resolve_may_not_write_another_open_clashs_field(ws, state):
    d = _project(ws, captions={"segments": []})
    _sidecar(state, fields=["*", "captions"], files=["*", "overlays/a.jsx"], clashes=STAR_CLASHES)
    before = _disk(d)
    _refused(_put(ws, {"captions": {"segments": [1]}}, RESOLVE("c1")), ["captions"])
    _refused(_put(ws, {"captions": {"segments": [1]}, "name": "renamed"}, RESOLVE("c1")), ["captions"])
    assert _disk(d) == before
    resp = _put(ws, {"name": "renamed", "tracks": [{"id": "trk-9", "items": []}]}, RESOLVE("c1"))
    assert resp.status_code == 200, resp.text
    assert _put(ws, {"captions": {"segments": [2]}}, RESOLVE("c2")).status_code == 200


def test_fold_a_star_resolve_whose_save_normalises_another_clashs_field_is_refused(ws, state):
    d = _legacy(ws)
    _sidecar(state, fields=["*", "tracks"], clashes=[{"id": "c1", "fields": ["*"], "files": []},
                                                     {"id": "c2", "fields": ["tracks"], "files": []}])
    before = _disk(d)
    _refused(_put(ws, {"name": "second"}, RESOLVE("c1")), ["tracks"])
    assert _disk(d) == before


def test_fold_a_star_resolve_may_not_write_another_open_clashs_file(ws, state):
    d = _project(ws)
    (d / "overlays").mkdir()
    _sidecar(state, fields=["*", "captions"], files=["*", "overlays/a.jsx"], clashes=STAR_CLASHES)
    _refused(_write_file(d / "overlays" / "a.jsx", RESOLVE("c1")), ["overlays/a.jsx"])
    assert not (d / "overlays" / "a.jsx").exists()
    assert _write_file(d / "overlays" / "b.jsx", RESOLVE("c1")).status_code == 200
    assert _write_file(d / "overlays" / "a.jsx", RESOLVE("c2")).status_code == 200


def test_fold_unit_a_star_resolve_closes_its_own_names_and_what_no_other_clash_holds():
    sc = _sc()
    clashes = sc._parse(json.dumps({"v": 1, "projectId": PID, "fields": ["*", "captions", "notes"],
                                    "files": ["*", "overlays/a.jsx"], "clashes": STAR_CLASHES}).encode(), PID)
    # `notes` is clashed with no clash of its own (the top-level list only): held, so refused too.
    assert sc.outside_clash(clashes, "c1", ["captions", "name", "notes"], ["overlays/a.jsx", "overlays/b.jsx"],
                            ["tracks", "captions"]) == ["captions", "notes", "overlays/a.jsx"]
    assert sc.outside_clash(clashes, "c1", everything=True) == ["captions", "notes", "overlays/a.jsx"]
    alone = sc._parse(json.dumps({"v": 1, "projectId": PID, "fields": ["*"], "files": ["*"],
                                  "clashes": [STAR_CLASHES[0]]}).encode(), PID)
    assert sc.outside_clash(alone, "c1", ["captions", "name"], ["overlays/a.jsx"], ["tracks"]) == []
    assert sc.outside_clash(alone, "c1", everything=True) == []


def test_fold_a_step_write_that_changes_the_id_is_checked_against_the_original_projects_clashes(tmp_path, state):
    from lib.project_lock import update_project
    path = _lib_project(tmp_path)
    _sidecar(state, fields=["tracks"])
    before = path.read_bytes()
    with pytest.raises(_sc().SyncConflict) as e:
        update_project(path, lambda p: {**p, "id": "renamed-proj", "tracks": [{"id": "trk-1", "items": []}]})
    assert e.value.body == _sc().refusal(["tracks"])
    assert path.read_bytes() == before


def test_fold_a_heal_that_changes_the_id_is_checked_against_the_original_projects_clashes(ws, state):
    _sidecar(state, fields=["tracks"])
    raw = json.dumps({"id": PID, "tracks": []})
    after = {"id": "renamed-proj", "tracks": [{"id": "trk-1", "items": []}]}
    assert save_guard.maintenance_refusal(raw, after) == _sc().refusal(["tracks"])
    assert not save_guard.maintenance_allows(raw, after)


# ── fail-open hardening: the state folder named badly or out of reach ─────────


@pytest.mark.parametrize("exists", [True, False], ids=["folder-there", "nothing-there"])
@pytest.mark.parametrize("value", ["studio-sync", "./studio-sync", "~/studio-sync"])
def test_harden_a_relative_state_dir_is_misconfigured_and_fails_closed(ws, tmp_path, monkeypatch, exists, value):
    monkeypatch.chdir(tmp_path)
    if exists:
        (tmp_path / "studio-sync").mkdir()
    monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", value)
    d = _project(ws)
    before = _disk(d)
    _refused(_put(ws, {"notes": []}, AI), ["notes"])
    _refused(_put(ws, {"notes": []}, TOOL), ["notes"])
    assert _disk(d) == before
    with pytest.raises(_sc().SyncConflict):
        _sc().check_step_write(PID, ["notes"])
    assert _put(ws, {"notes": []}, EDITOR, read=False).status_code == 200


@pytest.mark.parametrize("under", ["studio-sync", "runtime/studio-sync"], ids=["parent", "grandparent"])
def test_harden_a_state_dir_under_a_dangling_link_fails_closed(ws, tmp_path, monkeypatch, under):
    """An unmounted volume: the link is there, what it points at is not. Never "no folder, so no clash"."""
    vol = tmp_path / "Volumes" / "Backup"
    vol.parent.mkdir()
    vol.symlink_to(tmp_path / "unmounted", target_is_directory=True)
    monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", str(vol / under))
    d = _project(ws)
    before = _disk(d)
    _refused(_put(ws, {"notes": []}, AI), ["notes"])
    assert _disk(d) == before
    with pytest.raises(_sc().SyncConflict):
        _sc().check_step_write(PID, ["notes"])
    assert _put(ws, {"notes": []}, EDITOR, read=False).status_code == 200


def test_harden_pin_a_state_dir_missing_under_a_live_link_is_no_clash(ws, tmp_path, monkeypatch):
    (tmp_path / "real").mkdir()
    (tmp_path / "linked").symlink_to(tmp_path / "real", target_is_directory=True)
    monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", str(tmp_path / "linked" / "runtime" / "studio-sync"))
    _project(ws)
    assert _put(ws, {"notes": []}, AI).status_code == 200


@pytest.fixture
def missing_log(monkeypatch):
    """serve's one-line notice of a missing state folder, as a fresh serve process has it."""
    monkeypatch.setattr(_sc(), "_missing_log", {"armed": False, "logged": False})
    return _sc()


def _notices(err):
    return [line for line in err.splitlines() if line == _sc().MISSING_STATE_LINE]


def test_harden_serve_logs_one_line_at_startup_when_the_state_folder_is_missing(ws, no_state_dir, missing_log,
                                                                                 capsys):
    _project(ws)
    capsys.readouterr()
    save_guard.startup()
    save_guard.startup()      # `montaj serve`, then serve.server's import: still one line
    for _ in range(3):
        assert _put(ws, {"notes": []}, AI).status_code == 200
    assert len(_notices(capsys.readouterr().err)) == 1


def test_harden_serve_logs_one_line_on_first_detection_of_a_missing_state_folder(ws, state, missing_log, capsys):
    _project(ws)
    capsys.readouterr()
    save_guard.startup()
    assert _notices(capsys.readouterr().err) == []
    state.rmdir()
    for _ in range(3):
        assert _put(ws, {"notes": []}, AI).status_code == 200
    assert len(_notices(capsys.readouterr().err)) == 1


def test_harden_pin_no_notice_with_the_var_unset_a_folder_there_or_in_a_step(ws, tmp_path, monkeypatch, missing_log,
                                                                             capsys):
    capsys.readouterr()
    save_guard.startup()
    monkeypatch.setenv("MONTAJ_SYNC_STATE_DIR", str(tmp_path / "studio-sync"))
    (tmp_path / "studio-sync").mkdir()
    save_guard.startup()
    assert _notices(capsys.readouterr().err) == []
    # A step is its own process and never starts serve: it never prints the notice (its stderr carries its answer).
    (tmp_path / "studio-sync").rmdir()
    missing_log._missing_log.update(armed=False, logged=False)
    _sc().check_step_write(PID, ["notes"])
    assert _notices(capsys.readouterr().err) == []
