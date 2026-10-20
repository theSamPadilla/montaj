"""The engine's save guard (§477): a project write says which revision of each field it
was based on, and serve compares under the project lock.

Inert unless the app started serve with MONTAJ_ENGINE_GUARD=1: standalone montaj and the
CLI behave as before. The app also passes a per-launch secret (MONTAJ_SHELL_SECRET); only a
request carrying it may name its writer class or ask for advisory mode, so any other local
process calling serve directly is treated as the strictest class.
"""
import hmac
import json
import os
import sys

from fastapi import HTTPException

from lib import project_revisions
from lib.project_tracks import normalize_tracks

GUARD_ENV = project_revisions.GUARD_ENV
SECRET_ENV = "MONTAJ_SHELL_SECRET"

CANARY_MISMATCH_LINE = "save-guard: revision canary MISMATCH, engine guard disabled, shell guard only"

# Read once at startup. The secret never stays in os.environ: every step subprocess
# inherits serve's environment, and a step has no business holding it.
_state = {"requested": False, "secret": None, "canary": "ok", "logged": False}


def startup() -> None:
    """Take the guard switch and the secret from the environment, and check that this
    hasher still agrees with the app's. Runs when `montaj serve` starts (before its
    dependency checks spawn anything) and again when serve.server is imported; the
    second run finds the secret already taken and keeps it."""
    _state["requested"] = project_revisions.engine_guard_requested()
    _state["secret"] = os.environ.pop(SECRET_ENV, None) or _state["secret"]
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
    return _state["requested"] and _state["canary"] == "ok"


def canary_state() -> str:
    return _state["canary"]


# ── the PUT check ─────────────────────────────────────────────────────────────

WRITERS = ("ai", "tool", "editor")
# The answer's own report keys and the id are never project fields a save changes.
NOT_FIELDS = frozenset({"id", "copied", "warnings"})
# Fields only Montaj writes, blind: a body that changes nothing else needs no read.
OWNED_FIELDS = frozenset({"hubTemplate"})

READ_HEADER = "x-montaj-read-revisions"


class Verdict:
    """What the guard decided for one PUT that it let through."""
    __slots__ = ("writer", "advisory", "changed", "overrode")

    def __init__(self, writer, advisory, changed):
        self.writer = writer
        self.advisory = advisory
        self.changed = changed
        self.overrode = []


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


def check_save(headers, body: dict, raw_text, existing: dict):
    """Run under the project lock, after the project is read and before anything is merged.
    None when the guard is off. Raises the refusal (nothing written yet) or returns the
    Verdict the answer's headers are built from."""
    if not enabled():
        return None
    headers = headers if headers is not None else {}
    trusted = secret_valid(headers.get("x-montaj-shell"))
    writer = headers.get("x-montaj-writer") if trusted else None
    writer = writer if writer in WRITERS else "ai"
    advisory = trusted and writer == "editor" and headers.get("x-montaj-guard") == "advisory"
    changed = changed_fields(body)
    verdict = Verdict(writer, advisory, changed)
    if all(f in OWNED_FIELDS for f in changed):
        return verdict
    now = current_revisions(raw_text, existing, changed)
    found = project_revisions.stale_fields(None, changed, _read_header(headers), revisions=now)
    stale, missing = found["stale"], found["missing"]
    if not stale and not missing:
        return verdict
    if advisory:
        # An override is a field whose revision differs. A field the editor sent no
        # revision for was never read, which is not an override.
        verdict.overrode = stale
        return verdict
    if stale:
        raise HTTPException(409, detail={"error": "project_changed", "stale": stale, "missing": missing,
                                         "message": stale_message(stale, missing)})
    raise HTTPException(400, detail={"error": "read_required", "stale": [], "missing": missing,
                                     "message": missing_message(missing)})


def check_read(headers, raw_text, existing: dict, fields) -> None:
    """For a route that accepts `read` without requiring it (the caption translation): run
    under the project lock before anything is written. Every one of fields the request sent
    a revision for must still have it, or the write is refused as stale; a field it sent
    nothing for is left to the route's own checks."""
    if not enabled():
        return
    read = _read_header(headers if headers is not None else {})
    sent = [f for f in fields if read and isinstance(read.get(f), str) and read[f]]
    if not sent:
        return
    now = current_revisions(raw_text, existing, sent)
    stale = project_revisions.stale_fields(None, sent, read, revisions=now)["stale"]
    if stale:
        raise HTTPException(409, detail={"error": "project_changed", "stale": stale, "missing": [],
                                         "message": stale_message(stale, [])})


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
    written = [k for k in keys if k in verdict.changed or existing.get(k) != current.get(k)]
    if text is not None:
        revs = project_revisions.revisions_for_text(text, current, written)
    else:
        revs = project_revisions.revisions_of(current, written)
    response.headers["x-montaj-revisions"] = json.dumps(revs, separators=(",", ":"))
    response.headers["x-montaj-revisions-final"] = "1" if final else "0"
    if verdict.overrode:
        response.headers["x-montaj-overrode"] = _header_value(verdict.overrode)
        # Field names only, never values: this line reaches us through crash-report log tails.
        print(f"save-guard: advisory override {verdict.writer} fields={_header_value(verdict.overrode)}",
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
