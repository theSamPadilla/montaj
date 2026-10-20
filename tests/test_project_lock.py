"""The project write lock (lib/project_lock.py): one writer at a time across
threads and processes, reentrant, atomic writes."""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib.project_lock import ProjectLockTimeout, project_lock, update_project  # noqa: E402

COUNTER_WORKER = """
import json, sys
sys.path.insert(0, {root!r})
from lib.project_lock import update_project
def bump(p):
    p["n"] = p.get("n", 0) + 1
    return p
for _ in range(200):
    update_project({path!r}, bump)
"""

HOLDER = """
import sys, time
sys.path.insert(0, {root!r})
from lib.project_lock import project_lock
with project_lock({path!r}):
    print("held", flush=True)
    time.sleep({secs})
"""


def _project(tmp_path, **fields):
    path = tmp_path / "project.json"
    path.write_text(json.dumps({"id": "p1", **fields}))
    return path


def spawn_holder(path, secs):
    proc = subprocess.Popen(
        [sys.executable, "-c", HOLDER.format(root=str(REPO_ROOT), path=str(path), secs=secs)],
        stdout=subprocess.PIPE, text=True)
    assert proc.stdout.readline().strip() == "held"
    return proc


def test_threads_exclude_each_other(tmp_path):
    path = _project(tmp_path, n=0)

    def work():
        for _ in range(200):
            def bump(p):
                p["n"] += 1
                return p
            update_project(path, bump)

    threads = [threading.Thread(target=work) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert json.loads(path.read_text())["n"] == 400


def test_processes_exclude_each_other(tmp_path):
    path = _project(tmp_path, n=0)
    code = COUNTER_WORKER.format(root=str(REPO_ROOT), path=str(path))
    procs = [subprocess.Popen([sys.executable, "-c", code]) for _ in range(2)]
    assert [p.wait(timeout=120) for p in procs] == [0, 0]
    assert json.loads(path.read_text())["n"] == 400


def test_reentrant_in_a_thread(tmp_path):
    path = _project(tmp_path)
    with project_lock(path, timeout=0.5):
        with project_lock(path, timeout=0.5):
            update_project(path, lambda p: {**p, "x": 1}, timeout=0.5)
    assert json.loads(path.read_text())["x"] == 1


def test_timeout_when_another_process_holds_it(tmp_path):
    path = _project(tmp_path)
    proc = spawn_holder(path, 3)
    try:
        started = time.monotonic()
        with pytest.raises(ProjectLockTimeout):
            with project_lock(path, timeout=0.3):
                pass
        assert time.monotonic() - started < 2
        assert issubclass(ProjectLockTimeout, RuntimeError)
    finally:
        proc.kill()
        proc.wait()
    with project_lock(path, timeout=2):   # a killed holder frees it
        pass


def test_timeout_when_another_thread_holds_it(tmp_path):
    path = _project(tmp_path)
    held, release = threading.Event(), threading.Event()

    def hold():
        with project_lock(path):
            held.set()
            release.wait(5)

    t = threading.Thread(target=hold)
    t.start()
    held.wait(5)
    try:
        with pytest.raises(ProjectLockTimeout):
            with project_lock(path, timeout=0.2):
                pass
    finally:
        release.set()
        t.join()


def test_released_on_exception(tmp_path):
    path = _project(tmp_path)
    with pytest.raises(ValueError):
        with project_lock(path):
            raise ValueError("boom")
    with project_lock(path, timeout=0.5):
        pass


def test_failed_write_leaves_the_file_and_no_temp(tmp_path):
    path = _project(tmp_path, n=1)

    def bad(p):
        p["n"] = 2
        raise RuntimeError("apply failed")

    with pytest.raises(RuntimeError):
        update_project(path, bad)
    assert json.loads(path.read_text())["n"] == 1

    with pytest.raises(TypeError):   # not serialisable: dumps fails before any file exists
        update_project(path, lambda p: {"bad": object()})
    assert json.loads(path.read_text())["n"] == 1
    assert [f.name for f in tmp_path.iterdir() if f.name.endswith(".tmp")] == []


def test_none_leaves_the_file_untouched(tmp_path):
    path = _project(tmp_path, n=1)
    before = path.stat().st_mtime_ns
    assert update_project(path, lambda p: None) is None
    assert path.stat().st_mtime_ns == before
    assert json.loads(path.read_text())["n"] == 1


def test_update_rereads_and_returns_document(tmp_path):
    path = _project(tmp_path, a=1)
    out = update_project(path, lambda p: {**p, "b": 2})
    assert out == {"id": "p1", "a": 1, "b": 2}
    assert json.loads(path.read_text()) == out
