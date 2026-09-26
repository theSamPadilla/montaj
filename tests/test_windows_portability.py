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
import json
import ntpath
from pathlib import Path
from unittest.mock import Mock

import pytest
from starlette.testclient import TestClient

from lib import proc as proc_mod
import lib.normalize as normalize_mod
import serve.lockfile as lockfile_mod
import serve.routes.projects as projects_mod
from serve.server import app


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


# ---------------------------------------------------------------------------
# serve/routes/files.py — POST /api/files's "must be absolute" check goes
# through a module-level seam (_is_abs), not a hardcoded startswith("/"), so
# a Windows client's `C:\Users\a\x.jsx` isn't rejected purely for not
# starting with a slash. Proven via the ntpath seam, never sys.platform or a
# global os.path.isabs monkeypatch.
# ---------------------------------------------------------------------------

def test_write_file_posix_absolute_path_still_works(tmp_path, monkeypatch):
    """Sanity: on macOS, files._is_abs is os.path.isabs, which agrees with the
    old startswith("/") check for str paths — no behaviour change here."""
    monkeypatch.setattr("serve.routes.files.resolve_workspace", lambda: tmp_path)
    client = TestClient(app, raise_server_exceptions=False)

    target = tmp_path / "x.jsx"
    resp = client.post("/api/files", json={"path": str(target), "content": "ok"})

    assert resp.status_code == 200
    assert target.read_text() == "ok"


def test_write_file_relative_path_rejected_with_bad_request(tmp_path, monkeypatch):
    monkeypatch.setattr("serve.routes.files.resolve_workspace", lambda: tmp_path)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post("/api/files", json={"path": "relative/x.jsx", "content": "bad"})

    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "bad_request"


def test_write_file_windows_absolute_path_passes_isabs_gate_under_ntpath_seam(tmp_path, monkeypatch):
    """With files._is_abs swapped to ntpath.isabs (the injected Windows seam),
    a Windows-style absolute path like C:\\Users\\a\\x.jsx clears the "must be
    absolute" gate — it no longer starts with "/" so the old check would 400
    it. It still can't actually resolve into this POSIX workspace, so the
    request 403s afterward; the point proven here is specifically that it is
    no longer rejected as a *relative* path."""
    monkeypatch.setattr("serve.routes.files._is_abs", ntpath.isabs)
    monkeypatch.setattr("serve.routes.files.resolve_workspace", lambda: tmp_path)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post("/api/files", json={"path": r"C:\Users\a\x.jsx", "content": "bad"})

    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "forbidden"


# ---------------------------------------------------------------------------
# project/init.py — _copy_into_workspace's link=True path. Windows commonly
# denies CreateSymbolicLink to a non-elevated process (OSError winerror 1314,
# "A required privilege is not held by the client"); falling back to a real
# copy keeps project init working there instead of crashing the whole init.
# ---------------------------------------------------------------------------

def test_copy_into_workspace_falls_back_to_copy_when_symlink_denied(tmp_path, monkeypatch, capsys):
    import project.init as init_mod

    def _boom(src, dst):
        raise OSError(1314, "A required privilege is not held by the client")
    monkeypatch.setattr(init_mod.os, "symlink", _boom)

    src = tmp_path / "clip.mp4"
    src.write_bytes(b"fake video data")
    dest_dir = tmp_path / "workspace"
    dest_dir.mkdir()

    dest = init_mod._copy_into_workspace(str(src), str(dest_dir), "clip", link=True)

    dest_path = Path(dest)
    assert dest_path.is_file()
    assert not dest_path.is_symlink()
    assert dest_path.read_bytes() == b"fake video data"

    err_lines = [ln for ln in capsys.readouterr().err.strip().splitlines() if ln]
    assert len(err_lines) == 1
    assert "warning" in err_lines[0].lower()


def test_copy_into_workspace_symlinks_when_supported(tmp_path):
    """Unchanged macOS/Linux path: link=True still symlinks when os.symlink
    succeeds — the fallback only fires on OSError."""
    import project.init as init_mod

    src = tmp_path / "clip.mp4"
    src.write_bytes(b"fake video data")
    dest_dir = tmp_path / "workspace"
    dest_dir.mkdir()

    dest = init_mod._copy_into_workspace(str(src), str(dest_dir), "clip", link=True)

    dest_path = Path(dest)
    assert dest_path.is_symlink()


# ---------------------------------------------------------------------------
# lib/ai_video.py — save_project must write UTF-8 explicitly. Windows' default
# locale is a legacy code page (not UTF-8); Path.write_text's platform-default
# encoding would raise UnicodeEncodeError on a project with non-ASCII content
# (CJK names, emoji) instead of relying on it implicitly.
# ---------------------------------------------------------------------------

def test_save_project_writes_utf8_explicitly_and_round_trips_non_ascii(tmp_path, monkeypatch):
    calls = {}
    orig_write_text = Path.write_text

    def spy(self, data, *args, **kwargs):
        calls["encoding"] = kwargs.get("encoding")
        return orig_write_text(self, data, *args, **kwargs)
    monkeypatch.setattr(Path, "write_text", spy)

    from lib.ai_video import save_project
    path = tmp_path / "project.json"
    save_project(path, {"name": "名前 🎬"})

    assert calls.get("encoding") == "utf-8"
    raw = path.read_bytes()
    assert json.loads(raw.decode("utf-8"))["name"] == "名前 🎬"
