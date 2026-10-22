"""The engine's save guard (§477): a project write says which revision of each field it
was based on, and serve compares under the project lock.

Inert unless the app started serve with MONTAJ_ENGINE_GUARD=1: standalone montaj and the
CLI behave as before. The app also hands serve a per-launch secret on stdin (one line, with
MONTAJ_SHELL_SECRET_STDIN=1); only a request carrying it may name its writer class or ask
for advisory mode, so any other local process calling serve directly is treated as the
strictest class. The secret is never in serve's environment: a process's environment block
is readable by the same user (`ps eww`) even after os.environ forgets it.
"""
import hmac
import json
import os
import re
import sys
import threading
from collections import OrderedDict

from fastapi import HTTPException

from lib import project_revisions, sync_clash
from lib.project_tracks import normalize_tracks

GUARD_ENV = project_revisions.GUARD_ENV
STDIN_ENV = "MONTAJ_SHELL_SECRET_STDIN"
# Never read: a secret in the environment would be visible to `ps eww`. A stray one is
# still removed so no step subprocess inherits it.
SECRET_ENV = "MONTAJ_SHELL_SECRET"

CANARY_MISMATCH_LINE = "save-guard: revision canary MISMATCH, engine guard disabled, shell guard only"
SECRET_MISSING_LINE = "save-guard: shell secret not received, engine guard disabled, shell guard only"

_SECRET_LINE = re.compile(rb"[0-9a-f]{64}\n")
_STDIN_TIMEOUT_SECONDS = 5
# The fd the shell writes the secret line to; a test points it at a pipe.
_stdin_fd = 0

_state = {"requested": False, "secret": None, "canary": "ok", "logged": False,
          "stdin_done": False, "secret_logged": False}


def _read_secret_line(fd, timeout) -> "str | None":
    """One line from fd, at most 65 bytes and never past its newline, read on a thread so a
    closed, silent or terminal stdin cannot hang startup. The secret when the line is 64
    lowercase hex then a newline, else None. fd is then pointed at the null device, so
    nothing serve starts can read the rest of the shell's pipe."""
    box = {}

    def read():
        buf = b""
        try:
            while len(buf) < 65:
                ch = os.read(fd, 1)
                if not ch:
                    break
                buf += ch
                if ch == b"\n":
                    break
        except OSError:
            pass
        box["line"] = buf

    reader = threading.Thread(target=read, name="montaj-shell-secret", daemon=True)
    reader.start()
    reader.join(timeout)
    line = box.get("line")
    try:
        null = os.open(os.devnull, os.O_RDONLY)
        try:
            os.dup2(null, fd)
        finally:
            os.close(null)
    except OSError:
        pass
    if line is None or not _SECRET_LINE.fullmatch(line):
        return None
    return line[:64].decode("ascii")


def _inject_secret_for_tests(secret) -> None:
    """Tests only: hold secret as if the shell had sent it on stdin."""
    _state["secret"] = secret
    _state["stdin_done"] = True


def startup() -> None:
    """Take the guard switch from the environment and the secret from stdin, and check that
    this hasher still agrees with the app's. Runs when `montaj serve` starts (before its
    dependency checks spawn anything) and again when serve.server is imported: stdin is read
    on the first run only, and the second keeps what the first decided."""
    os.environ.pop(SECRET_ENV, None)
    # §482: a step learns it was the window's only from serve (check_sync's step_origin); an inherited value
    # must never reach a step or anything else serve starts.
    os.environ.pop(sync_clash.ORIGIN_ENV, None)
    if os.environ.pop(STDIN_ENV, None) == "1" and not _state["stdin_done"]:
        _state["stdin_done"] = True
        _state["secret"] = _read_secret_line(_stdin_fd, _STDIN_TIMEOUT_SECONDS)
    _state["requested"] = project_revisions.engine_guard_requested()
    if _state["requested"] and not _state["secret"]:
        # Without the secret serve cannot tell the window from any other caller, and would
        # refuse every human save as the AI's. Off for this process and for every step it
        # starts (they read the switch from the environment); the shell's guard still runs.
        _state["requested"] = False
        os.environ.pop(GUARD_ENV, None)
        if not _state["secret_logged"]:
            _state["secret_logged"] = True
            print(SECRET_MISSING_LINE, file=sys.stderr, flush=True)
    _state["canary"] = "ok" if project_revisions.canary_ok() else "mismatch"
    if _state["requested"] and _state["canary"] != "ok" and not _state["logged"]:
        # A divergent hasher would refuse every save as stale; the shell's own guard
        # still runs, so serve steps aside rather than loop the AI forever.
        _state["logged"] = True
        print(CANARY_MISMATCH_LINE, file=sys.stderr, flush=True)


def secret_valid(sent) -> bool:
    """Constant-time compare with the launch secret. False when serve has none."""
    secret = _state["secret"]
    if not secret or not isinstance(sent, str) or not sent:
        return False
    return hmac.compare_digest(sent.encode("utf-8"), secret.encode("utf-8"))


def enabled() -> bool:
    """The guard is effectively on: requested, the canary agrees and the secret arrived."""
    return bool(_state["requested"] and _state["canary"] == "ok" and _state["secret"])


def canary_state() -> str:
    return _state["canary"]


# ── the PUT check ─────────────────────────────────────────────────────────────

WRITERS = ("ai", "tool", "editor")
# The answer's own report keys and the id are never project fields a save changes.
NOT_FIELDS = frozenset({"id", "copied", "warnings"})
# Fields only Montaj writes, blind: a body that changes nothing else needs no read.
OWNED_FIELDS = frozenset({"hubTemplate"})

READ_HEADER = "x-montaj-read-revisions"
ORIGIN_HEADER = "x-montaj-write-origin"
SYNC_ORIGIN = "sync"
UNREAD_HEADER = "x-montaj-unread"


class Verdict:
    """What the guard decided for one PUT that it let through."""
    __slots__ = ("writer", "advisory", "changed", "overrode", "base_text", "project", "before",
                 "unread_marks", "unread", "origin")

    def __init__(self, writer, advisory, changed, base_text=None, project=None):
        self.writer = writer
        self.advisory = advisory
        self.changed = changed
        self.overrode = []
        # The text the save read, when its revisions are cached under it (the file already in
        # the reader's shape): the answer reuses them for every field the save left alone.
        self.base_text = base_text
        # The key of the project's marks (below); None keeps them out of it.
        self.project = project
        # The revisions of the body's fields in the file the save read, when the check took them.
        self.before = {}
        # Fields sent with no read whose value in the file is still another writer's: {field: mark}.
        self.unread_marks = {}
        self.unread = []
        # "sync" only for a trusted tool write carrying x-montaj-write-origin: sync (the app's
        # Studio sync pull); None for every other write. Marks and the writer stamp need it.
        self.origin = None


# ── marks: what the last guarded writes of another writer left (§482 G-2) ────────
#
# Per project and per serve process: {field: revision} for every top-level field a guarded PUT
# from a trusted Studio sync pull (a tool write with origin sync, and no other) changed the value of, as that write
# left it. An advisory editor write that sends no revision for such a field, while the file
# still holds that value, and changes it, overwrote a value it may never have seen; the answer
# names the field in x-montaj-unread (reported, never refused). Any editor write that writes the
# field takes it over (the mark goes), unless it sent no read and left the value as it was.
# Built only from revisions the check and the answer compute anyway: nothing more is hashed.
# Settled as the answer is built, just after the lock (the app's write queue runs one write per
# project at a time), and lost when serve restarts: a report, best effort, never a refusal.
_MARKS_PROJECTS = 64
_marks: "OrderedDict[str, dict]" = OrderedDict()
_marks_lock = threading.Lock()


def _unread_candidates(project, missing, now) -> dict:
    """{field: mark} for each field in missing whose value in the file is still the marked one."""
    if project is None or not missing:
        return {}
    with _marks_lock:
        marks = _marks.get(project)
        if not marks:
            return {}
        return {f: marks[f] for f in missing
                if f not in OWNED_FIELDS and f in marks and now.get(f) == marks[f]}


def _note_write(verdict, revs) -> None:
    """After a PUT, from revs (the revisions of every field it wrote): mark what another writer
    changed, or settle the editor's write against the marks and say what it overwrote unread."""
    if verdict.project is None:
        return
    if verdict.writer == "editor":
        verdict.unread = [f for f, mark in verdict.unread_marks.items() if revs.get(f) != mark]
        kept = {f for f, mark in verdict.unread_marks.items() if revs.get(f) == mark}
        with _marks_lock:
            marks = _marks.get(verdict.project)
            if marks:
                for f in verdict.changed:
                    if f not in kept:
                        marks.pop(f, None)
                if not marks:
                    _marks.pop(verdict.project, None)
        return
    if verdict.origin != SYNC_ORIGIN:
        return
    moved = {f: revs[f] for f in verdict.changed
             if f not in OWNED_FIELDS and f in revs and f in verdict.before and verdict.before[f] != revs[f]}
    if not moved:
        return
    with _marks_lock:
        _marks[verdict.project] = {**_marks.get(verdict.project, {}), **moved}
        _marks.move_to_end(verdict.project)
        while len(_marks) > _MARKS_PROJECTS:
            _marks.popitem(last=False)


def changed_fields(body: dict) -> list:
    return [k for k in body if k not in NOT_FIELDS]


def _read_header(headers):
    """The revisions the writer read. Anything but a JSON object counts as not sent."""
    try:
        read = json.loads(headers.get(READ_HEADER) or "")
    except ValueError:
        return None
    return read if isinstance(read, dict) else None


def current_revisions(raw_text, existing, fields) -> dict:
    """Revisions of fields in the project as a reader gets it (normalize_tracks of the file).
    Cached by the file's text when the text already is that document; a legacy shape the
    reader sees normalised is hashed from its normalised form, uncached."""
    normalized = normalize_tracks(existing)
    if normalized is existing and raw_text is not None:
        return project_revisions.revisions_for_text(raw_text, existing, fields)
    return project_revisions.revisions_of(normalized, fields)


def _fields_json(fields) -> str:
    # The list as the app's wrapper prints it (JSON.stringify of strings).
    return project_revisions.canonical(list(fields))


def stale_message(stale, missing) -> str:
    """The app wrapper's projectChangedText (desktop/mcp/app-tools.mjs), word for word."""
    fields = list(stale) + list(missing)
    never = f" (you never read {', '.join(missing)})" if missing else ""
    return (f"{', '.join(fields)} changed since you read it (you or the user edited it, or Montaj "
            f"updated it){never}, so nothing was saved: call get_project with fields "
            f"{_fields_json(fields)} and redo your change on what it returns, then save with the new "
            f"revisions.")


def missing_message(missing) -> str:
    """The app wrapper's readFirstText (desktop/mcp/app-tools.mjs), word for word."""
    return (f"save_project needs the revision of every field you change. Call get_project with fields "
            f"{_fields_json(missing)} (the fields you are changing), then call save_project again with "
            f"read set to the revisions it returned.")


def writer_of(headers) -> "tuple[str, bool]":
    """(writer class, trusted). Only a request carrying the launch secret may name its class;
    any other is `ai`, the strictest."""
    headers = headers if headers is not None else {}
    trusted = secret_valid(headers.get("x-montaj-shell"))
    writer = headers.get("x-montaj-writer") if trusted else None
    return (writer if writer in WRITERS else "ai"), trusted


def sync_origin_of(headers) -> "str | None":
    """"sync" for a request that is trusted (the launch secret), writes as `tool` and names
    origin sync; None for everything else, so a forged header, an `ai` write and a plain
    `tool` write are all inert."""
    headers = headers if headers is not None else {}
    writer, trusted = writer_of(headers)
    if trusted and writer == "tool" and headers.get(ORIGIN_HEADER) == SYNC_ORIGIN:
        return SYNC_ORIGIN
    return None


WRITER_STAMP = "event: writer\ndata: tool;origin=sync\n\n"


def writer_stamp(verdict) -> str:
    """The named SSE frame published just before a guarded PUT's data frame: only for a
    trusted sync pull, else empty."""
    return WRITER_STAMP if verdict is not None and verdict.origin == SYNC_ORIGIN else ""


def check_save(headers, body: dict, raw_text, existing: dict, project=None):
    """Run under the project lock, after the project is read and before anything is merged.
    None when the guard is off. Raises the refusal (nothing written yet) or returns the
    Verdict the answer's headers are built from. project keys the project's marks (any
    stable string, the project.json path); None leaves them out."""
    if not enabled():
        return None
    headers = headers if headers is not None else {}
    writer, trusted = writer_of(headers)
    advisory = trusted and writer == "editor" and headers.get("x-montaj-guard") == "advisory"
    changed = changed_fields(body)
    base_text = raw_text if normalize_tracks(existing) is existing else None
    verdict = Verdict(writer, advisory, changed, base_text, project)
    verdict.origin = sync_origin_of(headers)
    if all(f in OWNED_FIELDS for f in changed):
        return verdict
    now = current_revisions(raw_text, existing, changed)
    verdict.before = now
    found = project_revisions.stale_fields(None, changed, _read_header(headers), revisions=now)
    stale, missing = found["stale"], found["missing"]
    if not stale and not missing:
        return verdict
    if advisory:
        # An override is a field whose revision differs. A field the editor sent no
        # revision for was never read, which is not an override; the answer still names it
        # in x-montaj-unread when it changes another writer's value (_note_write).
        verdict.overrode = stale
        verdict.unread_marks = _unread_candidates(project, missing, now)
        return verdict
    if stale:
        raise HTTPException(409, detail={"error": "project_changed", "stale": stale, "missing": missing,
                                         "message": stale_message(stale, missing)})
    raise HTTPException(400, detail={"error": "read_required", "stale": [], "missing": missing,
                                     "message": missing_message(missing)})


HUMAN_ONLY_MESSAGE = "Only the Montaj window can do this."


def require_editor(headers) -> None:
    """For a route that replaces project content wholesale with no compare (restore, rerun,
    asset include, delete files): with the guard on, only the window's editor (the launch
    secret AND writer editor) may call it; anything else is 403 human_only. Nothing when
    the guard is off."""
    if not enabled():
        return
    writer, trusted = writer_of(headers)
    if not (trusted and writer == "editor"):
        raise HTTPException(403, detail={"error": "human_only", "message": HUMAN_ONLY_MESSAGE})


SHELL_ONLY_MESSAGE = "Only the Montaj app can do this."


def require_shell(headers) -> None:
    """For a route the app's own writers use, from the window or the main process, and
    the AI must not (recording where a file came from): with the guard on, only a
    request carrying the launch secret with writer `editor` or `tool` may call it;
    anything else, `ai` or a caller without the secret, is 403 shell_only. Nothing when
    the guard is off."""
    if not enabled():
        return
    writer, trusted = writer_of(headers)
    if not (trusted and writer in ("editor", "tool")):
        raise HTTPException(403, detail={"error": "shell_only", "message": SHELL_ONLY_MESSAGE})


def read_required_message(missing, action) -> str:
    """What a route other than save_project says when its write carries no revision."""
    return (f"{action} needs the revision of {', '.join(missing)} you read. Call get_project with fields "
            f"{_fields_json(missing)}, then {action.lower()} again with read set to the revisions it "
            f"returned.")


def check_read(headers, raw_text, existing: dict, fields, action: str) -> None:
    """For a route that writes `fields` from a read taken outside its lock hold (the caption
    translation): run under the project lock before anything is written. Strict for the ai
    and tool writers: a field with no revision sent is 400 read_required, one whose revision
    moved 409 project_changed. Advisory for the window's editor (secret-checked): applied,
    and a stale field is logged as an override. Nothing when the guard is off."""
    if not enabled():
        return
    headers = headers if headers is not None else {}
    writer, _ = writer_of(headers)
    now = current_revisions(raw_text, existing, fields)
    found = project_revisions.stale_fields(None, fields, _read_header(headers), revisions=now)
    stale, missing = found["stale"], found["missing"]
    if writer == "editor":
        if stale:
            # Field names only, never values, as the PUT's override line.
            print(f"save-guard: advisory override editor fields={_header_value(stale)}",
                  file=sys.stderr, flush=True)
        return
    if stale:
        raise HTTPException(409, detail={"error": "project_changed", "stale": stale, "missing": missing,
                                         "message": stale_message(stale, missing)})
    if missing:
        raise HTTPException(400, detail={"error": "read_required", "stale": [], "missing": missing,
                                         "message": read_required_message(missing, action)})


def _header_value(names) -> str:
    # A top-level key can be any string; a header value must be latin-1.
    return ",".join(names).encode("ascii", "backslashreplace").decode("ascii")


def answer_headers(response, verdict, existing: dict, current: dict, text, final: bool) -> None:
    """Revisions of every top-level field the PUT wrote, from the document it answers with:
    what the body named plus whatever else moved (a legacy shape normalised, settings
    markers, a media-copy patch). text is current's file text when the answer is exactly
    what the save wrote, so the next GET of that file hits the cache."""
    if verdict is None or response is None:
        return
    keys = list(dict.fromkeys([*verdict.changed, *current, *existing]))
    written = [k for k in keys if k in verdict.changed
               or (current.get(k) is not existing.get(k) and existing.get(k) != current.get(k))]
    if text is not None:
        revs = project_revisions.revisions_for_text(text, current, written,
                                                    base=(verdict.base_text, existing))
    else:
        revs = project_revisions.revisions_of(current, written)
    response.headers["x-montaj-revisions"] = json.dumps(revs, separators=(",", ":"))
    response.headers["x-montaj-revisions-final"] = "1" if final else "0"
    _note_write(verdict, revs)
    if verdict.overrode:
        response.headers["x-montaj-overrode"] = _header_value(verdict.overrode)
        # Field names only, never values: this line reaches us through crash-report log tails.
        print(f"save-guard: advisory override {verdict.writer} fields={_header_value(verdict.overrode)}",
              file=sys.stderr, flush=True)
    if verdict.unread:
        # Its own header: x-montaj-overrode means "applied over a newer revision" to every reader
        # of it, and a field with no read may have been seen; the app treats both the same.
        response.headers[UNREAD_HEADER] = _header_value(verdict.unread)
        print(f"save-guard: advisory unread {verdict.writer} fields={_header_value(verdict.unread)}",
              file=sys.stderr, flush=True)


def parse_fields(fields) -> "list | None":
    if not isinstance(fields, str):
        return None
    names = [f.strip() for f in fields.split(",") if f.strip()]
    return names or None


def get_headers(response, project, fields, raw_text=None, raw_project=None) -> None:
    """x-montaj-revisions on a GET: the asked fields (all top-level ones when none were
    asked) of the project in the answer. raw_text is cached only when the answer is the very
    object parsed from (or written as) it."""
    if not enabled() or response is None or not isinstance(project, dict):
        return
    names = parse_fields(fields)
    if names is None:
        names = list(project)
    if raw_text is not None and raw_project is project:
        revs = project_revisions.revisions_for_text(raw_text, project, names)
    else:
        revs = project_revisions.revisions_of(project, names)
    response.headers["x-montaj-revisions"] = json.dumps(revs, separators=(",", ":"))


# ── §482 M4: the Studio sync clash backstop ──────────────────────────────────
#
# With MONTAJ_SYNC_STATE_DIR set, every project write asks check_sync, under the project lock where the route has
# one and BEFORE check_save/check_read: a write that touches a field or file in an open Studio sync clash
# (lib/sync_clash.py) is refused with the binding 409 {error: sync_conflict, fields, message}, unless it is a
# person's. Unset: nothing is read and nothing changes. The trust rule is x-montaj-writer's: only a request with the
# launch secret may name its origin.
#
#   human     trusted `editor` with no x-montaj-write-origin: the window. Passes.
#   sync      trusted `tool` + origin `sync`: the app's Studio sync pull (it writes the merge). Passes.
#   resolve   trusted `tool` + origin `resolve` + x-montaj-sync-resolve: <clash id>: a person's resolve, written by
#             the shell. Passes when the id is an open clash in the sidecar, or when the sidecar is unsure (it can
#             not be checked, and the person must still be able to resolve).
#   other     everything else: `ai`, no or a wrong secret, plain `tool`, `tool` + `app`, `editor` + any origin
#             (`drive`), a step run by any of these, and serve's own maintenance heals. Refused on a clashed name.

RESOLVE_ORIGIN = "resolve"
RESOLVE_HEADER = "x-montaj-sync-resolve"
_RESOLVE_ID_MAX = 256


class SyncWho:
    """Who a write is, for the sync check: `human`, `sync`, `resolve` (with its clash id) or `other`."""
    __slots__ = ("kind", "clash_id")

    def __init__(self, kind, clash_id=None):
        self.kind = kind
        self.clash_id = clash_id


MAINTENANCE = SyncWho("other")


def sync_who(headers) -> SyncWho:
    if isinstance(headers, SyncWho):
        return headers
    headers = headers if headers is not None else {}
    writer, trusted = writer_of(headers)
    if not trusted:
        return MAINTENANCE
    origin = headers.get(ORIGIN_HEADER)
    if writer == "editor" and not origin:
        return SyncWho("human")
    if writer == "tool" and origin == SYNC_ORIGIN:
        return SyncWho("sync")
    if writer == "tool" and origin == RESOLVE_ORIGIN:
        clash_id = headers.get(RESOLVE_HEADER)
        if isinstance(clash_id, str) and 0 < len(clash_id) <= _RESOLVE_ID_MAX and clash_id.isprintable():
            return SyncWho("resolve", clash_id)
    return MAINTENANCE


def step_origin(headers) -> str:
    """MONTAJ_WRITE_ORIGIN for a step serve runs: `human` for the window only, else `ai`."""
    return sync_clash.HUMAN_ORIGIN if sync_who(headers).kind == "human" else "ai"


def sync_refusal(project_id, who, fields=(), files=(), *, everything: bool = False) -> "dict | None":
    """The refusal body for a write, or None to go on. Reads nothing with MONTAJ_SYNC_STATE_DIR unset."""
    if not sync_clash.state_dir():
        return None
    who = sync_who(who)
    if who.kind in ("human", "sync"):
        return None
    if not everything and not fields and not files:
        return None
    clashes = sync_clash.load(project_id)
    if who.kind == "resolve" and (clashes.unsure or who.clash_id in clashes.ids):
        return None
    names = sync_clash.touched(clashes, fields, files, everything)
    return sync_clash.refusal(names) if names else None


def check_sync(headers, project_id, fields=(), files=(), *, everything: bool = False) -> None:
    """Raise the binding 409 when this write touches a clashed name. `headers` is the request's, or a SyncWho;
    `fields` are top-level keys, `files` relpaths in the project folder (a trailing `/` a folder), `everything` a
    write of the whole project (a restore, a delete)."""
    body = sync_refusal(project_id, headers, fields, files, everything=everything)
    if body is not None:
        raise HTTPException(409, detail=body)


def maintenance_refusal(raw_text, project: dict, who=None) -> "dict | None":
    """For serve's own write-backs (a heal, a proxy, a copy patch, a download landing), under the project lock:
    the refusal when the write changes a top-level field in an open clash or the clash set is unsure, else None.
    The write is then skipped, and runs again at the next open or save. `raw_text` is the file as read under the
    lock; `who` is the request a follow-up belongs to (default: serve's own maintenance)."""
    if not sync_clash.state_dir():
        return None
    try:
        before = json.loads(raw_text) if isinstance(raw_text, str) else raw_text
    except ValueError:
        before = None
    changed = sync_clash.changed_fields(before, project)
    if not changed:
        return None
    pid = project.get("id") if isinstance(project, dict) else None
    if not pid and isinstance(before, dict):
        pid = before.get("id")
    return sync_refusal(pid, who if who is not None else MAINTENANCE, fields=changed)


def maintenance_allows(raw_text, project: dict, who=None) -> bool:
    return maintenance_refusal(raw_text, project, who) is None


def project_of_path(path, *, folder: bool = False) -> "tuple[str | None, str] | None":
    """(project id, relpath) of the topmost project folder in the workspace holding `path` (real path: `..`, a
    symlinked parent and the like resolve first), or None outside every project. The relpath ends with `/` when
    `folder`; the project folder itself is `*`. An unreadable project.json gives id None (which reads unsure)."""
    from serve.common import resolve_workspace
    try:
        ws = os.path.realpath(resolve_workspace())
        real = os.path.realpath(path)
    except (OSError, ValueError):
        return None
    try:
        if os.path.commonpath([real, ws]) != ws or real == ws:
            return None
    except ValueError:
        return None
    parts = os.path.relpath(real, ws).split(os.sep)
    here = ws
    for i, part in enumerate(parts):
        here = os.path.join(here, part)
        if i == len(parts) - 1 and not folder:
            break
        if os.path.isfile(os.path.join(here, "project.json")):
            try:
                with open(os.path.join(here, "project.json"), encoding="utf-8") as f:
                    pid = json.load(f).get("id")
            except (OSError, ValueError, AttributeError):
                pid = None
            rest = parts[i + 1:]
            if not rest:
                return (pid if isinstance(pid, str) else None), sync_clash.EVERYTHING
            rel = "/".join(rest) + ("/" if folder else "")
            return (pid if isinstance(pid, str) else None), rel
    return None


def check_sync_paths(headers, writes) -> None:
    """check_sync for writes given as absolute paths: `writes` is [(path, is_folder)]. Each path inside a project
    folder is checked against that project's clash set as its relpath."""
    if not sync_clash.state_dir() or sync_who(headers).kind in ("human", "sync"):
        return
    by_project: dict = {}
    for path, is_folder in writes:
        found = project_of_path(path, folder=is_folder)
        if found is not None:
            by_project.setdefault(found[0], []).append(found[1])
    for pid, rels in by_project.items():
        check_sync(headers, pid, files=rels)
