"""Step-level tests for steps/generate/kinovi_generate.py (§227).

Every test monkeypatches connectors.kinovi directly; the connector's own
HTTP-mocked tests (test_connectors_kinovi.py) cover what it does. Nothing here
makes a network call.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from connectors import ConnectorError, CONTENT_REFUSED, INSUFFICIENT_CREDIT
import connectors.kinovi as kinovi_mod

_STEP_PATH = REPO_ROOT / "steps" / "generate" / "kinovi_generate.py"


@pytest.fixture
def step_module():
    spec = importlib.util.spec_from_file_location("kinovi_generate_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _result(path, task="t-1"):
    return {"path": path, "taskId": task, "model": "seedance2-5", "creditsUsed": 295, "draft": False}


def _run(step_module, monkeypatch, argv):
    monkeypatch.setattr(sys, "argv", ["kinovi_generate.py", *argv])
    step_module.main()


def test_generate_with_the_default_model(step_module, monkeypatch, capsys, tmp_path):
    seen = {}

    def capture(**kw):
        seen.update(kw)
        return _result(kw["out_path"])
    monkeypatch.setattr(kinovi_mod, "generate_video", capture)
    _run(step_module, monkeypatch, ["--prompt", "a fox", "--out", str(tmp_path / "c.mp4"), "--json"])
    out = json.loads(capsys.readouterr().out)
    assert out["taskId"] == "t-1" and out["path"] == str(tmp_path / "c.mp4")
    assert seen["model"] == kinovi_mod.DEFAULT_VIDEO_MODEL == "seedance2-5"
    assert seen["sound"] is False and seen["duration"] == 5 and seen["resolution"] == "720p"


def test_frames_and_references_pass_through(step_module, monkeypatch, tmp_path):
    first, last, ref, vid = (tmp_path / n for n in ("a.png", "b.png", "r.png", "v.mp4"))
    for f in (first, last, ref, vid):
        f.write_bytes(b"x")
    seen = {}
    monkeypatch.setattr(kinovi_mod, "generate_video", lambda **kw: seen.update(kw) or _result(kw["out_path"]))
    _run(step_module, monkeypatch, ["--prompt", "a fox", "--out", str(tmp_path / "c.mp4"),
                                    "--image", str(first), "--end-image", str(last), "--sound", "--duration", "8"])
    assert (seen["image_path"], seen["end_image_path"], seen["sound"], seen["duration"]) == (str(first), str(last), True, 8)
    seen.clear()
    _run(step_module, monkeypatch, ["--prompt", "a fox", "--out", str(tmp_path / "c.mp4"), "--model", "seedance-20",
                                    "--ref-image", str(ref), "--ref-video", str(vid)])
    assert seen["reference_image_paths"] == [str(ref)] and seen["reference_video_paths"] == [str(vid)]


def test_task_id_resumes_without_a_new_task(step_module, monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(kinovi_mod, "generate_video", lambda **kw: pytest.fail("must not submit again"))
    monkeypatch.setattr(kinovi_mod, "resume", lambda task_id, out: _result(out, task_id))
    _run(step_module, monkeypatch, ["--task-id", "t-9", "--out", str(tmp_path / "c.mp4")])
    assert capsys.readouterr().out.strip() == str(tmp_path / "c.mp4")


def test_upgrade_a_draft(step_module, monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(kinovi_mod, "upgrade_draft", lambda draft, out: _result(out, "t-2"))
    _run(step_module, monkeypatch, ["--upgrade", "t-1", "--out", str(tmp_path / "hd.mp4"), "--json"])
    assert json.loads(capsys.readouterr().out)["taskId"] == "t-2"


@pytest.mark.parametrize("argv,message", [
    (["--out", "c.mp4"], "--prompt is required"),
    (["--task-id", "a", "--upgrade", "b", "--out", "c.mp4"], "not both"),
    (["--prompt", "x", "--out", "c.mp4", "--end-image", "b.png"], "--end-image requires --image"),
])
def test_invalid_args(step_module, monkeypatch, capsys, argv, message):
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, argv)
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "invalid_args" and message in err["message"]


def test_image_and_ref_image_are_exclusive(step_module, monkeypatch, capsys, tmp_path):
    a = tmp_path / "a.png"
    a.write_bytes(b"x")
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--prompt", "x", "--out", "c.mp4", "--image", str(a), "--ref-image", str(a)])
    assert "not both" in json.loads(capsys.readouterr().err)["message"]


@pytest.mark.parametrize("reason,code", [(CONTENT_REFUSED, "content_refused"), (INSUFFICIENT_CREDIT, "insufficient_credit")])
def test_failures_map_to_their_codes(step_module, monkeypatch, capsys, tmp_path, reason, code):
    def boom(**kw):
        raise ConnectorError("Kinovi refused it", reason=reason)
    monkeypatch.setattr(kinovi_mod, "generate_video", boom)
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--prompt", "x", "--out", str(tmp_path / "c.mp4")])
    assert json.loads(capsys.readouterr().err)["error"] == code
