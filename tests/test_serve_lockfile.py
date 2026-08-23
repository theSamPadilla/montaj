import json
import os

import pytest

from serve import lockfile


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setattr(lockfile, "_lockfile_path", lambda: tmp_path / "serve.json")
    return tmp_path


def test_write_then_read_roundtrips(tmp_path):
    lockfile.write(port=3100, workspace=tmp_path / "ws")
    info = lockfile.read()
    assert info is not None
    assert info["port"] == 3100
    assert info["pid"] == os.getpid()
    assert info["workspace"] == str(tmp_path / "ws")


def test_read_returns_none_when_absent():
    assert lockfile.read() is None


def test_remove_is_idempotent(tmp_path):
    lockfile.remove()          # nothing there yet
    lockfile.write(port=3000, workspace=tmp_path)
    lockfile.remove()
    assert lockfile.read() is None
    lockfile.remove()          # already gone


def test_read_ignores_a_dead_pid(tmp_path):
    path = lockfile._lockfile_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # PID 1 exists, so use a pid that cannot: a very high one we then verify.
    dead = 2 ** 22
    path.write_text(json.dumps({"port": 3000, "pid": dead, "workspace": str(tmp_path)}))
    assert lockfile.read() is None


def test_read_ignores_malformed_json(tmp_path):
    path = lockfile._lockfile_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json")
    assert lockfile.read() is None


def test_write_is_atomic_no_tmp_left_behind(tmp_path):
    lockfile.write(port=3000, workspace=tmp_path)
    leftovers = list(lockfile._lockfile_path().parent.glob("serve.json.tmp*"))
    assert leftovers == []


def test_lifespan_writes_and_removes_the_lockfile(tmp_path, monkeypatch):
    """The lockfile exists exactly while the app is up."""
    import asyncio

    from unittest.mock import patch

    import serve.server as server_mod

    monkeypatch.setattr(lockfile, "_lockfile_path", lambda: tmp_path / "serve.json")
    monkeypatch.setattr(server_mod, "resolve_workspace", lambda: tmp_path / "ws")
    monkeypatch.setattr(server_mod, "HEADLESS", True)

    async def drive():
        # Both watchers are patched away for the same reason
        # test_server_headless.py does it: GlobalOverlayWatcher.start()
        # hardcodes Path.home()/".montaj" (serve/watcher.py:56-68), which the
        # resolve_workspace patch does NOT redirect — unmocked, this test would
        # mkdir into the real home directory and start two watchdog threads.
        with patch("serve.server.ProjectWatcher"), patch("serve.server.GlobalOverlayWatcher"):
            async with server_mod.lifespan(server_mod.app):
                assert lockfile.read() is not None, "lockfile missing while serve is up"
        assert lockfile.read() is None, "lockfile survived shutdown"

    asyncio.run(drive())
