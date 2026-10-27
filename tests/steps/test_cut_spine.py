"""§590: a new project's timeline is empty (nothing is laid for the person or the AI), and cut builds the talking-head
spine from the project's sources: every take of every line in the plan as before, b-roll left out and named. A project
made before this, with its clips laid, cuts as it did. Helpers are test_cut's."""
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_cut import (FIX, SOURCE_S, SPEECH, _error, audio_project, git, narration, run, sections,  # noqa: E402
                      synthetic,  # noqa: E402
                      stub_transcribe)  # noqa: F401


def sources_project(tmp_path, clips, status="pending", laid=False):
    """A project as init now makes it: the clips in `sources`, trk-0 empty (`laid`: as init made it before §590)."""
    d = tmp_path / "proj"
    d.mkdir(parents=True)
    base = json.loads((FIX / "project.json").read_text())
    p = {k: base[k] for k in ("version", "settings", "status", "workflow", "editingPrompt")}
    sources = []
    for n, (name, tr) in enumerate(clips):
        shutil.copy(FIX / "speech.mp4", d / f"{name}.mp4")
        (d / f"{name}.json").write_text(json.dumps(tr))
        sources.append({"id": f"clip-{n}", "type": "video", "src": str(d / f"{name}.mp4"), "start": 0.0, "end": 0.0,
                        "sourceDuration": SOURCE_S, "sourceWidth": 64, "sourceHeight": 64})
    p.update({"id": "cut-fixture", "name": "Cut", "status": status, "sources": sources,
              "tracks": [{"id": "trk-0", "items": [dict(s) for s in sources] if laid else []}]})
    (d / "project.json").write_text(json.dumps(p, indent=2))
    git(d, "init", "-q")
    git(d, "add", "project.json")
    git(d, "commit", "-q", "-m", "init")
    return d


def _project(d):
    return json.loads((d / "project.json").read_text())


TWO = [("one", synthetic("Hey everyone, welcome back. We shipped it to Canada, Mexico and Brazil,")),
       ("two", synthetic("We shipped it to Canada, Mexico and Chile. Thanks for watching!"))]


def test_cut_on_an_empty_timeline_plans_every_source_and_writes_nothing(tmp_path, monkeypatch):
    d = sources_project(tmp_path, TWO)
    before = (d / "project.json").read_bytes()
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["mode"] == "plan" and plan["labels"] == {"retake?": 1}
    text = (d / "cut-plan.md").read_text()
    assert "Brazil" in text and "Chile" in text
    assert (d / "project.json").read_bytes() == before


def test_the_plan_is_the_one_a_laid_project_gets(tmp_path, monkeypatch):
    """The spine is what init used to lay: the same plan rows, made from the sources in memory."""
    a = sources_project(tmp_path / "a", TWO)
    b = sources_project(tmp_path / "b", TWO, laid=True)
    run(a, monkeypatch=monkeypatch)
    run(b, monkeypatch=monkeypatch)
    rows = [sections((d / "cut-plan.md").read_text()) for d in (a, b)]
    assert rows[0] == rows[1]


def test_the_apply_lays_the_cut_spine_and_starts_the_project(tmp_path, monkeypatch):
    d = sources_project(tmp_path, TWO)
    plan, _ = run(d, monkeypatch=monkeypatch)
    applied, _ = run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert applied["mode"] == "applied"
    p = _project(d)
    items = p["tracks"][0]["items"]
    assert items and {Path(it["src"]).name for it in items} == {"one.mp4", "two.mp4"}
    assert all(it["outPoint"] > it["inPoint"] for it in items)
    assert p["status"] == "draft"
    assert [s["id"] for s in p["sources"]] == ["clip-0", "clip-1"]


def test_b_roll_is_left_out_of_the_spine_and_named(tmp_path, monkeypatch):
    d = sources_project(tmp_path, [("speech", synthetic(SPEECH)),
                                   ("broll", synthetic("Thanks for watching!", start=12.0))])
    plan, _ = run(d, monkeypatch=monkeypatch)
    cut, unused = sections((d / "cut-plan.md").read_text())
    assert sum("Thanks for watching!" in r for r in cut + unused) == 1     # the speaker's own, not the b-roll's
    assert any("clip-1" in w and "b-roll" in w for w in plan["warnings"]), plan["warnings"]
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    items = _project(d)["tracks"][0]["items"]
    assert items and all(Path(it["src"]).name == "speech.mp4" for it in items)


def test_a_draft_the_person_opened_empty_still_cuts_from_its_sources(tmp_path, monkeypatch):
    """"Edit it yourself" leaves an empty draft; an AI asked to cut it builds the spine all the same."""
    d = sources_project(tmp_path, TWO, status="draft")
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["mode"] == "plan" and (d / "cut-plan.md").exists()


def test_an_empty_timeline_with_no_sources_is_still_refused(tmp_path, monkeypatch, capsys):
    d = sources_project(tmp_path, [])
    assert _error(d, monkeypatch=monkeypatch, capsys=capsys)["error"] == "no_clips"


def test_a_narration_cut_on_an_empty_timeline_lays_no_clip(tmp_path, monkeypatch):
    """The spine is built only for the video track cut: a voiceover cut leaves the sources where they are."""
    d = audio_project(tmp_path, voiceover=True)
    shutil.copy(FIX / "speech.mp4", d / "broll.mp4")
    p = _project(d)
    p["sources"] = [{"id": "clip-0", "type": "video", "src": str(d / "broll.mp4"), "start": 0.0, "end": 0.0,
                     "sourceDuration": SOURCE_S}]
    (d / "project.json").write_text(json.dumps(p, indent=2))
    git(d, "commit", "-qam", "sources")
    plan, _ = run(d, "--speech", "voiceover", monkeypatch=monkeypatch)
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    p = _project(d)
    assert p["tracks"][0]["items"] == [] and narration(p)


def test_the_plan_answer_carries_the_whole_plan_however_long(tmp_path, monkeypatch):
    """Sam, 2026-10-26: an answer that sends the AI back for the rest costs a turn. The plan is in the answer whole."""
    monkeypatch.setattr("steps.edit.cut.TEXT_INLINE_CAP", 10, raising=False)     # a cap, were there one, is far below it
    d = sources_project(tmp_path, TWO)
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["text"] == (d / "cut-plan.md").read_text()
