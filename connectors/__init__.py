"""External API connectors for Montaj.

Each connector module wraps one vendor's API. Step scripts import from here
and translate ConnectorError to fail().
"""


class ConnectorError(Exception):
    """Raised by any connector on a user-facing error (bad API response,
    timeout, vendor error, missing credential). Step scripts catch this
    and translate to fail()."""
