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
