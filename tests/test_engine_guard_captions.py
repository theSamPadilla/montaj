"""§477: both caption writers (the serve route's pipeline and the generate_captions step)
fingerprint their input when the job starts (the audible mix with every src replaced by its
item id, and the source caption segments) and compare it under the project lock at
write-back. Equal: only `captions` is written. Different: nothing is written and the job
fails with project_changed. Without the guard both behave exactly as before."""
import asyncio
import importlib.util
import json
import os
import sys

import pytest

import serve.routes.projects as projects_mod
from serve import save_guard
from serve.caption_job import caption_input_fingerprint

STEP_PY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "steps", "transform", "generate_captions.py")

AUDIO_MSG = "The audio changed while captions were generated. Run captions again."
TEXT_MSG = "The captions were edited while they were generated. Run captions again."

NEW_TRACK = {"style": "pop", "segments": [
    {"text": "new words", "start": 0.0, "end": 1.0,
     "words": [{"word": "new", "start": 0.0, "end": 0.5}, {"word": "words", "start": 0.5, "end": 1.0}]}]}


def _project(tmp_dir):
    return {
        "id": "p1", "name": "orig", "settings": {"colorSpace": "sdr"},
        "tracks": [
            {"id": "trk-0", "items": [{"id": "c1", "type": "video", "src": str(tmp_dir / "a.mp4"),
                                       "start": 0.0, "end": 2.0, "inPoint": 0.0, "outPoint": 2.0}]},
            {"id": "trk-ov", "items": []},
        ],
        "audio": {"tracks": [{"id": "m1", "src": str(tmp_dir / "music.mp3"), "start": 0.0, "end": 2.0,
                              "inPoint": 0.0, "volume": 0.3}]},
        "captions": {"style": "pop", "color": "#ffffff", "segments": [
            {"id": "cap-0", "text": "old words", "start": 0.0, "end": 1.0,
             "words": [{"word": "old", "start": 0.0, "end": 0.5}, {"word": "words", "start": 0.5, "end": 1.0}]}]},
    }


# ── edits made while the job runs ─────────────────────────────────────────────

def rename(d):
    d["name"] = "renamed"


def add_overlay(d):
    d["tracks"][1]["items"].append({"id": "ov-1", "type": "overlay", "src": "overlays/x.jsx",
                                    "start": 0.0, "end": 1.0})


def recolour(d):
    d["settings"]["colorSpace"] = "hdr-pq"


def caption_theme(d):
    d["captions"]["color"] = "#ff0000"


def normalize_src(d):
    d["tracks"][0]["items"][0]["src"] = d["tracks"][0]["items"][0]["src"].replace("a.mp4", "a.norm.mp4")
    d["audio"]["tracks"][0]["src"] = d["audio"]["tracks"][0]["src"].replace("music.mp3", "music.norm.mp3")


def clip_volume(d):
    d["tracks"][0]["items"][0]["volume"] = 0.5


def music_moved(d):
    d["audio"]["tracks"][0]["start"] = 0.5


def caption_text(d):
    d["captions"]["segments"][0]["text"] = "old wordz"


UNRELATED = [rename, add_overlay, recolour, caption_theme, normalize_src]


# ── the fingerprint ───────────────────────────────────────────────────────────

def test_fingerprint_ignores_src_and_unrelated_fields(tmp_path):
    base = caption_input_fingerprint(_project(tmp_path))
    for edit in UNRELATED:
        d = _project(tmp_path)
        edit(d)
        assert caption_input_fingerprint(d) == base, edit.__name__


def test_fingerprint_moves_with_audio_and_caption_text(tmp_path):
    base = caption_input_fingerprint(_project(tmp_path))
    for edit, field in ((clip_volume, "tracks"), (music_moved, "audio"), (caption_text, "captions")):
        d = _project(tmp_path)
        edit(d)
        now = caption_input_fingerprint(d)
        assert [k for k in base if base[k] != now[k]] == [field], edit.__name__


def test_fingerprint_keeps_translated_rows_out(tmp_path):
    """Translated rows are carried forward by the regeneration, as the theme is."""
    base = caption_input_fingerprint(_project(tmp_path))
    d = _project(tmp_path)
    d["captions"]["segments"].append({"id": "cap-0-es", "text": "palabras", "start": 0.0, "end": 1.0,
                                      "lang": "es", "translationOf": ["cap-0"], "lane": 1})
    assert caption_input_fingerprint(d) == base


# ── the serve route's pipeline ────────────────────────────────────────────────

class _Broadcaster:
    def __init__(self):
        self.frames = []

    def publish(self, project_id, frame):
        self.frames.append(frame)


class _Stream:
    async def readline(self):
        return b""

    async def read(self):
        return b""


class _Proc:
    returncode = 0

    def __init__(self):
        self.stderr = _Stream()
        self.stdout = _Stream()

    async def wait(self):
        pass


@pytest.fixture
def guard(monkeypatch):
    def set_on(on):
        monkeypatch.setitem(save_guard._state, "requested", on)
        monkeypatch.setitem(save_guard._state, "canary", "ok")
        if on:
            monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
        else:
            monkeypatch.delenv("MONTAJ_ENGINE_GUARD", raising=False)
    return set_on


def _route_setup(tmp_path, monkeypatch, edit):
    """project.json on disk; every pipeline subprocess succeeds at once, and the edit lands
    on disk while 'caption' runs (after the job read the project)."""
    pdir = tmp_path / "proj"
    pdir.mkdir()
    path = pdir / "project.json"
    project = _project(pdir)
    path.write_text(json.dumps(project))
    seen = {}

    async def fake_exec(*args, **kwargs):
        if any(str(a).endswith("caption.py") for a in args):
            (pdir / "_caption_track.json").write_text(json.dumps(NEW_TRACK))
            if edit is not None:
                doc = json.loads(path.read_text())
                edit(doc)
                path.write_text(json.dumps(doc))
            seen["bytes"] = path.read_bytes()
        return _Proc()
    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", fake_exec)
    return pdir, path, project, seen


def _run_route(pdir, project, broadcaster=None):
    return asyncio.run(projects_mod._run_caption_pipeline(
        "p1", pdir, project, model="base", language="auto", style="pop",
        broadcaster=broadcaster or _Broadcaster(), on_log=None, is_disconnected=None))


@pytest.mark.parametrize("edit", UNRELATED, ids=lambda e: e.__name__)
def test_route_unrelated_edit_lands_with_the_captions(edit, guard, tmp_path, monkeypatch):
    guard(True)
    pdir, path, project, _ = _route_setup(tmp_path, monkeypatch, edit)
    _run_route(pdir, project)
    doc = json.loads(path.read_text())
    expected = _project(pdir)
    edit(expected)
    assert doc["captions"]["segments"][0]["text"] == "new words"
    assert {k: v for k, v in doc.items() if k != "captions"} == {k: v for k, v in expected.items() if k != "captions"}


@pytest.mark.parametrize("edit,stale,message", [
    (clip_volume, ["tracks"], AUDIO_MSG),
    (music_moved, ["audio"], AUDIO_MSG),
    (caption_text, ["captions"], TEXT_MSG),
], ids=["clip-volume", "music-moved", "caption-text"])
def test_route_refuses_and_writes_nothing(edit, stale, message, guard, tmp_path, monkeypatch):
    guard(True)
    pdir, path, project, seen = _route_setup(tmp_path, monkeypatch, edit)
    with pytest.raises(projects_mod.CaptionPipelineError) as exc:
        _run_route(pdir, project)
    assert exc.value.status_code == 409
    assert exc.value.detail == {"error": "project_changed", "stale": stale, "missing": [], "message": message}
    assert exc.value.message == message
    assert path.read_bytes() == seen["bytes"]


def test_route_guard_off_writes_over_an_audio_change_as_today(guard, tmp_path, monkeypatch):
    guard(False)
    pdir, path, project, _ = _route_setup(tmp_path, monkeypatch, clip_volume)
    _run_route(pdir, project)
    doc = json.loads(path.read_text())
    assert doc["captions"]["segments"][0]["text"] == "new words"
    assert doc["tracks"][0]["items"][0]["volume"] == 0.5


def test_route_guard_off_writes_over_a_caption_edit_as_today(guard, tmp_path, monkeypatch):
    guard(False)
    pdir, path, project, _ = _route_setup(tmp_path, monkeypatch, caption_text)
    _run_route(pdir, project)
    assert json.loads(path.read_text())["captions"]["segments"][0]["text"] == "new words"


def test_detached_job_records_the_refusal(guard, tmp_path, monkeypatch):
    guard(True)
    pdir, path, project, seen = _route_setup(tmp_path, monkeypatch, clip_volume)
    job = projects_mod._CaptionJob()
    asyncio.run(projects_mod._run_caption_detached("p1", pdir, project, "base", "auto", "pop",
                                                   _Broadcaster(), job))
    assert job.status == "error" and job.error == AUDIO_MSG
    assert job.detail == {"error": "project_changed", "stale": ["tracks"], "missing": [], "message": AUDIO_MSG}
    monkeypatch.setitem(projects_mod._caption_jobs, "p1", job)
    out = asyncio.run(projects_mod.captions_status("p1", pdir))
    assert out == {"status": "error", "error": AUDIO_MSG,
                   "errorDetail": {"error": "project_changed", "stale": ["tracks"], "missing": [],
                                   "message": AUDIO_MSG}}
    assert path.read_bytes() == seen["bytes"]


def test_detached_job_status_shape_unchanged_for_other_errors(tmp_path):
    job = projects_mod._CaptionJob()
    job.status, job.error = "error", "mix_timeline failed (exit 1)"
    projects_mod._caption_jobs["p-other"] = job
    try:
        out = asyncio.run(projects_mod.captions_status("p-other", tmp_path))
    finally:
        projects_mod._caption_jobs.pop("p-other", None)
    assert out == {"status": "error", "error": "mix_timeline failed (exit 1)"}


# ── the generate_captions step ────────────────────────────────────────────────

def _load_step():
    spec = importlib.util.spec_from_file_location("generate_captions_step_guard", STEP_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _run_step(tmp_path, monkeypatch, edit, holder=None):
    """The step's real main() with the pipeline subprocesses stubbed; the edit lands on
    disk while 'caption' runs. holder gets the paths and the file's bytes before the
    step's write, so a test can still read them after the step exits."""
    holder = holder if holder is not None else {}
    mod = _load_step()
    pdir = tmp_path / "proj"
    pdir.mkdir()
    path = pdir / "project.json"
    path.write_text(json.dumps(_project(pdir)))
    holder.update(pdir=pdir, path=path)
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: pdir)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a, **k: None)
    monkeypatch.setattr(mod, "whisper_runaway_timeout_for", lambda p: 1)

    def fake_run(cmd, **kw):
        joined = " ".join(cmd)
        if "transcribe.py" in joined:
            (pdir / "_caption_words.json").write_text("{}")
        if "caption.py" in joined:
            (pdir / "_caption_track.json").write_text(json.dumps(NEW_TRACK))
            if edit is not None:
                doc = json.loads(path.read_text())
                edit(doc)
                path.write_text(json.dumps(doc))
            holder["bytes"] = path.read_bytes()
    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["generate_captions.py", "--project-id", "p1"])
    mod.main()
    return pdir, path, holder


@pytest.mark.parametrize("edit", UNRELATED, ids=lambda e: e.__name__)
def test_step_unrelated_edit_lands_with_the_captions(edit, monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    pdir, path, _ = _run_step(tmp_path, monkeypatch, edit)
    doc = json.loads(path.read_text())
    expected = _project(pdir)
    edit(expected)
    assert doc["captions"]["segments"][0]["text"] == "new words"
    assert {k: v for k, v in doc.items() if k != "captions"} == {k: v for k, v in expected.items() if k != "captions"}


@pytest.mark.parametrize("edit,message", [
    (clip_volume, AUDIO_MSG), (music_moved, AUDIO_MSG), (caption_text, TEXT_MSG),
], ids=["clip-volume", "music-moved", "caption-text"])
def test_step_refuses_and_writes_nothing(edit, message, monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    holder = {}
    with pytest.raises(SystemExit) as exc:
        _run_step(tmp_path, monkeypatch, edit, holder)
    assert exc.value.code == 1
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err == {"error": "project_changed", "message": message}
    assert holder["path"].read_bytes() == holder["bytes"]
    assert not (holder["pdir"] / "_caption_track.json").exists()     # temp files still cleaned


@pytest.mark.parametrize("edit", [clip_volume, caption_text], ids=lambda e: e.__name__)
def test_step_guard_off_writes_as_today(edit, monkeypatch, tmp_path, capsys):
    monkeypatch.delenv("MONTAJ_ENGINE_GUARD", raising=False)
    _, path, _ = _run_step(tmp_path, monkeypatch, edit)
    assert json.loads(path.read_text())["captions"]["segments"][0]["text"] == "new words"
