"""§477 engine save guard: what serve does once at startup (the shell secret, the
revision canary) and what it reports on /api/info."""
import errno
import os
import subprocess
import sys

import pytest
from starlette.testclient import TestClient

import lib.project_lock as pl
from serve import save_guard
from serve.server import app

SECRET = "ab" * 32


@pytest.fixture
def guard_state():
    """save_guard keeps process state; every test leaves it as it found it."""
    saved = dict(vars(save_guard)["_state"])
    yield
    save_guard._state.clear()
    save_guard._state.update(saved)


def _pipe_with(monkeypatch, data, close=True):
    """A pipe standing in for serve's stdin, holding data; its write end closed unless
    close is False (a shell that never writes)."""
    r, w = os.pipe()
    if data:
        os.write(w, data)
    if close:
        os.close(w)
    monkeypatch.setattr(save_guard, "_stdin_fd", r)
    return r, w


def _fresh(monkeypatch, *, guard=True, flag=True):
    for k, on in (("MONTAJ_ENGINE_GUARD", guard), ("MONTAJ_SHELL_SECRET_STDIN", flag)):
        if on:
            monkeypatch.setenv(k, "1")
        else:
            monkeypatch.delenv(k, raising=False)
    save_guard._state.update({"secret": None, "logged": False, "stdin_done": False, "secret_logged": False})


def _guard_lines(capsys):
    out = capsys.readouterr()
    return [l for l in (out.out + out.err).splitlines() if l.startswith("save-guard:")]


SECRET_MISSING_LINE = "save-guard: shell secret not received, engine guard disabled, shell guard only"


def test_startup_reads_the_secret_line_from_stdin(monkeypatch, guard_state, capsys):
    _fresh(monkeypatch)
    r, _ = _pipe_with(monkeypatch, (SECRET + "\n").encode())
    save_guard.startup()
    assert save_guard.enabled()
    assert save_guard.secret_valid(SECRET)
    assert not save_guard.secret_valid("cd" * 32)
    assert not save_guard.secret_valid(None)
    assert "MONTAJ_SHELL_SECRET_STDIN" not in os.environ and "MONTAJ_SHELL_SECRET" not in os.environ
    # stdin is closed: the fd now reads as an empty file, not the shell's pipe.
    assert os.read(r, 10) == b""
    assert _guard_lines(capsys) == []


def test_a_second_startup_keeps_the_secret_and_reads_stdin_once(monkeypatch, guard_state):
    """`montaj serve` runs startup before its dependency checks; importing serve.server
    runs it again in the same process."""
    _fresh(monkeypatch)
    _pipe_with(monkeypatch, (SECRET + "\n").encode())
    calls = []
    real = save_guard._read_secret_line
    monkeypatch.setattr(save_guard, "_read_secret_line", lambda *a: calls.append(1) or real(*a))
    save_guard.startup()
    save_guard.startup()
    assert calls == [1]
    assert save_guard.enabled() and save_guard.secret_valid(SECRET)


@pytest.mark.parametrize("data", [
    b"", b"\n", b"short\n", (SECRET.upper() + "\n").encode(), SECRET.encode(),
    (SECRET + "0\n").encode(), ("zz" * 32 + "\n").encode(), (SECRET + "\r\n").encode(),
])
def test_a_missing_or_malformed_line_turns_the_guard_off_with_one_loud_line(monkeypatch, guard_state, capsys, data):
    _fresh(monkeypatch)
    _pipe_with(monkeypatch, data)
    capsys.readouterr()
    save_guard.startup()
    save_guard.startup()
    assert not save_guard.enabled()
    assert not save_guard.secret_valid(SECRET)
    assert _guard_lines(capsys) == [SECRET_MISSING_LINE]
    # The steps serve starts read the switch from the environment: off for them too.
    assert "MONTAJ_ENGINE_GUARD" not in os.environ
    assert TestClient(app).get("/api/info").json()["engineGuard"] is False


def test_a_shell_that_never_writes_cannot_hang_startup(monkeypatch, guard_state, capsys):
    import time
    _fresh(monkeypatch)
    _, w = _pipe_with(monkeypatch, b"", close=False)
    monkeypatch.setattr(save_guard, "_STDIN_TIMEOUT_SECONDS", 0.2)
    capsys.readouterr()
    began = time.monotonic()
    try:
        save_guard.startup()
    finally:
        os.close(w)
    assert time.monotonic() - began < 2
    assert not save_guard.enabled()
    assert _guard_lines(capsys) == [SECRET_MISSING_LINE]


def test_the_stdin_read_timeout_is_five_seconds():
    assert save_guard._STDIN_TIMEOUT_SECONDS == 5


def test_a_secret_in_the_environment_is_never_used_and_is_removed(monkeypatch, guard_state, capsys):
    _fresh(monkeypatch, flag=False)
    monkeypatch.setenv("MONTAJ_SHELL_SECRET", SECRET)
    capsys.readouterr()
    save_guard.startup()
    assert "MONTAJ_SHELL_SECRET" not in os.environ
    assert not save_guard.secret_valid(SECRET)
    assert not save_guard.enabled()
    assert _guard_lines(capsys) == [SECRET_MISSING_LINE]


def test_without_the_flag_or_the_guard_stdin_is_never_touched(monkeypatch, guard_state, capsys):
    _fresh(monkeypatch, guard=False, flag=False)

    def boom(*a):
        raise AssertionError("stdin read without the flag")
    monkeypatch.setattr(save_guard, "_read_secret_line", boom)
    capsys.readouterr()
    save_guard.startup()
    assert not save_guard.enabled()
    assert _guard_lines(capsys) == []
    assert TestClient(app).get("/api/info").json()["engineGuard"] is False


def test_a_spawned_child_of_serve_never_sees_the_secret(tmp_path):
    """End to end over a real stdin: serve takes the line, and a child it starts gets
    neither the secret in its environment nor anything of the shell's pipe on stdin."""
    import json as _json
    import pathlib
    root = str(pathlib.Path(save_guard.__file__).resolve().parents[1])
    child = ("import os, sys, json; print(json.dumps([sys.stdin.read(), "
             "{k: v for k, v in os.environ.items() if k.startswith('MONTAJ_')}]))")
    serve_code = (
        "import subprocess, sys; from serve import save_guard; save_guard.startup(); "
        "print('on' if save_guard.enabled() else 'off'); sys.stdout.flush(); "
        f"subprocess.run([sys.executable, '-c', {child!r}])"
    )
    env = {k: v for k, v in os.environ.items() if not k.startswith("MONTAJ_")}
    env.update({"MONTAJ_ENGINE_GUARD": "1", "MONTAJ_SHELL_SECRET_STDIN": "1", "PYTHONPATH": root})
    out = subprocess.run([sys.executable, "-c", serve_code], input=SECRET + "\nleftover from the shell\n",
                         capture_output=True, text=True, env=env, cwd=root, timeout=60)
    assert out.returncode == 0, out.stderr
    first, second = out.stdout.splitlines()[:2]
    assert first == "on"
    stdin_seen, child_env = _json.loads(second)
    assert stdin_seen == ""
    assert "MONTAJ_SHELL_SECRET" not in child_env and "MONTAJ_SHELL_SECRET_STDIN" not in child_env
    assert SECRET not in out.stdout


def test_info_reports_engine_guard_only_when_effectively_on(monkeypatch, guard_state):
    _fresh(monkeypatch)
    _pipe_with(monkeypatch, (SECRET + "\n").encode())
    save_guard.startup()
    assert TestClient(app).get("/api/info").json()["engineGuard"] is True
    monkeypatch.setattr(save_guard.project_revisions, "canary_ok", lambda: False)
    save_guard.startup()
    assert TestClient(app).get("/api/info").json()["engineGuard"] is False


def test_guard_is_off_without_the_env(monkeypatch, guard_state):
    _fresh(monkeypatch, guard=False, flag=False)
    save_guard._inject_secret_for_tests(SECRET)
    save_guard.startup()
    assert not save_guard.enabled()
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    save_guard.startup()
    assert save_guard.enabled()


def test_canary_mismatch_turns_the_guard_off_with_one_loud_line(monkeypatch, capsys, guard_state):
    _fresh(monkeypatch, flag=False)
    save_guard._inject_secret_for_tests(SECRET)
    monkeypatch.setattr(save_guard.project_revisions, "canary_ok", lambda: False)
    save_guard.startup()
    assert not save_guard.enabled()
    assert save_guard.canary_state() == "mismatch"
    err = capsys.readouterr()
    lines = [l for l in (err.out + err.err).splitlines() if "canary" in l]
    assert lines == ["save-guard: revision canary MISMATCH, engine guard disabled, shell guard only"]


def test_info_reports_canary_and_lock_state_and_keeps_its_fields(monkeypatch, guard_state):
    _fresh(monkeypatch, flag=False)
    save_guard._inject_secret_for_tests(SECRET)
    save_guard.startup()
    monkeypatch.setattr(pl, "_degraded", False)
    body = TestClient(app).get("/api/info").json()
    assert body["revisionCanary"] == "ok"
    assert body["projectLock"] == "ok"
    assert "version" in body and "skill_path" in body

    monkeypatch.setattr(save_guard.project_revisions, "canary_ok", lambda: False)
    save_guard.startup()
    monkeypatch.setattr(pl, "_degraded", True)
    body = TestClient(app).get("/api/info").json()
    assert body["revisionCanary"] == "mismatch"
    assert body["projectLock"] == "degraded"


@pytest.mark.skipif(pl.fcntl is None, reason="posix flock")
def test_an_unlockable_filesystem_marks_the_lock_degraded(tmp_path, monkeypatch):
    (tmp_path / "project.json").write_text("{}")
    monkeypatch.setattr(pl, "_warned_paths", set())
    monkeypatch.setattr(pl, "_degraded", False)

    def no_flock(fd, op):
        if op & pl.fcntl.LOCK_UN:
            return
        raise OSError(errno.ENOLCK, "cannot lock")
    monkeypatch.setattr(pl.fcntl, "flock", no_flock)
    assert not pl.lock_degraded()
    with pl.project_lock(tmp_path / "project.json", timeout=1):
        pass
    assert pl.lock_degraded()
