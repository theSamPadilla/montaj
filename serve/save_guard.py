"""The engine's save guard (§477): a project write says which revision of each field it
was based on, and serve compares under the project lock.

Inert unless the app started serve with MONTAJ_ENGINE_GUARD=1: standalone montaj and the
CLI behave as before. The app also passes a per-launch secret (MONTAJ_SHELL_SECRET); only a
request carrying it may name its writer class or ask for advisory mode, so any other local
process calling serve directly is treated as the strictest class.
"""
import hmac
import os
import sys

from lib import project_revisions

GUARD_ENV = "MONTAJ_ENGINE_GUARD"
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
    _state["requested"] = os.environ.get(GUARD_ENV) == "1"
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
