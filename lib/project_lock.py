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

Code on an event loop (serve's async handlers) takes `project_lock_async`
instead, which waits without blocking the loop. A filesystem that cannot lock
(or a folder whose lock file cannot be created) degrades to a lock within this
process; only "held by someone else" is waited out.
"""
import asyncio
import contextlib
import errno
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

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
        self.fd = None                   # the OS-locked descriptor, None when only the in-process lock is held


_entries: dict = {}
_entries_guard = threading.Lock()
_warned_unlockable = False

# errno values that mean "somebody else holds it": the only ones that are waited out.
_BUSY_ERRNOS = {errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES}
if hasattr(errno, "EDEADLK"):
    _BUSY_ERRNOS.add(errno.EDEADLK)   # msvcrt reports a held region as EDEADLOCK/EACCES


def _entry_for(key) -> _Entry:
    with _entries_guard:
        entry = _entries.get(key)
        if entry is None:
            entry = _entries[key] = _Entry()
        return entry


def _lock_path(project_path) -> str:
    """The lock file for the project holding `project_path`: a project.json (or
    any file) or its folder. A directory is told from a file by the filesystem,
    never by a suffix: a folder may be called 'Ad v1.2'."""
    p = Path(project_path)
    folder = p if p.is_dir() else p.parent
    return os.path.join(os.path.realpath(folder), LOCK_NAME)


def _open_lock_file(path: str):
    """(fd, entry key). The key is the lock file's (device, inode), so every
    spelling of one folder (case variants on a case-insensitive volume, hard
    links, symlinks) shares one in-process entry. When the file cannot be
    created or opened (a read-only folder) there is no fd and the key is the
    path: the lock then excludes only this process, and the caller is never
    failed over it."""
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    except OSError:
        return None, path
    try:
        st = os.fstat(fd)
    except OSError:
        os.close(fd)
        return None, path
    return fd, (st.st_dev, st.st_ino)


def _warn_unlockable(err: OSError) -> None:
    global _warned_unlockable
    if not _warned_unlockable:
        _warned_unlockable = True
        logger.warning("File locking is not available here (%s): project writes are serialised "
                       "within this process only.", err)


def _try_os_lock(fd: int) -> str:
    """'locked', 'busy' (held elsewhere: wait) or 'unsupported' (this filesystem
    cannot lock at all: never wait for it)."""
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        return "locked"
    except OSError as e:
        if e.errno in _BUSY_ERRNOS:
            return "busy"
        _warn_unlockable(e)
        return "unsupported"


def _os_unlock(fd: int) -> None:
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_UN)
        else:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    except OSError:
        pass


def _close(fd) -> None:
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass


def _timeout_error(timeout: float) -> ProjectLockTimeout:
    return ProjectLockTimeout(f"The project is being written by another task (waited {timeout:g}s): try again.")


def _take_os_lock(entry: _Entry, fd) -> bool:
    """With entry.rlock held by this thread: take the OS lock if this is the
    outermost entry. True when the caller now holds the lock (and has bumped the
    depth), False when another process holds it. Consumes `fd` on success or on
    a nested entry; leaves it open on False so the caller can poll again."""
    if entry.depth == 0:
        if fd is not None:
            state = _try_os_lock(fd)
            if state == "busy":
                return False
            if state == "unsupported":
                _close(fd)
                fd = None
        entry.fd = fd
    else:
        _close(fd)   # a nested entry reuses the outer descriptor
    entry.depth += 1
    return True


def _release(entry: _Entry) -> None:
    entry.depth -= 1
    if entry.depth == 0:
        fd, entry.fd = entry.fd, None
        if fd is not None:
            _os_unlock(fd)
            _close(fd)
    entry.rlock.release()


@contextlib.contextmanager
def project_lock(project_path, timeout: float = DEFAULT_TIMEOUT):
    """Exclusive lock for the project holding `project_path` (its project.json
    or its folder), across threads and processes. Reentrant in a thread.
    Raises ProjectLockTimeout when not acquired within `timeout` seconds.

    BLOCKS the calling thread while it waits: never call it on an event-loop
    thread unless the lock is already held there (then it only reenters). Serve
    handlers use `project_lock_async`."""
    fd, key = _open_lock_file(_lock_path(project_path))
    entry = _entry_for(key)
    deadline = time.monotonic() + timeout
    if not entry.rlock.acquire(timeout=max(timeout, 0)):
        _close(fd)
        raise _timeout_error(timeout)
    try:
        while not _take_os_lock(entry, fd):
            if time.monotonic() >= deadline:
                raise _timeout_error(timeout)
            time.sleep(_POLL_SECONDS)
    except BaseException:
        _close(fd)
        entry.rlock.release()
        raise
    try:
        yield
    finally:
        _release(entry)


@contextlib.asynccontextmanager
async def project_lock_async(project_path, timeout: float | None = None):
    """`project_lock` for code running on an event loop: waits with
    `asyncio.sleep` between non-blocking attempts, so one slow holder (another
    process, a suspended step) never freezes the server.

    The protected section MUST be synchronous: no `await` (and no `async for` /
    `async with`) inside the block. Another task on this thread would otherwise
    run while the lock is held, and the thread-reentrant lock would let it in.
    A test scans serve/ for this. Sync helpers called inside the block may take
    `project_lock` again; it reenters."""
    if timeout is None:
        timeout = DEFAULT_TIMEOUT
    fd, key = _open_lock_file(_lock_path(project_path))
    entry = _entry_for(key)
    deadline = time.monotonic() + timeout
    try:
        while True:
            if entry.rlock.acquire(blocking=False):
                try:
                    if _take_os_lock(entry, fd):
                        fd = None   # consumed
                        break
                except BaseException:
                    entry.rlock.release()
                    raise
                entry.rlock.release()
            if time.monotonic() >= deadline:
                raise _timeout_error(timeout)
            await asyncio.sleep(_POLL_SECONDS)
    finally:
        _close(fd)
    try:
        yield
    finally:
        _release(entry)


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
