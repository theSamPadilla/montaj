"""jump_cut fails cleanly on clips that have not been
probed yet.

project/init.py creates fresh clips with only {id, type, src, start, end} —
no inPoint/outPoint (skills/SKILL.md tells the agent to run probe and set
those fields before editing). Before this guard, a raw
clip["outPoint"] - clip["inPoint"] index in this step
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
    find_project / save_project_changes are stubbed."""
    path = tmp_path / "project.json"
    saved = {}
    monkeypatch.setattr(module, "find_project", lambda pid: (path, project))
    monkeypatch.setattr(module, "save_project_changes", lambda p, orig, proj: saved.update(project=proj))
    monkeypatch.setattr(sys, "argv", argv)
    module.main()
    assert "project" in saved, "step did not save the project"
    return saved["project"]


def expect_missing_fields_fail(module, argv, project, monkeypatch, tmp_path, capsys, clip_id, step_name):
    """The step must fail(\"missing_fields\", ...) before writing anything."""
    monkeypatch.setattr(module, "find_project", lambda pid: (tmp_path / "project.json", project))
    monkeypatch.setattr(
        module, "save_project_changes",
        lambda p, orig, proj: pytest.fail("step must not save the project when a clip is unprobed"),
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


# ── jump_cut --spec and carried fields (§558 U1) ───────────────────────────

def rich_clip():
    c = probed_clip("clip-a", 0.0, dur=10.0)
    c.update({"proxySrc": "./clip-a_proxy.mp4", "sourceWidth": 1080, "sourceHeight": 1920,
              "sourceDuration": 10.0, "normalizedSrc": "./clip-a_n.mp4", "normalizedInPoint": 0})
    return c


def test_jump_cut_segments_carry_the_clip_preview_and_source_fields(monkeypatch, tmp_path):
    project = project_with(rich_clip())
    argv = ["jump_cut.py", "--project-id", "p1", "--clip-id", "clip-a", "--keeps", "[[1,2],[4,6]]"]
    out = run_step(jump_cut, argv, project, monkeypatch, tmp_path)
    for seg in out["tracks"][0]["items"]:
        assert seg["proxySrc"] == "./clip-a_proxy.mp4"
        assert (seg["sourceWidth"], seg["sourceHeight"], seg["sourceDuration"]) == (1080, 1920, 10.0)
        assert seg["normalizedSrc"] == "./clip-a_n.mp4" and seg["normalizedInPoint"] == 0


def test_jump_cut_spec_reads_keeps_from_a_trim_spec_in_source_time(monkeypatch, tmp_path):
    clip = rich_clip()
    clip["inPoint"], clip["outPoint"] = 2.0, 12.0
    spec = tmp_path / "clip-a_spec.json"
    spec.write_text(json.dumps({"input": "./clip-a.mp4", "keeps": [[3.0, 4.0], [6.0, 8.0]]}))
    argv = ["jump_cut.py", "--project-id", "p1", "--clip-id", "clip-a", "--spec", str(spec)]
    out = run_step(jump_cut, argv, project_with(clip), monkeypatch, tmp_path)
    segs = out["tracks"][0]["items"]
    assert [(s["inPoint"], s["outPoint"]) for s in segs] == [(3.0, 4.0), (6.0, 8.0)]
    assert [(s["start"], s["end"]) for s in segs] == [(0.0, 1.0), (1.0, 3.0)]


def test_jump_cut_spec_with_open_ended_keeps(monkeypatch, tmp_path):
    spec = tmp_path / "s.json"
    spec.write_text(json.dumps({"keeps": [[None, 1.0], [9.0, None]]}))
    argv = ["jump_cut.py", "--project-id", "p1", "--clip-id", "clip-a", "--spec", str(spec)]
    out = run_step(jump_cut, argv, project_with(probed_clip("clip-a", 0.0, dur=10.0)), monkeypatch, tmp_path)
    assert [(s["inPoint"], s["outPoint"]) for s in out["tracks"][0]["items"]] == [(0.0, 1.0), (9.0, 10.0)]


def test_jump_cut_spec_is_exclusive_with_keeps_and_cuts(monkeypatch, tmp_path):
    argv = ["jump_cut.py", "--project-id", "p1", "--clip-id", "clip-a", "--spec", "x.json", "--keeps", "[[0,1]]"]
    monkeypatch.setattr(sys, "argv", argv)
    with pytest.raises(SystemExit):
        jump_cut.main()


# ── review fixes (§558) ────────────────────────────────────────────────────

def write_spec(tmp_path, keeps, name="spec.json", **extra):
    p = tmp_path / name
    p.write_text(json.dumps({"keeps": keeps, **extra}))
    return str(p)


def spec_argv(clip_id, spec):
    return ["jump_cut.py", "--project-id", "p1", "--clip-id", clip_id, "--spec", spec]


def test_spec_works_on_an_init_placeholder_clip_and_two_clips_in_order(monkeypatch, tmp_path):
    monkeypatch.setattr(jump_cut, "get_duration", lambda p: 20.0)
    a = unprobed_clip("a")
    b = unprobed_clip("b")
    project = project_with(a, b)
    s1 = write_spec(tmp_path, [[1.0, 3.0], [5.0, 6.0]], "a.json", input="./a.mp4")
    s2 = write_spec(tmp_path, [[0.0, 2.0]], "b.json", input="./b.mp4")
    out = run_step(jump_cut, spec_argv("a", s1), project, monkeypatch, tmp_path)
    out = run_step(jump_cut, spec_argv("b", s2), out, monkeypatch, tmp_path)
    items = out["tracks"][0]["items"]
    assert [(i["src"], i["inPoint"], i["outPoint"], i["start"], i["end"]) for i in items] == [
        ("./a.mp4", 1.0, 3.0, 0.0, 2.0), ("./a.mp4", 5.0, 6.0, 2.0, 3.0), ("./b.mp4", 0.0, 2.0, 3.0, 5.0)]


def test_placeholder_clip_without_spec_still_fails(monkeypatch, tmp_path, capsys):
    argv = ["jump_cut.py", "--project-id", "p1", "--clip-id", "a", "--keeps", "[[0,1]]"]
    expect_missing_fields_fail(jump_cut, argv, project_with(unprobed_clip("a")), monkeypatch, tmp_path, capsys, "a", "jump_cut")


def test_a_legacy_normalized_cache_without_origin_is_anchored_at_the_clip_in_point(monkeypatch, tmp_path):
    clip = probed_clip("a", 0.0, dur=6.0)
    clip.update({"inPoint": 4.0, "outPoint": 10.0, "normalizedSrc": "./a_n.mp4"})
    argv = ["jump_cut.py", "--project-id", "p1", "--clip-id", "a", "--keeps", "[[1,2],[4,5]]"]
    out = run_step(jump_cut, argv, project_with(clip), monkeypatch, tmp_path)
    segs = out["tracks"][0]["items"]
    assert [s["inPoint"] - s["normalizedInPoint"] for s in segs] == [1.0, 4.0]


def test_a_spec_for_another_file_is_refused(monkeypatch, tmp_path, capsys):
    spec = write_spec(tmp_path, [[0, 1]], input="./other.mp4")
    monkeypatch.setattr(jump_cut, "save_project_changes", lambda *a: pytest.fail("must not save"))
    monkeypatch.setattr(jump_cut, "find_project", lambda pid: (tmp_path / "project.json", project_with(probed_clip("a", 0.0))))
    monkeypatch.setattr(sys, "argv", spec_argv("a", spec))
    with pytest.raises(SystemExit):
        jump_cut.main()
    assert "invalid_params" in capsys.readouterr().err


def test_a_spec_for_the_clip_proxy_is_accepted(monkeypatch, tmp_path):
    clip = probed_clip("a", 0.0)
    clip["proxySrc"] = "./a_proxy.mp4"
    spec = write_spec(tmp_path, [[0, 1]], input=str(tmp_path / "a_proxy.mp4"))
    out = run_step(jump_cut, spec_argv("a", spec), project_with(clip), monkeypatch, tmp_path)
    assert len(out["tracks"][0]["items"]) == 1


def test_segments_carry_the_human_set_fields(monkeypatch, tmp_path):
    clip = probed_clip("a", 0.0, dur=10.0)
    clip.update({"sourceCrop": {"x": 1}, "scale": 1.2, "offsetX": 5, "rotation": 3, "opacity": 0.5,
                 "volume": 0.8, "muted": True, "sourceCreatedAt": "2026-01-01T00:00:00Z"})
    argv = ["jump_cut.py", "--project-id", "p1", "--clip-id", "a", "--keeps", "[[1,2],[4,5]]"]
    out = run_step(jump_cut, argv, project_with(clip), monkeypatch, tmp_path)
    for s in out["tracks"][0]["items"]:
        for k in ("sourceCrop", "scale", "offsetX", "rotation", "opacity", "volume", "muted", "sourceCreatedAt"):
            assert s[k] == clip[k]


def test_segments_carry_the_mask_and_blend_mode(monkeypatch, tmp_path):
    clip = probed_clip("a", 0.0, dur=10.0)
    clip.update({"mask": {"shape": "ellipse", "feather": 0.1}, "blendMode": "screen", "blur": 40})
    argv = ["jump_cut.py", "--project-id", "p1", "--clip-id", "a", "--keeps", "[[1,2],[4,5]]"]
    out = run_step(jump_cut, argv, project_with(clip), monkeypatch, tmp_path)
    assert len(out["tracks"][0]["items"]) == 2
    for s in out["tracks"][0]["items"]:
        assert s["mask"] == clip["mask"] and s["blendMode"] == "screen" and s["blur"] == 40


@pytest.mark.parametrize("field,value", [("speed", 2), ("keyframes", [{"t": 0}])])
def test_a_clip_with_speed_or_keyframes_is_refused(monkeypatch, tmp_path, capsys, field, value):
    clip = probed_clip("a", 0.0)
    clip[field] = value
    monkeypatch.setattr(jump_cut, "save_project_changes", lambda *a: pytest.fail("must not save"))
    monkeypatch.setattr(jump_cut, "find_project", lambda pid: (tmp_path / "project.json", project_with(clip)))
    monkeypatch.setattr(sys, "argv", ["jump_cut.py", "--project-id", "p1", "--clip-id", "a", "--keeps", "[[0,1]]"])
    with pytest.raises(SystemExit):
        jump_cut.main()
    assert field in capsys.readouterr().err


def test_spec_keeps_are_clamped_to_the_clip(monkeypatch, tmp_path):
    spec = write_spec(tmp_path, [[-1.0, 2.0], [3.0, 99.0]])
    out = run_step(jump_cut, spec_argv("a", spec), project_with(probed_clip("a", 0.0, dur=4.0)), monkeypatch, tmp_path)
    assert [(s["inPoint"], s["outPoint"]) for s in out["tracks"][0]["items"]] == [(0.0, 2.0), (3.0, 4.0)]
