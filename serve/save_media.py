"""Saving a project copies media it borrows from elsewhere in the workspace
into the project itself (§126).

Measured 2026-10-07: a project's outro sound pointed at another project's
`assets/outro.wav`, so deleting that other project broke this one mid-render,
and another project pointed at seven files in the app's `.imports/` staging
area. Every writer (the AI, the editor, agents) saves through
`PUT /projects/{id}`, so `save_project` runs this in three steps:

1. `plan_borrowed_media`, on the event loop, stat calls only, between the
   save's merge and its write: which new or changed `src` values point at a
   borrowed file. The save is then written as it always was, borrowed paths
   and all, in the same synchronous read-merge-write. Nothing borrowed (the
   usual save) means nothing more: no thread, no await.
2. `copy_borrowed_media`, off the loop, with no lock, after the save's write:
   copy each one into `<project>/assets/` (or reuse an earlier copy).
3. `apply_borrowed_media`, on the loop, in a second synchronous
   read-modify-write (the patch), run by the copy's own completion whenever
   it finishes: in time for the save's answer, after the save stopped
   waiting, or after the request went away. It points each entry of the
   project as it is now that is new or changed against the project before
   the save, and still holds a copied path, at its copy. The patch never
   merges the save's body again, so a write that landed during the copy (an
   ingest, another save) is kept, and an entry someone changed meanwhile is
   left alone.

What is looked at: the `src` of video and image items on `tracks[*].items[*]`,
`sources[]`, `assets[]` and `audio.tracks[]`, and only a value that is NEW or
CHANGED: a `src` the saved project has anywhere, in any entry, however an
absolute path is spelled (`/./`, `/` for `\\` and case on Windows), is
unchanged (the editor gives id-less audio tracks an id on open, a split or
duplicated clip gets a new id, an asset can be placed on a track, a track can
be repointed at a file another entry uses). Nothing else (`proxySrc`, overlay
props, captions, the voiceover) is touched, and an unchanged path is never
copied, so a repeat save costs nothing. The one exception is a copy that
failed (an error, not a file left on purpose: over the cap, past the budget
or short of disk): its path is saved, so no longer new, and `retry_later`
keeps it, in this process and bounded, for the project's next save to try
again whatever that save carries.

What is copied (`borrowed`): an existing, non-symlink file whose literal path
(`normpath(abspath(p))`, never the realpath) is under the workspace, outside
this project's folder, and is in another project's folder (any folder under the
workspace holding a `project.json`), in `.imports/` or in `_uploads/`. The
workspace is checked first, so a path outside it costs no stat of its own, and
the workspace and project folder are spelled (and stat'ed) once per save.

What is never copied: a path inside this project's folder (judged by the
literal path, so a Clips child's link to its parent's footage stays a link, and
by identity, so a different spelling of this folder, by case or Unicode form,
is still this folder), a symlink, anything under `.sources/` (shared Clips
originals and proxies), anything outside the workspace (the user's own
footage), a missing file, a relative or non-string value.

How it copies: an APFS clone where it can, at any size. Otherwise a plain copy,
which is skipped (the path left, one warning) for a file over MAX_COPY_BYTES,
or, once this save has made plain copies, past COPY_BUDGET_BYTES of them in
all (so a save's first plain copy may be up to the cap), or without the
file's size plus DISK_HEADROOM_BYTES free. A copy is made under a unique
temporary name in `assets/` and then given a free final name, so it never
replaces or deletes another file. `assets/.copied.json` records each copy
(source realpath to the copy's file name and modification time, with the
source's device, inode, size and modification time then) as soon as it is
made, and a source saved again is given its recorded copy while that copy is
still the file it was made as and the source is unchanged, so an editor or
agent still holding the old path never makes a second one. The record is
found by the source's realpath or by its device and inode (a case or Unicode
variant of its path), and this process also remembers its copies, so a record
that could not be written still gives the copy back. Copies of one source
into one project take turns (a thread lock in this process), so two saves in
flight make one copy. Temporary files a crash left behind (in `assets/`, and
project.json's own in the project folder) are swept at the next copy once
they are an hour old.
"""
import json
import os
import shutil
import stat
import threading
import time
import uuid
import weakref
from collections import OrderedDict

from lib.project_tracks import normalize_tracks
from project.init import _free_name, _try_clone

# Plain copies only (a clone takes no space and no time).
MAX_COPY_BYTES = 8 * 1024 ** 3        # one file
COPY_BUDGET_BYTES = 2 * 1024 ** 3     # one save's plain copies after its first
DISK_HEADROOM_BYTES = 1024 ** 3       # left free after a plain copy
STALE_TEMP_SECONDS = 3600             # a temp file this old is a crash's leftover
ASSETS_DIR = "assets"
RECORD_NAME = ".copied.json"
PROJECT_FILE = "project.json"
_TEMP_PREFIX = ".copying-"
_STAGING_DIRS = (".imports", "_uploads")
_SHARED_DIR = ".sources"
_ITEM_TYPES = ("video", "image")

# Path logic, stat and the clock, as module globals so a test can run the
# rule with Windows paths (ntpath) on any OS, or age a temp file.
_p = os.path
_stat = os.stat
_now = time.time

# In-process turn-taking for copies (see the module docstring). No asyncio
# lock: these are held only in the copy's own thread.
_record_lock = threading.Lock()
_publish_lock = threading.Lock()
_source_locks: "weakref.WeakValueDictionary[tuple, threading.Lock]" = weakref.WeakValueDictionary()
_source_locks_guard = threading.Lock()

# This process's copies, by (assets folder key, source st_dev, st_ino): the
# record's entries, kept so a copy is reused even when `.copied.json` could
# not be written. Oldest dropped first.
_MEMO_SIZE = 1024
_memo: "OrderedDict[tuple, dict]" = OrderedDict()
_memo_lock = threading.Lock()

# Failed copies for a project's next save to try again (`retry_later`):
# {project key: {key: src}}. Oldest project, and a project's oldest file,
# dropped first.
_PENDING_PROJECTS = 64
_PENDING_PER_PROJECT = 256
_pending: "OrderedDict[str, dict[str, str]]" = OrderedDict()
_pending_lock = threading.Lock()


def _norm(path: str) -> str:
    return _p.normpath(_p.abspath(path))


def _cmp(path: str) -> str:
    return _p.normcase(path)


def _key(src: str) -> str:
    """One key per file however a value spells it, for grouping and the map."""
    return _cmp(_norm(src))


def _ident(src: str) -> str:
    """What a `src` is compared by: an absolute path by its key, anything
    else as written."""
    return _key(src) if _p.isabs(src) else src


def _inside(path: str, root: str) -> bool:
    """`path` is `root` or below it. Both already normalized."""
    p, r = _cmp(path), _cmp(root)
    return p == r or p.startswith(r if r.endswith(_p.sep) else r + _p.sep)


def _below(path: str, root: str) -> bool:
    """`path` is strictly below `root`. Both already normalized."""
    return _inside(path, root) and _cmp(path) != _cmp(root)


def _spellings(folder) -> list[str]:
    """A folder's literal path (`~` expanded) and, when an ancestor is a
    symlink (macOS /tmp, a workspace reached through a link), its real one too.
    Only the FOLDERS are resolved; the media path itself is always judged
    literally."""
    literal = _norm(_p.expanduser(str(folder)))
    real = _p.realpath(literal)
    return [literal] if _cmp(real) == _cmp(literal) else [literal, real]


_UNSET = object()


class _Where:
    """What one save's paths are judged against: the workspace and this
    project's folder, each spelled (and the folder stat'ed) at most once and
    only when a path first needs it, so a path outside the workspace still
    costs no stat of its own; and what a walk up a path's folders found, so
    paths sharing folders look at each once."""

    def __init__(self, project_dir, workspace):
        self.project_dir = project_dir
        self.workspace = _norm(_p.expanduser(str(workspace)))
        self._workspace_real = None
        self._project_spellings = None
        self._project_stat = _UNSET
        self._is_project: dict[str, bool] = {}
        self._holds_project: dict[str, bool] = {}

    def root(self, path: str) -> str | None:
        """The spelling of the workspace that `path` is strictly below, or
        None. A string test on the literal spelling first; the workspace's
        own realpath only when that fails. The path itself costs no stat."""
        if _below(path, self.workspace):
            return self.workspace
        if self._workspace_real is None:
            self._workspace_real = _p.realpath(self.workspace)
        real = self._workspace_real
        if _cmp(real) != _cmp(self.workspace) and _below(path, real):
            return real
        return None

    def project_spellings(self) -> list[str]:
        if self._project_spellings is None:
            self._project_spellings = _spellings(self.project_dir)
        return self._project_spellings

    def is_project(self, folder: str) -> bool:
        """`folder` is this project's folder, by identity (another spelling
        of it, by case or NFC/NFD, which only the file system can tell)."""
        hit = self._is_project.get(folder)
        if hit is None:
            if self._project_stat is _UNSET:
                try:
                    self._project_stat = _stat(_norm(_p.expanduser(str(self.project_dir))))
                except (OSError, ValueError):
                    self._project_stat = None
            hit = False
            if self._project_stat is not None:
                try:
                    hit = _p.samestat(_stat(folder), self._project_stat)
                except (OSError, ValueError):
                    pass
            self._is_project[folder] = hit
        return hit

    def holds_project(self, folder: str) -> bool:
        """`folder` holds a project.json: it is a project's folder."""
        hit = self._holds_project.get(folder)
        if hit is None:
            hit = self._holds_project[folder] = _p.isfile(_p.join(folder, PROJECT_FILE))
        return hit


def _in_project(path: str, where: _Where, root: str) -> bool:
    """`path` (below the workspace spelled `root`) is in this project's
    folder: literally (so a link that lives in the folder is the project's,
    wherever it points), or because one of its folders IS the project folder
    spelled another way. That walk stops at the workspace: the project is
    below it."""
    if any(_inside(path, d) for d in where.project_spellings()):
        return True
    folder = _p.dirname(path)
    while _below(folder, root):
        if where.is_project(folder):
            return True
        folder = _p.dirname(folder)
    return False


def _borrowed(src, where: _Where) -> bool:
    if not isinstance(src, str) or not src or not _p.isabs(src):
        return False
    path = _norm(src)
    root = where.root(path)
    if root is None or _in_project(path, where, root):
        return False
    top = _cmp(_p.relpath(path, root).split(_p.sep, 1)[0])
    if top == _SHARED_DIR or _p.islink(path) or not _p.isfile(path):
        return False
    if top in _STAGING_DIRS:
        return True
    folder = _p.dirname(path)
    while _below(folder, root):
        if where.holds_project(folder):
            return True
        folder = _p.dirname(folder)
    return False


def borrowed(src, project_dir, workspace) -> bool:
    """True when `src` is a file this project borrows from another project's
    folder, `.imports/` or `_uploads/` under `workspace`: media to copy in.
    Stat calls only, and none for a path outside the workspace. The module
    docstring has the full rule."""
    return _borrowed(src, _Where(project_dir, workspace))


def _refs(project) -> list[tuple[str, dict]]:
    """(family, entry) for every entry whose `src` may be copied: track video
    and image items and `sources` ("clip"), `assets` and `audio.tracks`."""
    out: list[tuple[str, dict]] = []
    if not isinstance(project, dict):
        return out
    tracks = project.get("tracks")
    for track in tracks if isinstance(tracks, list) else []:
        items = track.get("items") if isinstance(track, dict) else None
        for item in items if isinstance(items, list) else []:
            if isinstance(item, dict) and item.get("type") in _ITEM_TYPES:
                out.append(("clip", item))
    for key, family in (("sources", "clip"), ("assets", "asset")):
        entries = project.get(key)
        if isinstance(entries, list):
            out += [(family, e) for e in entries if isinstance(e, dict)]
    audio = project.get("audio")
    entries = audio.get("tracks") if isinstance(audio, dict) else None
    if isinstance(entries, list):
        out += [("audio", e) for e in entries if isinstance(e, dict)]
    return out


def _changed_entries(previous, project) -> list[dict]:
    """The entries of `project` whose string `src` is new or changed against
    `previous`: a `src` that `previous` has anywhere, in any entry, is
    unchanged, an absolute path however spelled (the module docstring has the
    rule)."""
    saved = normalize_tracks(previous) if isinstance(previous, dict) else {}
    known = {_ident(entry["src"]) for _, entry in _refs(saved) if isinstance(entry.get("src"), str)}
    return [entry for _, entry in _refs(project)
            if isinstance(entry.get("src"), str) and _ident(entry["src"]) not in known]


def _entries_holding(project, keys) -> list[dict]:
    """The entries of `project` whose absolute `src` is one of `keys`."""
    return [entry for _, entry in _refs(project)
            if isinstance(entry.get("src"), str) and _p.isabs(entry["src"]) and _key(entry["src"]) in keys]


def plan_borrowed_media(previous: dict, project: dict, project_dir, workspace,
                        pending: dict | None = None) -> dict[str, str]:
    """`{key: src}`, one per borrowed file a new or changed `src` in `project`
    points at, and per file of `pending` (`pending_media`: a copy that failed
    before) an entry of `project` still points at. On the event loop: stat
    calls only, no copy, no thread."""
    where = _Where(project_dir, workspace)
    entries = _changed_entries(previous, project)
    if pending:
        entries += _entries_holding(project, pending)
    wanted: dict[str, str] = {}
    looked: set = set()
    for entry in entries:
        src = entry["src"]
        key = _key(src) if _p.isabs(src) else None
        if key is None or key in looked:
            continue
        looked.add(key)
        if _borrowed(src, where):
            wanted[key] = src
    return wanted


def _project_key(project_dir) -> str:
    return _key(str(project_dir))


def retry_later(project_dir, files: dict[str, str]) -> None:
    """Keep `{key: src}`, files whose copy into the project failed, for the
    project's next save to plan again (`pending_media`), though their paths
    are saved by then and so no longer new. In this process only, bounded."""
    if not files:
        return
    project = _project_key(project_dir)
    with _pending_lock:
        kept = _pending.pop(project, {})
        for key, src in files.items():
            kept.pop(key, None)
            kept[key] = src
        while len(kept) > _PENDING_PER_PROJECT:
            del kept[next(iter(kept))]
        _pending[project] = kept
        while len(_pending) > _PENDING_PROJECTS:
            _pending.popitem(last=False)


def pending_media(project_dir) -> dict[str, str]:
    """The project's files to try again (`retry_later`), `{key: src}`."""
    with _pending_lock:
        return dict(_pending.get(_project_key(project_dir), ()))


def forget_pending(project_dir, keys) -> None:
    """Drop `keys` from the project's files to try again."""
    project = _project_key(project_dir)
    with _pending_lock:
        kept = _pending.get(project)
        if kept is None:
            return
        for key in keys:
            kept.pop(key, None)
        if not kept:
            del _pending[project]


def _size(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


class _Left(Exception):
    """A file deliberately not copied; the message says why. Never tried
    again by a later save (`retry_later` is for failures)."""


def _read_record(assets_dir: str) -> dict:
    try:
        with open(os.path.join(assets_dir, RECORD_NAME), encoding="utf-8") as f:
            record = json.load(f)
    except (OSError, ValueError):
        return {}
    return record if isinstance(record, dict) else {}


def _write_record(assets_dir: str, record: dict) -> None:
    """Temp file (a unique name) + os.replace: the record is whole or the old
    one."""
    path = os.path.join(assets_dir, RECORD_NAME)
    tmp = f"{path}.{uuid.uuid4().hex}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _record_entry(st: os.stat_result, dest: str) -> dict:
    """What the record keeps of one copy: its file name and modification time,
    and the source's device, inode, size and modification time (`st`)."""
    return {"name": os.path.basename(dest), "copyMtimeNs": os.lstat(dest).st_mtime_ns,
            "dev": st.st_dev, "ino": st.st_ino, "size": st.st_size, "mtimeNs": st.st_mtime_ns}


def _valid_copy(entry, st: os.stat_result, assets_dir: str) -> str | None:
    """The copy `entry` names, while the source (`st`) has the size and
    modification time it had when it was copied and the copy is still the
    file it was made as (a file of that size, with its modification time)."""
    if not isinstance(entry, dict):
        return None
    name = entry.get("name")
    if (not isinstance(name, str) or not name or os.path.basename(name) != name
            or name == RECORD_NAME or name.startswith(_TEMP_PREFIX)):
        return None
    if entry.get("size") != st.st_size or entry.get("mtimeNs") != st.st_mtime_ns:
        return None
    target = os.path.join(assets_dir, name)
    try:
        tst = os.lstat(target)
    except OSError:
        return None
    if (not stat.S_ISREG(tst.st_mode) or tst.st_size != st.st_size
            or tst.st_mtime_ns != entry.get("copyMtimeNs")):
        return None
    return target


def _recorded_copy(record: dict, real: str, st: os.stat_result, assets_dir: str) -> str | None:
    """An earlier copy of the source at `real` (stat `st`) in `assets_dir`:
    recorded under its realpath, or under any path with its device and inode
    (a case or Unicode variant of the path), or remembered by this process
    (a record that could not be written). See `_valid_copy`."""
    same_file = [e for e in record.values()
                 if isinstance(e, dict) and e.get("dev") == st.st_dev and e.get("ino") == st.st_ino]
    with _memo_lock:
        remembered = _memo.get((_key(assets_dir), st.st_dev, st.st_ino))
    for entry in [record.get(real), *same_file, remembered]:
        dest = _valid_copy(entry, st, assets_dir)
        if dest is not None:
            return dest
    return None


def _publish(tmp: str, assets_dir: str, name: str) -> str:
    """Give the finished copy at `tmp` its final name: `name`, or the first
    free numbered one. Never replaces an entry: a hard link fails on a name
    that exists, so one taken in the meantime is skipped. A volume without
    hard links (exFAT, some shares) gets a rename to a name checked free just
    before, which `_publish_lock` keeps free from this process's other copies."""
    with _publish_lock:
        return _publish_unlocked(tmp, assets_dir, name)


def _publish_unlocked(tmp: str, assets_dir: str, name: str) -> str:
    for _ in range(1000):
        dest = _free_name(assets_dir, name, "asset")
        try:
            os.link(tmp, dest)
        except FileExistsError:
            continue
        except OSError:
            if os.path.lexists(dest):
                continue
            os.replace(tmp, dest)
            return dest
        try:
            os.unlink(tmp)
        except OSError:
            # Held for a moment (Windows: an antivirus, the indexer). The copy
            # is published under `dest`; the temp sweep removes this name.
            pass
        return dest
    raise OSError(f"no free name for {name} in {assets_dir}")


def _copy_one(path: str, size: int, assets_dir: str, spent: list) -> str:
    """Copy `path` into `assets_dir` under a free name; returns it. A clone at
    any size; else a plain copy within the cap, the save's budget (`spent[0]`
    is what its earlier plain copies came to) and the free space, or `_Left`.
    Works under a unique temporary name, removed on any failure, so it never
    clobbers or deletes another file."""
    os.makedirs(assets_dir, exist_ok=True)
    tmp = os.path.join(assets_dir, f"{_TEMP_PREFIX}{uuid.uuid4().hex}{os.path.splitext(path)[1]}")
    made = False
    try:
        made = _try_clone(path, tmp)
        if not made:
            if size > MAX_COPY_BYTES:
                raise _Left(f"it is {_size(size)}, over the {_size(MAX_COPY_BYTES)} limit for one copy")
            if spent[0] and spent[0] + size > COPY_BUDGET_BYTES:
                raise _Left(f"it is {_size(size)} and this save already copied {_size(spent[0])}, "
                            f"past the {_size(COPY_BUDGET_BYTES)} one save may copy")
            # Not reserved: copies running at once each see the same free
            # space; the headroom absorbs that, and one that still runs out fails.
            free = shutil.disk_usage(assets_dir).free
            if free < size + DISK_HEADROOM_BYTES:
                raise _Left(f"it is {_size(size)} and the disk has {_size(free)} free")
            made = True
            shutil.copy2(path, tmp)
            spent[0] += size
        return _publish(tmp, assets_dir, os.path.basename(path))
    except BaseException:
        if made:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise


def _is_copy_temp(name: str) -> bool:
    """A copy's temp file or a record write's, in `assets/`."""
    return name.startswith(_TEMP_PREFIX) or (name.startswith(RECORD_NAME + ".") and name.endswith(".tmp"))


def _is_project_temp(name: str) -> bool:
    """A project.json write's temp file (serve's, or the CLI's `project.json.tmp`)."""
    return name.startswith(PROJECT_FILE + ".") and name.endswith(".tmp")


def _sweep_stale_temps(folder: str, is_temp) -> None:
    """Remove the files in `folder` that `is_temp` names and that are
    STALE_TEMP_SECONDS old: what a copy or a write left when serve died part
    way. Nothing else is looked at. Age is the later of mtime and ctime,
    because a clone or copy2 gives a fresh temp file the source's old mtime,
    while its ctime is when it was made."""
    cutoff = _now() - STALE_TEMP_SECONDS
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                if not is_temp(entry.name):
                    continue
                try:
                    st = entry.stat(follow_symlinks=False)
                    if stat.S_ISREG(st.st_mode) and max(st.st_mtime, st.st_ctime) < cutoff:
                        os.unlink(entry.path)
                except OSError:
                    pass
    except OSError:
        pass


def _source_lock(assets_dir: str, st: os.stat_result) -> threading.Lock:
    """The lock copies of the source file `st` (by device and inode, however
    its path is spelled) into `assets_dir` take turns on."""
    key = (_key(assets_dir), st.st_dev, st.st_ino)
    with _source_locks_guard:
        lock = _source_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _source_locks[key] = lock
        return lock


def _remember(assets_dir: str, real: str, entry: dict) -> None:
    """Add one copy to this process's memory, then to the record: re-read,
    add, write, under `_record_lock`, so copies finishing at once (a late one
    included) each keep their entry. Raises when the record can't be written;
    the memory still has the copy."""
    with _memo_lock:
        key = (_key(assets_dir), entry["dev"], entry["ino"])
        _memo.pop(key, None)
        _memo[key] = entry
        while len(_memo) > _MEMO_SIZE:
            _memo.popitem(last=False)
    with _record_lock:
        record = _read_record(assets_dir)
        record[real] = entry
        _write_record(assets_dir, record)


def copy_borrowed_media(wanted: dict[str, str], project_dir) -> tuple[dict[str, str], list[str]]:
    """Copy each file in `wanted` (from `plan_borrowed_media`) into
    `<project_dir>/assets/`, or find its earlier copy. Off the event loop,
    with no lock but the in-process turn-taking above, and safe to finish
    after the save stopped waiting. Never raises for one file; a file whose
    copy failed (not one left on purpose) is kept for the next save to try
    again (`retry_later`).

    Returns `({key: copy path}, warnings)`: a sentence per file left where it
    is (not copied, or the copy failed).
    """
    assets_dir = os.path.join(str(project_dir), ASSETS_DIR)
    _sweep_stale_temps(str(project_dir), _is_project_temp)
    _sweep_stale_temps(assets_dir, _is_copy_temp)
    spent = [0]
    made: dict[str, str] = {}
    warnings: list[str] = []
    for key, src in wanted.items():
        path = _norm(src)
        try:
            real = os.path.realpath(path)
            with _source_lock(assets_dir, os.stat(real)):
                st = os.stat(real)
                dest = _recorded_copy(_read_record(assets_dir), real, st, assets_dir)
                if dest is None:
                    dest = _copy_one(path, st.st_size, assets_dir, spent)
                    try:
                        _remember(assets_dir, real, _record_entry(st, dest))
                    except Exception as exc:  # the copy stands, and this process remembers it
                        print(f"[montaj] save_media: could not record a copy in {assets_dir}: {exc}")
        except _Left as why:
            warnings.append(f"Not copied into the project: {src} ({why}), so the project still depends on it.")
            continue
        except Exception as exc:
            warnings.append(f"Not copied into the project: {src} ({exc}), so the project still depends on it.")
            retry_later(project_dir, {key: src})
            continue
        made[key] = dest
    return made, warnings


def apply_borrowed_media(previous: dict, project: dict, made: dict[str, str], also=()) -> list[dict]:
    """The patch's swap: point every entry of `project` (the project as it is
    now) that is new or changed against `previous` (the project before the
    save), or holds a file of `also` (one this save tried again, whose path
    was saved before it), and still holds a path whose file was copied at its
    copy, in place. An entry someone changed meanwhile holds another path and
    is left alone. Returns `[{"from": old, "to": new}]`, one per file."""
    if not made:
        return []
    entries = _changed_entries(previous, project)
    if also:
        seen = {id(entry) for entry in entries}
        entries += [entry for entry in _entries_holding(project, set(also)) if id(entry) not in seen]
    copied: dict[str, dict] = {}
    for entry in entries:
        src = entry["src"]
        if not _p.isabs(src):
            continue
        key = _key(src)
        dest = made.get(key)
        if dest is None:
            continue
        copied.setdefault(key, {"from": src, "to": dest})
        entry["src"] = dest
    return list(copied.values())
