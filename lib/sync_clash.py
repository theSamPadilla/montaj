"""§482 M4: the Studio sync clash set, as serve's backstop and the steps read it.

The app passes MONTAJ_SYNC_STATE_DIR (its `<runtimeHome>/studio-sync`) when Studio sync is on, and writes one
names-only sidecar per synced project, `<dir>/<projectId>/clash-set.json`:

    {"v": 1, "projectId": "<id>", "fields": [...], "files": [...], "clashes": [{"id", "fields", "files"}]}

`fields` are top-level project.json keys; `files` are relpaths inside the project folder, `/`-separated as on disk
(a trailing `/` is a folder). A write that touches one is refused for every writer but a person (serve/save_guard).

- The variable unset: sync is off. Nothing here is read, and every writer behaves as before.
- No sidecar for the project (no folder, or no file in it): no clash.
- Anything else that is not a valid sidecar (the folder missing or unreadable, a corrupt file, an unknown `v`, an id
  that cannot name a folder, a link out of the folder): UNSURE, which refuses every non-human write.

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


def file_key(relpath: str) -> str:
    """A relpath as compared: NFC, `/`-separated, no empty or `.` segment, case-folded (a case-insensitive disk
    names one file many ways; on a case-sensitive one the fold only refuses more). A trailing `/` is kept."""
    p = unicodedata.normalize("NFC", relpath).replace("\\", "/")
    key = "/".join(s for s in p.split("/") if s not in ("", "."))
    if key and p.endswith("/"):
        key += "/"
    return key.casefold()


class ClashSet:
    """What one sidecar says. `files` maps file_key to the sidecar's own spelling; `unsure` refuses everything."""
    __slots__ = ("fields", "files", "ids", "unsure")

    def __init__(self, fields=frozenset(), files=None, ids=frozenset(), unsure=False):
        self.fields = frozenset(fields)
        self.files = dict(files or {})
        self.ids = frozenset(ids)
        self.unsure = unsure


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
    ids = set()
    for clash in clashes:
        if not isinstance(clash, dict) or not isinstance(clash.get("id"), str) or not clash["id"]:
            return UNSURE
        more_fields, more_files = _names(clash.get("fields")), _names(clash.get("files"))
        if more_fields is None or more_files is None:
            return UNSURE
        ids.add(clash["id"])
        fields = fields + more_fields
        files = files + more_files
    return ClashSet(fields=fields, files={file_key(f): f for f in files}, ids=ids)


def load(project_id) -> ClashSet:
    """The project's clash set. Call only with state_dir() set."""
    base = state_dir()
    if not base or not valid_project_id(project_id):
        return UNSURE
    try:
        root = os.path.realpath(base)
        if not os.path.isdir(root):
            return UNSURE
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
                if k == EVERYTHING or w == k or (w.endswith("/") and k.startswith(w)) \
                        or (k.endswith("/") and w.startswith(k)):
                    hit.append(spelled)
    return list(dict.fromkeys(hit))


def message(names) -> str:
    """The app wrapper's syncConflictText (desktop/mcp/app-tools.mjs), word for word."""
    named = ", ".join(names) if names else "some fields"
    return (f"This project has an open Studio sync clash on {named}, so nothing was saved. A person must resolve "
            f"it in Montaj. Do not retry, and do not edit those fields.")


def refusal(names) -> dict:
    """The binding body, exactly: {error, fields, message}."""
    return {"error": "sync_conflict", "fields": list(names), "message": message(names)}


_MISSING = object()


def changed_fields(before: dict, after: dict) -> list:
    """Top-level keys whose value differs between two documents, or that one of them lacks."""
    before = before if isinstance(before, dict) else {}
    after = after if isinstance(after, dict) else {}
    return [k for k in dict.fromkeys([*before, *after]) if before.get(k, _MISSING) != after.get(k, _MISSING)]


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
