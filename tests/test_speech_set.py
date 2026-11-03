"""§697: the speech set, and the loudness cache key that follows only the speech."""
import copy
import json
from pathlib import Path

import pytest

from lib.speech_set import speech_set, write_speech_set
from serve import mix_loudness as ml
from serve.routes.projects import _with_speech_set


def _sidecar(path: Path):
    path.with_suffix(".json").write_text(json.dumps(
        {"transcription": [{"text": "hi"}]}))


@pytest.fixture
def pd(tmp_path):
    for n in ("a.mp4", "b.mp4", "vo.wav", "sfx.wav", "music.wav"):
        (tmp_path / n).write_bytes(b"x" * 10)
    _sidecar(tmp_path / "a.mp4")
    _sidecar(tmp_path / "vo.wav")
    return tmp_path


def _doc():
    return {
        "settings": {"loudness": -14, "fps": 30},
        "tracks": [{"id": "t0", "items": [
            {"id": "a", "type": "video", "src": "a.mp4", "start": 0, "end": 2, "inPoint": 0, "outPoint": 2},
            {"id": "b", "type": "video", "src": "b.mp4", "start": 2, "end": 3, "inPoint": 0, "outPoint": 1},
            {"id": "m", "type": "video", "src": "a.mp4", "start": 3, "end": 4, "muted": True},
        ]}],
        "audio": {"tracks": [
            {"id": "vo", "type": "voiceover", "src": "vo.wav", "start": 0, "end": 2, "volume": 1.0},
            {"id": "sfx", "src": "sfx.wav", "start": 0, "end": 2, "volume": 0.35},
            {"id": "vo-muted", "type": "voiceover", "src": "vo.wav", "muted": True},
        ]},
    }


def test_speech_set_picks_voiceover_and_sidecar_clips(pd):
    s = speech_set(_doc(), pd)
    assert s == {"v": 1, "items": ["a"], "lanes": ["vo"],
                 "srcs": sorted([str(pd / "a.mp4"), str(pd / "vo.wav")])}


def test_speech_set_legacy_bare_track(pd):
    doc = _doc()
    doc["tracks"] = [doc["tracks"][0]["items"]]
    assert speech_set(doc, pd)["items"] == ["a"]


def test_key_ignores_non_speech_lane_volume(pd):
    doc = _doc()
    key = ml.cache_key(doc, pd)
    d = copy.deepcopy(doc)
    d["audio"]["tracks"][1]["volume"] = 1.0
    d["audio"]["tracks"][1]["src"] = "music.wav"
    d["tracks"][0]["items"][1]["volume"] = 0.2
    assert ml.cache_key(d, pd) == key


@pytest.mark.parametrize("edit", [
    lambda d: d["tracks"][0]["items"][0].update(volume=0.5),
    lambda d: d["tracks"][0]["items"][0].update(end=1.5),
    lambda d: d["audio"]["tracks"][0].update(volume=0.5),
    lambda d: d["audio"]["tracks"][0].update(src="music.wav"),
    lambda d: d["tracks"][0]["items"][0].update(src="b.mp4"),
])
def test_key_follows_speech_edits(pd, edit):
    doc = _doc()
    key = ml.cache_key(doc, pd)
    d = copy.deepcopy(doc)
    edit(d)
    assert ml.cache_key(d, pd) != key


def test_key_follows_a_new_sidecar(pd):
    doc = _doc()
    key = ml.cache_key(doc, pd)
    _sidecar(pd / "b.mp4")
    assert ml.cache_key(doc, pd) != key


def test_key_follows_an_edited_sidecar(pd):
    doc = _doc()
    key = ml.cache_key(doc, pd)
    (pd / "a.json").write_text(json.dumps({"transcription": [{"text": "yo there"}]}))
    assert ml.cache_key(doc, pd) != key


def test_no_speech_keeps_the_whole_mix_key(pd):
    doc = _doc()
    doc["audio"]["tracks"] = [doc["audio"]["tracks"][1]]
    doc["tracks"][0]["items"] = [doc["tracks"][0]["items"][1]]
    assert speech_set(doc, pd)["srcs"] == []
    key = ml.cache_key(doc, pd)
    d = copy.deepcopy(doc)
    d["audio"]["tracks"][0]["volume"] = 1.0
    assert ml.cache_key(d, pd) != key


def test_measure_passes_the_speech_set(pd, monkeypatch):
    doc = _doc()
    (pd / "project.json").write_text(json.dumps(doc))
    seen = {}

    class P:
        returncode = 0
        def communicate(self, timeout=None):
            return '{"status":"silent","targetI":-14}\n', ""

    def popen(argv, **kw):
        seen["argv"] = argv
        return P()

    monkeypatch.setattr(ml.subprocess, "Popen", popen)
    monkeypatch.setattr(ml.shutil, "which", lambda n: "/usr/bin/node")
    monkeypatch.setattr(ml, "render_runtime_dir", lambda: str(pd))
    (pd / "mix-loudness.js").write_text("")
    ml._measure(pd / "project.json")
    argv = seen["argv"]
    i = argv.index("--speech-set")
    assert argv.index("--project") < i
    assert json.loads(Path(argv[i + 1]).read_text()) == speech_set(doc, pd)


def test_answer_passes_basis():
    r = ml._answer({"status": "measured", "inputI": -20, "targetI": -14, "basis": "speech"})
    assert r["basis"] == "speech"
    assert "basis" not in ml._answer({"status": "measured", "inputI": -20, "targetI": -14})


def test_export_argv_carries_the_set_of_the_rendered_json(pd):
    doc = _doc()
    (pd / "project.json").write_text(json.dumps(doc))
    conv = copy.deepcopy(doc)
    conv["tracks"][0]["items"].pop(0)  # the converged copy differs
    (pd / ".render-input-x.json").write_text(json.dumps(conv))
    argv = _with_speech_set([str(pd / ".render-input-x.json"), "--out", "o.mp4"], pd, pd / ".render-input-x.json")
    i = argv.index("--speech-set")
    assert json.loads(Path(argv[i + 1]).read_text()) == speech_set(conv, pd)
    # replaced, never doubled
    assert _with_speech_set(argv, pd, pd / "project.json").count("--speech-set") == 1


def test_write_is_atomic_file(pd):
    f = write_speech_set(_doc(), pd)
    assert f == pd / "render" / "speech-set.json" and json.loads(f.read_text())["v"] == 1
    assert not list((pd / "render").glob("*.tmp"))
