"""An unsure read of the Studio sync clash set is not a clash (1.5.1, Sam: "if the sync state can't be checked make
the edit optimistically"): the write goes through, the reason is logged once per id and reason a minute. Only a
readable recorded clash that covers what the write touches refuses, and a whole-project one reads "the whole
project", not `*`."""
import pytest
from fastapi import HTTPException

from lib import sync_clash
from serve import save_guard
from tests.test_save_guard_sync import (  # noqa: F401  (fixtures)
    AI, DRIVE, PID, recorder, state, ws, _client, _project, _sidecar, _disk, ran,
)


def test_the_whole_project_is_named_in_words():
    assert sync_clash.message(["*"]).startswith("This project has an open Studio sync clash on the whole project, so")
    assert "*" not in sync_clash.message(["*"])
    assert " on notes, the whole project, so" in sync_clash.message(["notes", "*"])
    assert " on notes, tracks, so" in sync_clash.message(["notes", "tracks"])


def test_check_step_write_on_an_unsure_read_passes(state, monkeypatch):
    monkeypatch.setenv("MONTAJ_WRITE_ORIGIN", "ai")
    monkeypatch.setattr(sync_clash, "_load", lambda pid: sync_clash.UNSURE)
    sync_clash.check_step_write(PID, ["tracks"])


def test_a_load_that_raises_is_unsure_not_an_error(state, monkeypatch):
    monkeypatch.setenv("MONTAJ_WRITE_ORIGIN", "ai")

    def boom(pid):
        raise RuntimeError("x")

    monkeypatch.setattr(sync_clash, "_load", boom)
    assert sync_clash.load(PID).unsure is True
    sync_clash.check_step_write(PID, ["tracks"])
    save_guard.check_sync(AI, PID, everything=True)


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
def test_an_unreadable_sidecar_lets_the_write_through(ws, state, how, headers):
    _project(ws)
    folder = state / PID
    folder.mkdir()
    if how == "a-folder":
        (folder / "clash-set.json").mkdir()
    else:
        (folder / "clash-set.json").write_text("{tracks")
    _whole(headers)


@pytest.mark.parametrize("pid", ["has a space", "x" * 65, "trailing."])
def test_a_project_id_that_cannot_name_a_folder_is_never_a_clash(ws, state, pid):
    """An id the app cannot sync (its folder rule) has no clash to read: the write goes through."""
    save_guard.check_sync(AI, pid, everything=True)
    save_guard.check_sync(AI, None, everything=True)


def test_a_whole_project_write_over_http_passes_on_an_unreadable_sidecar(ws, state):
    _project(ws)
    (state / PID).mkdir()
    (state / PID / "clash-set.json").write_text("nope")
    resp = _client().delete(f"/api/projects/{PID}", headers=AI)
    assert resp.status_code not in (403, 409, 503), resp.text


def test_an_unsure_read_logs_its_reason_once_a_minute(state, capsys):
    sync_clash._unsure_logged.clear()
    (state / PID).mkdir()
    (state / PID / "clash-set.json").write_text("nope")
    sync_clash.load(PID)
    sync_clash.load(PID)
    err = capsys.readouterr().err
    lines = [l for l in err.splitlines() if l.startswith(f"sync_clash: unsure for {PID}: ")]
    assert len(lines) == 1 and lines[0].endswith("; let through")
    assert str(state) not in err and "nope" not in err


@pytest.mark.parametrize("pid", ["Hacker News Video", "x" * 65])
def test_place_on_a_project_whose_id_cannot_name_a_state_folder_is_not_refused(ws, state, ran, pid):
    """The systematic case: no clash file anywhere, yet load() read an id outside the app's folder rule as unsure, and
    a whole-project check on it answered `*` (lib/sync_clash.py load(): the valid_project_id branch)."""
    from tests.test_save_guard_sync import _step
    _project(ws, pid=pid)
    resp = _step("place", {"project": pid, "at": "1", "preset": "callout"})
    assert resp.status_code != 409 and "sync_conflict" not in resp.text, resp.text
    save_guard.check_sync(AI, pid, everything=True)
