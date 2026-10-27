"""Sam, 1.5.1: Studio sync never refuses an AI or driven write, a recorded clash or not. Only a person's resolve keeps
its outside-the-clash check."""
import json
from pathlib import Path

from lib import sync_clash
from serve import save_guard
import serve.routes.steps as steps_mod
from tests.test_save_guard_sync import (  # noqa: F401  (fixtures)
    AI, DRIVE, PID, RESOLVE, recorder, state, ws, _client, _project, _sidecar, _step, ran,
)

ARGS = Path("/Users/Shared/synctest/place-args.json")


def _params():
    if ARGS.exists():
        return json.loads(ARGS.read_text())["params"]
    return {"items": [{"at": 1, "for": 2, "preset": "stat", "props": {}}]}


def _clash(state):
    _sidecar(state, fields=["tracks"], files=["overlays/"])


def test_sams_place_call_passes_the_step_check_on_a_synced_project_with_a_real_clash(ws, state, monkeypatch):
    _project(ws)
    _clash(state)
    body = {**_params(), "_project": PID, "_async": True}
    for headers in (AI, DRIVE):
        steps_mod.check_step_sync("place", {"parameters": []}, body, headers)
    monkeypatch.setenv("MONTAJ_WRITE_ORIGIN", "ai")
    sync_clash.check_step_write(PID, ["tracks"], ["overlays/a.jsx"])


def test_sams_place_call_is_not_refused_over_http(ws, state, ran):
    _project(ws)
    _clash(state)
    resp = _step("place", {**_params(), "_project": PID, "_async": True})
    assert resp.status_code != 409 and "sync_conflict" not in resp.text, resp.text


def test_an_ai_project_write_with_a_real_clash_is_not_refused(ws, state):
    _project(ws)
    _clash(state)
    for who in (AI, DRIVE):
        assert save_guard.sync_refusal(PID, who, ["tracks"]) is None
        assert save_guard.sync_refusal(PID, who, everything=True) is None


def test_an_unsure_set_touches_nothing():
    assert sync_clash.touched(sync_clash.UNSURE, ["tracks"], ["a"], True) == []
    assert sync_clash.unheld_touched(sync_clash.UNSURE, ["tracks"], ["a"], True) == []


def test_a_resolve_outside_its_clash_is_still_refused(ws, state):
    _project(ws)
    _sidecar(state, fields=["tracks", "captions"],
             clashes=[{"id": "c1", "fields": ["tracks"], "files": []}, {"id": "c2", "fields": ["captions"], "files": []}])
    body = save_guard.sync_refusal(PID, RESOLVE("c1"), ["captions"])
    assert body is not None and body["error"] == "sync_conflict"
    assert save_guard.sync_refusal(PID, RESOLVE("c1"), ["tracks"]) is None


def test_the_whole_project_is_named_in_words():
    assert "on the whole project, so" in sync_clash.message(["*"]) and "*" not in sync_clash.message(["*"])
