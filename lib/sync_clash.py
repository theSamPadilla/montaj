"""§482 M4: the Studio sync clash set, as serve's backstop and the steps read it.

The app passes MONTAJ_SYNC_STATE_DIR (its `<runtimeHome>/studio-sync`) when Studio sync is on, and writes one
names-only sidecar per synced project, `<dir>/<projectId>/clash-set.json`:

    {"v": 1, "projectId": "<id>", "fields": [...], "files": [...], "clashes": [{"id", "fields", "files"}]}

`fields` are top-level project.json keys; `files` are relpaths inside the project folder, `/`-separated as on disk
(a trailing `/` is a folder). A write that touches one is refused for every writer but a person (serve/save_guard).

- The variable unset: sync is off. Nothing here is read, and every writer behaves as before.
- No sidecar for the project (no folder, or no file in it): no clash.
- No state folder at all (nothing at that name, review 40 3a): no clash for any project. The app writes every sidecar
  AND its own clash record (conflicts.json) under that folder, so with no folder neither exists, and the app's own
  state reads it as "nothing synced" too (studio-sync/state.cjs scan(): ENOENT is an empty list). Evidence of sync is
  a project's own folder in the state folder; with no state folder there can be none. The app creates the folder
  before it launches serve (its launch assert), so this is the never-made case, not a lost one.
- Anything else that is not a valid sidecar (a state folder that exists but is not a readable folder, a dangling link
  as the state folder, a project folder that cannot be read, a corrupt file, an unknown `v`, an id that cannot name a
  folder, a link out of the folder): UNSURE, which refuses every non-human write. An unreadable state folder hides
  every project's folder, so it stays closed for all: nothing can tell a synced project from a never-synced one.

Read fresh on every write (a few hundred bytes, no cache): a cache keyed on the file's stat can miss an in-place
rewrite, and the shell's atomic rename is the common case.

A step run through serve gets MONTAJ_WRITE_ORIGIN (`human` for the window, `ai` for anything else) and checks the
fields it changes under the project lock (`check_step_write`); with the variable unset that check is off too."""
import json
import os
import re
import stat
import sys
import unicodedata

STATE_ENV = "MONTAJ_SYNC_STATE_DIR"
ORIGIN_ENV = "MONTAJ_WRITE_ORIGIN"
HUMAN_ORIGIN = "human"
SIDECAR = "clash-set.json"
EVERYTHING = "*"

# The app's studio-sync state rule (desktop/src/studio-sync/state.cjs validProjectId): the server's project id
# rule, and a folder name no platform changes (no trailing dot, no Windows device name). ASCII only, so no other
# Unicode form, full-width dot, separator or NUL can pass.
_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_DEVICE_RE = re.compile(r"(con|prn|aux|nul|com[0-9]|lpt[0-9])", re.IGNORECASE)
_MAX_BYTES = 4 * 1024 * 1024


def state_dir() -> "str | None":
    """The studio-sync folder the app named, or None when sync is off."""
    value = os.environ.get(STATE_ENV)
    return value or None


def valid_project_id(project_id) -> bool:
    if not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id) or project_id.endswith("."):
        return False
    return not _DEVICE_RE.fullmatch(project_id.split(".", 1)[0])


def _segment_key(segment: str) -> str:
    """One segment as Windows opens it: a `:stream` suffix (`new.png::$DATA` IS new.png) and trailing dots and
    spaces (`new.png.` and `new.png ` ARE new.png) dropped. A segment that would be left empty is kept as given
    (`..` stays `..`). Applied everywhere, like the case fold: on a disk that tells them apart it only refuses more,
    because both sides of every compare go through it."""
    base = segment.split(":", 1)[0].rstrip(". ")
    return base or segment


def file_key(relpath: str) -> str:
    """A relpath as compared: NFC, `/`-separated, no empty or `.` segment, each segment as Windows names it
    (_segment_key), case-folded (a case-insensitive disk names one file many ways; on a case-sensitive one the fold
    only refuses more). A trailing `/` is kept."""
    p = unicodedata.normalize("NFC", relpath).replace("\\", "/")
    key = "/".join(_segment_key(s) for s in p.split("/") if s not in ("", "."))
    if key and p.endswith("/"):
        key += "/"
    return key.casefold()


class ClashSet:
    """What one sidecar says. `files` maps file_key to the sidecar's own spelling; `unsure` refuses everything.
    `by_id` holds each clash's own names, {id: (fields, {file_key: spelling})}, for a resolve of that id."""
    __slots__ = ("fields", "files", "ids", "unsure", "by_id")

    def __init__(self, fields=frozenset(), files=None, ids=frozenset(), unsure=False, by_id=None):
        self.fields = frozenset(fields)
        self.files = dict(files or {})
        self.ids = frozenset(ids)
        self.unsure = unsure
        self.by_id = dict(by_id or {})


NO_CLASH = ClashSet()
UNSURE = ClashSet(unsure=True)


def _names(value) -> "list | None":
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
        return None
    return value


def _parse(raw: bytes, project_id: str) -> ClashSet:
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return UNSURE
    if not isinstance(doc, dict) or type(doc.get("v")) is not int or doc["v"] != 1 \
            or doc.get("projectId") != project_id:
        return UNSURE
    fields, files, clashes = _names(doc.get("fields")), _names(doc.get("files")), doc.get("clashes")
    if fields is None or files is None or not isinstance(clashes, list):
        return UNSURE
    ids, by_id = set(), {}
    for clash in clashes:
        if not isinstance(clash, dict) or not isinstance(clash.get("id"), str) or not clash["id"]:
            return UNSURE
        more_fields, more_files = _names(clash.get("fields")), _names(clash.get("files"))
        if more_fields is None or more_files is None:
            return UNSURE
        ids.add(clash["id"])
        own_fields, own_files = by_id.get(clash["id"], (frozenset(), {}))
        by_id[clash["id"]] = (own_fields | frozenset(more_fields),
                              {**own_files, **{file_key(f): f for f in more_files}})
        fields = fields + more_fields
        files = files + more_files
    return ClashSet(fields=fields, files={file_key(f): f for f in files}, ids=ids, by_id=by_id)


def _nothing_at(path) -> bool:
    """True when nothing at all is at `path`, not even a link (a missing parent counts: nothing is there)."""
    try:
        os.lstat(path)
    except FileNotFoundError:
        return True
    except (OSError, ValueError):
        return False
    return False


def load(project_id) -> ClashSet:
    """The project's clash set. Call only with state_dir() set."""
    base = state_dir()
    if not base or not valid_project_id(project_id):
        return UNSURE
    try:
        root = os.path.realpath(base)
        if not os.path.isdir(root):
            # Nothing at that name: the app never made it, and no project has a clash recorded (module docstring).
            # Anything else there (a file, a dangling link, a folder that cannot be looked into) stays unsure.
            return NO_CLASH if _nothing_at(base) else UNSURE
        folder = os.path.realpath(os.path.join(root, project_id))
    except (OSError, ValueError):
        return UNSURE
    # The id's folder, directly in the state folder: never a link to anywhere else, not even a sibling.
    if os.path.dirname(folder) != root or os.path.basename(folder) != project_id:
        return UNSURE
    path = os.path.join(folder, SIDECAR)
    try:
        seen = os.lstat(path)
    except FileNotFoundError:
        return NO_CLASH
    except OSError:
        return UNSURE
    if not stat.S_ISREG(seen.st_mode):
        return UNSURE   # a link, a folder, a pipe
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        return NO_CLASH   # removed between the two calls: the shell's own clear
    except OSError:
        return UNSURE
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (seen.st_dev, seen.st_ino):
            return UNSURE   # swapped for something else between lstat and open
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            size += len(chunk)
            if size > _MAX_BYTES:
                return UNSURE
            chunks.append(chunk)
    except OSError:
        return UNSURE
    finally:
        os.close(fd)
    return _parse(b"".join(chunks), project_id)


def _file_hit(written_key: str, clashed_key: str) -> bool:
    """A written relpath (as file_key) meets a clashed one: the same, or either is a folder holding the other."""
    return clashed_key == EVERYTHING or written_key == clashed_key \
        or (written_key.endswith("/") and clashed_key.startswith(written_key)) \
        or (clashed_key.endswith("/") and written_key.startswith(clashed_key))


def touched(clashes: ClashSet, fields=(), files=(), everything: bool = False) -> list:
    """The clashed names a write touches: field names, then the sidecar's own relpaths. `everything` (or `*` in
    `fields`/`files`) is a write whose scope is the whole project. An unsure set names the write's own names
    (`*` for an `everything` write)."""
    fields, files = list(fields), list(files)
    if clashes.unsure:
        if everything:
            return [EVERYTHING]
        return list(dict.fromkeys([*fields, *files]))
    hit = []
    if everything or EVERYTHING in fields:
        hit += sorted(clashes.fields)
    else:
        hit += [f for f in fields if f in clashes.fields or EVERYTHING in clashes.fields]
    if everything or EVERYTHING in files:
        hit += [clashes.files[k] for k in sorted(clashes.files)]
    else:
        for written in files:
            w = file_key(written)
            for k, spelled in clashes.files.items():
                if _file_hit(w, k):
                    hit.append(spelled)
    return list(dict.fromkeys(hit))


def outside_clash(clashes: ClashSet, clash_id: str, fields=(), files=(), derived=(), everything: bool = False) -> list:
    """For a person's resolve of the open clash `clash_id` (review 40, 4): the names it may not write. Every field
    and file it names outside that clash's own names (a file is inside when it is one of them or under one of its
    folders; `*` covers all), in the write's own spelling; and every `derived` field (one the write changes without
    naming it, a normalisation) that another open clash holds. A whole-project write is `*`, unless the clash
    itself is the whole project."""
    own_fields, own_files = clashes.by_id.get(clash_id, (frozenset(), {}))
    if everything:
        return [] if EVERYTHING in own_fields and EVERYTHING in own_files else [EVERYTHING]
    out = [f for f in fields if f not in own_fields and EVERYTHING not in own_fields]
    for written in files:
        w = file_key(written)
        if not any(k == EVERYTHING or w == k or (k.endswith("/") and w.startswith(k)) for k in own_files):
            out.append(written)
    if EVERYTHING not in own_fields:
        out += [f for f in derived if f not in own_fields and (f in clashes.fields or EVERYTHING in clashes.fields)]
    return list(dict.fromkeys(out))


def message(names) -> str:
    """The app wrapper's syncConflictText (desktop/mcp/app-tools.mjs), word for word."""
    named = ", ".join(names) if names else "some fields"
    return (f"This project has an open Studio sync clash on {named}, so nothing was saved. A person must resolve "
            f"it in Montaj. Do not retry, and do not edit those fields.")


def refusal(names) -> dict:
    """The binding body, exactly: {error, fields, message}."""
    return {"error": "sync_conflict", "fields": list(names), "message": message(names)}


_MISSING = object()


def _same_on_disk(a, b) -> bool:
    """Whether two JSON values write the same. `==` is not enough: True == 1 == 1.0 in Python, never on disk. The
    same object, or values `==` says differ, decide at once; only an equal pair of distinct objects is compared again
    by their canonical JSON (key order aside). Anything that cannot be compared counts as changed."""
    if a is b:
        return True
    try:
        if a != b:
            return False
        return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    except (TypeError, ValueError, RecursionError):
        return False


def changed_fields(before: dict, after: dict) -> list:
    """Top-level keys whose value differs on disk between two documents (a change of type included), or that one of
    them lacks."""
    before = before if isinstance(before, dict) else {}
    after = after if isinstance(after, dict) else {}
    return [k for k in dict.fromkeys([*before, *after])
            if not _same_on_disk(before.get(k, _MISSING), after.get(k, _MISSING))]


class SyncConflict(RuntimeError):
    """A step's write refused under the project lock; `body` is the binding refusal."""

    def __init__(self, body: dict):
        super().__init__(body["message"])
        self.body = body


def check_step_write(project_id, fields=(), files=()) -> None:
    """For a step's own write, under the project lock: raise SyncConflict when it touches a clashed name. Off with
    the variable unset; a step the window ran (MONTAJ_WRITE_ORIGIN=human, set only by serve) passes."""
    if not state_dir() or os.environ.get(ORIGIN_ENV) == HUMAN_ORIGIN:
        return
    if not fields and not files:
        return
    names = touched(load(project_id), fields, files)
    if names:
        raise SyncConflict(refusal(names))


def check_step_document(before: dict, after: dict, files=()) -> None:
    """check_step_write on the top-level fields `after` changes from `before` (both read under the lock)."""
    if not state_dir():
        return
    pid = (after if isinstance(after, dict) else {}).get("id") or (before if isinstance(before, dict) else {}).get("id")
    check_step_write(pid, changed_fields(before, after), files)


def exit_refused(body: dict) -> None:
    """A step's structured exit for a refusal: the binding body on stderr, exit 1 (serve answers it as 409)."""
    print(json.dumps(body), file=sys.stderr)
    sys.exit(1)
