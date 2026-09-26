"""Windows-portability seams: lib/proc.py, and the callers that go through it.

`os.kill(pid, 0)` is a POSIX-only liveness probe: on Windows,
`signal.CTRL_C_EVENT == 0`, so CPython routes it to
`GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid)` instead of probing anything — a
console-attached caller can deliver Ctrl+C into its own console group, and a
console-less caller (an Electron-spawned serve) gets an uncaught OSError.
`os.killpg`/`os.getpgid` and `subprocess`'s `start_new_session` don't exist /
are silently ignored on Windows either, so a render's process tree could not
be killed the POSIX way, and children were never actually detached.

No Windows machine runs these tests (see montaj-app CLAUDE.md — "No Windows
machine"). Windows behaviour is proven entirely via injected seams: flipping
`lib.proc._IS_WINDOWS`, patching `lib.proc._win_query`, or (to exercise the
real ctypes-calling logic) faking `ctypes.windll`. Never `sys.platform`
globally — that would also flip every other module's own platform check.
"""
import ctypes
import inspect
from unittest.mock import Mock

import pytest

from lib import proc as proc_mod
import lib.normalize as normalize_mod
import serve.lockfile as lockfile_mod
import serve.routes.projects as projects_mod


# ---------------------------------------------------------------------------
# lib.proc.pid_alive — platform dispatch
# ---------------------------------------------------------------------------

def test_posix_process_lookup_error_is_not_alive(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    def _kill(pid, sig):
        raise ProcessLookupError()
    monkeypatch.setattr(proc_mod.os, "kill", _kill)
    assert proc_mod.pid_alive(12345) is False


def test_posix_permission_error_is_alive(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    def _kill(pid, sig):
        raise PermissionError()
    monkeypatch.setattr(proc_mod.os, "kill", _kill)
    assert proc_mod.pid_alive(12345) is True


def test_posix_success_is_alive(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    monkeypatch.setattr(proc_mod.os, "kill", lambda pid, sig: None)
    assert proc_mod.pid_alive(12345) is True


def test_windows_pid_alive_never_calls_os_kill(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", True)
    def _boom(pid, sig):
        raise AssertionError("os.kill must not be called on win32 (see module docstring)")
    monkeypatch.setattr(proc_mod.os, "kill", _boom)
    monkeypatch.setattr(proc_mod, "_win_query", lambda pid: True)
    assert proc_mod.pid_alive(999) is True

    monkeypatch.setattr(proc_mod, "_win_query", lambda pid: False)
    assert proc_mod.pid_alive(999) is False


# ---------------------------------------------------------------------------
# lib.proc._win_query — the actual ctypes call, proven with a faked kernel32
# ---------------------------------------------------------------------------

def _fake_windll(monkeypatch, *, open_returns, get_exit_ok, exit_code_value):
    """Installs a fake ctypes.windll.kernel32 and returns (kernel32, closed_handles)."""
    kernel32 = Mock()
    kernel32.OpenProcess.return_value = open_returns
    closed = []
    kernel32.CloseHandle.side_effect = lambda h: closed.append(h)

    def _get_exit_code(handle, ref):
        if not get_exit_ok:
            return 0
        ref._obj.value = exit_code_value
        return 1
    kernel32.GetExitCodeProcess.side_effect = _get_exit_code

    monkeypatch.setattr(proc_mod.ctypes, "windll", Mock(kernel32=kernel32), raising=False)
    return kernel32, closed


def test_win_query_open_process_fails_is_not_alive(monkeypatch):
    kernel32, closed = _fake_windll(monkeypatch, open_returns=0, get_exit_ok=True, exit_code_value=259)
    assert proc_mod._win_query(4242) is False
    kernel32.GetExitCodeProcess.assert_not_called()
    assert closed == []  # no handle to close


def test_win_query_still_active_is_alive(monkeypatch):
    kernel32, closed = _fake_windll(monkeypatch, open_returns=77, get_exit_ok=True, exit_code_value=259)
    assert proc_mod._win_query(4242) is True
    assert closed == [77]  # handle always closed


def test_win_query_exited_is_not_alive(monkeypatch):
    kernel32, closed = _fake_windll(monkeypatch, open_returns=77, get_exit_ok=True, exit_code_value=0)
    assert proc_mod._win_query(4242) is False
    assert closed == [77]


def test_win_query_get_exit_code_failure_closes_handle_and_is_not_alive(monkeypatch):
    kernel32, closed = _fake_windll(monkeypatch, open_returns=77, get_exit_ok=False, exit_code_value=259)
    assert proc_mod._win_query(4242) is False
    assert closed == [77]  # CloseHandle still called on the failure path


# ---------------------------------------------------------------------------
# lib.proc.kill_tree
# ---------------------------------------------------------------------------

def test_posix_kill_tree_terminates_the_process_group(monkeypatch):
    import signal as signal_mod
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    calls = {}
    monkeypatch.setattr(proc_mod.os, "getpgid", lambda pid: 4242)
    monkeypatch.setattr(proc_mod.os, "killpg", lambda pgid, sig: calls.update(pgid=pgid, sig=sig))

    proc_mod.kill_tree(Mock(pid=999))

    assert calls == {"pgid": 4242, "sig": signal_mod.SIGTERM}


def test_posix_kill_tree_falls_back_to_proc_kill_when_group_gone(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    def _no_group(pid):
        raise ProcessLookupError()
    monkeypatch.setattr(proc_mod.os, "getpgid", _no_group)
    proc = Mock(pid=999)

    proc_mod.kill_tree(proc)

    proc.kill.assert_called_once()


def test_windows_kill_tree_uses_taskkill_never_killpg(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", True)
    calls = []
    monkeypatch.setattr(proc_mod.subprocess, "run",
                         lambda cmd, **kw: calls.append(cmd) or Mock(returncode=0))
    def _boom(pid):
        raise AssertionError("os.getpgid must not be called on win32")
    monkeypatch.setattr(proc_mod.os, "getpgid", _boom)
    proc = Mock(pid=4321)

    proc_mod.kill_tree(proc)

    assert calls == [["taskkill", "/T", "/F", "/PID", "4321"]]
    proc.kill.assert_not_called()


def test_windows_kill_tree_falls_back_to_proc_kill_when_taskkill_fails(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", True)
    def _fail(cmd, **kw):
        raise FileNotFoundError("taskkill not found")
    monkeypatch.setattr(proc_mod.subprocess, "run", _fail)
    proc = Mock(pid=4321)

    proc_mod.kill_tree(proc)

    proc.kill.assert_called_once()


# ---------------------------------------------------------------------------
# lib.proc.detached_kwargs
# ---------------------------------------------------------------------------

def test_posix_detached_kwargs(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    assert proc_mod.detached_kwargs() == {"start_new_session": True}


def test_windows_detached_kwargs(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", True)
    assert proc_mod.detached_kwargs() == {
        "creationflags": getattr(proc_mod.subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)
    }


# ---------------------------------------------------------------------------
# serve/lockfile.py's _pid_alive — delegates to lib.proc, keeps ITS OWN extra
# handling of an ambiguous pid (OverflowError/ValueError -> False)
# ---------------------------------------------------------------------------

def test_lockfile_pid_alive_process_lookup_error_false(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    def _kill(pid, sig):
        raise ProcessLookupError()
    monkeypatch.setattr(proc_mod.os, "kill", _kill)
    assert lockfile_mod._pid_alive(1) is False


def test_lockfile_pid_alive_permission_error_true(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    def _kill(pid, sig):
        raise PermissionError()
    monkeypatch.setattr(proc_mod.os, "kill", _kill)
    assert lockfile_mod._pid_alive(1) is True


def test_lockfile_pid_alive_overflow_error_false(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    def _kill(pid, sig):
        raise OverflowError()
    monkeypatch.setattr(proc_mod.os, "kill", _kill)
    assert lockfile_mod._pid_alive(2 ** 64) is False


def test_lockfile_pid_alive_value_error_false(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    def _kill(pid, sig):
        raise ValueError()
    monkeypatch.setattr(proc_mod.os, "kill", _kill)
    assert lockfile_mod._pid_alive(-1) is False


def test_lockfile_pid_alive_windows_never_calls_os_kill(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", True)
    def _boom(pid, sig):
        raise AssertionError("must not call os.kill on win32")
    monkeypatch.setattr(proc_mod.os, "kill", _boom)
    monkeypatch.setattr(proc_mod, "_win_query", lambda pid: True)
    assert lockfile_mod._pid_alive(123) is True


# ---------------------------------------------------------------------------
# lib/normalize.py's _pid_alive — delegates to lib.proc, keeps ITS OWN extra
# handling of an ambiguous OSError (conservative: True, "don't reap")
# ---------------------------------------------------------------------------

def test_normalize_pid_alive_process_lookup_error_false(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    def _kill(pid, sig):
        raise ProcessLookupError()
    monkeypatch.setattr(proc_mod.os, "kill", _kill)
    assert normalize_mod._pid_alive(1) is False


def test_normalize_pid_alive_permission_error_true(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    def _kill(pid, sig):
        raise PermissionError()
    monkeypatch.setattr(proc_mod.os, "kill", _kill)
    assert normalize_mod._pid_alive(1) is True


def test_normalize_pid_alive_ambiguous_oserror_is_conservatively_true(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", False)
    def _kill(pid, sig):
        raise OSError("EINVAL")
    monkeypatch.setattr(proc_mod.os, "kill", _kill)
    assert normalize_mod._pid_alive(1) is True


def test_normalize_pid_alive_windows_never_calls_os_kill(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", True)
    def _boom(pid, sig):
        raise AssertionError("must not call os.kill on win32")
    monkeypatch.setattr(proc_mod.os, "kill", _boom)
    monkeypatch.setattr(proc_mod, "_win_query", lambda pid: False)
    assert normalize_mod._pid_alive(123) is False


# ---------------------------------------------------------------------------
# serve/routes/projects.py — render-kill delegates to lib.proc.kill_tree too
# ---------------------------------------------------------------------------

def test_kill_render_proc_uses_taskkill_on_windows(monkeypatch):
    monkeypatch.setattr(proc_mod, "_IS_WINDOWS", True)
    calls = []
    monkeypatch.setattr(proc_mod.subprocess, "run",
                         lambda cmd, **kw: calls.append(cmd) or Mock(returncode=0))
    def _boom(pid):
        raise AssertionError("os.getpgid must not be called on win32")
    monkeypatch.setattr(proc_mod.os, "getpgid", _boom)

    projects_mod._kill_render_proc(Mock(pid=4321))

    assert calls == [["taskkill", "/T", "/F", "/PID", "4321"]]


def test_projects_module_never_hardcodes_start_new_session():
    """Regression guard for the 3 call sites migrated to proc.detached_kwargs()
    (render subprocess, carousel auto-render, caption pipeline steps)."""
    src = inspect.getsource(projects_mod)
    assert "start_new_session=True" not in src
    assert "detached_kwargs" in src
