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


def test_startup_takes_the_secret_and_removes_it_from_the_environment(monkeypatch, guard_state):
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    monkeypatch.setenv("MONTAJ_SHELL_SECRET", SECRET)
    save_guard.startup()
    assert "MONTAJ_SHELL_SECRET" not in os.environ
    assert save_guard.secret_valid(SECRET)
    assert not save_guard.secret_valid("cd" * 32)
    assert not save_guard.secret_valid(None)


def test_a_second_startup_keeps_the_secret_it_already_took(monkeypatch, guard_state):
    """`montaj serve` runs startup before its dependency checks; importing serve.server
    runs it again with the secret already gone from the environment."""
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    monkeypatch.setenv("MONTAJ_SHELL_SECRET", SECRET)
    save_guard.startup()
    save_guard.startup()
    assert save_guard.secret_valid(SECRET)


def test_a_spawned_child_does_not_inherit_the_secret(monkeypatch, guard_state):
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    monkeypatch.setenv("MONTAJ_SHELL_SECRET", SECRET)
    save_guard.startup()
    out = subprocess.run(
        [sys.executable, "-c", "import os; print(os.environ.get('MONTAJ_SHELL_SECRET', 'absent'))"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert out == "absent"


def test_no_secret_configured_validates_nothing(monkeypatch, guard_state):
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    monkeypatch.delenv("MONTAJ_SHELL_SECRET", raising=False)
    save_guard.startup()
    assert not save_guard.secret_valid("")
    assert not save_guard.secret_valid(SECRET)


def test_guard_is_off_without_the_env(monkeypatch, guard_state):
    monkeypatch.delenv("MONTAJ_ENGINE_GUARD", raising=False)
    save_guard.startup()
    assert not save_guard.enabled()
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    save_guard.startup()
    assert save_guard.enabled()


def test_canary_mismatch_turns_the_guard_off_with_one_loud_line(monkeypatch, capsys, guard_state):
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    monkeypatch.setattr(save_guard.project_revisions, "canary_ok", lambda: False)
    save_guard.startup()
    assert not save_guard.enabled()
    assert save_guard.canary_state() == "mismatch"
    err = capsys.readouterr()
    lines = [l for l in (err.out + err.err).splitlines() if "canary" in l]
    assert lines == ["save-guard: revision canary MISMATCH, engine guard disabled, shell guard only"]


def test_info_reports_canary_and_lock_state_and_keeps_its_fields(monkeypatch, guard_state):
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
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
