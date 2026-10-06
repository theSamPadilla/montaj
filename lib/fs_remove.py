"""Delete a directory tree the way Windows needs it.

git writes its object files read-only, and `shutil.rmtree` raises
PermissionError (WinError 5) on a read-only file on Windows. Every project
folder is a git repo, so a plain rmtree cannot delete a project there.
"""
import errno
import os
import shutil
import stat
import sys
import time

_SHARING_VIOLATION = 32          # WinError 32: file in use (antivirus, indexer)
_RETRY_DELAYS = (0.1, 0.25, 0.5)


def _handler(func, path, exc):
    if isinstance(exc, FileNotFoundError):
        return
    is_perm = isinstance(exc, PermissionError) or (
        isinstance(exc, OSError) and exc.errno in (errno.EACCES, errno.EPERM))
    busy = getattr(exc, "winerror", None) == _SHARING_VIOLATION
    if not (is_perm or busy):
        raise exc
    if is_perm and not busy:
        try:
            os.chmod(path, stat.S_IWRITE | stat.S_IREAD | stat.S_IEXEC
                     if os.path.isdir(path) else stat.S_IWRITE)
        except OSError:
            pass
    delays = _RETRY_DELAYS if busy else (0,)
    last = exc
    for d in delays:
        if d:
            time.sleep(d)
        try:
            func(path)
            return
        except FileNotFoundError:
            return
        except OSError as e:
            last = e
            if getattr(e, "winerror", None) == _SHARING_VIOLATION:
                continue
            if isinstance(e, PermissionError):
                try:
                    os.chmod(path, stat.S_IWRITE)
                except OSError:
                    pass
                continue
            raise
    raise last


def rmtree_force(path, ignore_errors=False):
    """shutil.rmtree that clears read-only bits and retries files in use."""
    if ignore_errors:
        try:
            rmtree_force(path)
        except OSError:
            pass
        return
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=lambda f, p, e: _handler(f, p, e))
    else:
        shutil.rmtree(path, onerror=lambda f, p, ei: _handler(f, p, ei[1]))
