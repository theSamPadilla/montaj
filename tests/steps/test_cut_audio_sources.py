"""§661: `cut` on a voiceover-only project whose speech is audio sources (project.sources type "audio"), with no clip on
the timeline. The sources are the speech: planned and cut as one narration on lane 0, in order, no black video to wrap
them in; `clips` picks which sources; a changed source set is planned again; and a project whose workflow manages its
own phases (ai-broll) keeps its status. Transcription is a sidecar beside each wav: no model runs."""
import contextlib
import io
import json
import math
import random
import struct
import sys
import wave
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

import steps.edit.cut as cc  # noqa: E402

# (seconds, voiced): speech 1.0, silence 0.9, speech 1.0
SEGMENTS = [(1.0, True), (0.9, False), (1.0, True)]
DUR = sum(d for d, _ in SEGMENTS)
WORDS = [(" one", 0, 450), (" two", 500, 1000), (" three", 1900, 2400), (" four.", 2450, 2900)]


def wav(path, seed):
    rng = random.Random(seed)
    frames = []
    for secs, loud in SEGMENTS:
        for i in range(int(secs * 16000)):
            frames.append(int(8000 * math.sin(i * 0.35) if loud else rng.randint(-3, 3)))
    with wave.open(str(path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"".join(struct.pack("<h", x) for x in frames))
    path.with_suffix(".json").write_text(json.dumps({"transcription": [
        {"text": t, "offsets": {"from": a, "to": b}} for t, a, b in WORDS]}))


def make(d, takes=("take-a", "take-b"), status="pending", workflow="ai-broll"):
    sources = []
    for i, name in enumerate(takes):
        wav(d / f"{name}.wav", i + 1)
        sources.append({"id": name, "type": "audio", "src": f"{name}.wav"})
    project = {
        "version": "0.1", "id": "voonly", "name": "voonly", "status": status, "workflow": workflow, "editingPrompt": "",
        "settings": {"resolution": [1080, 1920], "fps": 30}, "tracks": [], "sources": sources,
    }
    (d / "project.json").write_text(json.dumps(project, indent=2))
    return project


def add_source(d, name):
    wav(d / f"{name}.wav", 9)
    p = json.loads((d / "project.json").read_text())
    p["sources"].append({"id": name, "type": "audio", "src": f"{name}.wav"})
    (d / "project.json").write_text(json.dumps(p, indent=2))


def run(d, monkeypatch, *extra):
    monkeypatch.setattr(sys, "argv", ["cut.py", "--project", str(d / "project.json"), *extra])
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        cc.main()
    return json.loads(out.getvalue())


def load(d):
    return json.loads((d / "project.json").read_text())


def lane0(p):
    return sorted((a for a in p["audio"]["tracks"] if a.get("lane") == 0), key=lambda a: a["start"])


def test_audio_sources_are_the_speech_and_cut_in_place_with_no_clip_on_the_timeline(tmp_path, monkeypatch):
    make(tmp_path)
    plan = run(tmp_path, monkeypatch)
    assert plan["mode"] == "plan" and plan["speech"] == "audio:lane-0"
    applied = run(tmp_path, monkeypatch, "--plan", str(tmp_path / "cut-plan.md"))
    assert applied["mode"] == "applied"
    p = load(tmp_path)
    assert p["tracks"] == [] or all(not t["items"] for t in p["tracks"]), "no video is made to carry the speech"
    items = lane0(p)
    assert {a["src"] for a in items} == {"take-a.wav", "take-b.wav"}
    for a, b in zip(items, items[1:]):
        assert abs(a["end"] - b["start"]) < 1e-3, "back to back"
    assert abs(items[-1]["end"] - applied["duration"]) < 1e-3
    assert applied["duration"] < 2 * DUR - 0.5, "the silences are gone"


def test_clips_picks_which_sources_are_cut(tmp_path, monkeypatch):
    make(tmp_path)
    run(tmp_path, monkeypatch, "--clips", "take-b")
    run(tmp_path, monkeypatch, "--clips", "take-b", "--plan", str(tmp_path / "cut-plan.md"))
    items = lane0(load(tmp_path))
    assert items and {a["src"] for a in items} == {"take-b.wav"}


def test_an_unknown_clip_id_is_refused_and_says_the_ids(tmp_path, monkeypatch, capsys):
    make(tmp_path)
    with pytest.raises(SystemExit):
        run(tmp_path, monkeypatch, "--clips", "nope")
    err = capsys.readouterr().err
    assert "nope" in err and "take-a" in err


def test_a_workflow_that_manages_its_own_phases_keeps_its_status(tmp_path, monkeypatch):
    make(tmp_path)
    run(tmp_path, monkeypatch)
    run(tmp_path, monkeypatch, "--plan", str(tmp_path / "cut-plan.md"))
    assert load(tmp_path)["status"] == "pending"


def test_a_pending_project_of_another_workflow_is_still_started_by_the_cut(tmp_path, monkeypatch):
    make(tmp_path, workflow="blank")
    run(tmp_path, monkeypatch)
    run(tmp_path, monkeypatch, "--plan", str(tmp_path / "cut-plan.md"))
    assert load(tmp_path)["status"] == "draft"


def test_a_changed_source_set_is_planned_again_not_called_already_cut(tmp_path, monkeypatch):
    make(tmp_path, takes=("take-a",))
    run(tmp_path, monkeypatch)
    run(tmp_path, monkeypatch, "--plan", str(tmp_path / "cut-plan.md"))
    assert run(tmp_path, monkeypatch)["mode"] == "already-cut", "nothing changed: as before"
    add_source(tmp_path, "take-c")
    again = run(tmp_path, monkeypatch)
    assert again["mode"] == "plan"
    assert any("take-c" in w for w in again.get("warnings", []) + again.get("notes", []))
