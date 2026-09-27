"""jump_cut / cross_cut / montage fail cleanly on clips that have not been
probed yet.

project/init.py creates fresh clips with only {id, type, src, start, end} —
no inPoint/outPoint (skills/SKILL.md tells the agent to run probe and set
those fields before editing). Before this guard, a raw
clip["outPoint"] - clip["inPoint"] index in each of these three steps
surfaced as an uncaught KeyError traceback instead of a structured fail().
"""
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

import steps.edit.jump_cut as jump_cut
import steps.edit.cross_cut as cross_cut
import steps.edit.montage as montage


def unprobed_clip(cid, start=0.0, end=0.0):
    """Exactly what project/init.py hands back for a fresh clip: no inPoint/outPoint."""
    return {"id": cid, "type": "video", "src": f"./{cid}.mp4", "start": start, "end": end}


def probed_clip(cid, start, dur=4.0):
    return {
        "id": cid, "type": "video", "src": f"./{cid}.mp4",
        "start": start, "end": start + dur, "inPoint": 0.0, "outPoint": dur,
    }


def project_with(*clips):
    return {"id": "p1", "tracks": [{"id": "trk-0", "items": list(clips)}]}


def run_step(module, argv, project, monkeypatch, tmp_path):
    """Drive the step's real main() against an in-memory project. Only
    find_project / save_project are stubbed."""
    path = tmp_path / "project.json"
    saved = {}
    monkeypatch.setattr(module, "find_project", lambda pid: (path, project))
    monkeypatch.setattr(module, "save_project", lambda p, proj: saved.update(project=proj))
    monkeypatch.setattr(sys, "argv", argv)
    module.main()
    assert "project" in saved, "step did not save the project"
    return saved["project"]


def expect_missing_fields_fail(module, argv, project, monkeypatch, tmp_path, capsys, clip_id, step_name):
    """The step must fail(\"missing_fields\", ...) before writing anything."""
    monkeypatch.setattr(module, "find_project", lambda pid: (tmp_path / "project.json", project))
    monkeypatch.setattr(
        module, "save_project",
        lambda p, proj: pytest.fail("step must not save the project when a clip is unprobed"),
    )
    monkeypatch.setattr(sys, "argv", argv)

    with pytest.raises(SystemExit) as exc:
        module.main()
    assert exc.value.code == 1

    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "missing_fields"
    assert clip_id in err["message"]
    assert step_name in err["message"]
    assert "probe" in err["message"].lower()


# ── jump_cut ───────────────────────────────────────────────────────────────

def test_jump_cut_fails_cleanly_on_unprobed_clip(monkeypatch, tmp_path, capsys):
    project = project_with(unprobed_clip("clip-a"))
    argv = ["jump_cut.py", "--project-id", "p1", "--clip-id", "clip-a",
            "--cuts", json.dumps([[1.0, 2.0]])]
    expect_missing_fields_fail(jump_cut, argv, project, monkeypatch, tmp_path, capsys,
                                "clip-a", "jump_cut")


def test_jump_cut_still_works_on_a_probed_clip(monkeypatch, tmp_path, capsys):
    project = project_with(probed_clip("clip-a", 0.0, dur=4.0))
    argv = ["jump_cut.py", "--project-id", "p1", "--clip-id", "clip-a",
            "--cuts", json.dumps([[1.0, 2.0]])]
    out = run_step(jump_cut, argv, project, monkeypatch, tmp_path)

    items = out["tracks"][0]["items"]
    # cut [1,2] out of a 4s clip leaves two kept segments: [0,1] and [2,4]
    assert len(items) == 2


# ── cross_cut ──────────────────────────────────────────────────────────────

def test_cross_cut_fails_cleanly_when_clip_a_is_unprobed(monkeypatch, tmp_path, capsys):
    project = project_with(unprobed_clip("clip-a"), probed_clip("clip-b", 4.0, dur=4.0))
    argv = ["cross_cut.py", "--project-id", "p1", "--clip-a", "clip-a",
            "--clip-b", "clip-b", "--segment-duration", "1.5"]
    expect_missing_fields_fail(cross_cut, argv, project, monkeypatch, tmp_path, capsys,
                                "clip-a", "cross_cut")


def test_cross_cut_fails_cleanly_when_clip_b_is_unprobed(monkeypatch, tmp_path, capsys):
    project = project_with(probed_clip("clip-a", 0.0, dur=4.0), unprobed_clip("clip-b", start=4.0, end=4.0))
    argv = ["cross_cut.py", "--project-id", "p1", "--clip-a", "clip-a",
            "--clip-b", "clip-b", "--segment-duration", "1.5"]
    expect_missing_fields_fail(cross_cut, argv, project, monkeypatch, tmp_path, capsys,
                                "clip-b", "cross_cut")


def test_cross_cut_still_works_on_probed_clips(monkeypatch, tmp_path, capsys):
    project = project_with(probed_clip("clip-a", 0.0, dur=4.0), probed_clip("clip-b", 4.0, dur=4.0))
    argv = ["cross_cut.py", "--project-id", "p1", "--clip-a", "clip-a",
            "--clip-b", "clip-b", "--segment-duration", "1.5"]
    out = run_step(cross_cut, argv, project, monkeypatch, tmp_path)

    items = out["tracks"][0]["items"]
    assert len(items) > 0


# ── montage ────────────────────────────────────────────────────────────────

def test_montage_fails_cleanly_on_an_unprobed_clip(monkeypatch, tmp_path, capsys):
    project = project_with(unprobed_clip("clip-a"), probed_clip("clip-b", 4.0, dur=4.0))
    argv = ["montage.py", "--project-id", "p1",
            "--clips", json.dumps(["clip-a", "clip-b"]), "--beat-duration", "1.0"]
    expect_missing_fields_fail(montage, argv, project, monkeypatch, tmp_path, capsys,
                                "clip-a", "montage")


def test_montage_still_works_on_probed_clips(monkeypatch, tmp_path, capsys):
    project = project_with(probed_clip("clip-a", 0.0, dur=4.0), probed_clip("clip-b", 4.0, dur=4.0))
    argv = ["montage.py", "--project-id", "p1",
            "--clips", json.dumps(["clip-a", "clip-b"]), "--beat-duration", "1.0"]
    out = run_step(montage, argv, project, monkeypatch, tmp_path)

    items = out["tracks"][0]["items"]
    assert len(items) > 0
