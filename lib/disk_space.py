"""A full disk, said plainly.

One place that recognises "the disk is full" (ENOSPC, a quota, Windows'
disk-full codes) and turns it into one stable error: code `disk_full`, one
short sentence, and the numbers (`needed`, `free`, `path`). serve answers it as
HTTP 507; a CLI or step prints it as its one JSON error line and exits 1,
never a traceback.

Also the preflight: before a copy or an upload whose size is known, compare it
with the destination's free space and refuse before anything is written. A
free-space read that fails never blocks anything (fail open).
"""
import errno
import json
from decimal import ROUND_HALF_UP, Decimal
import os
import re
import shutil
import sys
import traceback

DISK_FULL = "disk_full"

# errno values that mean the disk (or the user's quota on it) is full. EDQUOT is
# 69 on macOS and 122 on Linux; only this OS's own value is used, since the other
# number means something else here.
_FULL_ERRNOS = {errno.ENOSPC} | ({errno.EDQUOT} if hasattr(errno, "EDQUOT") else set())
# Windows: ERROR_HANDLE_DISK_FULL (39) and ERROR_DISK_FULL (112). Python maps
# both to ENOSPC, but a winerror alone is checked too.
_FULL_WINERRORS = {39, 112}

GIB = 1024 ** 3
MIB = 1024 ** 2
# Room left free after a known-size write, so the disk is not left at zero (the
# OS, the app's logs and the next encode need some): 2% of the write, at least
# 256 MiB and at most 1 GiB. A write under 16 MiB (an image, a JSON file) gets
# none: it is refused only when it does not fit at all, so a 50 KB image is
# never turned away for want of a gigabyte. (§541 review: a fixed 1 GiB refused
# a 5 MB upload with 900 MB free.)
TINY_WRITE_BYTES = 16 * MIB
HEADROOM_FLOOR_BYTES = 256 * MIB
HEADROOM_CAP_BYTES = GIB
HEADROOM_SHARE = 0.02

_UNITS = ("B", "KB", "MB", "GB", "TB")


def format_bytes(n) -> str:
    """The app's own byte formatter (desktop/ui/src/lib/storageSize.ts
    formatBytes): 1024-based, KB/MB/GB/TB, one decimal, whole bytes bare."""
    try:
        value = float(n)
    except (TypeError, ValueError):
        return "0 B"
    if not (value > 0) or value == float("inf"):
        return "0 B"
    unit = 0
    while value >= 1024 and unit < len(_UNITS) - 1:
        value /= 1024
        unit += 1
    # JS toFixed rounds the exact value half up (3.25 -> "3.3"); Python's own
    # format rounds half to even, so Decimal does it the app's way.
    places = Decimal("1") if unit == 0 else Decimal("0.1")
    return f"{Decimal(value).quantize(places, rounding=ROUND_HALF_UP)} {_UNITS[unit]}"


def _chain(exc):
    """`exc`, what it was raised from (`__cause__`, `__context__`) and, in an
    ExceptionGroup, each exception in it, once each."""
    seen, stack = set(), [exc]
    while stack:
        e = stack.pop()
        if e is None or id(e) in seen:
            continue
        seen.add(id(e))
        yield e
        if isinstance(e, BaseExceptionGroup):
            stack.extend(e.exceptions)
        stack.extend((e.__cause__, e.__context__))


def _is_full_oserror(e) -> bool:
    return isinstance(e, OSError) and (e.errno in _FULL_ERRNOS or getattr(e, "winerror", None) in _FULL_WINERRORS)


def is_disk_full(exc) -> bool:
    """True when `exc` or anything in its chain (see `_chain`) is a disk-full
    OSError. Recognised by errno/winerror only, never by text."""
    return any(_is_full_oserror(e) for e in _chain(exc))


# A child process that is only text (an ffmpeg, git or older-init failure):
# a line in the shape the tool itself reports a full disk, never the words
# anywhere. ffmpeg and git END a line with ": No space left on device" (or the
# quota or Windows text); ffmpeg then prints stats, a frame= line and
# "Conversion failed!", so its tail is searched, not only its last line. A
# Python traceback's last line starts with the exception's name and
# "[Errno 28]". A file named "Errno 28.mov", or the words echoed inside a
# longer line, is not a full disk.
_TOOL_LINE = re.compile(r": (No space left on device|Disk quota exceeded|There is not enough space on the disk\.?)$")
_PY_LINE = re.compile(r"^[A-Za-z_][\w.]*(?:Error|Exception): \[Errno (?:%d|%d)\] " % (errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)))


TOOL_TAIL_LINES = 20


# ffmpeg's own description of its inputs and outputs, which can carry a clip's
# tags (a title ending in the full-disk sentence): never a report of its own.
_FFMPEG_DESCRIPTION = re.compile(r"^(Input|Output|Stream) #")


def tool_reported_disk_full(text) -> bool:
    """True when a child's `text` reports a full disk in the tool's own words:
    one of its last TOOL_TAIL_LINES lines (JSON lines skipped) is the tool's
    own error report ending with `_TOOL_LINE`, or its last line is a
    traceback's `_PY_LINE`. A report is never indented: ffmpeg indents its
    `Metadata:` blocks and stream details (where a clip's tags print), and
    `Input #` / `Output #` / `Stream #` lines describe media, so neither
    counts. What counts: ffmpeg's `Error writing trailer:`, `Error closing
    file:`, `av_interleaved_write_frame():`, `Error muxing a packet`, or any
    unindented `<path>: No space left on device` (git's `fatal: ...` too)."""
    if not isinstance(text, str):
        return False
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("{")]
    if not lines:
        return False
    for ln in lines[-TOOL_TAIL_LINES:]:
        if ln[:1].isspace() or _FFMPEG_DESCRIPTION.match(ln):
            continue
        if _TOOL_LINE.search(ln):
            return True
    return bool(_PY_LINE.match(lines[-1]))




def workspace_root() -> str:
    """The workspace folder, resolved as serve and init resolve it
    (MONTAJ_WORKSPACE_DIR, then ~/.montaj/config.json's workspaceDir, then
    ~/Montaj): where free space is read when nothing better is known."""
    env = os.environ.get("MONTAJ_WORKSPACE_DIR")
    if env:
        return env
    root = os.path.join(os.path.expanduser("~"), "Montaj")
    try:
        with open(os.path.join(os.path.expanduser("~"), ".montaj", "config.json")) as f:
            cfg = json.load(f)
        if isinstance(cfg, dict) and isinstance(cfg.get("workspaceDir"), str) and cfg["workspaceDir"]:
            root = cfg["workspaceDir"]
    except (OSError, ValueError):
        pass
    return root


def _existing(path) -> str | None:
    """`path`, or its nearest folder that exists (a destination may not yet)."""
    if not path:
        return None
    p = os.path.abspath(str(path))
    while p and not os.path.exists(p):
        parent = os.path.dirname(p)
        if parent == p:
            return None
        p = parent
    return p or None


def free_bytes(path) -> int | None:
    """Free space on `path`'s volume, or None when it cannot be read.

    statvfs's available blocks: on macOS this leaves out purgeable space (APFS
    snapshots, caches the OS would drop on demand), so the number can be lower
    than Finder's and the check errs toward refusing. Hence "about" in every
    sentence."""
    where = _existing(path)
    if where is None:
        return None
    try:
        return int(shutil.disk_usage(where).free)
    except (OSError, ValueError):
        return None


def headroom(size: int) -> int:
    """What a write of `size` bytes must leave free on top of itself: none
    under TINY_WRITE_BYTES, else 2% of it within [256 MiB, 1 GiB]."""
    if size < TINY_WRITE_BYTES:
        return 0
    return min(HEADROOM_CAP_BYTES, max(HEADROOM_FLOOR_BYTES, int(size * HEADROOM_SHARE)))


def message(needed=None, free=None) -> str:
    """The one sentence a person sees. `needed` is the free space wanted (the
    write plus its headroom), so "needs about X free" is true as said."""
    if isinstance(needed, int) and needed > 0 and isinstance(free, int):
        if needed > free and format_bytes(needed) == format_bytes(free):
            # Both read the same at one decimal: say what is missing instead.
            return f"Not enough disk space. Montaj needs about {format_bytes(needed - free)} more for this, {format_bytes(free)} is free."
        return f"Not enough disk space. Montaj needs about {format_bytes(needed)} free for this, {format_bytes(free)} is free."
    if isinstance(free, int):
        return f"Not enough disk space. {format_bytes(free)} is free."
    return "Not enough disk space."


class DiskFull(Exception):
    """The disk is full, or would be: raised by `preflight`, or made from a
    disk-full OSError by `from_os_error`. `path` is the folder the write went
    to (a caller passes the workspace root or the project folder), never a
    file inside it."""

    def __init__(self, needed=None, free=None, path=None, headroom=None):
        self.needed = int(needed) if isinstance(needed, (int, float)) and needed > 0 else None
        self.headroom = int(headroom) if isinstance(headroom, (int, float)) and headroom >= 0 else None
        self.free = int(free) if isinstance(free, (int, float)) and free >= 0 else None
        self.path = str(path) if path else None
        super().__init__(message(self.needed, self.free))

    @property
    def message(self) -> str:
        return str(self)

    def detail(self) -> dict:
        d = {"error": DISK_FULL, "message": self.message, "needed": self.needed,
             "free": self.free, "path": self.path}
        if self.headroom is not None:
            d["headroom"] = self.headroom
        return d


def from_os_error(exc, path=None, needed=None) -> DiskFull:
    """A DiskFull for a disk-full OSError met writing under `path`, with the
    free space read now (None when it cannot be)."""
    return DiskFull(needed=needed, free=free_bytes(path), path=path)


def preflight(path, size, reserved: int = 0) -> None:
    """Raise DiskFull when a write of `size` bytes plus its headroom does not
    fit in `path`'s free space less `reserved` (writes already under way that
    will take their share). The DiskFull's `needed` is the whole free space
    wanted (size + headroom + reserved), the number its sentence states.
    Nothing to check (no size, or a free-space read that fails) passes: this
    never blocks on an error of its own."""
    if not isinstance(size, (int, float)) or size <= 0:
        return
    free = free_bytes(path)
    if free is None:
        return
    room = headroom(int(size))
    want = int(size) + room + max(0, int(reserved or 0))
    if free < want:
        raise DiskFull(needed=want, free=free, path=path, headroom=room)


def file_sizes(paths) -> int:
    """The total size of the files in `paths` (anything unreadable counts 0)."""
    total = 0
    for p in paths or []:
        try:
            total += os.path.getsize(p)
        except (OSError, TypeError, ValueError):
            pass
    return total


def create_new(dest_dir: str, name: str, alternative) -> str:
    """Reserve a free name in `dest_dir` by creating the file exclusively
    (O_CREAT|O_EXCL: never an existing entry, a dangling symlink included,
    never through a link), so two writers at once can never both pick it.
    `alternative(name, n)` is the n-th other name to try (n from 2). Returns
    the created (empty) file's path: the caller owns it, and only it."""
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    candidate, n = name, 2
    while True:
        dest = os.path.join(dest_dir, candidate)
        try:
            os.close(os.open(dest, flags, 0o644))
            return dest
        except FileExistsError:
            candidate = alternative(name, n)
            n += 1


def remove_partial(path) -> None:
    """Best-effort removal of a half-written file this code itself created."""
    if not path:
        return
    try:
        os.unlink(path)
    except OSError:
        pass


def print_and_exit(err: DiskFull, code: int = 1):
    """A CLI or step's answer to a full disk: its one JSON error line on
    stderr (the steps' own error convention, lib/common.fail), exit `code`."""
    print(json.dumps(err.detail()), file=sys.stderr, flush=True)
    sys.exit(code)


_previous_hook = None


def written_folder(exc, fallback=None) -> str:
    """The folder a disk-full OSError in `exc`'s chain was writing in (its
    filename's), else `fallback`, else the workspace root: free space is read
    there, never at the process's cwd."""
    for e in _chain(exc):
        if _is_full_oserror(e):
            for name in (getattr(e, "filename2", None), getattr(e, "filename", None)):
                if isinstance(name, str) and name:
                    return os.path.dirname(os.path.abspath(name))
    return fallback or workspace_root()


def _excepthook(exc_type, exc, tb):
    if isinstance(exc, DiskFull) or is_disk_full(exc):
        # The traceback still goes to stderr, so a crash log stays diagnosable;
        # the LAST line is the one JSON error serve reads and the person sees.
        try:
            traceback.print_exception(exc_type, exc, tb, file=sys.stderr)
        except Exception:
            pass
        root = workspace_root()
        d = exc.detail() if isinstance(exc, DiskFull) else DiskFull(free=free_bytes(written_folder(exc, root)), path=root).detail()
        d["path"] = d.get("path") or root
        print(json.dumps(d), file=sys.stderr, flush=True)
        return
    (_previous_hook or sys.__excepthook__)(exc_type, exc, tb)


def install_excepthook() -> None:
    """Make an uncaught disk-full error in this process print the one JSON
    error line instead of a traceback (the exit status stays 1). Any other
    error goes to the hook that was there before. Idempotent."""
    global _previous_hook
    if sys.excepthook is _excepthook:
        return
    _previous_hook = sys.excepthook
    sys.excepthook = _excepthook
