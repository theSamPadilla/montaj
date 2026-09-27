"""External API connectors for Montaj.

Each connector module wraps one vendor's API. Step scripts import from here
and translate ConnectorError to fail().
"""


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
