"""External API connectors for Montaj.

Each connector module wraps one vendor's API. Step scripts import from here
and translate ConnectorError to fail().
"""
import os


def retarget_extension(path: str, ext: str) -> str:
    """`path` with `ext` substituted; unchanged when it already matches.

    Shared by connectors whose vendor call returns audio in a fixed
    container regardless of what the caller's `out_path` extension asked
    for (Gemini TTS/Lyria, ElevenLabs speech/sfx/music) — the file is named
    after what the bytes actually are, never re-encoded to match the
    request.
    """
    base, current = os.path.splitext(path)
    return path if current.lower() == ext else base + ext


class ConnectorError(Exception):
    """Raised by any connector on a user-facing error (bad API response,
    timeout, vendor error, missing credential). Step scripts catch this
    and translate to fail().

    `reason` is an optional machine-readable subtype for the cases a step
    needs to branch on with its own fail() code/message, instead of
    pattern-matching the free-text message (e.g. "invalid_api_key" for a
    rejected vendor API key). None means "no distinct reason — use the
    connector's generic api_error message as-is."
    """

    def __init__(self, message: str, reason: str | None = None):
        super().__init__(message)
        self.reason = reason


INVALID_API_KEY = "invalid_api_key"
MODEL_RETIRED = "model_retired"
INSUFFICIENT_CREDIT = "insufficient_credit"
UNREACHABLE = "unreachable"

_KEY_WORDS = ("api key", "api_key", "apikey", "access key", "secret key", "invalid token",
              "token is invalid", "token expired", "invalid authentication", "incorrect api key")
_RETIRED_WORDS = ("no longer available", "deprecated", "retired", "model_not_found",
                  "model not found", "unknown model", "does not exist")
_CREDIT_WORDS = ("balance", "insufficient", "credit", "quota exceeded", "billing", "payment required")


def classify_http_error(status: int, message: str) -> str | None:
    """Map a vendor HTTP failure to a shared reason, or None for a generic error.
    Word lists are deliberately narrow: a false None only costs a less specific
    message, but a false invalid_api_key would tell the user their good key is bad."""
    m = (message or "").lower()
    if status == 401:
        return INVALID_API_KEY
    if status == 402 or any(w in m for w in _CREDIT_WORDS):
        return INSUFFICIENT_CREDIT
    if status in (400, 404) and "model" in m and any(w in m for w in _RETIRED_WORDS):
        return MODEL_RETIRED
    if status == 403 and any(w in m for w in _KEY_WORDS):
        return INVALID_API_KEY
    return None
