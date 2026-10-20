"""A write lock for project.json, shared by serve and the steps.

Serve funnels its own writes through one process, but steps are separate
processes that read project.json, work for a while and write it back. A human
edit that lands in between used to be lost. Every read-modify-write of
project.json now takes `project_lock` (an OS advisory lock on
`<project dir>/.project.lock`) and re-reads the file UNDER it; `update_project`
does that for a caller and writes atomically.

Hold it only for the read-modify-write (milliseconds): never across an await,
a subprocess, an ffmpeg run or a network call. It is reentrant in a thread, so
a helper that takes it inside a locked section does not deadlock on itself.
"""
import contextlib
import json
import os
import threading
import time
import uuid
from pathlib import Path

LOCK_NAME = ".project.lock"
DEFAULT_TIMEOUT = 10.0
_POLL_SECONDS = 0.015

_REPLACE_TRIES = 5
_REPLACE_PAUSE_SECONDS = 0.05

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
    import msvcrt


class ProjectLockTimeout(RuntimeError):
    """The project's write lock was not free within the timeout."""


class _Entry:
    __slots__ = ("rlock", "depth", "fd")

    def __init__(self):
        self.rlock = threading.RLock()   # one thread at a time in this process, reentrant
        self.depth = 0                   # nesting of the thread holding rlock
        self.fd = None


_entries: dict[str, _Entry] = {}
_entries_guard = threading.Lock()


def _entry_for(key: str) -> _Entry:
    with _entries_guard:
        entry = _entries.get(key)
        if entry is None:
            entry = _entries[key] = _Entry()
        return entry


def _lock_path(project_path) -> str:
    p = Path(project_path)
    folder = p.parent if p.suffix else p
    return os.path.join(os.path.realpath(folder), LOCK_NAME)


def _try_os_lock(fd: int) -> bool:
    if fcntl is not None:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        return True
    except OSError:
        return False


def _os_unlock(fd: int) -> None:
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_UN)
        else:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    except OSError:
        pass


@contextlib.contextmanager
def project_lock(project_path, timeout: float = DEFAULT_TIMEOUT):
    """Exclusive lock for the project holding `project_path` (its project.json
    or its folder), across threads and processes. Reentrant in a thread.
    Raises ProjectLockTimeout when not acquired within `timeout` seconds."""
    key = _lock_path(project_path)
    entry = _entry_for(key)
    deadline = time.monotonic() + timeout
    if not entry.rlock.acquire(timeout=max(timeout, 0)):
        raise ProjectLockTimeout(f"The project is being written by another task (waited {timeout:g}s): try again.")
    try:
        if entry.depth == 0:
            fd = os.open(key, os.O_RDWR | os.O_CREAT, 0o644)
            try:
                while not _try_os_lock(fd):
                    if time.monotonic() >= deadline:
                        raise ProjectLockTimeout(
                            f"The project is being written by another task (waited {timeout:g}s): try again.")
                    time.sleep(_POLL_SECONDS)
            except BaseException:
                os.close(fd)
                raise
            entry.fd = fd
        entry.depth += 1
    except BaseException:
        entry.rlock.release()
        raise
    try:
        yield
    finally:
        entry.depth -= 1
        if entry.depth == 0:
            fd, entry.fd = entry.fd, None
            _os_unlock(fd)
            os.close(fd)
        entry.rlock.release()


def write_json_atomic(project_path, project: dict, *, indent=2, ensure_ascii: bool = True) -> str:
    """tmp + os.replace under a temp name of its own (pid + random), so two
    writers never share one. A replace refused with PermissionError (Windows:
    an antivirus or the indexer holding project.json for a moment) is tried
    again a few times, 50 ms apart, before the write fails. Returns the text
    written."""
    project_path = Path(project_path)
    text = json.dumps(project, indent=indent, ensure_ascii=ensure_ascii)
    tmp = f"{project_path}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    try:
        Path(tmp).write_text(text, encoding="utf-8")
        for attempt in range(_REPLACE_TRIES):
            try:
                os.replace(tmp, project_path)
                break
            except PermissionError:
                if attempt == _REPLACE_TRIES - 1:
                    raise
                time.sleep(_REPLACE_PAUSE_SECONDS)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return text


def update_project(project_path, apply, *, timeout: float = DEFAULT_TIMEOUT,
                   indent=2, ensure_ascii: bool = True):
    """Under the lock, re-read project.json, call `apply(project)` and write
    what it returns atomically. `apply` returns the document to write, or None
    to leave the file untouched. Returns the document written (None if not)."""
    project_path = Path(project_path)
    with project_lock(project_path, timeout):
        project = json.loads(project_path.read_text(encoding="utf-8"))
        result = apply(project)
        if result is None:
            return None
        write_json_atomic(project_path, result, indent=indent, ensure_ascii=ensure_ascii)
        return result
