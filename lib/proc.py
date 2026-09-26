#!/usr/bin/env python3
"""Process helpers that are safe on Windows: pid liveness and tree-kill.

`os.kill(pid, 0)` is a POSIX-only liveness probe. On Windows,
`signal.CTRL_C_EVENT == 0`, so CPython routes it to
`GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid)` instead of probing anything —
with a console attached that can deliver Ctrl+C into the probing process's
own console group, and with no console (an Electron-spawned serve) it raises
an OSError that callers don't expect. `os.killpg`/`os.getpgid` don't exist on
Windows either (AttributeError), and `start_new_session` is silently ignored
by `subprocess`/`asyncio.create_subprocess_exec` there, so a render's process
tree was never actually detached or killable as a group.

Windows-vs-POSIX seam, same convention as lib/common.py's `_EXE_SUFFIX`:
tests patch `_IS_WINDOWS` (and, to reach the ctypes call, `_win_query`) on
THIS module, never `sys.platform` globally — that would also flip every
other module's own platform check.
"""
import ctypes
from ctypes import wintypes
import os
import signal
import subprocess
import sys

_IS_WINDOWS = sys.platform == "win32"


def _win_query(pid: int) -> bool:
    """True if a Windows process with this pid is still running.

    `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `GetExitCodeProcess`
    == `STILL_ACTIVE` (259) — the standard Windows liveness probe (never
    `os.kill`, see module docstring). Any handle OpenProcess hands back is
    always closed, including on the GetExitCodeProcess-failure path.

    Kept as its own function (rather than inlined into `pid_alive`) so tests
    — run on macOS, where `ctypes.windll` doesn't exist — can monkeypatch
    this one call directly instead of faking the whole ctypes layer.
    """
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return False
        return exit_code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def pid_alive(pid: int) -> bool:
    """True if a process with this pid currently exists (best-effort).

    POSIX: `os.kill(pid, 0)`. `ProcessLookupError` -> False (gone).
    `PermissionError` -> True (exists, owned by someone else). Any other
    `OSError` (an ambiguous errno, or a bad pid raising `OverflowError` /
    `ValueError`) is NOT caught here and propagates to the caller — the two
    current callers (serve/lockfile.py, lib/normalize.py) disagreed on how to
    treat that case before this module existed, so each keeps deciding it
    its own way rather than this function picking a winner silently.

    Windows: `_win_query` (never `os.kill` — see module docstring).
    """
    if _IS_WINDOWS:
        return _win_query(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists but owned by another user
    return True


def kill_tree(proc) -> None:
    """Kill `proc`'s whole process tree so orphaned ffmpeg/browser children die too.

    POSIX: SIGTERMs the process group (`os.killpg(os.getpgid(proc.pid), ...)`),
    falling back to `proc.kill()` if the group is already gone.

    Windows has neither `os.killpg` nor `os.getpgid` (AttributeError); the
    equivalent is `taskkill /T /F /PID <pid>` (`/T` kills the whole tree
    rooted at pid, `/F` forces it), falling back to `proc.kill()` if taskkill
    itself fails to run. Never touches `os.killpg`/`os.getpgid` on Windows.
    """
    if _IS_WINDOWS:
        try:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                check=True,
                capture_output=True,
            )
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, OSError):
        try:
            proc.kill()
        except Exception:
            pass


def detached_kwargs() -> dict:
    """subprocess / `asyncio.create_subprocess_exec` kwargs that put a child in
    its own process group, so `kill_tree` can reach its whole tree later.

    POSIX: `start_new_session=True`. Windows: `CREATE_NEW_PROCESS_GROUP` —
    `start_new_session` is silently ignored there.
    """
    if _IS_WINDOWS:
        return {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)}
    return {"start_new_session": True}
