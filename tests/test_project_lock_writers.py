"""Writers that used to clobber a concurrent edit (§467): steps re-read
project.json under the lock and write only the fields they changed."""
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

from tests.test_project_lock import spawn_holder  # noqa: E402
import lib.ai_video as ai_video  # noqa: E402
import steps.edit.jump_cut as jump_cut  # noqa: E402


def _clip(cid, start, dur=4.0):
    return {"id": cid, "type": "video", "src": f"./{cid}.mp4", "start": start,
            "end": start + dur, "inPoint": 0.0, "outPoint": dur}


def _write(tmp_path, **extra):
    path = tmp_path / "project.json"
    path.write_text(json.dumps({"id": "p1", "name": "orig",
                                "tracks": [{"id": "trk-0", "items": [_clip("clip-a", 0.0)]}], **extra}))
    return path


def _argv():
    return ["jump_cut.py", "--project-id", "p1", "--clip-id", "clip-a", "--cuts", json.dumps([[1.0, 2.0]])]


def _run_jump_cut(monkeypatch, path):
    """Real main() and real save; find_project reads the file once, as at step start."""
    monkeypatch.setattr(jump_cut, "find_project", lambda pid: (path, json.loads(path.read_text())))
    monkeypatch.setattr(sys, "argv", _argv())
    jump_cut.main()


def test_jump_cut_keeps_a_rename_made_during_the_run(monkeypatch, tmp_path):
    path = _write(tmp_path)
    real_find = jump_cut.find_project

    def find_then_human_edit(pid):
        got = (path, json.loads(path.read_text()))
        doc = json.loads(path.read_text())
        doc["name"] = "renamed by hand"        # lands after the step's read
        path.write_text(json.dumps(doc))
        return got

    monkeypatch.setattr(jump_cut, "find_project", find_then_human_edit)
    monkeypatch.setattr(sys, "argv", _argv())
    jump_cut.main()
    doc = json.loads(path.read_text())
    assert doc["name"] == "renamed by hand"
    assert len(doc["tracks"][0]["items"]) == 2          # the cut landed


def test_jump_cut_refuses_when_tracks_changed(monkeypatch, tmp_path, capsys):
    path = _write(tmp_path)

    def find_then_track_edit(pid):
        got = (path, json.loads(path.read_text()))
        doc = json.loads(path.read_text())
        doc["tracks"][0]["items"].append(_clip("clip-b", 4.0))
        path.write_text(json.dumps(doc))
        return got

    monkeypatch.setattr(jump_cut, "find_project", find_then_track_edit)
    monkeypatch.setattr(sys, "argv", _argv())
    before = None
    with pytest.raises(SystemExit) as exc:
        jump_cut.main()
    assert exc.value.code == 1
    err = json.loads(capsys.readouterr().err)
    assert err == {"error": "project_changed",
                   "message": "The project's tracks changed while this step ran: read it again and redo the cut."}
    assert [i["id"] for i in json.loads(path.read_text())["tracks"][0]["items"]] == ["clip-a", "clip-b"]


def test_jump_cut_waits_for_the_lock_then_applies_on_the_fresh_document(monkeypatch, tmp_path):
    path = _write(tmp_path)
    holder = spawn_holder(path, 0.6)
    # the holder (another process) edits the name before releasing: write it while it holds
    doc = json.loads(path.read_text())
    doc["name"] = "edited during write"
    path.write_text(json.dumps(doc))
    started = time.monotonic()
    _run_jump_cut(monkeypatch, path)
    assert time.monotonic() - started >= 0.3
    holder.wait()
    out = json.loads(path.read_text())
    assert out["name"] == "edited during write"
    assert len(out["tracks"][0]["items"]) == 2


def test_save_clip_keeps_a_concurrent_edit(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_video, "probe_video", lambda p: None)
    monkeypatch.setattr(ai_video, "get_duration", lambda p: 2.0)
    scene = {"id": "s1", "duration": 2.0}
    path = tmp_path / "project.json"
    path.write_text(json.dumps({"id": "p1", "name": "orig", "storyboard": {"scenes": [scene]},
                                "tracks": [{"id": "trk-0", "items": []}]}))
    stale = json.loads(path.read_text())
    doc = json.loads(path.read_text())
    doc["name"] = "human"
    path.write_text(json.dumps(doc))
    clip_file = tmp_path / "c.mp4"
    clip_file.write_bytes(b"")
    ai_video.save_clip_to_project(path, stale, scene, str(clip_file), "prompt")
    out = json.loads(path.read_text())
    assert out["name"] == "human"
    assert out["tracks"][0]["items"][0]["id"] == "clip-s1"
    assert out["status"] == "draft"


def test_save_error_keeps_a_concurrent_edit(tmp_path):
    scene = {"id": "s1", "duration": 2.0}
    path = tmp_path / "project.json"
    path.write_text(json.dumps({"id": "p1", "name": "orig", "storyboard": {"scenes": [scene]}}))
    stale = json.loads(path.read_text())
    doc = json.loads(path.read_text())
    doc["name"] = "human"
    path.write_text(json.dumps(doc))
    ai_video.save_error_to_project(path, stale, "s1", "boom")
    out = json.loads(path.read_text())
    assert out["name"] == "human"
    assert out["storyboard"]["scenes"][0]["lastError"]["message"] == "boom"


# ── serve: the PUT holds the project lock (§467) ─────────────────────────────

from tests.test_server_canvas_follows_footage import _setup as _serve_setup, client  # noqa: E402,F401
from tests.test_server_source_dims import PID  # noqa: E402


def test_put_waits_for_another_process_holding_the_lock_then_lands(client, tmp_path):
    c, holder = client
    holder["dir"] = _serve_setup(tmp_path)
    proc = spawn_holder(holder["dir"] / "project.json", 0.8)
    try:
        started = time.monotonic()
        resp = c.put(f"/api/projects/{PID}", json={"id": PID, "name": "after the lock"})
        waited = time.monotonic() - started
    finally:
        proc.wait()
    assert resp.status_code == 200, resp.text
    assert waited >= 0.4
    assert json.loads((holder["dir"] / "project.json").read_text())["name"] == "after the lock"
