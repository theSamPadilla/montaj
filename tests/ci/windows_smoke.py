#!/usr/bin/env python3
"""Windows CI smoke: lib.proc.pid_alive across a real process boundary.

Not a pytest test file — its name matches neither `test_*.py` nor `*_test.py`,
so pytest's default collection (testpaths = ["tests"]) never picks it up even
though it lives under tests/. Run directly: `python tests/ci/windows_smoke.py`.

tests/test_windows_portability.py fakes `ctypes.WinDLL("kernel32", ...)` end to end,
which proves _win_query's own logic but never actually calls OpenProcess /
GetExitCodeProcess against a real Windows process. This script does that for
real, and specifically guards against the failure mode the module's docstring
warns about: on Windows, `signal.CTRL_C_EVENT == 0`, so a probe that mistakenly
used `os.kill(pid, 0)` would route through `GenerateConsoleCtrlEvent(CTRL_C_EVENT,
pid)` — which can deliver Ctrl+C into the *probing* process's own console
group, not just the target. That would kill the prober outright, not just
return a wrong answer.

So the probe itself runs in a SEPARATE subprocess (never in this process): if
pid_alive ever regressed to that behaviour, the symptom is the probing
subprocess dying before it reaches the line printed immediately after the
call, not a clean False. This script asserts on that post-call marker and on
the subprocess's own exit code, not only on the answer pid_alive gave.

Exits 0 on success; prints a diagnostic and exits 1 on the first failed check.
"""
import os
import subprocess
import sys
import time

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

_MARKER = "MARKER_AFTER_PROBE_CALL"


def _probe_in_subprocess(pid: int) -> subprocess.CompletedProcess:
    """Call lib.proc.pid_alive(pid) inside a brand-new Python process, print
    the answer, THEN print _MARKER, then exit 0. Returns the finished
    subprocess (never raises on a non-zero/missing-marker outcome — the
    caller decides what that means)."""
    code = (
        f"import sys; sys.path.insert(0, {_REPO_ROOT!r})\n"
        "from lib.proc import pid_alive\n"
        f"alive = pid_alive({pid})\n"
        "print('ALIVE=' + str(alive), flush=True)\n"
        f"print({_MARKER!r}, flush=True)\n"
    )
    return subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True, text=True, timeout=30,
    )


def _assert_probe_survived(result: subprocess.CompletedProcess, expect_alive: bool, label: str):
    print(f"--- probe subprocess ({label}) ---", flush=True)
    print(f"exit={result.returncode}\nstdout={result.stdout!r}\nstderr={result.stderr!r}", flush=True)
    if result.returncode != 0:
        raise SystemExit(
            f"[{label}] probe subprocess exited {result.returncode} instead of 0 — "
            "it did not survive to print its own exit; see stderr above"
        )
    if _MARKER not in result.stdout:
        raise SystemExit(
            f"[{label}] probe subprocess never printed the post-probe marker "
            f"({_MARKER!r}) — it was killed mid-probe (Ctrl+C delivered to the "
            "prober itself?), see stderr above"
        )
    want = f"ALIVE={expect_alive}"
    if want not in result.stdout:
        raise SystemExit(f"[{label}] expected {want!r} in stdout, got {result.stdout!r}")


def _pid_definitely_absent(pid: int) -> bool:
    """External verification (not lib.proc, which is what we're testing) that
    no process has this pid. tasklist on Windows (the CI target); `ps` on
    POSIX only so this script's control flow is exercisable in a macOS dry
    run — the real assertion always runs the tasklist branch on the runner."""
    if sys.platform == "win32":
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}"], capture_output=True, text=True,
        ).stdout
    else:
        out = subprocess.run(["ps", "-p", str(pid)], capture_output=True, text=True).stdout
    return str(pid) not in out


def main():
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        print(f"spawned long-lived child pid={child.pid}", flush=True)

        result = _probe_in_subprocess(child.pid)
        _assert_probe_survived(result, expect_alive=True, label="live child")

        if child.poll() is not None:
            raise SystemExit(
                f"child pid={child.pid} had already exited (code={child.returncode}) "
                "after the probe — expected it still running"
            )
        print(f"child pid={child.pid} confirmed still running after the probe", flush=True)

        child.kill()
        child.wait(timeout=10)
        print(f"child pid={child.pid} killed (exit={child.returncode})", flush=True)

        result = _probe_in_subprocess(child.pid)
        _assert_probe_survived(result, expect_alive=False, label="killed child")

        # A pid essentially guaranteed never to be in use: a large multiple of
        # 4, verified absent via the platform's own process listing first.
        unused_pid = 999996
        if not _pid_definitely_absent(unused_pid):
            raise SystemExit(
                f"pid {unused_pid} is unexpectedly in use on this runner — pick another"
            )
        result = _probe_in_subprocess(unused_pid)
        _assert_probe_survived(result, expect_alive=False, label="never-used pid")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)

    print("windows_smoke: OK", flush=True)


if __name__ == "__main__":
    main()
