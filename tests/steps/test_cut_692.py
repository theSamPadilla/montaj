"""§692: a narration of two audio takes on a voiceover track (a short take 1, a long take 2), as the report had it: a
row of the short take that no item plays ([earlier]) moved into ## Cut must play from ITS file; a plan made stale by
a transcript change is planned again by a plain cut on the base the waiting plan was made on; and the apply's seams
name every word that plays. Transcripts are sidecars beside each wav: no model runs."""
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

RATE = 16000
# take 1: one line; take 2: two lines with a pause between. Words (text, from ms, to ms) on their voiced spans; take
# 2's "same" is a zero-length word, as whisper often gives a short word.
TAKE1 = ([(0.3, False), (1.6, True), (0.4, False)],
         [(" What", 300, 550), (" if", 600, 800), (" instead", 850, 1300), (" of", 1350, 1500), (" training.", 1550, 1900)])
TAKE2 = ([(0.3, False), (1.7, True), (1.0, False), (1.6, True), (0.6, False)],
         [(" That", 300, 600), (" same", 650, 650), (" year,", 700, 1100), (" Uber's", 1150, 1500), (" fleet", 1550, 2000),
          (" Robots", 3000, 3400), (" learn", 3450, 3800), (" by", 3850, 4000), (" watching.", 4050, 4600)])


def wav(path, segments, words, seed):
    rng = random.Random(seed)
    frames = []
    for secs, loud in segments:
        for i in range(int(secs * RATE)):
            frames.append(int(8000 * math.sin(i * 0.35) if loud else rng.randint(-3, 3)))
    with wave.open(str(path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", x) for x in frames))
    sidecar(path, words)
    return sum(s for s, _ in segments)


def sidecar(path, words):
    path.with_suffix(".json").write_text(json.dumps({"transcription": [
        {"text": t, "offsets": {"from": a, "to": b}} for t, a, b in words]}))


def make(d):
    """Take 2 on the timeline as the voiceover; take 1 a source no item plays (an earlier cut took it)."""
    wav(d / "take1.wav", *TAKE1, seed=1)
    dur2 = wav(d / "take2.wav", *TAKE2, seed=2)
    project = {
        "version": "0.1", "id": "two-takes", "name": "two takes", "status": "draft", "workflow": "blank",
        "editingPrompt": "", "settings": {"resolution": [1080, 1920], "fps": 30}, "tracks": [],
        "sources": [{"id": "take1", "type": "audio", "src": "take1.wav"},
                    {"id": "take2", "type": "audio", "src": "take2.wav"}],
        "audio": {"tracks": [{"id": "vo", "type": "voiceover", "src": "take2.wav", "start": 0.0, "end": dur2,
                              "inPoint": 0.0, "outPoint": dur2, "volume": 1}]},
    }
    (d / "project.json").write_text(json.dumps(project, indent=2))


def run(d, monkeypatch, *extra):
    monkeypatch.setattr(sys, "argv", ["cut.py", "--project", str(d / "project.json"), "--speech", "audio:voiceover",
                                      *extra])
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        cc.main()
    return json.loads(out.getvalue())


def refused(d, monkeypatch, capsys, *extra):
    with pytest.raises(SystemExit):
        run(d, monkeypatch, *extra)
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


def load(d):
    return json.loads((d / "project.json").read_text())


def b1_into_cut(text, words):
    """The plan with take 1's [earlier] row moved into ## Cut above the first row, trimmed to its first `words`."""
    lines = text.split("\n")
    row = next(ln for ln in lines if ln.startswith("B1 ") and ln.endswith("[earlier]"))
    lines.remove(row)
    first = next(k for k, ln in enumerate(lines) if ln.startswith("A1 "))
    lines.insert(first, "B1 " + " ".join(row.split()[1:1 + words]))
    return "\n".join(lines)


def test_an_earlier_row_of_a_take_no_item_plays_plays_from_its_own_file(tmp_path, monkeypatch):
    make(tmp_path)
    plan = run(tmp_path, monkeypatch)
    assert "B = take1.wav" in plan["text"] and "B1 What if instead of training. [earlier]" in plan["text"]
    edited = b1_into_cut(plan["text"], 2)
    (tmp_path / "cut-plan.md").write_text(edited)
    run(tmp_path, monkeypatch, "--plan", str(tmp_path / "cut-plan.md"))
    items = sorted(load(tmp_path)["audio"]["tracks"], key=lambda a: a["start"])
    first = items[0]
    assert first["src"] == "take1.wav", f"B1 plays take 1's times from {first['src']}"
    assert 0.2 < first["inPoint"] < first["outPoint"] < 1.0
    assert all(a["src"] == "take2.wav" for a in items[1:])


def test_a_plain_cut_plans_a_stale_recut_plan_again_as_a_recut(tmp_path, monkeypatch, capsys):
    make(tmp_path)
    run(tmp_path, monkeypatch)
    run(tmp_path, monkeypatch, "--plan", str(tmp_path / "cut-plan.md"))
    recut = run(tmp_path, monkeypatch, "--recut")
    assert recut["mode"] == "plan"
    # a transcribe writes take 2's sidecar again, with a word heard differently
    sidecar(tmp_path / "take2.wav", [(" This" if t == " That" else t, a, b) for t, a, b in TAKE2[1]])
    err = refused(tmp_path, monkeypatch, capsys, "--plan", str(tmp_path / "cut-plan.md"))
    assert err["error"] == "stale_plan"
    again = run(tmp_path, monkeypatch)
    assert again["mode"] == "plan", again
    assert "This same year," in again["text"]
    assert again["text"] == run(tmp_path, monkeypatch, "--recut")["text"], "planned on the same base as a recut"
    assert run(tmp_path, monkeypatch, "--plan", str(tmp_path / "cut-plan.md"))["mode"] == "applied"
    assert run(tmp_path, monkeypatch)["mode"] == "already-cut", "nothing waits to be applied now"


def test_a_plain_cut_never_plans_a_cut_project_again_for_a_first_pass_plan(tmp_path, monkeypatch, capsys):
    """A plan made before the cut that applied (here at another max-pause, applied as another text) is the first
    pass's: planning it again would cut the cut's output twice."""
    make(tmp_path)
    other = run(tmp_path, monkeypatch, "--max-pause", "0.8")["text"]
    run(tmp_path, monkeypatch)
    run(tmp_path, monkeypatch, "--plan", other)
    sidecar(tmp_path / "take2.wav", [(" This" if t == " That" else t, a, b) for t, a, b in TAKE2[1]])
    assert run(tmp_path, monkeypatch)["mode"] == "already-cut"


def test_the_seams_name_a_short_word_that_plays(tmp_path, monkeypatch):
    make(tmp_path)
    plan = run(tmp_path, monkeypatch)
    (tmp_path / "cut-plan.md").write_text(b1_into_cut(plan["text"], 2))
    applied = run(tmp_path, monkeypatch, "--plan", str(tmp_path / "cut-plan.md"))
    assert any(s.split(" | ")[1].startswith("That same year,") for s in applied["seams"]), applied["seams"]
