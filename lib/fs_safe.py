"""A write that never follows a symlink at the final path, on every OS.

§334 security round: `_write_project_json` (project/init.py) and the `/api/files` write (serve/routes/files.py)
must not write THROUGH a link planted at their target, so a staged clip or asset cannot redirect the write out of
the project. POSIX gets that atomically from `O_NOFOLLOW`; Windows has no such flag (`os.O_NOFOLLOW` is undefined),
so there the open followed the link and, worse, `os.O_NOFOLLOW` raised AttributeError and every new project failed
to create (the Windows 1.4.1 smoke). This module is the one Windows-safe write both callers use.

The guard on Windows is an `os.lstat` check right before the open: a symlink, or any reparse point (a junction or a
name-surrogate), is refused. A reparse point is Windows's link, so `FILE_ATTRIBUTE_REPARSE_POINT` covers the junction
case `os.path.islink` can miss. The residual is a narrow local race between the lstat and the open on Windows (no
atomic O_NOFOLLOW there); creating a symlink on Windows needs Developer Mode or admin, and the parent folder is one
the project owns, so this is outside the sidecar threat model, the same standing the POSIX parent-swap race already
has. The bytes are written binary (`O_BINARY` where it exists), so the file is identical on macOS and Windows.
"""
import errno
import os
import stat
import sys

_FILE_ATTRIBUTE_REPARSE_POINT = 0x400


def _is_link(path: str) -> bool:
    """True when a symlink or a Windows reparse point sits at `path`; False when nothing is there."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return True
    if sys.platform == "win32":
        attrs = getattr(st, "st_file_attributes", 0)
        if attrs & _FILE_ATTRIBUTE_REPARSE_POINT:
            return True
    return False


def open_write_no_follow(path: str, mode: int = 0o644) -> int:
    """Open `path` for a create/truncate write, refusing a symlink or reparse point at the final component, and
    return the fd. Raises `OSError(ELOOP)` when a link is there, so a caller's `except OSError` treats the Windows
    refusal exactly like POSIX's own ELOOP from `O_NOFOLLOW`."""
    if _is_link(path):
        raise OSError(errno.ELOOP, "refusing to write through a symlink", path)
    flags = os.O_CREAT | os.O_WRONLY | os.O_TRUNC
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    return os.open(path, flags, mode)
