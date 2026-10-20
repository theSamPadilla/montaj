"""§477: with MONTAJ_ENGINE_GUARD=1 the cut steps and speech_apply decide project_changed
through the shared revision machinery (lib/project_revisions.stale_fields over revisions
taken when the step read the project), and say so in the shared step wording. Without the
env they behave exactly as before."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

import lib.ai_video as ai_video  # noqa: E402
import lib.project_revisions as project_revisions  # noqa: E402
import steps.edit.jump_cut as jump_cut  # noqa: E402
from lib import speech_apply  # noqa: E402
from lib.speech_text import derive, render  # noqa: E402

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "speech_text")


@pytest.fixture
def guard_on(monkeypatch):
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")


@pytest.fixture
def guard_off(monkeypatch):
    monkeypatch.delenv("MONTAJ_ENGINE_GUARD", raising=False)


def _spy_stale_fields(monkeypatch):
    calls = []
    real = project_revisions.stale_fields

    def spy(*a, **k):
        out = real(*a, **k)
        calls.append(out)
        return out
    monkeypatch.setattr(project_revisions, "stale_fields", spy)
    return calls


# ── the helper ────────────────────────────────────────────────────────────────

def test_engine_guard_enabled_reads_the_env(monkeypatch):
    monkeypatch.delenv("MONTAJ_ENGINE_GUARD", raising=False)
    assert not project_revisions.engine_guard_enabled()
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "0")
    assert not project_revisions.engine_guard_enabled()
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    assert project_revisions.engine_guard_enabled()


def test_engine_guard_is_off_when_the_canary_disagrees(monkeypatch):
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    monkeypatch.setattr(project_revisions, "canary_ok", lambda: False)
    assert not project_revisions.engine_guard_enabled()


def test_a_step_subprocess_sees_the_guard(monkeypatch):
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    out = subprocess.run(
        [sys.executable, "-c", "from lib.project_revisions import engine_guard_enabled as e; print(e())"],
        cwd=str(REPO_ROOT), capture_output=True, text=True, check=True).stdout.strip()
    assert out == "True"


def test_step_stale_message():
    assert project_revisions.step_stale_message(["tracks", "audio"]) == (
        "The project changed while the step ran: tracks, audio changed since it was read. "
        "Read the project again and rerun.")


# ── cut steps (save_project_changes) ──────────────────────────────────────────

def _clip(cid, start, dur=4.0):
    return {"id": cid, "type": "video", "src": f"./{cid}.mp4", "start": start,
            "end": start + dur, "inPoint": 0.0, "outPoint": dur}


def _write(tmp_path):
    path = tmp_path / "project.json"
    path.write_text(json.dumps({"id": "p1", "name": "orig",
                                "tracks": [{"id": "trk-0", "items": [_clip("clip-a", 0.0)]}]}))
    return path


def _run_jump_cut(monkeypatch, path, mutate):
    def find(pid):
        got = (path, json.loads(path.read_text()))
        doc = json.loads(path.read_text())
        mutate(doc)
        path.write_text(json.dumps(doc))
        return got
    monkeypatch.setattr(jump_cut, "find_project", find)
    monkeypatch.setattr(sys, "argv", ["jump_cut.py", "--project-id", "p1", "--clip-id", "clip-a",
                                      "--cuts", json.dumps([[1.0, 2.0]])])
    jump_cut.main()


def test_cut_refuses_changed_tracks_with_the_shared_message(guard_on, monkeypatch, tmp_path, capsys):
    path = _write(tmp_path)
    calls = _spy_stale_fields(monkeypatch)
    edited = {}

    def mutate(doc):
        doc["tracks"][0]["items"].append(_clip("clip-b", 4.0))
    with pytest.raises(SystemExit) as exc:
        def find(pid):
            got = (path, json.loads(path.read_text()))
            doc = json.loads(path.read_text())
            mutate(doc)
            path.write_text(json.dumps(doc))
            edited["bytes"] = path.read_bytes()
            return got
        monkeypatch.setattr(jump_cut, "find_project", find)
        monkeypatch.setattr(sys, "argv", ["jump_cut.py", "--project-id", "p1", "--clip-id", "clip-a",
                                          "--cuts", json.dumps([[1.0, 2.0]])])
        jump_cut.main()
    assert exc.value.code == 1
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err == {"error": "project_changed",
                   "message": "The project changed while the step ran: tracks changed since it was read. "
                              "Read the project again and rerun."}
    assert path.read_bytes() == edited["bytes"]
    assert calls and calls[-1]["stale"] == ["tracks"]


def test_cut_keeps_an_unrelated_edit_through_the_revision_compare(guard_on, monkeypatch, tmp_path):
    path = _write(tmp_path)
    calls = _spy_stale_fields(monkeypatch)
    _run_jump_cut(monkeypatch, path, lambda d: d.update(name="renamed"))
    doc = json.loads(path.read_text())
    assert doc["name"] == "renamed"
    assert len(doc["tracks"][0]["items"]) == 2
    assert calls and calls[-1] == {"missing": [], "stale": []}


def test_cut_revisions_are_the_ones_taken_at_read_time(guard_on, tmp_path, capsys):
    """original is the document as read; a later change to the caller's own copy of
    project never moves the baseline."""
    path = _write(tmp_path)
    original = json.loads(path.read_text())
    project = json.loads(path.read_text())
    project["tracks"][0]["items"] = []
    doc = json.loads(path.read_text())
    doc["tracks"][0]["volume"] = 0.5
    path.write_text(json.dumps(doc))
    before = path.read_bytes()
    with pytest.raises(SystemExit):
        ai_video.save_project_changes(path, original, project)
    assert path.read_bytes() == before
    assert json.loads(capsys.readouterr().err)["error"] == "project_changed"


def test_cut_guard_off_keeps_todays_message(guard_off, monkeypatch, tmp_path, capsys):
    path = _write(tmp_path)
    calls = _spy_stale_fields(monkeypatch)
    with pytest.raises(SystemExit):
        _run_jump_cut(monkeypatch, path, lambda d: d["tracks"][0]["items"].append(_clip("clip-b", 4.0)))
    err = json.loads(capsys.readouterr().err)
    assert err == {"error": "project_changed",
                   "message": "The project's tracks changed while this step ran: read it again and redo the cut."}
    assert calls == []


def test_cut_guard_off_keeps_an_unrelated_edit(guard_off, monkeypatch, tmp_path):
    path = _write(tmp_path)
    _run_jump_cut(monkeypatch, path, lambda d: d.update(name="renamed"))
    doc = json.loads(path.read_text())
    assert doc["name"] == "renamed" and len(doc["tracks"][0]["items"]) == 2


# ── speech_apply ──────────────────────────────────────────────────────────────

@pytest.fixture
def senv(tmp_path):
    pdir = tmp_path / "proj"
    shutil.copytree(FIX, pdir)
    pj = pdir / "project.json"
    pj.write_text(pj.read_text().replace("/FIXTURE", str(pdir)))
    git = ["git", "-c", "user.name=t", "-c", "user.email=t@local"]
    for args in (["init", "-q"], ["add", "project.json"], ["commit", "-q", "-m", "init"]):
        subprocess.run([*git, *args], cwd=pdir, capture_output=True, check=True)
    project = json.loads(pj.read_text())
    text = render(derive(project, str(pdir)), project.get("name") or project["id"])
    return type("E", (), {"dir": str(pdir), "path": str(pj), "text": text})


def _drop_a4(text):
    return "\n".join(ln for ln in text.split("\n") if not ln.startswith("A4 "))


def _edit_during_window(monkeypatch, path, mutate, seen=None):
    real = speech_apply.commit_version

    def commit(*a, **k):
        v = real(*a, **k)
        doc = json.loads(Path(path).read_text())
        mutate(doc)
        Path(path).write_text(json.dumps(doc))
        if seen is not None:
            seen["bytes"] = Path(path).read_bytes()
        return v
    monkeypatch.setattr(speech_apply, "commit_version", commit)


def _apply(senv):
    return speech_apply.apply(senv.path, _drop_a4(senv.text), preview=False, max_pause=None, feel="tight")


def test_speech_apply_refuses_its_own_key_with_the_shared_message(guard_on, senv, monkeypatch, capsys):
    calls = _spy_stale_fields(monkeypatch)
    seen = {}
    _edit_during_window(monkeypatch, senv.path,
                        lambda d: d.update(markers=[{"id": "m-new", "time": 1.0, "label": "x"}]), seen)
    with pytest.raises(SystemExit):
        _apply(senv)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err == {"error": "project_changed",
                   "message": "The project changed while the step ran: markers changed since it was read. "
                              "Read the project again and rerun."}
    assert Path(senv.path).read_bytes() == seen["bytes"]
    assert calls and calls[-1]["stale"] == ["markers"]


def test_speech_apply_refuses_a_changed_fps(guard_on, senv, monkeypatch, capsys):
    _edit_during_window(monkeypatch, senv.path,
                        lambda d: d.setdefault("settings", {}).update(fps=24))
    with pytest.raises(SystemExit):
        _apply(senv)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "project_changed" and "settings.fps" in err["message"]


def test_speech_apply_keeps_an_unrelated_edit_through_the_revision_compare(guard_on, senv, monkeypatch):
    calls = _spy_stale_fields(monkeypatch)

    def mutate(doc):
        doc["name"] = "renamed meanwhile"
        doc.setdefault("settings", {})["proxyReady"] = True
    _edit_during_window(monkeypatch, senv.path, mutate)
    assert _apply(senv)["applied"]
    doc = json.loads(Path(senv.path).read_text())
    assert doc["name"] == "renamed meanwhile" and doc["settings"]["proxyReady"] is True
    assert calls and calls[-1] == {"missing": [], "stale": []}


def test_speech_apply_guard_off_keeps_todays_message(guard_off, senv, monkeypatch, capsys):
    calls = _spy_stale_fields(monkeypatch)
    _edit_during_window(monkeypatch, senv.path,
                        lambda d: d.update(markers=[{"id": "m-new", "time": 1.0, "label": "x"}]))
    with pytest.raises(SystemExit):
        _apply(senv)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err == {"error": "project_changed",
                   "message": "The project changed while the edit was applied: read the text again and redo it."}
    assert calls == []
