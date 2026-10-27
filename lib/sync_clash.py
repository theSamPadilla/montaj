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
  before it launches serve (its launch assert), so this is the never-made case, not a lost one. "Nothing there" means
  a real folder above it lacks the name: a missing name under a link that points nowhere (an unmounted volume) is
  unsure. serve prints MISSING_STATE_LINE once (at startup, or when it first finds the folder gone), so this
  fail-open is never silent.
- Anything else that is not a valid sidecar (a relative path, a state folder that exists but is not a readable folder,
  a dangling link, a project folder that cannot be read, a corrupt file, an unknown `v`, an id that cannot name a
  folder, a link out of the folder): UNSURE. UNSURE IS NOT A CLASH (Sam, 1.5.1: a false "person must resolve it"
  stopped the AI on a project with no clash; "if the sync state can't be checked make the edit optimistically"). The
  write goes through. load() logs the reason once per id and reason a minute, so an unsure read names itself. Only a
  readable recorded clash that covers what the write touches refuses, and a whole-project one reads "the whole
  project", not `*`.

Read fresh on every write (a few hundred bytes, no cache): a cache keyed on the file's stat can miss an in-place
rewrite, and the shell's atomic rename is the common case.

A step run through serve gets MONTAJ_WRITE_ORIGIN (`human` for the window, `drive` for the window while the person's
AI drives it, `ai` for anything else) and checks the fields it changes under the project lock (`check_step_write`);
with the variable unset that check is off too.

HELD CLASHES (Sam, 2026-10-24: an AI write from the window to a clashed name is allowed). Before it forwards a driven
window write, the app copies the person's version of each clash that write may touch and marks that clash `held: true`
in the sidecar. A `drive` write passes on a name only while every clash naming it is held (`unheld_touched`); a name no
clash entry holds, or an unsure set, refuses it as before."""
import json
import os
import re
import stat
import sys
import time
import unicodedata

STATE_ENV = "MONTAJ_SYNC_STATE_DIR"
ORIGIN_ENV = "MONTAJ_WRITE_ORIGIN"
HUMAN_ORIGIN = "human"
DRIVE_ORIGIN = "drive"
SIDECAR = "clash-set.json"
EVERYTHING = "*"

# The app's studio-sync state rule (desktop/src/studio-sync/state.cjs validProjectId): the server's project id
# rule, and a folder name no platform changes (no trailing dot, no Windows device name). ASCII only, so no other
# Unicode form, full-width dot, separator or NUL can pass.
_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_DEVICE_RE = re.compile(r"(con|prn|aux|nul|com[0-9]|lpt[0-9])", re.IGNORECASE)
_MAX_BYTES = 4 * 1024 * 1024

# serve's notice of a missing state folder: no paths (it reaches us through crash-report log tails). Only serve arms it
# (serve/save_guard.startup); a step is a process of its own whose stderr carries its answer, and never prints it.
MISSING_STATE_LINE = ("studio-sync: MONTAJ_SYNC_STATE_DIR is set but its folder does not exist, "
                      "so serve sees no Studio sync clash in any project")
_missing_log = {"armed": False, "logged": False}


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
    `by_id` holds each clash's own names, {id: (fields, {file_key: spelling})}, for a resolve of that id; `held` the ids
    the app marked held (every entry of that id says `held: true`)."""
    __slots__ = ("fields", "files", "ids", "unsure", "by_id", "held")

    def __init__(self, fields=frozenset(), files=None, ids=frozenset(), unsure=False, by_id=None, held=frozenset()):
        self.fields = frozenset(fields)
        self.files = dict(files or {})
        self.ids = frozenset(ids)
        self.unsure = unsure
        self.by_id = dict(by_id or {})
        self.held = frozenset(held)


NO_CLASH = ClashSet()
UNSURE = ClashSet(unsure=True)

# An UNSURE read is not a clash (Sam, 1.5.1): it is logged and the write goes through. The reason is only ever
# logged, never the contents of a path.
_UNSURE_LOG_EVERY = 60.0
_unsure_logged: dict = {}


def _unsure(project_id, reason: str) -> ClashSet:
    """UNSURE, having logged `reason` to stderr: once per project id and reason a minute."""
    ident = project_id if valid_project_id(project_id) else "<invalid id>"
    now = time.monotonic()
    key = (ident, reason)
    last = _unsure_logged.get(key)
    if last is None or now - last >= _UNSURE_LOG_EVERY:
        _unsure_logged[key] = now
        print(f"sync_clash: unsure for {ident}: {reason}; let through", file=sys.stderr, flush=True)
    return UNSURE


def _names(value) -> "list | None":
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
        return None
    return value


def _parse(raw: bytes, project_id: str) -> ClashSet:
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return _unsure(project_id, "the sidecar is not valid JSON")
    if not isinstance(doc, dict) or type(doc.get("v")) is not int or doc["v"] != 1 \
            or doc.get("projectId") != project_id:
        return _unsure(project_id, "the sidecar is not a v1 sidecar of this project")
    fields, files, clashes = _names(doc.get("fields")), _names(doc.get("files")), doc.get("clashes")
    if fields is None or files is None or not isinstance(clashes, list):
        return _unsure(project_id, "the sidecar's fields, files or clashes are malformed")
    ids, by_id, held, unheld = set(), {}, set(), set()
    for clash in clashes:
        if not isinstance(clash, dict) or not isinstance(clash.get("id"), str) or not clash["id"]:
            return _unsure(project_id, "a clash entry has no id")
        more_fields, more_files = _names(clash.get("fields")), _names(clash.get("files"))
        if more_fields is None or more_files is None:
            return _unsure(project_id, "a clash entry's fields or files are malformed")
        ids.add(clash["id"])
        (held if clash.get("held") is True else unheld).add(clash["id"])
        own_fields, own_files = by_id.get(clash["id"], (frozenset(), {}))
        by_id[clash["id"]] = (own_fields | frozenset(more_fields),
                              {**own_files, **{file_key(f): f for f in more_files}})
        fields = fields + more_fields
        files = files + more_files
    return ClashSet(fields=fields, files={file_key(f): f for f in files}, ids=ids, by_id=by_id, held=held - unheld)


def _nothing_at(path) -> bool:
    """True when nothing at all is at `path`, not even a link, because a real folder above it lacks the next name (a
    missing parent counts: nothing is there). The nearest thing that IS there, walking up, must be a folder through
    any links: a link that points nowhere (an unmounted volume) or a file is not "nothing", it is unsure."""
    try:
        os.lstat(path)
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        return False
    else:
        return False
    here = path
    while True:
        up = os.path.dirname(here)
        if up == here:
            return False
        here = up
        try:
            os.lstat(here)
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            return False
        return os.path.isdir(here)


_MISSING_ROOT = ""


def _state_root(base) -> "str | None":
    """The state folder's real path; _MISSING_ROOT when nothing is at its name; None when unsure."""
    if not os.path.isabs(base):
        return None   # misconfigured: a relative path names another folder from every working directory
    try:
        root = os.path.realpath(base)
        if os.path.isdir(root):
            return root
        # Nothing at that name: the app never made it, and no project has a clash recorded (module docstring).
        # Anything else there (a file, a dangling link, a folder that cannot be looked into) stays unsure.
        if _nothing_at(base):
            _note_missing()
            return _MISSING_ROOT
    except (OSError, ValueError):
        pass
    return None


def _note_missing() -> None:
    if _missing_log["armed"] and not _missing_log["logged"]:
        _missing_log["logged"] = True
        print(MISSING_STATE_LINE, file=sys.stderr, flush=True)


def startup() -> None:
    """For serve only, at startup: arm the missing-folder notice, and print it now when the folder is missing."""
    _missing_log["armed"] = True
    base = state_dir()
    if base:
        _state_root(base)


def load(project_id) -> ClashSet:
    """The project's clash set. Call only with state_dir() set. Never raises: anything unexpected is UNSURE."""
    try:
        return _load(project_id)
    except Exception as e:
        return _unsure(project_id, f"unexpected {type(e).__name__}")


def _load(project_id) -> ClashSet:
    base = state_dir()
    if not base:
        return _unsure(project_id, "the state folder is not named")
    if not valid_project_id(project_id):
        return _unsure(project_id, "the project id cannot name a folder")
    root = _state_root(base)
    if root is None:
        return _unsure(project_id, "the state folder cannot be read")
    if root == _MISSING_ROOT:
        return NO_CLASH
    try:
        folder = os.path.realpath(os.path.join(root, project_id))
    except (OSError, ValueError):
        return _unsure(project_id, "the project's state folder path cannot be resolved")
    # The id's folder, directly in the state folder: never a link to anywhere else, not even a sibling.
    if os.path.dirname(folder) != root or os.path.basename(folder) != project_id:
        return _unsure(project_id, "the project's state folder is a link out of the state folder")
    path = os.path.join(folder, SIDECAR)
    try:
        seen = os.lstat(path)
    except FileNotFoundError:
        return NO_CLASH
    except OSError:
        return _unsure(project_id, "the sidecar cannot be looked at")
    if not stat.S_ISREG(seen.st_mode):
        return _unsure(project_id, "the sidecar is not a plain file")   # a link, a folder, a pipe
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        return NO_CLASH   # removed between the two calls: the shell's own clear
    except OSError:
        return _unsure(project_id, "the sidecar cannot be opened")
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (seen.st_dev, seen.st_ino):
            return _unsure(project_id, "the sidecar was swapped between lstat and open")
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            size += len(chunk)
            if size > _MAX_BYTES:
                return _unsure(project_id, "the sidecar is larger than the limit")
            chunks.append(chunk)
    except OSError:
        return _unsure(project_id, "the sidecar cannot be read")
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


def unheld_touched(clashes: ClashSet, fields=(), files=(), everything: bool = False) -> list:
    """The clashed names a DRIVE write touches that are not held: those `touched` names that no clash entry names, or
    that some clash not held names. An unsure set is `touched`'s answer (everything the write names)."""
    names = touched(clashes, fields, files, everything)
    if clashes.unsure or not names:
        return names

    def held_only(name):
        # a whole-project clash (`*` among its own names) owns every name: unheld, it refuses them all
        key = file_key(name)
        owners = [cid for cid, (own_fields, own_files) in clashes.by_id.items()
                  if name in own_fields or key in own_files or EVERYTHING in own_fields or file_key(EVERYTHING) in own_files]
        return bool(owners) and all(cid in clashes.held for cid in owners)

    return [n for n in names if not held_only(n)]


def outside_clash(clashes: ClashSet, clash_id: str, fields=(), files=(), derived=(), everything: bool = False) -> list:
    """For a person's resolve of the open clash `clash_id` (review 40, 4): the names it may not write. Every field
    and file it names outside that clash's own names (a file is inside when it is one of them or under one of its
    folders; `*` covers all), in the write's own spelling; and every `derived` field (one the write changes without
    naming it, a normalisation) that another open clash holds. A whole-project write is `*`, unless the clash
    itself is the whole project. A clash whose own fields (or files) are `*` covers only what no other open clash
    holds: its resolve may not write another open clash's field or file (review fold), and its whole-project write is
    refused on the names the others hold."""
    own_fields, own_files = clashes.by_id.get(clash_id, (frozenset(), {}))
    all_fields, all_files = EVERYTHING in own_fields, EVERYTHING in own_files
    other_fields, other_files = _held_by_others(clashes, clash_id)
    if everything:
        if not (all_fields and all_files):
            return [EVERYTHING]
        # The clash is the whole project: it writes everything but what another open clash holds.
        return [*sorted(f for f in other_fields if f != EVERYTHING),
                *(other_files[k] for k in sorted(other_files) if k != EVERYTHING)]

    # Another clash's `*` holds nothing here: two whole-project clashes do not block each other's resolve. Another
    # clash's named fields and files still do.
    def other_field(f):
        return f != EVERYTHING and f in other_fields

    named_others = [k for k in other_files if k != EVERYTHING]

    if all_fields:
        # A `*` clash closes its own names and the fields no other open clash holds (review fold): never another's.
        out = [f for f in fields if f not in own_fields and other_field(f)]
    else:
        out = [f for f in fields if f not in own_fields]
    for written in files:
        w = file_key(written)
        if w in own_files:
            continue   # named by this clash itself
        if any(_file_hit(w, k) for k in named_others):
            out.append(written)   # held by another clash, even inside a folder this resolve owns
            continue
        if any(k.endswith("/") and w.startswith(k) for k in own_files if k != EVERYTHING):
            continue
        if all_files:
            continue
        out.append(written)
    if all_fields:
        out += [f for f in derived if f not in own_fields and other_field(f)]
    else:
        out += [f for f in derived if f not in own_fields and (f in clashes.fields or EVERYTHING in clashes.fields)]
    return list(dict.fromkeys(out))


def _held_by_others(clashes: ClashSet, clash_id: str) -> "tuple[frozenset, dict]":
    """The fields and files ({file_key: spelling}) some open clash other than `clash_id` holds, plus any the sidecar
    lists with no clash of its own (its top-level lists are the union, so a name in them alone is held too)."""
    fields, files = set(), {}
    for cid, (f, k) in clashes.by_id.items():
        if cid == clash_id:
            continue
        fields |= f
        files.update(k)
    every_field = set().union(*(f for f, _ in clashes.by_id.values()))
    every_file = {k for _, ks in clashes.by_id.values() for k in ks}
    fields |= clashes.fields - every_field
    files.update({k: v for k, v in clashes.files.items() if k not in every_file})
    return frozenset(fields), files


def message(names) -> str:
    """The app wrapper's syncConflictText (desktop/mcp/app-tools.mjs), word for word."""
    named = ", ".join("the whole project" if n == EVERYTHING else n for n in names) if names else "some fields"
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
    """For a step's own write, under the project lock: raise SyncConflict when it touches a clashed name of a readable
    clash set (an unreadable one is not a clash). Off with
    the variable unset; a step the window ran (MONTAJ_WRITE_ORIGIN=human, set only by serve) passes, and one it ran
    while the person's AI drove it (`drive`) passes on held names only."""
    origin = os.environ.get(ORIGIN_ENV)
    if not state_dir() or origin == HUMAN_ORIGIN:
        return
    if not fields and not files:
        return
    clashes = load(project_id)
    if clashes.unsure:
        return   # not a clash: the write goes through (load logged why)
    names = unheld_touched(clashes, fields, files) if origin == DRIVE_ORIGIN else touched(clashes, fields, files)
    if names:
        raise SyncConflict(refusal(names))


def check_step_document(before: dict, after: dict, files=()) -> None:
    """check_step_write on the top-level fields `after` changes from `before` (both read under the lock)."""
    if not state_dir():
        return
    # The project's id as read: a write that changes `id` is checked against the clashes of the project it changes.
    pid = (before if isinstance(before, dict) else {}).get("id") or (after if isinstance(after, dict) else {}).get("id")
    check_step_write(pid, changed_fields(before, after), files)


def exit_refused(body: dict) -> None:
    """A step's structured exit for a refusal: the binding body on stderr, exit 1 (serve answers a sync_conflict as
    409)."""
    print(json.dumps(body), file=sys.stderr)
    sys.exit(1)
