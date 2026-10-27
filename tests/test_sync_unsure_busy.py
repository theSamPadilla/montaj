"""An unsure read of the Studio sync clash set is not a clash (1.5.1, Sam): it waits and re-reads, and when it is
still unsure the answer is a retryable 503 sync_state_busy, never "A person must resolve it". A real clash that
covers what the write touches still refuses, and a whole-project one says "the whole project", not `*`."""
import json
import time

import pytest
from fastapi import HTTPException

from lib import sync_clash
from serve import save_guard
from tests.test_save_guard_sync import (  # noqa: F401  (fixtures)
    AI, DRIVE, PID, recorder, state, ws, _client, _project, _sidecar, _step, _disk, ran,
)

BUSY = {"error": "sync_state_busy",
        "message": "Montaj couldn't read this project's Studio sync state just now, so nothing was saved. "
                   "Run the same call again in a moment."}


def _no_sleep(monkeypatch):
    slept = []
    monkeypatch.setattr(time, "sleep", lambda s: slept.append(s))
    return slept


def test_load_settled_rereads_an_unsure_first_read(monkeypatch):
    _no_sleep(monkeypatch)
    reads = iter([sync_clash.UNSURE, sync_clash.NO_CLASH])
    monkeypatch.setattr(sync_clash, "load", lambda pid: next(reads))
    assert sync_clash.load_settled(PID) is sync_clash.NO_CLASH


def test_load_settled_gives_up_unsure_after_its_tries(monkeypatch):
    slept = _no_sleep(monkeypatch)
    calls = []
    monkeypatch.setattr(sync_clash, "load", lambda pid: calls.append(1) or sync_clash.UNSURE)
    assert sync_clash.load_settled(PID).unsure is True
    assert len(calls) == 5 and len(slept) == 4


def test_the_busy_body_is_exact():
    assert sync_clash.busy() == BUSY


def test_the_whole_project_is_named_in_words():
    assert sync_clash.message(["*"]).startswith("This project has an open Studio sync clash on the whole project, so")
    assert "*" not in sync_clash.message(["*"])
    assert " on notes, the whole project, so" in sync_clash.message(["notes", "*"])
    assert " on notes, tracks, so" in sync_clash.message(["notes", "tracks"])


def test_check_step_write_on_a_persistent_unsure_raises_busy_not_a_clash(state, monkeypatch):
    _no_sleep(monkeypatch)
    monkeypatch.setenv("MONTAJ_WRITE_ORIGIN", "ai")
    monkeypatch.setattr(sync_clash, "load", lambda pid: sync_clash.UNSURE)
    with pytest.raises(sync_clash.SyncBusy) as e:
        sync_clash.check_step_write(PID, ["tracks"])
    assert e.value.body == BUSY


def test_check_step_write_passes_when_the_second_read_is_sure(state, monkeypatch):
    _no_sleep(monkeypatch)
    monkeypatch.setenv("MONTAJ_WRITE_ORIGIN", "ai")
    reads = iter([sync_clash.UNSURE, sync_clash.NO_CLASH])
    monkeypatch.setattr(sync_clash, "load", lambda pid: next(reads))
    sync_clash.check_step_write(PID, ["tracks"])


def test_a_step_exits_with_the_busy_body(state, monkeypatch, capsys):
    _no_sleep(monkeypatch)
    monkeypatch.setenv("MONTAJ_WRITE_ORIGIN", "ai")
    monkeypatch.setattr(sync_clash, "load", lambda pid: sync_clash.UNSURE)
    with pytest.raises(SystemExit) as e:
        try:
            sync_clash.check_step_write(PID, ["tracks"])
        except sync_clash.SyncBusy as busy:
            sync_clash.exit_refused(busy.body)
    assert e.value.code == 1
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1]) == BUSY


def test_update_project_or_fail_exits_with_the_busy_body(tmp_path, state, monkeypatch, capsys):
    from lib.project_lock import update_project_or_fail, write_json_atomic
    _no_sleep(monkeypatch)
    monkeypatch.setenv("MONTAJ_WRITE_ORIGIN", "ai")
    monkeypatch.setattr(sync_clash, "load", lambda pid: sync_clash.UNSURE)
    path = tmp_path / "project.json"
    write_json_atomic(path, {"id": PID, "tracks": [], "notes": []})

    def fail(code, message):
        raise AssertionError(code)

    with pytest.raises(SystemExit):
        update_project_or_fail(path, lambda p: {**p, "tracks": [1]}, fail)
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1]) == BUSY


def test_serve_answers_a_childs_busy_exit_with_503(ws, state, monkeypatch):
    import serve.routes.steps as steps_mod

    async def fake(cmd, *, timeout, cwd=None, env=None, **kwargs):
        return "", json.dumps(BUSY), 1

    monkeypatch.setattr(steps_mod, "run_subprocess", fake)
    _project(ws)
    resp = _step("jump_cut", {"project-id": PID, "clip-id": "clip-0", "cuts": "[]"})
    assert resp.status_code == 503, resp.text
    assert resp.json()["detail"] == BUSY


# serve, whole-project write by the AI (what `place` was refused with)


def _whole(headers=AI):
    save_guard.check_sync(headers, PID, everything=True)


def test_a_whole_project_write_passes_with_no_sidecar(ws, state):
    _project(ws)
    _whole()


def test_a_whole_project_clash_still_refuses_and_says_the_whole_project(ws, state):
    _project(ws)
    _sidecar(state, fields=["*"], files=["*"])
    with pytest.raises(HTTPException) as e:
        _whole()
    assert e.value.status_code == 409
    detail = e.value.detail
    assert detail["error"] == "sync_conflict"
    assert "the whole project" in detail["message"] and " on *," not in detail["message"]


@pytest.mark.parametrize("how", ["a-folder", "not-json"])
@pytest.mark.parametrize("headers", [AI, DRIVE], ids=["ai", "drive"])
def test_an_unreadable_sidecar_is_busy_not_a_clash(ws, state, monkeypatch, how, headers):
    _no_sleep(monkeypatch)
    _project(ws)
    folder = state / PID
    folder.mkdir()
    if how == "a-folder":
        (folder / "clash-set.json").mkdir()
    else:
        (folder / "clash-set.json").write_text("{tracks")
    with pytest.raises(HTTPException) as e:
        _whole(headers)
    assert e.value.status_code == 503
    assert e.value.detail == BUSY
    assert "person must resolve" not in e.value.detail["message"] and "Do not retry" not in e.value.detail["message"]


def test_a_transient_unsure_between_lstat_and_open_passes(ws, state, monkeypatch):
    _no_sleep(monkeypatch)
    _project(ws)
    real = sync_clash.load
    first = []

    def flaky(pid):
        if not first:
            first.append(1)
            return sync_clash.UNSURE
        return real(pid)

    monkeypatch.setattr(sync_clash, "load", flaky)
    _whole()


def test_the_http_answer_is_a_503_for_a_whole_project_write(ws, state, monkeypatch):
    _no_sleep(monkeypatch)
    d = _project(ws)
    (state / PID).mkdir()
    (state / PID / "clash-set.json").write_text("nope")
    before = _disk(d)
    resp = _client().delete(f"/api/projects/{PID}", headers=AI)
    assert resp.status_code == 503, resp.text
    assert resp.json()["detail"] == BUSY
    assert _disk(d) == before


def test_an_unsure_read_logs_its_reason_once_a_minute(state, monkeypatch, capsys):
    _no_sleep(monkeypatch)
    sync_clash._unsure_logged.clear()
    (state / PID).mkdir()
    (state / PID / "clash-set.json").write_text("nope")
    sync_clash.load(PID)
    sync_clash.load(PID)
    err = capsys.readouterr().err
    lines = [l for l in err.splitlines() if l.startswith(f"sync_clash: unsure for {PID}: ")]
    assert len(lines) == 1
    assert str(state) not in err and "nope" not in err
