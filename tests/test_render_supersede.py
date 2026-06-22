"""Manual-render supersede semantics.

A new POST /render for a project whose previous render is still *tracked* (it
hung, or its SSE stream was abandoned so its ``finally`` never released the
slot) must kill that previous render and take over, rather than rejecting with
409 forever. A slot held by a non-render job (e.g. a carousel auto-render) still
blocks. Covers `_supersede_active_render` (the decision) and `_kill_render_proc`
(the kill mechanics).
"""
import signal
from unittest.mock import Mock

import pytest

import serve.routes.projects as projects_mod
from serve.routes.projects import _supersede_active_render, _kill_render_proc

PID = "22222222-2222-4222-8222-222222222222"


@pytest.fixture(autouse=True)
def _clean_state():
    projects_mod._active_renders.clear()
    projects_mod._render_procs.clear()
    yield
    projects_mod._active_renders.clear()
    projects_mod._render_procs.clear()


def test_supersede_kills_tracked_previous_render_and_proceeds(monkeypatch):
    killed = []
    monkeypatch.setattr(projects_mod, "_kill_render_proc", killed.append)
    prev = Mock(name="prev_render_proc")
    projects_mod._render_procs[PID] = prev
    projects_mod._active_renders.add(PID)

    assert _supersede_active_render(PID) is True       # new render takes over, no 409
    assert killed == [prev]                            # the previous render was killed
    assert PID not in projects_mod._render_procs       # its handle was cleared
    assert PID not in projects_mod._active_renders     # its slot was freed


def test_supersede_rejects_when_non_render_holds_slot(monkeypatch):
    # slot occupied but no tracked render proc — e.g. a carousel auto-render
    monkeypatch.setattr(projects_mod, "_kill_render_proc",
                        lambda p: pytest.fail("must not kill a non-render holder"))
    projects_mod._active_renders.add(PID)

    assert _supersede_active_render(PID) is False       # caller raises 409


def test_supersede_allows_when_idle():
    assert _supersede_active_render(PID) is True


def test_kill_render_proc_terminates_the_process_group(monkeypatch):
    calls = {}
    monkeypatch.setattr(projects_mod.os, "getpgid", lambda pid: 4242)
    monkeypatch.setattr(projects_mod.os, "killpg",
                        lambda pgid, sig: calls.update(pgid=pgid, sig=sig))

    _kill_render_proc(Mock(pid=999))

    assert calls == {"pgid": 4242, "sig": signal.SIGTERM}


def test_kill_render_proc_falls_back_to_proc_kill_when_group_gone(monkeypatch):
    def _no_group(pid):
        raise ProcessLookupError()
    monkeypatch.setattr(projects_mod.os, "getpgid", _no_group)
    proc = Mock(pid=999)

    _kill_render_proc(proc)

    proc.kill.assert_called_once()
